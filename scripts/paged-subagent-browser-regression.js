'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TranscriptPanelManager, transcriptHtml } = require('../lib/subagent-sidebar');

module.exports = async function testPagedSubagent(browser) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-paged-browser-'));
  const filePath = path.join(root, 'agent-local.jsonl');
  const page = await browser.newPage();
  const origin = 'http://paged-agent.test';
  const vscode = { workspace: { getConfiguration: () => ({ get: () => root }) },
    ViewColumn: { Beside: 2 }, Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') } };
  const html = transcriptHtml(vscode, { asWebviewUri: (uri) => uri, cspSource: origin }, origin);
  const manager = new TranscriptPanelManager(vscode, { subscriptions: [] });
  const messages = [];
  try {
    const giant = Array.from({ length: 1000 }, (_, index) => `Paragraph ${index}`).join('\n\n') + '\n\n' +
      '**' + 'long paragraph '.repeat(6000) + 'DEEP_PROSE_TARGET**\n\n```javascript\n' +
      'const line = 1;\n'.repeat(4000) + 'const last = "DEEP_ROW_TARGET";\n```\n\n' +
      '| Cell |\n|---|\n| ' + 'cell '.repeat(17000) + 'DEEP_CELL_TARGET |';
    const record = (index) => ({ type: 'assistant', uuid: `agent-${index}`, message: { role: 'assistant', content: [
      { type: index === 65 || index % 10 === 0 ? 'thinking' : 'text', text: index === 65 ? giant :
        `Message ${index} ` + (index < 60 ? 'body '.repeat(4000) : '') },
    ] } });
    fs.writeFileSync(filePath, Array.from({ length: 10000 }, (_, index) => JSON.stringify(record(index)) + '\n').join(''));
    await page.route(`${origin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (!pathname.startsWith('/vendor/')) return route.fulfill({ contentType: 'text/html', body: html });
      const extension = path.extname(pathname);
      return route.fulfill({ body: fs.readFileSync(path.join(__dirname, '..', pathname)),
        contentType: extension === '.js' ? 'text/javascript' : extension === '.css' ? 'text/css' : 'font/woff2' });
    });
    await page.exposeFunction('__hostRequest', (request) => {
      if (request.type === 'loadPage') {
        if (request.ackToken) manager.acknowledgePageChunk(request);
        else return manager.loadConversationPage(request);
      } else if (request.type === 'search') return manager.searchConversation(request);
      else if (request.type === 'cancelSearch') manager.cancelConversationSearches();
    });
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({ postMessage: (message) => window.__hostRequest(message), getState: () => ({}),
        setState: (state) => { window.__savedState = state; } });
    });
    await page.goto(origin);
    manager.panel = { visible: true, reveal() {}, dispose() {}, webview: { postMessage: async (message) => {
      messages.push({ type: message.type, bytes: Buffer.byteLength(JSON.stringify(message)), count: message.messages?.length || 0 });
      await page.evaluate((data) => window.dispatchEvent(new MessageEvent('message', { data })), message);
      return true;
    } } };
    manager.watchTranscriptFile = () => {};
    manager.show({ filePath, sessionId: 'agent-local', label: 'Paged agent' });
    manager.ready = true;
    await manager.loadConversationNow(true);
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 40);
    assert(await page.locator('#filter-group').isVisible());
    await page.locator('#conversation-first').click();
    await page.waitForFunction(() => document.querySelector('.message')?.dataset.messageLine === '1' &&
      document.getElementById('transcript').getAttribute('aria-busy') === 'false');
    assert(await page.locator('.message').count() <= 60);
    assert(messages.filter((message) => message.type === 'conversationPageChunk').length >= 2,
      'the real host must await Webview acknowledgements between byte-bounded page chunks');
    assert(messages.filter((message) => message.type === 'conversationPageChunk').every((message) => message.bytes < 520 * 1024));
    await page.locator('[data-filter="thinking"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.conversation-search-hit').length === 50);
    await page.locator('#search').fill('Message 9990');
    await page.waitForFunction(() => document.querySelectorAll('.conversation-search-hit').length === 1);
    assert(await page.evaluate(() => window.__savedState.filter === 'thinking' && window.__savedState.query === 'Message 9990'),
      'paged sub-agent filters and queries must survive Webview suspension');
    await page.locator('.conversation-search-hit').click();
    await page.waitForFunction(() => document.querySelector('.message[data-message-line="9991"]'));
    assert(await page.locator('.message').count() <= 60);
    await page.locator('[data-filter="all"]').click();
    await page.locator('#search').fill('');
    await page.waitForFunction(() => document.getElementById('conversation-search-results').hidden);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(100);
    fs.appendFileSync(filePath, JSON.stringify(record(10000)) + '\n');
    await manager.loadConversationNow();
    await page.waitForFunction(() => document.querySelector('.message[data-message-line="10001"]'));
    assert(!manager.historyIndex.messages && manager.pageAcknowledgements.size === 0);
    for (const query of ['DEEP_PROSE_TARGET', 'DEEP_ROW_TARGET', 'DEEP_CELL_TARGET']) {
      await page.locator('#search').fill(query);
      await page.waitForFunction((needle) => {
        const hits = document.querySelectorAll('.conversation-search-hit');
        return hits.length === 1 && hits[0].textContent.includes(needle);
      }, query);
      await page.locator('.conversation-search-hit').click();
      await page.waitForFunction((needle) => {
        const rich = document.querySelector('.message[data-message-line="66"] ce-rich-message');
        const block = rich?.shadowRoot.querySelector('section');
        if (!block || rich.forcedBlock !== null) return false;
        const roots = [rich.shadowRoot];
        for (let cursor = 0; cursor < roots.length; cursor++) {
          for (const element of roots[cursor].querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
        }
        return roots.some((root) => Array.from(root.querySelectorAll('[data-search-match="true"]')).some((element) =>
          element.textContent.includes(needle) && element.getBoundingClientRect().bottom > 0 && element.getBoundingClientRect().top < innerHeight));
      }, query, { timeout: 60000 }).catch(async (error) => {
        console.error('Search navigation state', query, await page.evaluate(() => {
          const rich = document.querySelector('.message[data-message-line="66"] ce-rich-message');
          return { status: document.getElementById('status')?.textContent, render: rich?.dataset.ceRenderState,
            forcedBlock: rich?.forcedBlock, range: rich?.windowRange, near: rich?.nearViewport,
            parts: Array.from(rich?.shadowRoot.querySelectorAll('ce-rich-parts') || [], (part) => ({ ...part.dataset })),
            top: rich?.getBoundingClientRect().top, scrollY, worker: window.__CLAUDE_ENHANCE_RICH__.diagnostics };
        }));
        throw error;
      });
      assert(await page.locator('.message').count() <= 60);
      assert(await page.locator('.message[data-message-line="66"] ce-rich-message section').count() <= 64,
        'global search must move the inner block window without mounting all thousand paragraphs');
    }
    console.log('paged sub-agent browser regression passed (10,001 records, real host paging, acknowledgements, global filters, live append)');
  } finally {
    manager.dispose();
    await page.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
};
