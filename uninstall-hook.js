'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { workerPolicyRestoreEntries, cleanupWorkerPolicy } = require('./lib/worker-policy');
const { validateBundleSyntax } = require('./lib/bundle-transform');
const {
  readJsonFile,
  sha256,
  transactionalWriteFilesSync,
  withFileLockSync,
} = require('./lib/file-transaction');

const PATCH_MARKER = '/* === KaTeX LaTeX Rendering Patch === */';
const PATCH_CSS_MARKER = '/* === KaTeX LaTeX Rendering CSS Patch === */';
const BACKUP_METADATA_FILE = '.claude-enhance-backup.json';
const PATCH_SCHEMA_VERSION = 2;
const PATCH_FONTS_DIRECTORY = 'claude-enhance-fonts';
const PATCH_LOCK_FILE = '.claude-enhance.lock';

function versionParts(version) {
  return String(version || '0').split('.').map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

function compareVersionDescending(a, b) {
  for (let i = 0; i < 4; i++) {
    const difference = (b.parts[i] || 0) - (a.parts[i] || 0);
    if (difference) return difference;
  }
  return b.mtimeMs - a.mtimeMs;
}

function extensionVersion(extDir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return name.replace(/^anthropic\.claude-code-/, '') || 'unknown';
  }
}

function extensionSearchDirs() {
  const searchDirs = [
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
    path.join(os.homedir(), '.local', 'share', 'code-server', 'extensions'),
    path.join(os.homedir(), '.local', 'share', 'openvscode-server', 'extensions'),
  ];
  if (process.env.VSCODE_EXTENSIONS) {
    searchDirs.unshift(...String(process.env.VSCODE_EXTENSIONS).split(path.delimiter).filter(Boolean));
  }
  return Array.from(new Set(searchDirs.map((directory) => path.resolve(directory))));
}

function findClaudeCodeDirs() {
  const candidates = [];
  const seen = new Set();
  for (const base of extensionSearchDirs()) {
    try {
      for (const name of fs.readdirSync(base)) {
        if (!name.startsWith('anthropic.claude-code-')) continue;
        const extDir = path.join(base, name);
        const stat = fs.statSync(extDir);
        if (!stat.isDirectory()) continue;
        let canonical = path.resolve(extDir);
        try { canonical = fs.realpathSync.native(canonical); } catch {}
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const version = extensionVersion(extDir, name);
        candidates.push({
          extDir,
          parts: versionParts(version),
          mtimeMs: stat.mtimeMs,
        });
      }
    } catch {}
  }
  return candidates.sort(compareVersionDescending).map((candidate) => candidate.extDir);
}

function findClaudeCodeDir() {
  return findClaudeCodeDirs()[0] || null;
}

function restorePaths(extDir) {
  const webview = path.join(extDir, 'webview');
  return {
    webview,
    js: path.join(webview, 'index.js'),
    css: path.join(webview, 'index.css'),
    jsBackup: path.join(webview, 'index.js.katex-bak'),
    cssBackup: path.join(webview, 'index.css.katex-bak'),
    metadata: path.join(webview, BACKUP_METADATA_FILE),
    fonts: path.join(webview, PATCH_FONTS_DIRECTORY),
    worker: path.join(webview, 'claude-enhance-worker.js'),
    lock: path.join(webview, PATCH_LOCK_FILE),
  };
}

function verifiedBackups(extDir, paths = restorePaths(extDir)) {
  if (!fs.existsSync(paths.jsBackup) || !fs.existsSync(paths.cssBackup)) return null;
  const js = fs.readFileSync(paths.jsBackup);
  const css = fs.readFileSync(paths.cssBackup);
  if (js.includes(Buffer.from(PATCH_MARKER)) || css.includes(Buffer.from(PATCH_CSS_MARKER))) return null;

  const metadata = readJsonFile(paths.metadata);
  if (!metadata) return null;
  if (metadata.schemaVersion !== PATCH_SCHEMA_VERSION ||
      metadata.jsSha256 !== sha256(js) || metadata.cssSha256 !== sha256(css)) return null;
  const currentVersion = extensionVersion(extDir, path.basename(extDir));
  if (metadata.claudeVersion !== 'unknown' && currentVersion !== 'unknown' &&
      metadata.claudeVersion !== currentVersion) return null;
  return { js, css, metadata };
}

