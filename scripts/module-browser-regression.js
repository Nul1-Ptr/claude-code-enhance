'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vm = require('vm');

module.exports = async function testModulePatch(browser) {
  const originalLoad = Module._load;
  let extension;
  Module._load = function loadWithVscode(request, parent, isMain) {
    return request === 'vscode' ? {} : originalLoad.call(this, request, parent, isMain);
  };
  try {
    extension = require('../extension')._test;
  } finally {
    Module._load = originalLoad;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-module-browser-'));
  const webview = path.join(directory, 'webview');
  const vendor = path.join(__dirname, '..', 'vendor');
  fs.mkdirSync(webview);
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-bundles', '2.1.332.js'), 'utf8');
  const prelude = `
    const katex='native-katex',hljs='native-highlighter';
    const React={useState(value){return[value,()=>{}]},createElement(component,props){return props},Fragment:'fragment'};
    const Markdown='markdown',Code='code',Pre='pre',basePlugins=[function basePlugin(){}];
    const memo=(callback)=>callback();
    function codeRenderer(enabled){window.__nativeCodeEnabled=enabled;return Code}
    function useMath(source,enabled,costs,index,drawsMath){
      window.__nativeMathEnabled=enabled;
      return {remarkPlugins:enabled?[function nativeRemark(){}]:[],rehypePlugins:enabled?[function nativeRehype(){}]:[]};
    }
  `;
  const probe = `
    window.__markdownProbe=()=>MathMarkdown({source:'$x^2$',isMathEnabled:true,mathCosts:[],index:0,drawsMath:true,isCodeColored:true});
    window.__probe=window.__markdownProbe();
    window.__fixtureReady=true;
  `;
  try {
    for (const { moduleMode, crossOrigin } of [
      { moduleMode: false, crossOrigin: false },
      { moduleMode: true, crossOrigin: false },
      { moduleMode: true, crossOrigin: true },
    ]) {
      const scriptFixture = fixture
        .replace(/const mathAsset[^\n]+\nconst loadMathAsset[^\n]+\n/, '')
        .replace(/export \{[^\n]+\n/, '');
      const originalSource = prelude + (moduleMode ? fixture : scriptFixture) + probe;
      fs.writeFileSync(path.join(webview, 'index.js'), originalSource);
      fs.writeFileSync(path.join(webview, 'index.css'), 'body{color:inherit}');
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '2.1.332', main: 'host.js' }));
      fs.writeFileSync(path.join(directory, 'host.js'), 'function policy(webview){return `worker-src ${webview.cspSource}`;}');
      assert(extension.applyPatch(directory, vendor));
      const patched = fs.readFileSync(path.join(webview, 'index.js'), 'utf8');
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => { window.__CLAUDE_ENHANCE_TEST_MODE__ = true; });
      const assetOrigin = crossOrigin ? 'http://claude-assets.test' : 'http://claude-fixture.test';
      const policy = vm.runInNewContext(fs.readFileSync(path.join(directory, 'host.js'), 'utf8') +
        ';policy({cspSource:' + JSON.stringify(assetOrigin) + '})');
      await page.route('**/*', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/webview/index.js') {
          await route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: patched });
        } else if (pathname === '/webview/claude-enhance-worker.js') {
          await route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(webview, 'claude-enhance-worker.js')) });
        } else if (pathname === '/webview/math.js') {
          await route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: 'export const assetLoaded = true;' });
        } else {
          await route.fulfill({ contentType: 'text/html', body:
            `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-fixture'; style-src 'unsafe-inline'; ${policy}"></head><body><script nonce="fixture" ${moduleMode ? 'type="module"' : ''} src="${assetOrigin}/webview/index.js"></script></body></html>` });
        }
      });
      try {
        await page.goto('http://claude-fixture.test/');
        await page.waitForFunction(() => window.__fixtureReady);
        const result = await page.evaluate(() => {
          const api = window.__CLAUDE_ENHANCE_TEST_API__;
          const code = document.createElement('code');
          code.className = 'language-javascript';
          code.textContent = 'const answer = 42;';
          const pre = document.createElement('pre');
          pre.append(code);
          document.body.append(pre);
          const highlight = api.highlightCodeBlock(code);
          const formula = api.renderLatexHtml('x^2', false);
          const plugins = window.__probe.remarkPlugins.length;
          const rehype = window.__probe.rehypePlugins.length;
          const nativeEnabled = window.__nativeMathEnabled;
          const nativeCodeEnabled = window.__nativeCodeEnabled;
          window.__CLAUDE_ENHANCE_CONFIG__ = { syntaxHighlighting: false };
          window.__markdownProbe();
          const disabledNativeCodeEnabled = window.__nativeCodeEnabled;
          window.__KATEX_V2_LOADED = false;
          const fallback = window.__markdownProbe();
          return {
            highlight,
            hasHighlight: !!code.querySelector('.hljs-keyword'),
            hasMath: formula.includes('katex'),
            plugins,
            rehype,
            nativeEnabled,
            nativeCodeEnabled,
            disabledNativeCodeEnabled,
            fallbackNativeEnabled: window.__nativeMathEnabled,
            fallbackPlugins: fallback.remarkPlugins.length,
            fallbackRehype: fallback.rehypePlugins.length,
          };
        });
        assert.strictEqual(result.nativeEnabled, false, 'enhancer math should suppress native provider work');
        assert(!result.nativeCodeEnabled && result.disabledNativeCodeEnabled,
          'enhancer highlighting should suppress native coloring only while it is enabled');
        assert(result.plugins === 3 && result.rehype === 1, 'exactly one enhancer math pipeline should be attached');
        assert(result.fallbackNativeEnabled && result.fallbackPlugins === 2 && result.fallbackRehype === 1,
          'native math should remain available when the enhancer pipeline is unavailable');
        assert(result.highlight === 'highlighted' && result.hasHighlight && result.hasMath,
          'KaTeX and Highlight.js must work without capturing Claude module bindings');
        const workerResult = await page.evaluate(async (crossOrigin) => {
          if (!crossOrigin) delete window.__CLAUDE_ENHANCE_WORKER_SOURCE__;
          const output = await window.__CLAUDE_ENHANCE_RICH__.request('math', { source: 'x^2', display: false });
          return { valid: output.includes('katex'), ...window.__CLAUDE_ENHANCE_RICH__.diagnostics };
        }, crossOrigin);
        assert(workerResult.valid && workerResult.workerTasks > 0 && workerResult.fallbackTasks === 0,
          'patched worker must execute off-thread under Claude-style CSP');
        if (crossOrigin) assert.strictEqual(workerResult.backend, 'worker-blob', 'cross-origin resources must use the permitted local Blob worker');
        if (moduleMode) {
          const lazy = await page.evaluate(async (origin) => {
            const entry = await import(origin + '/webview/index.js');
            return (await entry.loadMathAsset()).assetLoaded;
          }, assetOrigin);
          assert(lazy, 'import.meta.url must resolve lazy chunks relative to the original entry point');
        }
        assert.deepStrictEqual(errors, [], 'patched scripts and modules must load without browser errors');
        assert(extension.removePatch(directory));
        assert(!fs.existsSync(path.join(webview, 'claude-enhance-worker.js')), 'restore must remove the owned worker asset');
        assert.strictEqual(fs.readFileSync(path.join(webview, 'index.js'), 'utf8'), originalSource,
          'module and script restore must preserve exact original contents');
      } finally {
        await page.close();
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('module browser regression passed (script/module startup, math fallback, highlighting, lazy chunks, restore)');
};
