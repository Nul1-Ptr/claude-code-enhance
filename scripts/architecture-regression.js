'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const originalLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      extensions: { getExtension: () => null, onDidChange: () => ({ dispose() {} }) },
      commands: { executeCommand() {}, registerCommand: () => ({ dispose() {} }) },
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
      window: {
        showInformationMessage: () => Promise.resolve(),
        showWarningMessage: () => Promise.resolve(),
        showErrorMessage() {},
      },
      env: { openExternal() {} },
      Uri: { parse: (value) => value },
      StatusBarAlignment: { Right: 1 },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const projectRoot = path.join(__dirname, '..');
const extension = require('../extension.js')._test;
const {
  transformClaudeBundle,
  findMessageRetentionTargets,
  parseBundle,
} = require('../lib/bundle-transform');
const { transactionalWriteFilesSync } = require('../lib/file-transaction');
const { ALL_FEATURES, createIncrementalScheduler } = require('../vendor/runtime-core');
const uninstall = require('../uninstall-hook');

const retentionDeclaration = 'var cap=600,keep=500;function trim(items){if(items.length>cap){let offset=items.length-keep;return items.slice(offset)}return items}';
const markdownCall = 'const plugins=base;React.createElement(Markdown,{components:{p:P},remarkPlugins:plugins},value);';

function testStructuralTransforms() {
  const source = `${retentionDeclaration}\n${markdownCall}`;
  const transformed = transformClaudeBundle(source, { fullTranscript: true });
  assert(transformed.ok, 'formatted Markdown renderer should transform');
  assert(transformed.body.includes('__remarkMath'), 'remark math should be injected');
  assert(transformed.body.includes('__rehypeKatex'), 'rehype KaTeX should be injected');
  assert(transformed.diagnostics.retentionApplied, 'retention function should be transformed');

  const withRehype = 'h(M,{remarkPlugins:r,rehypePlugins:k,components:c},v)';
  const rehypeResult = transformClaudeBundle(withRehype, { fullTranscript: false });
  assert(rehypeResult.ok, 'existing rehypePlugins should transform');
  assert(/\(k\)\.concat\([^)]*__rehypeKatex/.test(rehypeResult.body), 'existing rehypePlugins should be extended');

  const noTarget = 'const unrelated={remarkPlugins:[],components:{}};';
  const missing = transformClaudeBundle(noTarget);
  assert(!missing.ok && missing.reason === 'markdown-renderer-not-found', 'missing renderer should fail closed');
  assert(missing.body === noTarget, 'missing renderer should leave source untouched');

  const ambiguousSource = `${markdownCall}\nh(M,{remarkPlugins:r,components:c},v);`;
  const ambiguous = transformClaudeBundle(ambiguousSource);
  assert(!ambiguous.ok && ambiguous.reason === 'ambiguous-markdown-renderer', 'ambiguous renderers should fail closed');
  assert(ambiguous.body === ambiguousSource, 'ambiguous renderer should leave source untouched');

  const disabled = transformClaudeBundle(source, { fullTranscript: false });
  assert(disabled.ok && !disabled.body.includes('claude-code-enhance-full-transcript'), 'disabled full transcript should preserve retention');
  assert(!disabled.diagnostics.retentionApplied, 'disabled full transcript should report no retention transform');

  const functionForms = [
    'const trim=function(items){if(items["length"]>cap){let offset=items.length-keep;return items["slice"](offset)}return items};',
    'const trim=(items)=>{if(items.length>cap){let offset=items.length-keep;return items.slice(offset)}return items};',
  ];
  for (const form of functionForms) {
    const ast = parseBundle(`var cap=600,keep=500;${form}`);
    assert(findMessageRetentionTargets(ast).length === 1, `retention form should be discovered: ${form}`);
  }
}

