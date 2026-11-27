'use strict';

const fs = require('fs');
const path = require('path');
const { parseBundle, walkAst, validateBundleSyntax } = require('./bundle-transform');
const { sha256, readJsonFile } = require('./file-transaction');

const MARKER = '/* claude-enhance-local-worker-policy */';

function policyPaths(extensionDirectory) {
  return {
    backup: path.join(extensionDirectory, 'webview', 'claude-enhance-worker-policy.backup'),
    metadata: path.join(extensionDirectory, 'webview', 'claude-enhance-worker-policy.json'),
  };
}

function hostPath(extensionDirectory, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Invalid worker policy entry path.');
  const filename = path.resolve(extensionDirectory, relative);
  const difference = path.relative(path.resolve(extensionDirectory), filename);
  if (difference.startsWith('..' + path.sep) || difference === '..') throw new Error('Worker policy entry escapes the extension.');
  const actualRoot = fs.realpathSync(extensionDirectory);
  const actual = fs.realpathSync(filename);
  const actualDifference = path.relative(actualRoot, actual);
  if (actualDifference.startsWith('..' + path.sep) || actualDifference === '..' || path.isAbsolute(actualDifference)) {
    throw new Error('Worker policy entry resolves outside the extension.');
  }
  return filename;
}

function transformWorkerPolicy(source) {
  const candidates = [];
  walkAst(parseBundle(source), (node) => {
    if (node.type !== 'TemplateLiteral' || node.expressions.length !== 1 || node.quasis.length !== 2) return;
    if (node.quasis[0].value.cooked !== 'worker-src ' || node.quasis[1].value.cooked !== '') return;
    const resource = node.expressions[0];
    if (resource.type !== 'MemberExpression' || resource.computed || resource.property?.name !== 'cspSource') return;
    candidates.push(node);
  });
  if (candidates.length !== 1) return null;
  const target = candidates[0];
  const body = source.slice(0, target.start) + MARKER + source.slice(target.start, target.end - 1) +
    ' blob:`' + source.slice(target.end);
  validateBundleSyntax(body);
  return body;
}

function verifiedPolicy(extensionDirectory) {
  const paths = policyPaths(extensionDirectory);
  const metadata = readJsonFile(paths.metadata);
  if (!metadata) {
    if (fs.existsSync(paths.metadata) || fs.existsSync(paths.backup)) throw new Error('Worker policy backup metadata is missing or invalid.');
    return null;
  }
  const filename = hostPath(extensionDirectory, metadata.entry);
  const original = fs.readFileSync(paths.backup);
  const current = fs.readFileSync(filename);
  if (metadata.schema !== 1 || original.includes(MARKER) || sha256(original) !== metadata.originalHash) {
    throw new Error('Worker policy backup verification failed.');
  }
  if (current.includes(MARKER) && sha256(current) !== metadata.patchedHash) {
    throw new Error('Worker policy host entry changed after patching.');
  }
  return { paths, filename, original, current, metadata };
}

function prepareWorkerPolicy(extensionDirectory) {
  const previous = verifiedPolicy(extensionDirectory);
  if (previous?.current.includes(MARKER)) return { entries: [], supported: true, changed: false };
  const manifest = readJsonFile(path.join(extensionDirectory, 'package.json'));
  if (!manifest?.main) return { entries: [], supported: false, changed: false };
  const filename = hostPath(extensionDirectory, manifest.main);
  const original = fs.readFileSync(filename, 'utf8');
  if (original.includes(MARKER)) throw new Error('Worker policy is patched without a verified backup.');
  const patched = transformWorkerPolicy(original);
  if (!patched) return { entries: [], supported: false, changed: false };
  const paths = policyPaths(extensionDirectory);
  const metadata = { schema: 1, entry: path.relative(extensionDirectory, filename),
    originalHash: sha256(original), patchedHash: sha256(patched) };
  return { supported: true, changed: true, entries: [
    { path: paths.backup, content: original },
    { path: paths.metadata, content: JSON.stringify(metadata) + '\n' },
    { path: filename, content: patched },
  ] };
}

function workerPolicyRestoreEntries(extensionDirectory) {
  const policy = verifiedPolicy(extensionDirectory);
  return policy?.current.includes(MARKER) ? [{ path: policy.filename, content: policy.original }] : [];
}

function cleanupWorkerPolicy(extensionDirectory) {
  for (const filename of Object.values(policyPaths(extensionDirectory))) fs.rmSync(filename, { force: true });
}

module.exports = { MARKER, policyPaths, transformWorkerPolicy, prepareWorkerPolicy,
  workerPolicyRestoreEntries, cleanupWorkerPolicy };
