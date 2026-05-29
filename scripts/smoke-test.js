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

const fixtureJs = 'const gfm=a;createElement(Md,{remarkPlugins:[gfm],components:{}},text);';
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
  'repairProseKatexErrors',
  'renderRelaxedMarkdownBold',
  'role="textbox"',
  'measurement layers',
  '--ce-fg',
  '--ce-inline-code-fg',
  '--ce-markdown-text',
  '--ce-syntax-keyword',
  'Common Highlight.js palette',
  'vscode-high-contrast',
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

console.log('smoke test passed');
