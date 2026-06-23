const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      extensions: { getExtension: () => null, onDidChange: () => ({ dispose() {} }) },
      commands: { executeCommand: () => {} },
      window: {
        showInformationMessage: () => Promise.resolve(),
        showWarningMessage: () => Promise.resolve(),
        showErrorMessage: () => {},
        createStatusBarItem: () => ({ show() {}, dispose() {} }),
      },
      env: { openExternal: () => {} },
      Uri: { parse: (value) => value },
      StatusBarAlignment: { Right: 1 },
    };
  }
  return originalLoad.apply(this, arguments);
};

const extension = require('../extension.js')._test;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-enhance-'));
const webview = path.join(tmp, 'webview');
fs.mkdirSync(webview);

const fixtureJs = 'var Nrt=600,Art=500;function jS(e){if(e.length>Nrt){let t=e.length-Art;return e.slice(t)}return e}const gfm=a;createElement(Md,{remarkPlugins:[gfm],components:{}},text);';
const fixtureCss = '/* css */';
fs.writeFileSync(path.join(webview, 'index.js'), fixtureJs);
fs.writeFileSync(path.join(webview, 'index.css'), fixtureCss);

if (!extension.applyPatch(tmp, path.join(__dirname, '..', 'vendor'))) {
  throw new Error('applyPatch returned false');
}

const patchedJs = fs.readFileSync(path.join(webview, 'index.js'), 'utf8');
const patchedCss = fs.readFileSync(path.join(webview, 'index.css'), 'utf8');

for (const marker of [
  'Highlight.js Core',
  'Claude Code output preview enhancer',
  'enhance-patch-build',
  'window.__KATEX_V2_LOADED',
  'markCodeBlockPlain',
  'claude-code-copy-btn',
  'claude-enhance-root',
  'shouldSkipPreviewEnhancement',
  'isProseHeavyLatex',
  'isLikelyInlineDollarFormula',
  'isDimensionLatexFormula',
  'normalizeDimensionLatexFormula',
  'repairBareDimensionMath',
  'renderBareDimensionMathInTextNode',
  'repairMalformedDimensionKatex',
  'parseMalformedDimensionText',
  'repairProseKatexErrors',
  'renderRelaxedMarkdownBold',
  'promoteStandaloneInlineMath',
  'isOnlyMathInTableCell',
  'shouldPromoteInlineMath',
  'adaptInlineMathSize',
  'ce-large-inline-math',
  'stable-runtime-guards',
  'safeRun',
  'CONTENT_BASE_FONT_SCALE',
  'zoom * CONTENT_BASE_FONT_SCALE',
  'NON_PREVIEW_SELECTOR',
  'renderMathInTextNode',
  'runEnhancementCycle',
  'characterData: true',
  'renderApiErrors',
  'parseApiErrorText',
  'findApiErrorContainer',
  'data-ce-api-error-rendered',
  '--ce-api-error-bg',
  'Show raw API error',
  'table :is(td, th) .katex-display',
  'width: fit-content',
  'margin: 0.35em 0',
  'clamp(8px, 0.65em, 14px)',
  'font-size: 1.48em',
  'font-size: 1.22em',
  '\\uE000',
  '__remarkPipeGuard',
  'meaningfulTextWithoutMath',
  'font-size: 1.6em',
  'padding: 14px 18px',
  'min-height: 48px',
  'width: 100% !important',
  'min-width: 100% !important',
  '--ce-math-inline-bg',
  '--ce-math-display-bg',
  'vscode-textCodeBlock-background',
  'text-align: center',
  'role="textbox"',
  'measurement layers',
  '--ce-fg',
  '--ce-inline-code-fg',
  '--ce-markdown-text',
  '--ce-syntax-keyword',
  'Common Highlight.js palette',
  'vscode-high-contrast',
  'claude-code-enhance-full-transcript',
]) {
  if (!patchedJs.includes(marker)) throw new Error('missing JS marker: ' + marker);
}

for (const marker of ['.katex-display', '.hljs']) {
  if (!patchedCss.includes(marker)) throw new Error('missing CSS marker: ' + marker);
}

extension.removePatch(tmp);

if (fs.readFileSync(path.join(webview, 'index.js'), 'utf8') !== fixtureJs) {
  throw new Error('index.js did not restore');
}
if (fs.readFileSync(path.join(webview, 'index.css'), 'utf8') !== fixtureCss) {
  throw new Error('index.css did not restore');
}

function versionParts(version) {
  return String(version || '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
}

function compareVersionDesc(a, b) {
  for (let i = 0; i < 4; i++) {
    const diff = (b.versionParts[i] || 0) - (a.versionParts[i] || 0);
    if (diff) return diff;
  }
  return b.mtimeMs - a.mtimeMs;
}

function readExtensionVersion(extDir, fallbackName) {
  try {
    return JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8')).version;
  } catch {
    const match = fallbackName.match(/^anthropic\.claude-code-(.+)$/);
    return match ? match[1] : '0.0.0';
  }
}

function originalCandidate(webviewDir, fileName) {
  const backup = path.join(webviewDir, fileName + '.katex-bak');
  if (fs.existsSync(backup)) return backup;
  return path.join(webviewDir, fileName);
}

function findLatestInstalledClaudeCodeFixture() {
  const extensionRoots = [
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
  ];
  const fixtures = [];

  for (const root of extensionRoots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('anthropic.claude-code-')) continue;
      const extDir = path.join(root, name);
      const webviewDir = path.join(extDir, 'webview');
      const jsPath = originalCandidate(webviewDir, 'index.js');
      const cssPath = originalCandidate(webviewDir, 'index.css');
      if (!fs.existsSync(jsPath) || !fs.existsSync(cssPath)) continue;

      const version = readExtensionVersion(extDir, name);
      fixtures.push({
        name,
        version,
        versionParts: versionParts(version),
        mtimeMs: fs.statSync(extDir).mtimeMs,
        jsPath,
        cssPath,
      });
    }
  }

  return fixtures.sort(compareVersionDesc)[0] || null;
}

const installedFixture = findLatestInstalledClaudeCodeFixture();
if (installedFixture) {
  const installedSource = fs.readFileSync(installedFixture.jsPath, 'utf8');
  const installedHasRetentionCap = extension.MESSAGE_RETENTION_CONSTANTS_RE.test(installedSource);
  const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-enhance-installed-'));
  const localWebview = path.join(localTmp, 'webview');
  fs.mkdirSync(localWebview);
  fs.copyFileSync(installedFixture.jsPath, path.join(localWebview, 'index.js'));
  fs.copyFileSync(installedFixture.cssPath, path.join(localWebview, 'index.css'));

  if (!extension.applyPatch(localTmp, path.join(__dirname, '..', 'vendor'))) {
    throw new Error('applyPatch returned false for installed Claude Code fixture: ' + installedFixture.name);
  }
  const localPatchedJs = fs.readFileSync(path.join(localWebview, 'index.js'), 'utf8');
  for (const marker of ['stable-runtime-guards', 'safeRun', 'NON_PREVIEW_SELECTOR']) {
    if (!localPatchedJs.includes(marker)) {
      throw new Error('missing installed Claude Code marker: ' + marker);
    }
  }
  if (installedHasRetentionCap && !localPatchedJs.includes(extension.FULL_TRANSCRIPT_MARKER)) {
    throw new Error('missing installed Claude Code full-transcript retention marker');
  }
  extension.removePatch(localTmp);
}

console.log('smoke test passed');