function currentFilesAllowRestore(paths, backups) {
  try {
    const currentJs = fs.readFileSync(paths.js);
    const currentCss = fs.readFileSync(paths.css);
    const jsPatched = currentJs.includes(Buffer.from(PATCH_MARKER));
    const cssPatched = currentCss.includes(Buffer.from(PATCH_CSS_MARKER));
    if (jsPatched && cssPatched) return true;
    if (jsPatched !== cssPatched) {
      if (!jsPatched && sha256(currentJs) !== backups.metadata.jsSha256) return false;
      if (!cssPatched && sha256(currentCss) !== backups.metadata.cssSha256) return false;
      return true;
    }
    return sha256(currentJs) === backups.metadata.jsSha256 &&
      sha256(currentCss) === backups.metadata.cssSha256;
  } catch {
    return false;
  }
}

function restoreClaudeCode(extDir) {
  if (!extDir) return { restored: false, reason: 'claude-not-found' };
  const paths = restorePaths(extDir);
  if (!fs.existsSync(paths.webview)) {
    return { restored: false, reason: 'backup-verification-failed' };
  }
  return withFileLockSync(paths.lock, () => {
    const policyRestore = workerPolicyRestoreEntries(extDir);
    const hasJsBackup = fs.existsSync(paths.jsBackup);
    const hasCssBackup = fs.existsSync(paths.cssBackup);
    if (!hasJsBackup && !hasCssBackup) {
      let patched = false;
      try {
        patched = fs.readFileSync(paths.js).includes(Buffer.from(PATCH_MARKER)) ||
          fs.readFileSync(paths.css).includes(Buffer.from(PATCH_CSS_MARKER));
      } catch {}
      if (patched) return { restored: false, reason: 'backup-verification-failed' };
      if (policyRestore.length) transactionalWriteFilesSync(policyRestore);
      cleanupWorkerPolicy(extDir);
      fs.rmSync(paths.metadata, { force: true });
      fs.rmSync(paths.fonts, { recursive: true, force: true });
      fs.rmSync(paths.worker, { force: true });
      return { restored: false, reason: 'not-patched' };
    }
    const backups = verifiedBackups(extDir, paths);
    if (!backups) return { restored: false, reason: 'backup-verification-failed' };
    if (!currentFilesAllowRestore(paths, backups)) {
      return { restored: false, reason: 'current-files-changed' };
    }

    transactionalWriteFilesSync([
      { path: paths.js, content: backups.js },
      { path: paths.css, content: backups.css },
      ...policyRestore,
    ], (temporaryFiles) => {
      const js = fs.readFileSync(temporaryFiles.get(paths.js), 'utf8');
      const css = fs.readFileSync(temporaryFiles.get(paths.css), 'utf8');
      if (js.includes(PATCH_MARKER) || css.includes(PATCH_CSS_MARKER)) {
        throw new Error('Claude Code uninstall restore found enhancement markers in backups.');
      }
      validateBundleSyntax(js, temporaryFiles.get(paths.js));
    });

    fs.rmSync(paths.jsBackup, { force: true });
    fs.rmSync(paths.cssBackup, { force: true });
    fs.rmSync(paths.metadata, { force: true });
    if (fs.existsSync(paths.fonts)) fs.rmSync(paths.fonts, { recursive: true });
    fs.rmSync(paths.worker, { force: true });
    cleanupWorkerPolicy(extDir);
    return { restored: true, reason: 'restored' };
  });
}

function restoreAllClaudeCode(directories = findClaudeCodeDirs()) {
  return directories.map((extDir) => {
    try {
      return { extDir, ...restoreClaudeCode(extDir) };
    } catch (error) {
      return {
        extDir,
        restored: false,
        reason: 'restore-error',
        error: String(error.message || error),
      };
    }
  });
}

if (require.main === module) {
  const explicitDirectory = process.argv[2];
  const results = restoreAllClaudeCode(explicitDirectory ? [explicitDirectory] : undefined);
  for (const result of results) {
    if (!result.restored && !['claude-not-found', 'not-patched'].includes(result.reason)) {
      const detail = result.error ? ` (${result.error})` : '';
      console.warn(`[Claude Code Enhance] Uninstall restore skipped for ${result.extDir}: ${result.reason}${detail}`);
    }
  }
}

module.exports = {
  compareVersionDescending,
  extensionSearchDirs,
  findClaudeCodeDir,
  findClaudeCodeDirs,
  restoreAllClaudeCode,
  restoreClaudeCode,
  restorePaths,
  currentFilesAllowRestore,
  verifiedBackups,
  versionParts,
};
