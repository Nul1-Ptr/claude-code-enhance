const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  findMarkdownRenderTargets,
  findMessageRetentionTargets,
  parseBundle,
  patchMessageRetentionCap: patchRetentionStructurally,
  transformClaudeBundle,
  validateBundleSyntax,
} = require('./lib/bundle-transform');
const {
  atomicWriteFileSync,
  readJsonFile,
  sha256,
  transactionalWriteFilesSync,
} = require('./lib/file-transaction');

const PATCH_MARKER = '/* === KaTeX LaTeX Rendering Patch === */';
const PATCH_CSS_MARKER = '/* === KaTeX LaTeX Rendering CSS Patch === */';

// This extension's own version. It is stamped into the patch (right after
// PATCH_MARKER) so a newer build can recognize "patched, but by an older
// build" and refresh the injected code instead of leaving it stale.
const EXTENSION_VERSION = require('./package.json').version;
// Version-agnostic prefix of the stamp line: `/* katex-ext-version: X.Y.Z */`.
// Patches from builds <= 1.9.0 have no stamp at all (getPatchedVersion -> null).
const PATCH_VERSION_PREFIX = '/* katex-ext-version: ';
// Internal patch revision. Changing this forces a refresh even when the
// package version is unchanged.
const PATCH_BUILD_ID = 'structural-transactional-incremental-runtime-2026-08-18.3';
const PATCH_BUILD_PREFIX = '/* enhance-patch-build: ';
const PATCH_CONFIG_PREFIX = '/* enhance-patch-config: ';
const FULL_TRANSCRIPT_MARKER = 'claude-code-enhance-full-transcript';
const BACKUP_METADATA_FILE = '.claude-enhance-backup.json';
const PATCH_SCHEMA_VERSION = 2;

const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  fullTranscript: true,
  contentScale: 1.1,
  mathScale: 1.0,
  toolOutputMath: true,
  syntaxHighlighting: true,
  copyButtons: true,
  apiErrorCards: true,
});

// Where users report a Claude Code build the patch no longer fits.
const ISSUES_URL = 'https://github.com/MahammadNuriyev62/claude-code-enhance/issues';

