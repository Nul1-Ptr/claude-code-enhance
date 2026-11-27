'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { findClaudeCodeDir } = require('../uninstall-hook');
const { parseBundle, walkAst, findMarkdownRenderTargets } = require('../lib/bundle-transform');

module.exports = async function testInstalledMarkdown(browser) {
  const installed = findClaudeCodeDir();
  if (!installed) {
    console.log('installed Markdown browser regression skipped (Claude Code unavailable)');
    return;
  }
  let source = fs.readFileSync(path.join(installed, 'webview', 'index.js'), 'utf8');
  const suffix = source.includes('/* === KaTeX LaTeX Rendering Patch === */') ? '.katex-bak' : '';
  if (suffix) source = fs.readFileSync(path.join(installed, 'webview', 'index.js' + suffix), 'utf8');
  const ast = parseBundle(source);
  const targets = findMarkdownRenderTargets(source, ast);
  const bootstrap = ast.body.at(-1);
  const bootCall = bootstrap?.type === 'TryStatement' && bootstrap.block.body[0]?.expression;
  const bootFunction = bootCall?.callee?.type === 'Identifier' && ast.body.find((node) =>
    node.type === 'FunctionDeclaration' && node.id?.name === bootCall.callee.name);
  let createRoot;
  if (bootFunction) walkAst(bootFunction, (node) => {
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
        node.callee.property?.name === 'createRoot' && node.arguments[0]?.type === 'CallExpression' &&
        node.arguments[0].arguments[0]?.value === '#root') createRoot = source.slice(node.callee.start, node.callee.end);
  });
  assert(targets.length === 1 && createRoot, 'installed React Markdown and startup boundaries must be uniquely identified');
  const target = targets[0];
  const originalLoad = Module._load;
  let extension;
  Module._load = function loadWithVscode(request, parent, isMain) {
    return request === 'vscode' ? {} : originalLoad.call(this, request, parent, isMain);
  };
  try { extension = require('../extension')._test; }
  finally { Module._load = originalLoad; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-installed-markdown-'));
  const webview = path.join(directory, 'webview');
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    fs.mkdirSync(webview);
    fs.writeFileSync(path.join(webview, 'index.js'), source);
    fs.copyFileSync(path.join(installed, 'webview', 'index.css' + suffix), path.join(webview, 'index.css'));
    assert(extension.applyPatch(directory, path.join(__dirname, '..', 'vendor')));
    const patched = fs.readFileSync(path.join(webview, 'index.js'), 'utf8');
    const tail = source.slice(bootstrap.start);
    assert(patched.endsWith(tail), 'only the temporary copy should replace the original app bootstrap');
    const probe = patched.slice(0, -tail.length) + `
      const ceTestRoot=${createRoot}(document.getElementById('root'));
      window.__renderInstalledMarkdown=(source)=>ceTestRoot.render(${target.callee}(${target.component},{
        remarkPlugins:[window.__remarkBracketMath,window.__remarkMath],
        rehypePlugins:[window.__rehypeKatex],children:source
      }));
      window.__unmountInstalledMarkdown=()=>ceTestRoot.unmount();
    `;
    await page.addInitScript(() => { window.__CLAUDE_ENHANCE_TEST_MODE__ = true; });
    const origin = 'http://installed-markdown.test';
    await page.route('**/*', async (route) => {
      const requested = new URL(route.request().url());
      if (requested.origin !== origin) { await route.abort(); return; }
      if (requested.pathname === '/webview/index.js') {
        await route.fulfill({ contentType: 'text/javascript', body: probe });
      } else if (requested.pathname === '/webview/claude-enhance-worker.js') {
        await route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(webview, 'claude-enhance-worker.js')) });
      } else {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div><script type="module" src="/webview/index.js"></script>' });
      }
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.__renderInstalledMarkdown);
    await page.evaluate(() => {
      window.__renderInstalledMarkdown('# Actual renderer\n\n' + 'paragraph '.repeat(7000) + '\n\n$x^2$');
    });
    await page.waitForFunction(() => document.querySelector('ce-rich-message')?.dataset.ceRenderState === 'complete');
    assert(await page.locator('ce-rich-message h1').innerText() === 'Actual renderer');
    assert(await page.locator('ce-rich-message .katex').count() === 1);
    await page.evaluate(() => {
      window.__actualHeading = document.querySelector('ce-rich-message').shadowRoot.querySelector('h1');
      window.__renderInstalledMarkdown('# Actual renderer\n\n' + 'paragraph '.repeat(7000) + '\n\n$x^2$\n\n## Updated');
    });
    await page.locator('ce-rich-message h2').waitFor();
    await page.waitForFunction(() => document.querySelector('ce-rich-message')?.dataset.ceRenderState === 'complete');
    assert(await page.evaluate(() => document.querySelector('ce-rich-message').shadowRoot.querySelector('h1') === window.__actualHeading),
      'React streaming updates must retain completed shadow blocks');
    await page.evaluate(() => { window.__renderInstalledMarkdown('Short **answer** with $y^2$'); });
    await page.locator('#root > p strong').waitFor();
    assert(await page.locator('ce-rich-message').count() === 0, 'a shorter React replacement should return to the original Markdown pipeline');
    assert(await page.locator('#root .katex').count() === 1);
    await page.evaluate(() => window.__unmountInstalledMarkdown());
    assert.deepStrictEqual(errors, [], 'actual React reconciliation must complete without DOM ownership errors');
    console.log('installed Markdown browser regression passed (real React/Markdown, progressive output, streaming reuse, short replacement, unmount)');
  } finally {
    await page.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