function testScheduler() {
  const scheduled = [];
  const batches = [];
  const rootA = { id: 'a', usable: true };
  const rootB = { id: 'b', usable: true };
  const scheduler = createIncrementalScheduler({
    schedule(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    flush(batch) {
      batches.push(batch);
    },
    isUsableRoot: (root) => root.usable,
  });

  scheduler.enqueue(rootA, ['math'], { reason: 'characterData' });
  scheduler.enqueue(rootB, ['code'], { reason: 'childList' });
  scheduler.enqueue(rootA, ['apiErrors', 'math'], { reason: 'stream' });
  assert(scheduled.length === 1, 'multiple mutations should schedule one flush');
  assert(scheduler.getState().dirtyRootCount === 2, 'dirty roots should be deduplicated');
  scheduled.shift()();
  assert(batches.length === 1 && batches[0].roots.length === 2, 'incremental batch should retain both roots');
  assert(['apiErrors', 'code', 'math'].every((feature) => batches[0].features.includes(feature)), 'feature flags should accumulate');

  scheduler.enqueue(rootA, ['math'], { reason: 'before-swap' });
  scheduler.enqueue(null, undefined, { fullPass: true, reason: 'container-attached' });
  scheduled.shift()();
  assert(batches[1].fullPass && batches[1].roots.length === 0, 'full pass should supersede dirty roots');
  assert(ALL_FEATURES.every((feature) => batches[1].features.includes(feature)), 'full pass should include every feature');
}

function testTransactions() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-enhance-transaction-'));
  const first = path.join(temp, 'first.txt');
  const second = path.join(temp, 'second.txt');
  fs.writeFileSync(first, 'first-original');
  fs.writeFileSync(second, 'second-original');

  let verifierFailed = false;
  try {
    transactionalWriteFilesSync([
      { path: first, content: 'first-new' },
      { path: second, content: 'second-new' },
    ], () => { throw new Error('verification failed'); });
  } catch {
    verifierFailed = true;
  }
  assert(verifierFailed, 'verifier failure should propagate');
  assert(fs.readFileSync(first, 'utf8') === 'first-original', 'verifier failure should preserve first file');
  assert(fs.readFileSync(second, 'utf8') === 'second-original', 'verifier failure should preserve second file');

  const originalRename = fs.renameSync;
  let injectedFailure = false;
  fs.renameSync = function failSecondCommit(source, target) {
    if (!injectedFailure && target === second && source.includes('.claude-enhance-')) {
      injectedFailure = true;
      throw new Error('injected second commit failure');
    }
    return originalRename.call(fs, source, target);
  };
  try {
    transactionalWriteFilesSync([
      { path: first, content: 'first-new' },
      { path: second, content: 'second-new' },
    ]);
    throw new Error('partial commit failure did not propagate');
  } catch (error) {
    assert(error.message.includes('injected second commit failure'), 'expected injected commit failure');
  } finally {
    fs.renameSync = originalRename;
  }
  assert(fs.readFileSync(first, 'utf8') === 'first-original', 'partial commit should roll back first file');
  assert(fs.readFileSync(second, 'utf8') === 'second-original', 'partial commit should preserve second file');
  assert(!fs.readdirSync(temp).some((name) => name.endsWith('.tmp')), 'transaction should remove temporary files');
}

function createClaudeFixture(version = '9.9.9') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-enhance-architecture-'));
  const webview = path.join(root, 'webview');
  fs.mkdirSync(webview);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(webview, 'index.js'), `${retentionDeclaration}\n${markdownCall}`);
  fs.writeFileSync(path.join(webview, 'index.css'), '/* pristine */');
  return root;
}

function testConfigurationAndBackups() {
  const fixture = createClaudeFixture();
  const firstOptions = { runtimeConfig: { fullTranscript: false, contentScale: 1 } };
  assert(extension.applyPatch(fixture, path.join(projectRoot, 'vendor'), firstOptions), 'fixture should patch');
  let patched = fs.readFileSync(path.join(fixture, 'webview', 'index.js'), 'utf8');
  assert(!patched.includes(extension.FULL_TRANSCRIPT_MARKER), 'fullTranscript=false should preserve retention in patched fixture');
  const firstHash = extension.getPatchedConfigHash(fixture);

  const secondOptions = { runtimeConfig: { fullTranscript: true, contentScale: 1.25 } };
  assert(extension.ensurePatched(fixture, path.join(projectRoot, 'vendor'), secondOptions) === 'refreshed', 'config change should refresh patch');
  const secondHash = extension.getPatchedConfigHash(fixture);
  assert(firstHash !== secondHash, 'config refresh should change config hash');
  assert(extension.ensurePatched(fixture, path.join(projectRoot, 'vendor'), secondOptions) === 'current', 'same config should be current');
  patched = fs.readFileSync(path.join(fixture, 'webview', 'index.js'), 'utf8');
  assert(patched.includes(extension.FULL_TRANSCRIPT_MARKER), 'fullTranscript=true should transform retention after refresh');

  const mismatchFixture = createClaudeFixture('8.8.8');
  assert(extension.applyPatch(mismatchFixture, path.join(projectRoot, 'vendor')), 'mismatch fixture should patch');
  fs.appendFileSync(path.join(mismatchFixture, 'webview', 'index.js.katex-bak'), '\n/* changed */');
  assert(!extension.canRestoreOriginals(mismatchFixture), 'backup hash mismatch should block restore');
  assert(extension.removePatch(mismatchFixture) === false, 'invalid backup should not be restored');

  const partialFixture = createClaudeFixture('7.7.7');
  assert(extension.applyPatch(partialFixture, path.join(projectRoot, 'vendor')), 'partial fixture should patch');
  fs.copyFileSync(
    path.join(partialFixture, 'webview', 'index.css.katex-bak'),
    path.join(partialFixture, 'webview', 'index.css')
  );
  assert(extension.getPatchState(partialFixture) === 'partial', 'one-sided patch should be detected');
  assert(extension.ensurePatched(partialFixture, path.join(projectRoot, 'vendor')) === 'refreshed', 'verified partial patch should recover');
  assert(extension.getPatchState(partialFixture) === 'patched', 'partial recovery should restore both patch files');

  const updateFixture = createClaudeFixture('6.6.6');
  assert(extension.applyPatch(updateFixture, path.join(projectRoot, 'vendor')), 'update fixture should patch');
  assert(extension.removePatch(updateFixture), 'update fixture should restore before simulated update');
  fs.writeFileSync(path.join(updateFixture, 'package.json'), JSON.stringify({ version: '6.6.7' }));
  fs.appendFileSync(path.join(updateFixture, 'webview', 'index.js'), '\n/* updated Claude bundle */');
  fs.writeFileSync(path.join(updateFixture, 'webview', 'index.css'), '/* updated pristine css */');
  assert(extension.applyPatch(updateFixture, path.join(projectRoot, 'vendor')), 'in-place Claude update should rotate backups');
  const updatedMetadata = extension.backupMetadata(updateFixture);
  assert(updatedMetadata.claudeVersion === '6.6.7', 'rotated backup should record new Claude version');
  assert(
    fs.readFileSync(path.join(updateFixture, 'webview', 'index.js.katex-bak'), 'utf8').includes('updated Claude bundle'),
    'rotated JavaScript backup should match updated Claude bundle'
  );
}

