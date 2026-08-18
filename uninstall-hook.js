'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateBundleSyntax } = require('./lib/bundle-transform');
const {
  readJsonFile,
  sha256,
  transactionalWriteFilesSync,
} = require('./lib/file-transaction');

const PATCH_MARKER = '/* === KaTeX LaTeX Rendering Patch === */';
const PATCH_CSS_MARKER = '/* === KaTeX LaTeX Rendering CSS Patch === */';
const BACKUP_METADATA_FILE = '.claude-enhance-backup.json';
const PATCH_SCHEMA_VERSION = 2;

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

function findClaudeCodeDir() {
  const searchDirs = [
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
  ];
  const candidates = [];
  for (const base of searchDirs) {
    try {
      for (const name of fs.readdirSync(base)) {
        if (!name.startsWith('anthropic.claude-code-')) continue;
        const extDir = path.join(base, name);
        const version = extensionVersion(extDir, name);
        candidates.push({
          extDir,
          parts: versionParts(version),
          mtimeMs: fs.statSync(extDir).mtimeMs,
        });
      }
    } catch {}
  }
  return candidates.sort(compareVersionDescending)[0]?.extDir || null;
}

function restorePaths(extDir) {
  const webview = path.join(extDir, 'webview');
  return {
    js: path.join(webview, 'index.js'),
    css: path.join(webview, 'index.css'),
    jsBackup: path.join(webview, 'index.js.katex-bak'),
    cssBackup: path.join(webview, 'index.css.katex-bak'),
    metadata: path.join(webview, BACKUP_METADATA_FILE),
    fonts: path.join(webview, 'fonts'),
  };
}

function verifiedBackups(extDir, paths = restorePaths(extDir)) {
  if (!fs.existsSync(paths.jsBackup) || !fs.existsSync(paths.cssBackup)) return null;
  const js = fs.readFileSync(paths.jsBackup);
  const css = fs.readFileSync(paths.cssBackup);
  if (js.includes(Buffer.from(PATCH_MARKER)) || css.includes(Buffer.from(PATCH_CSS_MARKER))) return null;

  const metadata = readJsonFile(paths.metadata);
  if (!metadata) return { js, css, metadata: null };
  if (metadata.schemaVersion !== PATCH_SCHEMA_VERSION ||
      metadata.jsSha256 !== sha256(js) || metadata.cssSha256 !== sha256(css)) return null;
  const currentVersion = extensionVersion(extDir, path.basename(extDir));
  if (metadata.claudeVersion !== 'unknown' && currentVersion !== 'unknown' &&
      metadata.claudeVersion !== currentVersion) return null;
  return { js, css, metadata };
}

function restoreClaudeCode(extDir) {
  if (!extDir) return { restored: false, reason: 'claude-not-found' };
  const paths = restorePaths(extDir);
  const backups = verifiedBackups(extDir, paths);
  if (!backups) return { restored: false, reason: 'backup-verification-failed' };

  transactionalWriteFilesSync([
    { path: paths.js, content: backups.js },
    { path: paths.css, content: backups.css },
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
  return { restored: true, reason: 'restored' };
}

if (require.main === module) {
  const result = restoreClaudeCode(process.argv[2] || findClaudeCodeDir());
  if (!result.restored && result.reason !== 'claude-not-found') {
    console.warn(`[Claude Code Enhance] Uninstall restore skipped: ${result.reason}`);
  }
}

module.exports = {
  compareVersionDescending,
  findClaudeCodeDir,
  restoreClaudeCode,
  restorePaths,
  verifiedBackups,
  versionParts,
};
