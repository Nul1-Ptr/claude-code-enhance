'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { transcriptHtml } = require('../lib/subagent-sidebar');
const { richWorkerSource } = require('../lib/rich-content-assets');

const projectRoot = path.join(__dirname, '..');
const vendor = path.join(projectRoot, 'vendor');

async function waitForRich(page, selector = 'ce-rich-message') {
  await page.waitForFunction((query) => {
    const elements = Array.from(document.querySelectorAll(query));
    return elements.length && elements.every((element) => element.dataset.ceRenderState === 'complete');
  }, selector, { timeout: 60000 });
}

async function testMainMessage(browser) {
  const page = await browser.newPage();
  const errors = [];
  const origin = 'http://rich-main.test';
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route(`${origin}/**`, async (route) => {
      if (route.request().url().endsWith('/worker.js')) {
        await route.fulfill({ contentType: 'text/javascript', body: richWorkerSource(vendor) });
      } else {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><div class="messagesContainer_test"></div>' });
      }
    });
    await page.goto(origin);
    await page.evaluate(() => {
      window.__CLAUDE_ENHANCE_TEST_MODE__ = true;
      window.__CLAUDE_ENHANCE_WORKER_URL__ = new URL('/worker.js', location.href).href;
    });
    for (const name of ['katex.min.js', 'highlight.min.js', 'marked.min.js', 'remark-math-bundle.js',
      'runtime-core.js', 'math-core.js', 'subagent-view.js', 'rich-fragments.js', 'rich-document.js', 'rich-rows.js', 'rich-content.js', 'enhance.js']) {
      await page.addScriptTag({ path: path.join(vendor, name) });
    }
    const initial = await page.evaluate(() => {
      window.__richHeartbeat = { count: 0, longestGap: 0, previous: performance.now(), active: true };
      const beat = () => {
        const state = window.__richHeartbeat;
        const now = performance.now();
        state.count++;
        state.longestGap = Math.max(state.longestGap, now - state.previous);
        state.previous = now;
        if (state.active) requestAnimationFrame(beat);
      };
      requestAnimationFrame(beat);
      window.__copied = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text) => { window.__copied = text; },
      } });
      window.__parserCalls = 0;
      const processor = { parser() { window.__parserCalls++; throw new Error('Giant source entered synchronous parser'); } };
      window.__remarkBracketMath.call(processor);
      window.__source = '# Giant message\n\n<script>window.__unsafe=true</script>\n\n' +
        Array.from({ length: 24 }, (_, index) => `## Block ${index}\n\n` + 'complete original source '.repeat(3700)).join('\n\n') +
        '\n\n[reference][target]\n\n| Value | Math |\n|---|---|\n| sample | $x^2$ |\n\n' +
        '```javascript\n' + 'const value = "a";\n'.repeat(3500) + '```\n\n' +
        '[target]: https://example.com/history\n';
      const tree = processor.parser(window.__source, {});
      const element = document.createElement(tree.children[0].data.hName);
      element.textContent = tree.children[0].children[0].value;
      document.querySelector('.messagesContainer_test').append(element);
      return { length: window.__source.length, parserCalls: window.__parserCalls, tag: element.tagName };
    });
    assert(initial.length > 2 * 1024 * 1024 && initial.parserCalls === 0 && initial.tag === 'CE-RICH-MESSAGE',
      'giant source must reach a progressive renderer without synchronous React Markdown parsing');
    await waitForRich(page);
    const result = await page.evaluate(async () => {
      const element = document.querySelector('ce-rich-message');
      const shadow = element.shadowRoot;
      shadow.querySelector('.toolbar button').click();
      await Promise.resolve();
      return {
        retained: element.textContent === window.__source,
        copied: window.__copied === window.__source,
        headings: shadow.querySelectorAll('h2').length,
        math: shadow.querySelectorAll('.katex').length,
        highlight: shadow.querySelector('ce-rich-rows')?.shadowRoot.querySelectorAll('.hljs-keyword').length,
        codeRows: shadow.querySelector('ce-rich-rows')?.dataset.totalRows,
        link: shadow.querySelector('a')?.href,
        unsafe: !!shadow.querySelector('script, img, [onclick], [onerror]'),
        diagnostics: window.__CLAUDE_ENHANCE_RICH__.diagnostics,
        heartbeat: { ...window.__richHeartbeat },
      };
    });
    assert(result.retained && result.copied && result.headings === 24 && result.math === 1 &&
      result.highlight > 0 && result.highlight <= 80 && Number(result.codeRows) === 3500,
      'all giant-message Markdown, code, and math must eventually render and exact source must stay copyable');
    assert(result.link === 'https://example.com/history' && !result.unsafe,
      'cross-block references and inert raw HTML must survive progressive parsing');
    assert(result.diagnostics.workerTasks > 0 && result.diagnostics.fallbackTasks === 0 && result.diagnostics.domSlices > 0,
      'heavy parsing must use the worker and DOM processing must yield');
    assert(result.heartbeat.count >= 3 && result.heartbeat.longestGap < 500 && result.diagnostics.longestTaskMs < 500,
      'the synthetic 2 MiB worker rendering must allow animation/input frames without a 500 ms stall');
    const equivalentMath = await page.evaluate(async () => {
      for (const formula of ['\\mathds{R}', '\\text{src_main}', '\\mbox{cost_1}', 'x+'.repeat(200) + 'y']) {
        const regular = window.__CLAUDE_ENHANCE_TEST_API__.renderLatexHtml(formula, false);
        const deferred = await window.__CLAUDE_ENHANCE_RICH__.request('math', { source: formula, display: false });
        if (regular !== deferred) return false;
      }
      return true;
    });
    assert(equivalentMath, 'normal and worker math must share repairs and complete rendered output');

    const liveUpdates = await page.evaluate(async () => {
      const element = document.querySelector('ce-rich-message');
      const prefix = element.textContent;
      const heading = element.shadowRoot.querySelector('h1');
      let visible = true;
      for (let update = 0; update < 30; update++) {
        const marker = `Live update ${update}`;
        element.textContent = prefix + '\n\n' + Array.from({ length: update + 1 }, (_, index) => `Live update ${index}`).join('\n');
        await new Promise((resolve) => setTimeout(resolve, 50));
        const live = element.shadowRoot.querySelector('.live-tail');
        visible &&= (!live.hidden && live.textContent.includes(marker)) ||
          element.shadowRoot.querySelector('.markdown-content').textContent.includes(marker);
      }
      return { visible, stableHeading: element.shadowRoot.querySelector('h1') === heading };
    });
    assert(liveUpdates.visible && liveUpdates.stableHeading,
      'continuous streaming must expose every new tail while retaining the completed prefix');
    await waitForRich(page);
    await page.evaluate(() => {
      const rows = document.querySelector('ce-rich-message').shadowRoot.querySelector('ce-rich-rows');
      rows.viewport.scrollTop = rows.viewport.scrollHeight;
    });
    await page.waitForFunction(() => {
      const rows = document.querySelector('ce-rich-message').shadowRoot.querySelector('ce-rich-rows');
      return rows.status.textContent.includes('3500 / 3500') && Number(rows.dataset.mountedRows) <= 80;
    });
    await page.locator('ce-rich-rows button').click();
    await page.waitForFunction(() => window.__copied === 'const value = "a";\n'.repeat(3500));
    assert(await page.evaluate(() => window.__copied === 'const value = "a";\n'.repeat(3500)),
      'row virtualization must copy the complete code after an incremental document update');

    await page.evaluate(() => {
      document.querySelector('ce-rich-message').textContent = '| row | math |\n|---|---|\n' +
        Array.from({ length: 1000 }, (_, index) => `| row-${index} | $x^2$ |`).join('\n');
    });
    await page.waitForFunction(() => document.querySelector('ce-rich-message').shadowRoot
      .querySelector('ce-rich-rows')?.dataset.totalRows === '1000');
    await waitForRich(page);
    assert(await page.locator('ce-rich-message ce-rich-rows tbody tr').count() <= 80);
    await page.evaluate(() => {
      const rows = document.querySelector('ce-rich-message').shadowRoot.querySelector('ce-rich-rows');
      rows.viewport.scrollTop = rows.viewport.scrollHeight;
    });
    await page.getByText('row-999', { exact: true }).waitFor();
    assert(await page.locator('ce-rich-message ce-rich-rows .katex').count() > 0,
      'table windows must preserve math and reach the last row');

    await page.evaluate(() => {
      const element = document.querySelector('ce-rich-message');
      element.textContent = '# Current revision\n\n' + '$x^2$ '.repeat(65);
    });
    await page.waitForFunction(() => document.querySelector('ce-rich-message').shadowRoot.querySelector('h1')?.textContent === 'Current revision');
    await waitForRich(page);
    assert(await page.locator('ce-rich-message .katex').count() === 65,
      'dense math must be formatted instead of disabled');

    const cancelled = await page.evaluate(async () => {
      const controller = new AbortController();
      const request = window.__CLAUDE_ENHANCE_RICH__.request('highlight', {
        source: 'const stale = true;\n'.repeat(100000), language: 'javascript',
      }, controller.signal).then(() => false, (error) => error.name === 'AbortError');
      controller.abort();
      return request;
    });
    assert(cancelled, 'active worker operations must be cancellable');
    await page.evaluate(() => {
      const element = document.querySelector('ce-rich-message');
      element.textContent = '# Stale\n\n' + 'body '.repeat(20000);
      setTimeout(() => { element.textContent = '# Latest\n\n' + 'fresh '.repeat(15000); }, 260);
    });
    await page.waitForFunction(() => document.querySelector('ce-rich-message').shadowRoot.querySelector('h1')?.textContent === 'Latest');
    await waitForRich(page);
    assert(!await page.locator('ce-rich-message').evaluate((element) => element.shadowRoot.textContent.includes('Stale')),
      'older worker responses must not overwrite a newer revision');
    await page.evaluate(() => {
      const element = document.querySelector('ce-rich-message');
      window.__stableHeading = element.shadowRoot.querySelector('h1');
      element.textContent += '\n\n## Appended\n\n$z^2$';
    });
    await page.waitForFunction(() => document.querySelector('ce-rich-message').shadowRoot.querySelector('h2')?.textContent === 'Appended');
    await waitForRich(page);
    assert(await page.evaluate(() => document.querySelector('ce-rich-message').shadowRoot.querySelector('h1') === window.__stableHeading),
      'streaming appends must retain already completed blocks and their DOM identity');
    await page.evaluate(() => {
      document.querySelector('ce-rich-message').textContent = '# Interrupted code\n\n```javascript\n' +
        'const pending = true;\n'.repeat(4000) + '```';
    });
    await page.waitForFunction(() => {
      const rows = document.querySelector('ce-rich-message').shadowRoot.querySelector('ce-rich-rows');
      return rows && !rows.dataset.mountedRows;
    });
    await page.evaluate(() => { document.querySelector('ce-rich-message').textContent += '\n\n### New tail'; });
    await page.locator('ce-rich-message h3').waitFor();
    await waitForRich(page);
    assert(await page.locator('ce-rich-message ce-rich-rows code.hljs .hljs-keyword').count() > 0 &&
      await page.locator('ce-rich-message ce-rich-rows').getAttribute('data-total-rows') === '4000',
      'cancelling an in-progress code block must not mark its unfinished output as reusable');

    const deferred = await page.evaluate(() => {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.id = 'large-code';
      code.className = 'language-javascript';
      window.__largeCode = 'const entry = 1;\n'.repeat(4000);
      code.textContent = window.__largeCode;
      pre.append(code);
      document.body.append(pre);
      return window.__CLAUDE_ENHANCE_TEST_API__.highlightCodeBlock(code);
    });
    assert.strictEqual(deferred, 'deferred');
    await page.waitForFunction(() => document.getElementById('large-code').classList.contains('hljs'));
    await waitForRich(page, 'ce-rich-code');
    assert(await page.locator('ce-rich-code ce-rich-rows .line').count() <= 80,
      'standalone code must use the same bounded row window');
    assert(await page.evaluate(() => document.getElementById('large-code').textContent === window.__largeCode),
      'giant code should eventually highlight without changing its source');
    await page.evaluate(() => {
      document.querySelector('ce-rich-code').shadowRoot.querySelector('ce-rich-rows').viewport.scrollTop = 22000;
    });
    await page.waitForFunction(() => document.querySelector('ce-rich-code').shadowRoot.querySelector('ce-rich-rows').start > 900);
    const readingRow = await page.evaluate(() => document.querySelector('ce-rich-code').shadowRoot.querySelector('ce-rich-rows').position().row);
    await page.evaluate(() => { document.getElementById('large-code').textContent += 'const liveTail = true;'; });
    await page.waitForFunction(() => {
      const preview = document.querySelector('ce-rich-code');
      return !preview.live.hidden && preview.live.textContent.includes('const liveTail = true;');
    });
    await page.waitForFunction(() => {
      const rich = document.querySelector('ce-rich-code');
      return rich.dataset.ceRenderState === 'complete' && rich.documentSource.endsWith('const liveTail = true;');
    });
    assert(await page.evaluate((row) => Math.abs(document.querySelector('ce-rich-code').shadowRoot
      .querySelector('ce-rich-rows').position().row - row) <= 1, readingRow),
    'streaming code appends must preserve the nested reading row');

    await page.evaluate(() => {
      const controller = new AbortController();
      window.__CLAUDE_ENHANCE_RICH__.request('math', { source: 'x', display: false }, controller.signal).catch(() => {});
      controller.abort();
      window.Worker = class { constructor() { throw new DOMException('Worker unavailable', 'SecurityError'); } };
      const element = document.querySelector('ce-rich-message');
      element.textContent = '# Fallback\n\n' + '$y^2$ '.repeat(65);
    });
    await page.waitForFunction(() => document.querySelector('ce-rich-message').shadowRoot.querySelector('h1')?.textContent === 'Fallback');
    await waitForRich(page);
    assert(await page.evaluate(() => window.__CLAUDE_ENHANCE_RICH__.diagnostics.fallbackTasks > 0),
      'a worker-unavailable environment must still finish formatting');
    await page.evaluate(() => {
      document.getElementById('large-code')?.parentElement.remove();
      const element = document.querySelector('ce-rich-message');
      element.textContent = Array.from({ length: 1000 }, (_, index) => `Paragraph marker ${index}`).join('\n\n');
      window.scrollTo(0, 0);
    });
    await waitForRich(page);
    assert(await page.locator('ce-rich-message section').count() <= 64,
      'a giant message must mount only its visible semantic blocks');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(() => document.querySelector('ce-rich-message').shadowRoot
      .querySelector('.markdown-content').textContent.includes('Paragraph marker 999'));
    assert(await page.locator('ce-rich-message section').count() <= 64,
      'scrolling to the end must recycle the semantic block window');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => document.querySelector('ce-rich-message').shadowRoot
      .querySelector('.markdown-content').textContent.includes('Paragraph marker 0'));
    assert.deepStrictEqual(errors, []);
  } finally {
    await page.close();
  }
}