function testUninstallRestore() {
  const fixture = createClaudeFixture('5.5.5');
  const pristineJs = fs.readFileSync(path.join(fixture, 'webview', 'index.js'), 'utf8');
  const pristineCss = fs.readFileSync(path.join(fixture, 'webview', 'index.css'), 'utf8');
  assert(extension.applyPatch(fixture, path.join(projectRoot, 'vendor')), 'uninstall fixture should patch');
  const restored = uninstall.restoreClaudeCode(fixture);
  assert(restored.restored, 'uninstall should restore verified backups');
  assert(fs.readFileSync(path.join(fixture, 'webview', 'index.js'), 'utf8') === pristineJs, 'uninstall should restore JavaScript');
  assert(fs.readFileSync(path.join(fixture, 'webview', 'index.css'), 'utf8') === pristineCss, 'uninstall should restore CSS');
  assert(!fs.existsSync(path.join(fixture, 'webview', 'index.js.katex-bak')), 'uninstall should remove consumed backups');

  const tampered = createClaudeFixture('5.5.6');
  assert(extension.applyPatch(tampered, path.join(projectRoot, 'vendor')), 'tampered uninstall fixture should patch');
  fs.appendFileSync(path.join(tampered, 'webview', 'index.css.katex-bak'), '\n/* tampered */');
  const skipped = uninstall.restoreClaudeCode(tampered);
  assert(!skipped.restored && skipped.reason === 'backup-verification-failed', 'uninstall should reject tampered backups');
  assert(extension.getPatchState(tampered) === 'patched', 'rejected uninstall should leave the working patch intact');

  const versions = [
    { parts: uninstall.versionParts('2.1.99'), mtimeMs: 3 },
    { parts: uninstall.versionParts('2.1.234'), mtimeMs: 1 },
    { parts: uninstall.versionParts('2.1.153'), mtimeMs: 2 },
  ].sort(uninstall.compareVersionDescending);
  assert(versions[0].parts[2] === 234, 'uninstall discovery should compare Claude versions numerically');
}

function installedClaudeBundles() {
  const roots = [
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
  ];
  const bundles = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('anthropic.claude-code-')) continue;
      const webview = path.join(root, name, 'webview');
      const backup = path.join(webview, 'index.js.katex-bak');
      const source = fs.existsSync(backup) ? backup : path.join(webview, 'index.js');
      if (fs.existsSync(source)) bundles.push({ name, source });
    }
  }
  return bundles;
}

function testInstalledCompatibility() {
  for (const bundle of installedClaudeBundles()) {
    const transformed = transformClaudeBundle(fs.readFileSync(bundle.source, 'utf8'));
    assert(transformed.ok, `installed Claude bundle should be compatible: ${bundle.name} (${transformed.reason})`);
    assert(transformed.diagnostics.markdownTargets === 1, `installed Claude bundle should have one Markdown target: ${bundle.name}`);
  }
}

testStructuralTransforms();
testScheduler();
testTransactions();
testConfigurationAndBackups();
testUninstallRestore();
testInstalledCompatibility();
console.log(`architecture regression passed (${installedClaudeBundles().length} installed Claude versions)`);