function finiteSetting(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizePatchOptions(options = {}) {
  const supplied = options.runtimeConfig || {};
  const runtimeConfig = {
    fullTranscript: options.fullTranscript ?? supplied.fullTranscript ?? DEFAULT_RUNTIME_CONFIG.fullTranscript,
    contentScale: finiteSetting(supplied.contentScale, DEFAULT_RUNTIME_CONFIG.contentScale, 0.8, 1.5),
    mathScale: finiteSetting(supplied.mathScale, DEFAULT_RUNTIME_CONFIG.mathScale, 0.8, 1.6),
    toolOutputMath: supplied.toolOutputMath ?? DEFAULT_RUNTIME_CONFIG.toolOutputMath,
    syntaxHighlighting: supplied.syntaxHighlighting ?? DEFAULT_RUNTIME_CONFIG.syntaxHighlighting,
    copyButtons: supplied.copyButtons ?? DEFAULT_RUNTIME_CONFIG.copyButtons,
    apiErrorCards: supplied.apiErrorCards ?? DEFAULT_RUNTIME_CONFIG.apiErrorCards,
  };
  Object.keys(runtimeConfig).forEach((key) => {
    if (key !== 'contentScale' && key !== 'mathScale') runtimeConfig[key] = !!runtimeConfig[key];
  });
  return { fullTranscript: runtimeConfig.fullTranscript, runtimeConfig };
}

function readPatchOptions() {
  const config = vscode.workspace?.getConfiguration?.('claudeCodeEnhance');
  const get = (key) => config?.get?.(key, DEFAULT_RUNTIME_CONFIG[key]) ?? DEFAULT_RUNTIME_CONFIG[key];
  return normalizePatchOptions({
    runtimeConfig: {
      fullTranscript: get('fullTranscript'),
      contentScale: get('contentScale'),
      mathScale: get('mathScale'),
      toolOutputMath: get('toolOutputMath'),
      syntaxHighlighting: get('syntaxHighlighting'),
      copyButtons: get('copyButtons'),
      apiErrorCards: get('apiErrorCards'),
    },
  });
}

function patchConfigHash(options = {}) {
  return sha256(JSON.stringify(normalizePatchOptions(options).runtimeConfig)).slice(0, 16);
}

function patchMessageRetentionCap(body) {
  return patchRetentionStructurally(body, FULL_TRANSCRIPT_MARKER);
}

function findClaudeCodeExtDir() {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  return ext ? ext.extensionPath : null;
}

function getPatchState(extDir) {
  try {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const css = fs.readFileSync(path.join(extDir, 'webview', 'index.css'), 'utf8');
    const jsPatched = js.includes(PATCH_MARKER);
    const cssPatched = css.includes(PATCH_CSS_MARKER);
    if (jsPatched && cssPatched) return 'patched';
    if (jsPatched || cssPatched) return 'partial';
    return 'unpatched';
  } catch {
    return 'unavailable';
  }
}

function isPatched(extDir) {
  return getPatchState(extDir) === 'patched';
}

// Reads the extension version stamped into the patch. Returns the version
// string, or null when the webview is unpatched or carries a patch from a
// pre-versioning build (<= 1.9.0, which wrote no stamp).
function getPatchedVersion(extDir) {
  try {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const start = js.indexOf(PATCH_VERSION_PREFIX);
    if (start === -1) return null;
    const rest = js.slice(start + PATCH_VERSION_PREFIX.length);
    const end = rest.indexOf(' */');
    if (end === -1) return null;
    return rest.slice(0, end).trim();
  } catch {
    return null;
  }
}

function getPatchedBuildId(extDir) {
  try {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const start = js.indexOf(PATCH_BUILD_PREFIX);
    if (start === -1) return null;
    const rest = js.slice(start + PATCH_BUILD_PREFIX.length);
    const end = rest.indexOf(' */');
    if (end === -1) return null;
    return rest.slice(0, end).trim();
  } catch {
    return null;
  }
}

function getPatchedConfigHash(extDir) {
  try {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const start = js.indexOf(PATCH_CONFIG_PREFIX);
    if (start === -1) return null;
    const rest = js.slice(start + PATCH_CONFIG_PREFIX.length);
    const end = rest.indexOf(' */');
    return end === -1 ? null : rest.slice(0, end).trim();
  } catch {
    return null;
  }
}

function getClaudeCodeVersion(extDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function patchPaths(extDir) {
  const webviewDir = path.join(extDir, 'webview');
  return {
    webviewDir,
    jsPath: path.join(webviewDir, 'index.js'),
    cssPath: path.join(webviewDir, 'index.css'),
    jsBackup: path.join(webviewDir, 'index.js.katex-bak'),
    cssBackup: path.join(webviewDir, 'index.css.katex-bak'),
    metadataPath: path.join(webviewDir, BACKUP_METADATA_FILE),
  };
}

function backupMetadata(extDir, paths = patchPaths(extDir)) {
  const metadata = readJsonFile(paths.metadataPath);
  return metadata?.schemaVersion === PATCH_SCHEMA_VERSION ? metadata : null;
}

function ensureBackupFiles(extDir, originalJs, originalCss) {
  const paths = patchPaths(extDir);
  const originalJsBuffer = Buffer.from(originalJs);
  const originalCssBuffer = Buffer.from(originalCss);
  const existing = backupMetadata(extDir, paths);
  const currentVersion = getClaudeCodeVersion(extDir);
  const hasBothBackups = fs.existsSync(paths.jsBackup) && fs.existsSync(paths.cssBackup);
  let backupJs = hasBothBackups ? fs.readFileSync(paths.jsBackup) : null;
  let backupCss = hasBothBackups ? fs.readFileSync(paths.cssBackup) : null;

  if (backupJs?.includes(Buffer.from(PATCH_MARKER)) || backupCss?.includes(Buffer.from(PATCH_CSS_MARKER))) {
    throw new Error('Refusing to use a patched file as an original Claude Code backup.');
  }
  if (existing && hasBothBackups &&
      (existing.jsSha256 !== sha256(backupJs) || existing.cssSha256 !== sha256(backupCss))) {
    throw new Error('Claude Code backup metadata does not match the backup files.');
  }

  const versionChanged = existing && existing.claudeVersion !== 'unknown' && currentVersion !== 'unknown' &&
    existing.claudeVersion !== currentVersion;
  if (!existing && hasBothBackups &&
      (sha256(backupJs) !== sha256(originalJsBuffer) || sha256(backupCss) !== sha256(originalCssBuffer))) {
    throw new Error('Legacy Claude Code backups do not match the current pristine webview files.');
  }

  const replaceBackups = !hasBothBackups || versionChanged;
  const metadata = replaceBackups || !existing ? {
    schemaVersion: PATCH_SCHEMA_VERSION,
    claudeVersion: currentVersion,
    jsSha256: sha256(originalJsBuffer),
    cssSha256: sha256(originalCssBuffer),
    createdAt: new Date().toISOString(),
  } : existing;

  if (replaceBackups) {
    transactionalWriteFilesSync([
      { path: paths.jsBackup, content: originalJsBuffer },
      { path: paths.cssBackup, content: originalCssBuffer },
      { path: paths.metadataPath, content: JSON.stringify(metadata, null, 2) + '\n' },
    ], (temporaryFiles) => {
      const temporaryJs = fs.readFileSync(temporaryFiles.get(paths.jsBackup));
      const temporaryCss = fs.readFileSync(temporaryFiles.get(paths.cssBackup));
      if (temporaryJs.includes(Buffer.from(PATCH_MARKER)) || temporaryCss.includes(Buffer.from(PATCH_CSS_MARKER)) ||
          sha256(temporaryJs) !== metadata.jsSha256 || sha256(temporaryCss) !== metadata.cssSha256) {
        throw new Error('Claude Code backup transaction failed verification.');
      }
      validateBundleSyntax(temporaryJs.toString('utf8'), temporaryFiles.get(paths.jsBackup));
    });
    backupJs = originalJsBuffer;
    backupCss = originalCssBuffer;
  } else if (!existing) {
    atomicWriteFileSync(paths.metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  }
  return { paths, metadata };
}

let lastPatchDiagnostics = null;

function inspectCompatibility(extDir, options = {}) {
  const paths = patchPaths(extDir);
  const sourcePath = getPatchState(extDir) !== 'unpatched' && fs.existsSync(paths.jsBackup)
    ? paths.jsBackup
    : paths.jsPath;
  try {
    const normalizedOptions = normalizePatchOptions(options);
    const transformed = transformClaudeBundle(fs.readFileSync(sourcePath, 'utf8'), {
      fullTranscript: normalizedOptions.fullTranscript,
      fullTranscriptMarker: FULL_TRANSCRIPT_MARKER,
    });
    return {
      supported: transformed.ok,
      reason: transformed.reason,
      claudeVersion: getClaudeCodeVersion(extDir),
      sourcePath,
      ...transformed.diagnostics,
    };
  } catch (error) {
    return {
      supported: false,
      reason: 'compatibility-check-error',
      claudeVersion: getClaudeCodeVersion(extDir),
      sourcePath,
      error: String(error.message || error),
    };
  }
}

function buildCssPatch(katexCss, highlightCss) {
  return `
${PATCH_CSS_MARKER}
${katexCss}
${highlightCss}
.katex-display {
  display: block !important;
  width: 100% !important;
  min-width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box;
  clear: both;
  margin: 1.2em 0 !important;
  overflow-x: auto;
  overflow-y: hidden;
  min-height: 48px;
  padding: 14px 18px !important;
  border-radius: 12px !important;
  border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, rgba(127, 127, 127, 0.32))) !important;
  background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background, var(--vscode-input-background, rgba(127, 127, 127, 0.10)))) !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18) !important;
  text-align: center;
  -webkit-overflow-scrolling: touch;
  scrollbar-gutter: stable both-edges;
}
.katex-display > .katex {
  display: inline-block;
  font-size: 1.6em !important;
  line-height: 1.6;
  text-align: initial;
  white-space: normal;
}
.katex {
  font-size: 1.1em;
}
/* === End KaTeX CSS Patch === */`;
}

// Patches Claude Code's webview to render math through its own react-markdown
// pipeline. Returns true if patched, or false if the react-markdown injection
// point was not found (a future Claude Code reshaped its bundle) — in which
// case nothing on disk is touched and the caller surfaces an "unsupported"
// message.
function applyPatch(extDir, vendorDir, options = {}) {
  const paths = patchPaths(extDir);
  const body = fs.readFileSync(paths.jsPath, 'utf8');
  const originalCss = fs.readFileSync(paths.cssPath, 'utf8');
  if (body.includes(PATCH_MARKER) || originalCss.includes(PATCH_CSS_MARKER)) return false;

  const normalizedOptions = normalizePatchOptions(options);
  const transformed = transformClaudeBundle(body, {
    fullTranscript: normalizedOptions.fullTranscript,
    fullTranscriptMarker: FULL_TRANSCRIPT_MARKER,
  });
  lastPatchDiagnostics = {
    supported: transformed.ok,
    reason: transformed.reason,
    claudeVersion: getClaudeCodeVersion(extDir),
    ...transformed.diagnostics,
  };
  if (!transformed.ok) return false;

  ensureBackupFiles(extDir, body, originalCss);

  // Copy KaTeX fonts
  const fontsTarget = path.join(paths.webviewDir, 'fonts');
  const fontsSrc = path.join(vendorDir, 'fonts');
  fs.mkdirSync(fontsTarget, { recursive: true });
  for (const font of fs.readdirSync(fontsSrc)) {
    fs.copyFileSync(path.join(fontsSrc, font), path.join(fontsTarget, font));
  }

  // Patch index.js — inject remark-math + rehype-katex into Claude Code's
  // react-markdown call, then prepend KaTeX core, Highlight.js, the
  // remark-math bundle, and the preview enhancer.
  // remark-math tokenizes $...$ / $$...$$ during micromark parsing, capturing
  // the LaTeX verbatim BEFORE CommonMark's characterEscape collapses `\\`
  // (matrix row separators) and before block parsing can mis-read a lone `=`
  // line as a setext heading. The injected plugin references are guarded on
  // window.__KATEX_V2_LOADED so that if the bundle ever fails to load, Claude
  // Code's markdown still renders normally. Prepended, not appended: Claude
  // Code mounts its React app at the end of the bundle, so window.__remarkMath
  // etc. must be defined before that runs.
  const katexCore = fs.readFileSync(path.join(vendorDir, 'katex.min.js'), 'utf8');
  const highlightCore = fs.readFileSync(path.join(vendorDir, 'highlight.min.js'), 'utf8');
  const v2Bundle = fs.readFileSync(path.join(vendorDir, 'remark-math-bundle.js'), 'utf8');
  const runtimeCore = fs.readFileSync(path.join(vendorDir, 'runtime-core.js'), 'utf8');
  const enhanceCode = fs.readFileSync(path.join(vendorDir, 'enhance.js'), 'utf8');
  const patchedJs =
    `${PATCH_MARKER}\n${PATCH_VERSION_PREFIX}${EXTENSION_VERSION} */\n` +
    `${PATCH_BUILD_PREFIX}${PATCH_BUILD_ID} */\n` +
    `${PATCH_CONFIG_PREFIX}${patchConfigHash(normalizedOptions)} */\n` +
    `window.__CLAUDE_ENHANCE_CONFIG__=Object.freeze(${JSON.stringify(normalizedOptions.runtimeConfig)});\n` +
    `/* KaTeX Core - MIT License - https://katex.org */\n${katexCore}\n` +
    `/* Highlight.js Core - BSD-3-Clause License - https://highlightjs.org */\n${highlightCore}\n` +
    `/* remark-math + rehype-katex pipeline */\n${v2Bundle}\n` +
    `/* Claude Code Enhance incremental runtime */\n${runtimeCore}\n` +
    `/* Claude Code output preview enhancer */\n${enhanceCode}\n` +
    `/* === End KaTeX/Enhance Patch — Claude Code bundle follows === */\n` +
    transformed.body;

  // Patch index.css — KaTeX and syntax-highlight styles
  const katexCss = fs.readFileSync(path.join(vendorDir, 'katex.min.css'), 'utf8');
  const highlightCss = fs.readFileSync(path.join(vendorDir, 'highlight-vs2015.min.css'), 'utf8');
  const cssPatch = buildCssPatch(katexCss, highlightCss);
  const patchedCss = originalCss + cssPatch;
  transactionalWriteFilesSync([
    { path: paths.jsPath, content: patchedJs },
    { path: paths.cssPath, content: patchedCss },
  ], (temporaryFiles) => {
    const temporaryJs = fs.readFileSync(temporaryFiles.get(paths.jsPath), 'utf8');
    const temporaryCss = fs.readFileSync(temporaryFiles.get(paths.cssPath), 'utf8');
    if (!temporaryJs.includes(PATCH_MARKER) || !temporaryJs.includes(PATCH_BUILD_ID) ||
        !temporaryJs.includes('__remarkMath') || !temporaryJs.includes('__rehypeKatex')) {
      throw new Error('Patched Claude Code JavaScript failed marker verification.');
    }
    if (!temporaryCss.includes(PATCH_CSS_MARKER)) {
      throw new Error('Patched Claude Code CSS failed marker verification.');
    }
    validateBundleSyntax(temporaryJs, temporaryFiles.get(paths.jsPath));
  });

  return true;
}

function removePatch(extDir) {
  const paths = patchPaths(extDir);
  if (!canRestoreOriginals(extDir)) return false;

  transactionalWriteFilesSync([
    { path: paths.jsPath, content: fs.readFileSync(paths.jsBackup) },
    { path: paths.cssPath, content: fs.readFileSync(paths.cssBackup) },
  ], (temporaryFiles) => {
    const restoredJs = fs.readFileSync(temporaryFiles.get(paths.jsPath), 'utf8');
    const restoredCss = fs.readFileSync(temporaryFiles.get(paths.cssPath), 'utf8');
    if (restoredJs.includes(PATCH_MARKER) || restoredCss.includes(PATCH_CSS_MARKER)) {
      throw new Error('Claude Code backup verification found enhancement markers.');
    }
    validateBundleSyntax(restoredJs, temporaryFiles.get(paths.jsPath));
  });

  const fontsDir = path.join(paths.webviewDir, 'fonts');
  if (fs.existsSync(fontsDir)) {
    fs.rmSync(fontsDir, { recursive: true });
  }
  return true;
}

// True only when the `.katex-bak` originals exist AND are themselves unpatched,
// so removePatch() would restore genuine pristine files. This guards the
// refresh path in ensurePatched(): we never treat an already-patched file as
// if it were the backup-able original.
function canRestoreOriginals(extDir) {
  const paths = patchPaths(extDir);
  try {
    if (!fs.existsSync(paths.jsBackup) || !fs.existsSync(paths.cssBackup)) return false;
    const backupJs = fs.readFileSync(paths.jsBackup);
    const backupCss = fs.readFileSync(paths.cssBackup);
    if (backupJs.includes(Buffer.from(PATCH_MARKER)) || backupCss.includes(Buffer.from(PATCH_CSS_MARKER))) {
      return false;
    }

    const metadata = backupMetadata(extDir, paths);
    if (!metadata) return true;
    if (metadata.jsSha256 !== sha256(backupJs) || metadata.cssSha256 !== sha256(backupCss)) return false;
    const currentClaudeVersion = getClaudeCodeVersion(extDir);
    if (metadata.claudeVersion !== 'unknown' && currentClaudeVersion !== 'unknown' &&
        metadata.claudeVersion !== currentClaudeVersion) return false;
    return true;
  } catch {
    return false;
  }
}

// Ensures Claude Code's webview carries THIS build's patch. Returns:
//   'fresh'       - was unpatched; patch applied
//   'refreshed'   - carried an older/unstamped patch; originals restored, re-patched
//   'current'     - already patched with this exact version; nothing done
//   'skipped'     - patch is stale but cannot be refreshed safely; left untouched
//   'unsupported' - the react-markdown injection point was not found
// May throw on filesystem errors from applyPatch/removePatch; callers handle.
function ensurePatched(extDir, vendorDir, options = {}) {
  const normalizedOptions = normalizePatchOptions(options);
  const patchState = getPatchState(extDir);
  if (patchState === 'partial') {
    if (!canRestoreOriginals(extDir)) return 'skipped';
    removePatch(extDir);
    if (getPatchState(extDir) !== 'unpatched') return 'skipped';
    return applyPatch(extDir, vendorDir, normalizedOptions) ? 'refreshed' : 'unsupported';
  }
  if (patchState === 'unpatched') {
    return applyPatch(extDir, vendorDir, normalizedOptions) ? 'fresh' : 'unsupported';
  }
  if (patchState === 'unavailable') return 'unsupported';
  if (getPatchedVersion(extDir) === EXTENSION_VERSION &&
      getPatchedBuildId(extDir) === PATCH_BUILD_ID &&
      getPatchedConfigHash(extDir) === patchConfigHash(normalizedOptions)) {
    return 'current';
  }
  // A patch from an older (or pre-versioning) build is present. Refresh it so
  // the injected code matches this build — but only if the pristine originals
  // can be safely restored first.
  if (!canRestoreOriginals(extDir)) {
    console.warn('[Claude Code Enhance] Webview carries a stale patch but the original backup is missing or invalid; leaving the existing patch in place.');
    return 'skipped';
  }
  removePatch(extDir);
  if (isPatched(extDir)) {
    console.error('[Claude Code Enhance] Restore did not clear the old patch; not re-applying.');
    return 'skipped';
  }
  return applyPatch(extDir, vendorDir, normalizedOptions) ? 'refreshed' : 'unsupported';
}

// Reloads the Claude Code webview so an on-disk patch change takes effect
// immediately. A webview reload re-fetches the patched bundle; a full window
// reload is not required. The notification keeps manual fallbacks for the rare
// case the auto-reload did not take.
function reloadWebviewAndNotify(message) {
  vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
  vscode.window
    .showInformationMessage(message, 'Reload Webview', 'Reload Window')
    .then(function(choice) {
      if (choice === 'Reload Webview') {
        vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
      } else if (choice === 'Reload Window') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
}

// Shown when applyPatch reports the react-markdown injection point is gone
// (a Claude Code update reshaped its bundle). The patch is NOT applied, so
// Claude Code keeps working — just without math rendering — and the user is
// pointed at an extension update or the issue tracker.
function notifyUnsupported() {
  vscode.window
    .showWarningMessage(
      'Claude Code Enhance could not apply its patch — this version of Claude Code changed its internals. ' +
      'Update the extension if an update is available; if there is no update yet, please report it so it can be fixed.',
      'Check for Updates',
      'Report an Issue'
    )
    .then(function(choice) {
      if (choice === 'Check for Updates') {
        vscode.commands.executeCommand('workbench.extensions.action.checkForUpdates');
      } else if (choice === 'Report an Issue') {
        vscode.env.openExternal(vscode.Uri.parse(ISSUES_URL));
      }
    });
}

function collectDiagnostics(extDir, options = readPatchOptions()) {
  if (!extDir) {
    return { extensionVersion: EXTENSION_VERSION, claudeFound: false };
  }
  const paths = patchPaths(extDir);
  const normalizedOptions = normalizePatchOptions(options);
  return {
    extensionVersion: EXTENSION_VERSION,
    buildId: PATCH_BUILD_ID,
    claudeFound: true,
    claudeVersion: getClaudeCodeVersion(extDir),
    extensionPath: extDir,
    patched: isPatched(extDir),
    patchState: getPatchState(extDir),
    patchedVersion: getPatchedVersion(extDir),
    patchedBuildId: getPatchedBuildId(extDir),
    patchedConfigHash: getPatchedConfigHash(extDir),
    expectedConfigHash: patchConfigHash(normalizedOptions),
    canRestoreOriginals: canRestoreOriginals(extDir),
    backupMetadata: backupMetadata(extDir, paths),
    compatibility: inspectCompatibility(extDir, normalizedOptions),
    runtimeConfig: normalizedOptions.runtimeConfig,
    lastPatch: lastPatchDiagnostics,
  };
}

function activate(context) {
  const vendorDir = path.join(context.extensionPath, 'vendor');

  // Auto-patch on startup. Files stay patched on disk between sessions so the
  // webview always loads the patched version (it loads before this extension).
  const extDir = findClaudeCodeExtDir();
  if (extDir) {
    try {
      const result = ensurePatched(extDir, vendorDir, readPatchOptions());
      if (result === 'fresh') {
        reloadWebviewAndNotify('Claude Code Enhance enabled. The webview was reloaded; reload again if any math still looks unrendered.');
      } else if (result === 'refreshed') {
        reloadWebviewAndNotify('Claude Code Enhance updated. The webview was reloaded; reload again if any math still looks unrendered.');
      } else if (result === 'unsupported') {
        notifyUnsupported();
      }
    } catch (e) {
      console.error('[Claude Code Enhance] Auto-patch failed:', e);
    }
  } else {
    console.warn('[Claude Code Enhance] Claude Code extension not found.');
  }

  // Enable command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-enhance.enable', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showErrorMessage('Claude Code extension not found.');
        return;
      }
      if (isPatched(dir)) {
        vscode.window.showInformationMessage('Claude Code Enhance is already active.');
        return;
      }
      try {
        const result = ensurePatched(dir, vendorDir, readPatchOptions());
        if (result === 'fresh' || result === 'refreshed') {
          reloadWebviewAndNotify('Claude Code Enhance enabled. The webview was reloaded; reload again if any math still looks unrendered.');
        } else if (result === 'skipped') {
          vscode.window.showErrorMessage('Claude Code Enhance found an incomplete patch but could not verify its backups. No files were changed.');
        } else if (result === 'unsupported') {
          notifyUnsupported();
        }
      } catch (e) {
        vscode.window.showErrorMessage('Failed to apply patch: ' + e.message);
      }
    })
  );

  // Disable command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-enhance.disable', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showErrorMessage('Claude Code extension not found.');
        return;
      }
      if (getPatchState(dir) === 'unpatched') {
        vscode.window.showInformationMessage('Claude Code Enhance is not active.');
        return;
      }
      try {
        removePatch(dir);
        reloadWebviewAndNotify('Claude Code Enhance disabled. The webview was reloaded.');
      } catch (e) {
        vscode.window.showErrorMessage('Failed to remove patch: ' + e.message);
      }
    })
  );

  // Status command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-enhance.status', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showInformationMessage('Claude Code extension not found.');
        return;
      }
      const diagnostics = collectDiagnostics(dir);
      const compatibility = diagnostics.compatibility?.supported ? 'Compatible' : 'Unsupported';
      const configuration = diagnostics.patchedConfigHash === diagnostics.expectedConfigHash ? 'Current' : 'Stale';
      vscode.window.showInformationMessage(
        `Claude Code Enhance: ${diagnostics.patchState === 'partial' ? 'Incomplete patch' : (diagnostics.patched ? 'Active' : 'Not active')} | ` +
        `Claude ${diagnostics.claudeVersion} | ${compatibility} | Config ${configuration}`
      );
    })
  );

  const diagnosticsChannel = vscode.window.createOutputChannel?.('Claude Code Enhance');
  if (diagnosticsChannel) context.subscriptions.push(diagnosticsChannel);
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-enhance.diagnostics', function() {
      const diagnostics = collectDiagnostics(findClaudeCodeExtDir());
      const report = JSON.stringify(diagnostics, null, 2);
      if (diagnosticsChannel) {
        diagnosticsChannel.clear();
        diagnosticsChannel.appendLine(report);
        diagnosticsChannel.show(true);
      } else {
        console.log('[Claude Code Enhance] Diagnostics:', report);
      }
    })
  );

  // Status bar indicator. Always visible; text reflects whether the patch is
  // active. Clicking it shows the status message.
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'claude-code-enhance.status';
  function refreshStatusBar() {
    const dir = findClaudeCodeExtDir();
    const patchState = dir ? getPatchState(dir) : 'unavailable';
    if (patchState === 'patched') {
      statusBarItem.text = '$(symbol-operator) LaTeX';
      statusBarItem.tooltip = 'Claude Code Enhance is active. Click for status.';
    } else if (patchState === 'partial') {
      statusBarItem.text = '$(warning) LaTeX';
      statusBarItem.tooltip = 'Claude Code Enhance found an incomplete patch. Click for diagnostics.';
    } else if (dir) {
      statusBarItem.text = '$(symbol-operator) LaTeX (off)';
      statusBarItem.tooltip = 'Claude Code Enhance is not patched. Run "Claude Code Enhance: Enable" or reload after install.';
    } else {
      statusBarItem.text = '$(symbol-operator) LaTeX (no CC)';
      statusBarItem.tooltip = 'Claude Code extension not found.';
    }
  }
  refreshStatusBar();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Watch for Claude Code extension changes (updates). A Claude Code update
  // installs a fresh (unpatched) webview; this re-patches it.
  context.subscriptions.push(
    vscode.extensions.onDidChange(function() {
      const dir = findClaudeCodeExtDir();
      if (dir) {
        try {
          const result = ensurePatched(dir, vendorDir, readPatchOptions());
          if (result === 'fresh' || result === 'refreshed') {
            reloadWebviewAndNotify('Claude Code Enhance re-applied after a Claude Code update. The webview was reloaded; reload again if any math still looks unrendered.');
          } else if (result === 'unsupported') {
            notifyUnsupported();
          }
        } catch (e) {
          console.error('[Claude Code Enhance] Re-patch after update failed:', e);
        }
      }
      refreshStatusBar();
    })
  );

  if (vscode.workspace?.onDidChangeConfiguration) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(function(event) {
        if (!event.affectsConfiguration('claudeCodeEnhance')) return;
        const dir = findClaudeCodeExtDir();
        if (!dir) return;
        try {
          const result = ensurePatched(dir, vendorDir, readPatchOptions());
          if (result === 'fresh' || result === 'refreshed') {
            reloadWebviewAndNotify('Claude Code Enhance settings updated. The webview was reloaded.');
          } else if (result === 'unsupported') {
            notifyUnsupported();
          }
        } catch (error) {
          vscode.window.showErrorMessage('Failed to apply Claude Code Enhance settings: ' + error.message);
        }
        refreshStatusBar();
      })
    );
  }
}

