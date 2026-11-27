'use strict';

const assert = require('assert');
const path = require('path');

module.exports = async function testEnhancementScheduling(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.setContent('<!doctype html><div class="messagesContainer_test" style="height:400px;overflow:auto"></div>');
    await page.evaluate(() => {
      window.__CLAUDE_ENHANCE_TEST_MODE__ = true;
      window.__CLAUDE_ENHANCE_CONFIG__ = { copyButtons: false };
    });
    for (const name of ['katex.min.js', 'highlight.min.js', 'runtime-core.js', 'math-core.js', 'enhance.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '..', 'vendor', name) });
    }
    const result = await page.evaluate(async () => {
      const api = window.__CLAUDE_ENHANCE_TEST_API__;
      const container = document.querySelector('.messagesContainer_test');
      const roots = [];
      const runs = [];
      let frame = 0;
      let keepCounting = true;
      const heartbeat = () => {
        frame++;
        if (keepCounting) requestAnimationFrame(heartbeat);
      };
      requestAnimationFrame(heartbeat);
      const originalHighlight = window.hljs.highlight;
      window.hljs.highlight = (...args) => {
        runs.push({ frame, text: args[0] });
        const startedAt = performance.now();
        while (performance.now() - startedAt < 8) {}
        return originalHighlight(...args);
      };
      for (let index = 0; index < 12; index++) {
        const root = document.createElement('div');
        root.className = 'timelineMessage_test';
        root.style.height = '24px';
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-javascript';
        code.textContent = `const value = ${index};`;
        pre.append(code);
        root.append(pre);
        container.append(root);
        roots.push(root);
      }
      api.enqueueRichEnhancements(roots, ['code'], 'browser-regression');
      roots.at(-1).remove();
      const deadline = performance.now() + 10000;
      while (api.diagnosticsSnapshot().scheduler.richPending && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      keepCounting = false;
      window.hljs.highlight = originalHighlight;
      return {
        runs,
        codeCount: container.querySelectorAll('code.hljs').length,
        scheduler: api.diagnosticsSnapshot().scheduler,
      };
    });
    assert.strictEqual(result.codeCount, 11, 'all connected queued code blocks should eventually be highlighted');
    assert.strictEqual(result.runs.length, 11, 'removed roots should be dropped and each stable code block processed once');
    assert.strictEqual(new Set(result.runs.map((run) => run.frame)).size, result.runs.length,
      'expensive queued blocks should yield to the next animation frame between tasks');
    assert(result.scheduler.richPending === 0 && result.scheduler.richDropped >= 1 && result.scheduler.richYieldedFrames > 0,
      'the scheduler should finish without leaking dropped or yielded entries');
    assert.deepStrictEqual(errors, [], 'scheduled enhancement should not cause browser errors');
    console.log(`enhancement browser regression passed (${result.runs.length} heavy blocks across ${new Set(result.runs.map((run) => run.frame)).size} frames)`);
  } finally {
    await page.close();
  }
};
