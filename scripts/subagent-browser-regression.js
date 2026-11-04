'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('@playwright/test');

const projectRoot = path.join(__dirname, '..');

function transcriptMessage(index) {
  return {
    id: `message-${index}`,
    line: index + 1,
    role: index % 2 ? 'assistant' : 'user',
    agentType: index % 2 ? 'general-purpose' : null,
    error: index === 9999 ? 'server_error' : null,
    blocks: [{
      kind: index % 17 === 0 ? 'thinking' : 'text',
      text: index === 7777 ? 'needle-7777 in the complete transcript' : `message body ${index}`,
      isError: index === 9999,
    }],
  };
}

async function waitForStableView(page) {
  await page.waitForFunction(() => {
    const status = document.getElementById('status')?.textContent || '';
    const count = document.querySelectorAll('.message').length;
    return count > 0 && count <= 100 && !/Loading|Searching/.test(status);
  });
}

async function waitForStableVirtualWindow(page) {
  await page.waitForFunction(() => {
    const firstKey = document.querySelector('.message')?.dataset.messageKey || '';
    const signature = `${firstKey}:${Math.round(window.scrollY)}:${document.querySelectorAll('.message').length}`;
    const now = performance.now();
    if (window.__virtualWindowSignature !== signature) {
      window.__virtualWindowSignature = signature;
      window.__virtualWindowStableSince = now;
      return false;
    }
    return now - (window.__virtualWindowStableSince || now) >= 250;
  });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: chromium.executablePath(),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
    await page.setContent(`<!doctype html><html><body>
      <header class="toolbar">
        <input id="search" type="search">
        <div class="filters">
          <button data-filter="all" aria-pressed="true">All</button>
          <button data-filter="assistant" aria-pressed="false">Answers</button>
          <button data-filter="thinking" aria-pressed="false">Thinking</button>
          <button data-filter="tools" aria-pressed="false">Tools</button>
          <button data-filter="errors" aria-pressed="false">Errors</button>
        </div>
        <button id="latest">Latest</button>
      </header>
      <section id="summary"></section>
      <main id="transcript" class="transcript" aria-busy="true"></main>
      <div id="status"></div>
    </body></html>`);
    await page.addStyleTag({ path: path.join(projectRoot, 'vendor', 'subagent-view.css') });
    await page.evaluate(() => {
      window.__hostMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return {}; },
        setState(value) { window.__savedState = value; },
      });
    });
    await page.addScriptTag({ path: path.join(projectRoot, 'vendor', 'marked.min.js') });
    await page.addScriptTag({ path: path.join(projectRoot, 'vendor', 'katex.min.js') });
    await page.addScriptTag({ path: path.join(projectRoot, 'vendor', 'highlight.min.js') });
    await page.addScriptTag({ path: path.join(projectRoot, 'vendor', 'subagent-view.js') });
    await page.waitForFunction(() => window.__hostMessages?.some((message) => message.type === 'ready'));

    const metadata = {
      filePath: '/fixture/agent-browser.jsonl',
      bytes: 4_000_000,
      lines: 10_000,
      malformedLines: 0,
      partialLine: false,
      descriptor: {
        agentId: 'browser',
        agentType: 'general-purpose',
        label: 'Browser regression',
        status: 'completed',
      },
    };
    await page.evaluate((transcript) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'replaceStart', transcript },
      }));
    }, metadata);
    for (let start = 0; start < 10_000; start += 250) {
      const messages = Array.from({ length: Math.min(250, 10_000 - start) }, (_, offset) => (
        transcriptMessage(start + offset)
      ));
      await page.evaluate((chunk) => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'replaceChunk', messages: chunk },
        }));
      }, messages);
    }
    await page.evaluate((transcript) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'replaceComplete', transcript },
      }));
    }, { ...metadata, messageCount: 10_000 });
    await waitForStableView(page);

    const initialCount = await page.locator('.message').count();
    assert(initialCount <= 100, `initial transcript DOM exceeded cap: ${initialCount}`);
    assert(await page.locator('.virtual-spacer[data-virtual-spacer="bottom"]').count() === 1,
      'long transcript should render a bottom virtual spacer');

    const firstKey = await page.locator('.message').first().getAttribute('data-message-key');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.55));
    await page.waitForFunction(() => window.scrollY > 1000);
    await page.waitForFunction((previousKey) => {
      const current = document.querySelector('.message')?.dataset.messageKey;
      return current && current !== previousKey && document.querySelectorAll('.message').length <= 100;
    }, firstKey);
    await waitForStableVirtualWindow(page);

    const anchor = await page.evaluate(() => {
      const messages = Array.from(document.querySelectorAll('.message'));
      const element = messages.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      });
      if (!element) {
        return {
          key: null,
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          transcriptTop: document.getElementById('transcript')?.getBoundingClientRect().top,
          topSpacer: document.querySelector('[data-virtual-spacer="top"]')?.getBoundingClientRect().toJSON(),
          bottomSpacer: document.querySelector('[data-virtual-spacer="bottom"]')?.getBoundingClientRect().toJSON(),
          first: messages[0]?.getBoundingClientRect().toJSON(),
          last: messages.at(-1)?.getBoundingClientRect().toJSON(),
          count: messages.length,
        };
      }
      const rect = element.getBoundingClientRect();
      return { key: element.dataset.messageKey, top: rect.top };
    });
    assert(anchor.key, `Expected a visible virtualized message: ${JSON.stringify(anchor)}`);
    const resizeSetup = await page.evaluate(() => {
      const messages = Array.from(document.querySelectorAll('.message'));
      const element = Array.from(document.querySelectorAll('.message'))
        .filter((candidate) => candidate.getBoundingClientRect().bottom <= 0)
        .at(-1);
      if (!element) {
        return {
          key: null,
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          first: messages[0]?.getBoundingClientRect().toJSON(),
          last: messages.at(-1)?.getBoundingClientRect().toJSON(),
          count: messages.length,
        };
      }
      const expansion = document.createElement('div');
      expansion.style.height = '360px';
      expansion.textContent = 'resize regression';
      const beforeRect = element.getBoundingClientRect().toJSON();
      const beforeScrollY = window.scrollY;
      element.appendChild(expansion);
      return { key: element.dataset.messageKey, beforeRect, beforeScrollY };
    });
    assert(resizeSetup.key, `Expected an overscanned message above the viewport: ${JSON.stringify(resizeSetup)}`);
    const expandedKey = resizeSetup.key;
    await page.waitForFunction((beforeScrollY) => window.scrollY > beforeScrollY + 300,
      resizeSetup.beforeScrollY);
    await waitForStableVirtualWindow(page);
    const corrected = await page.evaluate(({ anchorKey, expandedKey }) => {
      const element = Array.from(document.querySelectorAll('.message'))
        .find((candidate) => candidate.dataset.messageKey === anchorKey);
      const expanded = Array.from(document.querySelectorAll('.message'))
        .find((candidate) => candidate.dataset.messageKey === expandedKey);
      return {
        anchorTop: element?.getBoundingClientRect().top,
        expandedRect: expanded?.getBoundingClientRect().toJSON(),
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
      };
    }, { anchorKey: anchor.key, expandedKey });
    assert(Number.isFinite(corrected.anchorTop) && Math.abs(corrected.anchorTop - anchor.top) < 8,
      `ResizeObserver anchor shifted by ${corrected.anchorTop - anchor.top}px: ${JSON.stringify({ anchor, resizeSetup, corrected })}`);
    assert(expandedKey !== anchor.key, 'resize regression should expand a message above the visible anchor');

    const refreshAnchor = await page.evaluate(() => {
      const element = Array.from(document.querySelectorAll('.message')).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      });
      const rect = element?.getBoundingClientRect();
      return { key: element?.dataset.messageKey || null, top: rect?.top };
    });
    assert(refreshAnchor.key, 'same-file refresh should start from a visible semantic anchor');
    await page.evaluate((transcript) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'replaceStart', transcript },
      }));
    }, metadata);
    for (let start = 0; start < 10_000; start += 250) {
      const messages = Array.from({ length: Math.min(250, 10_000 - start) }, (_, offset) => (
        transcriptMessage(start + offset)
      ));
      await page.evaluate((chunk) => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'replaceChunk', messages: chunk },
        }));
      }, messages);
    }
    await page.evaluate((transcript) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'replaceComplete', transcript },
      }));
    }, { ...metadata, messageCount: 10_000 });
    await waitForStableView(page);
    await waitForStableVirtualWindow(page);
    const refreshedAnchor = await page.evaluate((key) => {
      const element = Array.from(document.querySelectorAll('.message'))
        .find((candidate) => candidate.dataset.messageKey === key);
      return {
        key: element?.dataset.messageKey || null,
        top: element?.getBoundingClientRect().top,
        firstKey: document.querySelector('.message')?.dataset.messageKey || null,
        lastKey: Array.from(document.querySelectorAll('.message')).at(-1)?.dataset.messageKey || null,
        scrollY: window.scrollY,
      };
    }, refreshAnchor.key);
    assert(refreshedAnchor.key && Math.abs(refreshedAnchor.top - refreshAnchor.top) < 8,
      `same-file full refresh shifted the semantic anchor: ${JSON.stringify({ refreshAnchor, refreshedAnchor })}`);
    assert(await page.locator('.message').count() <= 100,
      'same-file full refresh should preserve the transcript DOM cap');

    await page.locator('#search').fill('needle-7777');
    await page.locator('#search').dispatchEvent('input');
    await page.waitForFunction(() => document.getElementById('status')?.textContent === '1 messages shown');
    assert(await page.locator('.message').count() === 1, 'full-history search should return one message');
    assert((await page.locator('.message').innerText()).includes('needle-7777'),
      'search should find an unmounted historical message');

    await page.locator('#search').fill('');
    await page.locator('#search').dispatchEvent('input');
    await page.locator('[data-filter="errors"]').click();
    await page.waitForFunction(() => document.getElementById('status')?.textContent === '1 messages shown');
    assert(await page.locator('.message-error').count() === 1, 'error filter should query complete history data');

    await page.locator('[data-filter="all"]').click();
    await page.waitForFunction(() => !/Searching/.test(document.getElementById('status')?.textContent || ''));
    const appended = transcriptMessage(10_000);
    await page.evaluate(({ transcript, message }) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'appendStart', transcript } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'append', messages: [message] } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'appendComplete', transcript } }));
    }, {
      transcript: { ...metadata, lines: 10_001, messageCount: 10_001 },
      message: appended,
    });
    await page.locator('#latest').click();
    await page.waitForFunction(() => document.body.textContent.includes('message body 10000'));
    const finalCount = await page.locator('.message').count();
    assert(finalCount <= 100, `appended transcript DOM exceeded cap: ${finalCount}`);

    console.log('sub-agent browser regression passed (10,001 messages, DOM <= 100)');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