async function testViewerMessage(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = 'http://large-message.test';
  const html = transcriptHtml({ Uri: { joinPath: (base, ...segments) => [base, ...segments].join('/') } }, {
    asWebviewUri: (uri) => uri, cspSource: origin,
  }, origin);
  try {
    await page.route(`${origin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (!pathname.startsWith('/vendor/')) {
        await route.fulfill({ contentType: 'text/html', body: html });
      } else {
        const extension = path.extname(pathname);
        await route.fulfill({ body: fs.readFileSync(path.join(projectRoot, pathname)),
          contentType: extension === '.js' ? 'text/javascript' : extension === '.css' ? 'text/css' : 'font/woff2' });
      }
    });
    await page.goto(origin);
    await page.evaluate(() => {
      window.__replace = (id, blocks) => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'replace', transcript: { filePath: `/fixture/${id}.jsonl`, descriptor: { label: id },
          messages: [{ id, line: 1, role: 'assistant', blocks }] },
      } }));
      window.__largeFormula = 'x+'.repeat(2100) + 'y';
      window.__toolSource = JSON.stringify({ example: 'payload '.repeat(10000) });
      window.__replace('giant', [
        { kind: 'text', text: '# Dense math\n\n' + '$x^2$ '.repeat(64) + '$\\sqrt{x} + \\frac{1}{2}$' },
        { kind: 'text', text: `$$${window.__largeFormula}$$` },
        { kind: 'tool', text: window.__toolSource },
        { kind: 'thinking', text: '# Lazy thinking\n\n' + 'thinking '.repeat(10000) },
      ]);
    });
    await waitForRich(page, '.markdown-content > ce-rich-message');
    const math = await page.locator('ce-rich-message').evaluateAll((elements) => elements.map((element) => ({
      count: element.shadowRoot.querySelectorAll('.katex').length,
      parts: element.shadowRoot.querySelector('ce-rich-parts')?.dataset.totalParts,
      error: !!element.shadowRoot.querySelector('.ce-math-error'),
    })));
    assert(math.length === 2 && math[0].count === 65 && Number(math[1].parts) > 1 && !math[1].error,
      'large formulas must paginate complete KaTeX layout groups while small formulas stay inline');
    const formula = page.locator('ce-rich-message').nth(1).locator('ce-rich-parts');
    assert(await formula.locator('.katex .base').count() < 200,
      'a formula fragment must bound mounted layout groups');
    await formula.getByRole('button', { name: 'Show entire block', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('ce-rich-message')[1].shadowRoot
      .querySelector('ce-rich-parts')?.dataset.expanded === 'true');
    assert(await formula.locator('math annotation').textContent() === await page.evaluate(() => window.__largeFormula),
      'the complete formula remains available with its original accessible MathML');
    await formula.getByRole('button', { name: 'Show fragments', exact: true }).click();
    assert(await page.locator('ce-rich-message svg').first().evaluate((element) =>
      element.namespaceURI === 'http://www.w3.org/2000/svg'),
    'progressive KaTeX output must preserve SVG namespaces');
    assert(await page.locator('ce-rich-message math').first().evaluate((element) =>
      element.namespaceURI === 'http://www.w3.org/1998/Math/MathML'),
    'progressive KaTeX output must preserve accessible MathML');
    await page.locator('.tool-block > summary').click();
    await waitForRich(page, '.tool-block ce-rich-code');
    assert(await page.evaluate(() => document.querySelector('.tool-block ce-rich-code').textContent === window.__toolSource),
      'large tool input must highlight with exact text');
    assert(await page.evaluate(() => window.__CLAUDE_ENHANCE_RICH__.diagnostics.workerTasks > 0 &&
      window.__CLAUDE_ENHANCE_RICH__.diagnostics.fallbackTasks === 0),
    'the production viewer CSP must allow its self-contained worker');

    await page.locator('.thinking-block > summary').click();
    await waitForRich(page, '.thinking-block ce-rich-message');
    await page.evaluate(() => {
      const node = document.querySelector('.thinking-block ce-rich-message');
      node.textContent = '# Old thinking\n\n' + 'stale '.repeat(20000);
      document.querySelector('.thinking-block').open = false;
    });
    await page.waitForTimeout(300);
    await page.locator('.thinking-block > summary').click();
    await page.waitForFunction(() => document.querySelector('.thinking-block ce-rich-message').shadowRoot.querySelector('h1')?.textContent === 'Old thinking');
    await waitForRich(page, '.thinking-block ce-rich-message');

    await page.evaluate(() => {
      window.__replace('malicious', [{ kind: 'text', text: '# Safe\n\n' +
        '<script>window.__unsafe=true</script>\n\n[bad](javascript:alert(1))\n\n' +
        '![remote](https://example.com/tracker)\n\n' + 'safe '.repeat(16000) }]);
    });
    await page.waitForFunction(() => document.querySelectorAll('ce-rich-message').length === 1 &&
      document.querySelector('ce-rich-message').textContent.startsWith('# Safe'));
    await waitForRich(page);
    assert(!await page.locator('ce-rich-message').evaluate((element) =>
      !!element.shadowRoot.querySelector('script, img, a[href^="javascript:"], [onerror]')),
    'progressive Markdown must follow the existing safe-display policy');

    await page.evaluate(() => {
      window.__replace('stale', [{ kind: 'text', text: '# Stale\n\n' + 'body '.repeat(20000) }]);
      setTimeout(() => window.__replace('current', [{ kind: 'text', text: 'Current message' }]), 270);
    });
    await page.waitForFunction(() => document.getElementById('transcript').textContent.includes('Current message'));
    await page.waitForTimeout(300);
    assert.strictEqual(await page.locator('ce-rich-message').count(), 0, 'switching transcript must discard old work');
    await page.evaluate(() => {
      window.__replace('combined', Array.from({ length: 4 }, (_, index) => ({ kind: 'text',
        text: `## Part ${index}\n\n` + 'combined '.repeat(2100) })));
    });
    await page.waitForFunction(() => document.querySelectorAll('ce-rich-message').length === 4);
    for (const element of await page.locator('ce-rich-message').all()) {
      await element.scrollIntoViewIfNeeded();
      await element.locator('h2').waitFor();
    }
    assert(await page.locator('ce-rich-message h2').count() === 4,
      'a message made of individually small blocks must defer and eventually format all of them');
    await page.evaluate(() => {
      window.__atomicProse = '**' + 'styled 😀 content '.repeat(6000) + 'END_PROSE** [safe](https://example.com) ' +
        '[unsafe](javascript:alert(1)) <img src=x onerror="window.__atomicUnsafe=true">';
      window.__replace('atomic-prose', [{ kind: 'text', text: window.__atomicProse }]);
    });
    await page.locator('.message[data-message-id="atomic-prose"]').waitFor();
    await waitForRich(page);
    assert(await page.locator('ce-rich-message ce-rich-parts strong').count() === 1);
    assert(await page.locator('ce-rich-message ce-rich-parts .content').evaluate((element) => element.textContent.length < 8300));
    await page.evaluate(async () => {
      const rich = document.querySelector('ce-rich-message');
      await rich.revealLocation(window.__atomicProse.indexOf('END_PROSE'), 'END_PROSE');
    });
    assert(await page.locator('ce-rich-message ce-rich-parts').getAttribute('data-search-match') === 'true');
    assert(await page.locator('ce-rich-message ce-rich-parts strong').textContent().then((text) => text.includes('END_PROSE')));
    assert(await page.locator('ce-rich-message ce-rich-parts a[href^="javascript:"], ce-rich-message ce-rich-parts img').count() === 0 &&
      await page.evaluate(() => !window.__atomicUnsafe), 'fragment boundaries must preserve the Markdown sanitizer');
    await page.locator('ce-rich-message ce-rich-parts').getByRole('button', { name: 'Previous fragment' }).click();
    await page.waitForFunction(() => !document.querySelector('ce-rich-message').shadowRoot.querySelector('ce-rich-parts')
      .content.textContent.includes('END_PROSE'));
    await page.evaluate(async () => {
      const rich = document.querySelector('ce-rich-message');
      await window.__CLAUDE_ENHANCE_RICH__.request('documentDrop', { id: rich.documentId });
      await rich.revealLocation(window.__atomicProse.indexOf('END_PROSE'), 'END_PROSE');
    });
    assert(await page.locator('ce-rich-message ce-rich-parts .content').textContent().then((text) => text.includes('END_PROSE')),
      'fragment navigation must recover a recycled worker document');
    const readingPart = await page.locator('ce-rich-message ce-rich-parts').getAttribute('data-part');
    await page.evaluate(() => { document.querySelector('ce-rich-message').textContent += ' **APPENDED**'; });
    await page.waitForFunction(() => {
      const rich = document.querySelector('ce-rich-message');
      return rich.dataset.ceRenderState === 'complete' && rich.documentSource.endsWith(' **APPENDED**');
    });
    assert.strictEqual(await page.locator('ce-rich-message ce-rich-parts').getAttribute('data-part'), readingPart,
      'appending a giant paragraph must preserve its current fragment');
    await page.evaluate(() => {
      window.__atomicCode = 'const value = "' + 'large payload '.repeat(12000) + 'END_CODE";';
      window.__replace('atomic-code', [{ kind: 'tool', text: window.__atomicCode }]);
    });
    await page.locator('.message[data-message-id="atomic-code"]').waitFor();
    await page.locator('.tool-block > summary').click();
    await waitForRich(page, '.tool-block ce-rich-code');
    await page.evaluate(async () => {
      await document.querySelector('ce-rich-code').revealLocation(window.__atomicCode.indexOf('END_CODE'), 'END_CODE');
    });
    assert(await page.locator('ce-rich-code ce-rich-rows ce-rich-parts').getAttribute('data-search-match') === 'true');
    assert(await page.locator('ce-rich-code ce-rich-rows ce-rich-parts .content').evaluate((element) => element.textContent.length < 16400),
      'one enormous code line must mount only the target fragments');
    await page.evaluate(() => {
      window.__atomicTable = '| Header |\n|---|\n| **' + 'cell '.repeat(18000) + 'END_CELL** |';
      window.__replace('atomic-table', [{ kind: 'text', text: window.__atomicTable }]);
    });
    await page.locator('.message[data-message-id="atomic-table"]').waitFor();
    await waitForRich(page);
    await page.evaluate(async () => {
      await document.querySelector('ce-rich-message').revealLocation(window.__atomicTable.indexOf('END_CELL'), 'END_CELL');
    });
    assert(await page.locator('ce-rich-message ce-rich-rows td ce-rich-parts').getAttribute('data-search-match') === 'true');
    assert(await page.locator('ce-rich-message ce-rich-rows td ce-rich-parts strong').textContent().then((text) => text.includes('END_CELL')),
      'a giant table cell must preserve formatting and reveal the matching fragment');
    assert.deepStrictEqual(errors, []);
  } finally {
    await page.close();
  }
}

module.exports = async function testLargeMessages(browser) {
  await testMainMessage(browser);
  await testViewerMessage(browser);
  console.log('large-message browser regression passed (2 MiB rich output, dense/large math, code, exact copy, worker cancellation, safe Markdown, fallback)');
};