function deactivate() {
  // Intentionally empty. Files stay patched on disk so Claude Code's webview
  // (which loads before our extension activates) always gets the patched version.
  // Cleanup happens via: "Disable" command, or uninstall-hook.js on uninstall.
}

module.exports = { activate, deactivate };

// Exposed for testing only
module.exports._test = {
  findClaudeCodeExtDir,
  isPatched,
  getPatchState,
  getPatchedVersion,
  getPatchedBuildId,
  canRestoreOriginals,
  applyPatch,
  removePatch,
  ensurePatched,
  reloadWebviewAndNotify,
  notifyUnsupported,
  patchMessageRetentionCap,
  inspectCompatibility,
  getLastPatchDiagnostics: () => lastPatchDiagnostics,
  getClaudeCodeVersion,
  patchPaths,
  backupMetadata,
  ensureBackupFiles,
  findMarkdownRenderTargets,
  findMessageRetentionTargets,
  parseBundle,
  transformClaudeBundle,
  validateBundleSyntax,
  normalizePatchOptions,
  readPatchOptions,
  patchConfigHash,
  getPatchedConfigHash,
  collectDiagnostics,
  buildCssPatch,
  DEFAULT_RUNTIME_CONFIG,
  EXTENSION_VERSION,
  PATCH_BUILD_ID,
  PATCH_MARKER,
  PATCH_CSS_MARKER,
  PATCH_VERSION_PREFIX,
  PATCH_BUILD_PREFIX,
  FULL_TRANSCRIPT_MARKER,
  BACKUP_METADATA_FILE,
  PATCH_SCHEMA_VERSION,
  ISSUES_URL,
};
