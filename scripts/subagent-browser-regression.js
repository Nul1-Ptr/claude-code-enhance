'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');
const { transcriptHtml } = require('../lib/subagent-sidebar');
const testModulePatch = require('./module-browser-regression');
const testEnhancementScheduling = require('./enhancement-browser-regression');
const testLargeMessages = require('./large-message-browser-regression');
const testInstalledMarkdown = require('./installed-markdown-browser-regression');
const testPagedSubagent = require('./paged-subagent-browser-regression');

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
    await testModulePatch(browser);
    await testInstalledMarkdown(browser);
    await testEnhancementScheduling(browser);
    await testLargeMessages(browser);
    await testPagedSubagent(browser);
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
    const origin = 'http://transcript-fixture.test';
    const html = transcriptHtml({ Uri: { joinPath: (base, ...segments) => [base, ...segments].join('/') } }, {
      asWebviewUri: (uri) => uri,
      cspSource: origin,
    }, origin);
    await page.route(`${origin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/vendor/')) {
        const extension = path.extname(pathname);
        await route.fulfill({
          body: fs.readFileSync(path.join(projectRoot, pathname)),
          contentType: extension === '.js' ? 'text/javascript' : extension === '.css' ? 'text/css' : 'font/woff2',
        });
      } else {
        await route.fulfill({ contentType: 'text/html', body: html });
      }
    });
    await page.addInitScript(() => {
      window.__hostMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          window.__hostMessages.push(message);
          window.__hostMessageHandler?.(message);
        },
        getState() { return {}; },
        setState(value) { window.__savedState = value; },
      });
    });
    await page.goto(origin);
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

    const retainedDom = await page.evaluate(async () => {
      const transcript = document.getElementById('transcript');
      const article = transcript.querySelector('.message');
      const focusTarget = article.querySelector('summary');
      focusTarget.focus({ preventScroll: true });
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(article.querySelector('header strong'));
      selection.removeAllRanges();
      selection.addRange(range);
      const selectedText = selection.toString();
      const removedMessages = [];
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) for (const node of mutation.removedNodes) {
          if (node.classList?.contains('message')) removedMessages.push(node.dataset.messageKey);
        }
      });
      observer.observe(transcript, { childList: true });
      window.dispatchEvent(new Event('resize'));
      for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
      observer.disconnect();
      return {
        removedMessages,
        focused: document.activeElement === focusTarget,
        selectedText,
        retainedSelection: selection.toString(),
      };
    });
    assert(retainedDom.selectedText && retainedDom.focused &&
      retainedDom.selectedText === retainedDom.retainedSelection && retainedDom.removedMessages.length === 0,
    'height/viewport refreshes must keep mounted messages connected, focused, and selected');

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

    const shiftedWindow = await page.evaluate(async () => {
      const transcript = document.getElementById('transcript');
      const previous = new Map(Array.from(transcript.querySelectorAll('.message'),
        (node) => [node.dataset.messageKey, node]));
      const removed = new Set();
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) for (const node of mutation.removedNodes) {
          if (node.classList?.contains('message')) removed.add(node.dataset.messageKey);
        }
      });
      observer.observe(transcript, { childList: true });
      window.scrollBy(0, 500);
      for (let frame = 0; frame < 12; frame++) await new Promise(requestAnimationFrame);
      observer.disconnect();
      const retained = Array.from(transcript.querySelectorAll('.message'))
        .filter((node) => previous.has(node.dataset.messageKey));
      return {
        retained: retained.length,
        removed: removed.size,
        remounted: retained.filter((node) => removed.has(node.dataset.messageKey)).length,
        replaced: retained.filter((node) => previous.get(node.dataset.messageKey) !== node).length,
      };
    });
    assert(shiftedWindow.removed > 0 && shiftedWindow.retained > 0 &&
      shiftedWindow.remounted === 0 && shiftedWindow.replaced === 0,
    `overlapping scroll windows must remove only outgoing messages: ${JSON.stringify(shiftedWindow)}`);
    await waitForStableVirtualWindow(page);

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
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 1);
    assert(await page.locator('.message').count() === 1, 'full-history search should return one message');
    assert((await page.locator('.message').innerText()).includes('needle-7777'),
      'search should find an unmounted historical message');

    await page.locator('#search').fill('');
    await page.locator('#search').dispatchEvent('input');
    await page.waitForFunction(() => document.getElementById('status')?.textContent === '');
    const idleFiltering = await page.evaluate(async () => {
      const nativeIdle = window.requestIdleCallback;
      window.requestIdleCallback = undefined;
      const originalLowerCase = String.prototype.toLocaleLowerCase;
      let slice = 0;
      let slowCalls = 0;
      let simulateCost = true;
      const callsPerSlice = new Map();
      const nativeTimeout = window.setTimeout;
      const status = document.getElementById('status');
      window.setTimeout = (callback, delay, ...args) => nativeTimeout(() => {
        slice++;
        callback(...args);
      }, delay);
      String.prototype.toLocaleLowerCase = function(...args) {
        const value = String(this);
        if (simulateCost && slowCalls < 20 && status.textContent === 'Searching transcript...' && value.includes('message body')) {
          slowCalls++;
          callsPerSlice.set(slice, (callsPerSlice.get(slice) || 0) + 1);
          const startedAt = performance.now();
          while (performance.now() - startedAt < 3) {}
        }
        return originalLowerCase.apply(this, args);
      };
      try {
        const search = document.getElementById('search');
        search.value = 'budget-no-match';
        search.dispatchEvent(new Event('input'));
        const deadline = performance.now() + 10000;
        while (!callsPerSlice.size && performance.now() < deadline) {
          await new Promise((resolve) => nativeTimeout(resolve, 1));
        }
        const interrupted = status.textContent === 'Searching transcript...';
        simulateCost = false;
        search.value = 'needle-7777';
        search.dispatchEvent(new Event('input'));
        while (status.textContent !== '1 messages shown' && performance.now() < deadline) {
          await new Promise((resolve) => nativeTimeout(resolve, 5));
        }
        return { interrupted, maxRecordsPerSlice: Math.max(0, ...callsPerSlice.values()), slices: callsPerSlice.size };
      } finally {
        window.requestIdleCallback = nativeIdle;
        window.setTimeout = nativeTimeout;
        String.prototype.toLocaleLowerCase = originalLowerCase;
      }
    });
    assert(idleFiltering.interrupted && idleFiltering.slices > 1 && idleFiltering.maxRecordsPerSlice <= 3,
      `fallback filtering must yield on time and accept a new query: ${JSON.stringify(idleFiltering)}`);
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 1 &&
      document.querySelector('.message').textContent.includes('needle-7777'));
    await page.locator('#search').fill('');
    await page.locator('#search').dispatchEvent('input');
    await page.locator('[data-filter="errors"]').click();
    await page.waitForFunction(() => document.getElementById('status')?.textContent === '1 messages shown');
    assert(await page.locator('.message-error').count() === 1, 'error filter should query complete history data');
    await page.evaluate(({ transcript, message }) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'replaceStart', transcript } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'replaceChunk', messages: [message] } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'replaceComplete', transcript } }));
    }, { transcript: metadata, message: transcriptMessage(0) });
    await page.waitForFunction(() => document.getElementById('status')?.textContent === '0 messages shown');
    assert(await page.locator('[data-filter="errors"]').getAttribute('aria-pressed') === 'true',
      'full transcript replacement should preserve the active sub-agent filter');

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
    await page.locator('#search').fill('message body 0');
    await page.locator('#search').dispatchEvent('input');
    await page.waitForFunction(() => document.querySelector('.thinking-block[open] .markdown-content')?.textContent
      .includes('message body 0'));
    assert(await page.locator('.message').count() === 1,
      'search should reveal matches inside a cached, previously collapsed sub-agent message');

    const conversationMessages = Array.from({ length: 10_000 }, (_, index) => ({
      id: `conversation-${index}`,
      line: index + 1,
      conversationIndex: index,
      largeRecord: index === 9_998,
      role: index % 2 ? 'assistant' : 'user',
      timestamp: '2026-10-21T12:00:00.000Z',
      blocks: [{
        kind: 'text',
        text: index === 7_777
          ? 'needle-7777 in the oldest conversation history'
          : index === 9_999
            ? 'unsafe-marker <script>window.__historyXss = true</script> content'
            : `message body ${index}`,
      }],
    }));
    conversationMessages[0].blocks = [
      { kind: 'text', text: 'Lazy content fixture' },
      { kind: 'thinking', text: 'deferred-thinking $x^2$\n\n' + 'Reasoning prose. '.repeat(1000) },
      { kind: 'tool', name: 'Read', text: JSON.stringify({ prompt: 'deferred-tool ' + 'payload '.repeat(3000) }) },
      { kind: 'tool-result', text: 'deferred-result ' + 'output '.repeat(10000) },
    ];
    const conversationMetadata = {
      bytes: 5_000_000,
      lines: 10_000,
      malformedLines: 0,
      partialLine: false,
      messageCount: conversationMessages.length,
      descriptor: {
        sessionId: 'conversation-browser',
        projectLabel: 'browser-fixture',
        label: '10,000 message conversation',
        status: 'completed',
      },
    };
    const deliveredPageSizes = [];
    const searchBatchSizes = [];
    const openedRawLines = [];
    let cancelledSearches = 0;
    await page.exposeFunction('__handleConversationRequest', async (request) => {
      if (request.type === 'loadPage') {
        const pageIndex = Math.max(0, Number(request.pageIndex) || 0);
        const messages = conversationMessages.slice(pageIndex * 60, (pageIndex + 1) * 60);
        deliveredPageSizes.push(messages.length);
        await page.evaluate(({ transcript, requestId, pageIndex, messages, preserveScroll }) => {
          window.dispatchEvent(new MessageEvent('message', {
            data: {
              type: 'conversationPage',
              requestId,
              preserveScroll,
              pageIndex,
              pageSize: 60,
              totalMessages: transcript.messageCount,
              transcript,
              messages,
            },
          }));
        }, {
          transcript: conversationMetadata,
          requestId: request.requestId,
          pageIndex,
          messages,
          preserveScroll: request.preserveScroll === true,
        });
      } else if (request.type === 'search') {
        const matches = conversationMessages.reduce((found, message) => {
          const text = message.blocks.map((block) => block.text).join('\n').toLocaleLowerCase();
          if (text.includes(String(request.query).toLocaleLowerCase())) {
            found.push({
              messageIndex: message.conversationIndex,
              line: message.line,
              role: message.role,
              preview: message.blocks[0].text.slice(0, 120),
            });
          }
          return found;
        }, []);
        const start = request.continuationToken ? Number(request.continuationToken) : 0;
        const hits = matches.slice(start, start + 50);
        searchBatchSizes.push(hits.length);
        const next = start + hits.length;
        await page.evaluate(({ requestId, query, hits, continuationToken, done }) => {
          window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'searchResults', requestId, query, hits, continuationToken, done },
          }));
        }, {
          requestId: request.requestId,
          query: request.query,
          hits,
          continuationToken: next < matches.length ? String(next) : null,
          done: next >= matches.length,
        });
      } else if (request.type === 'cancelSearch') {
        cancelledSearches++;
      } else if (request.type === 'openRaw') {
        openedRawLines.push(request.line);
      }
    });
    await page.evaluate(() => {
      window.__hostMessageHandler = (message) => window.__handleConversationRequest(message);
    });
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'conversationLoading', label: '10,000 message conversation' },
      }));
    });
    await page.waitForFunction(() => document.getElementById('transcript')?.textContent
      .includes('Indexing local conversation history'));
    assert(await page.locator('#filter-group').isHidden(), 'conversation mode should hide sub-agent filters');
    await page.evaluate((transcript) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'conversationStart', requestId: 'initial-conversation-test', transcript },
      }));
    }, conversationMetadata);
    assert(await page.locator('#search').isDisabled(),
      'history search should stay disabled until its first page is installed');
    const savedStateBeforeConversation = await page.evaluate(() => window.__savedState);
    const lastConversationPage = Math.ceil(conversationMessages.length / 60) - 1;
    const latestMessages = conversationMessages.slice(lastConversationPage * 60);
    deliveredPageSizes.push(latestMessages.length);
    await page.evaluate(({ transcript, pageIndex, messages }) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'conversationPage',
          requestId: 'initial-conversation-test',
          pageIndex,
          pageSize: 60,
          totalMessages: transcript.messageCount,
          transcript,
          messages,
        },
      }));
    }, { transcript: conversationMetadata, pageIndex: lastConversationPage, messages: latestMessages });
    await page.waitForFunction(() => document.querySelectorAll('.message').length > 0 &&
      document.getElementById('transcript').getAttribute('aria-busy') === 'false');
    assert(await page.locator('.message').count() <= 60,
      'conversation history mode should keep only the current page mounted');
    assert(await page.locator('#conversation-page-label').innerText() === '167 / 167 · 10000 messages',
      'conversation history mode should expose paginated position and total count');
    await page.locator('.message-raw-link').click();
    assert(openedRawLines.includes(9_999), 'large-record controls should request raw JSONL at the record line');

    await page.evaluate(() => {
      window.scrollTo(0, document.getElementById('transcript').offsetTop + 200);
      window.__historyAnchorArticle = document.querySelector('.message');
    });
    const beforeAppend = await page.evaluate(() => window.scrollY);
    for (let index = 10_000; index < 10_025; index++) {
      conversationMessages.push({ ...transcriptMessage(index), conversationIndex: index });
    }
    conversationMetadata.messageCount = conversationMessages.length;
    await page.evaluate((transcript) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'conversationUpdate', messagesChanged: true, transcript,
      } }));
    }, conversationMetadata);
    assert(await page.locator('#conversation-page-label').innerText() === '167 / 168 · 10025 messages',
      'append updates should change totals while leaving the current page selected');
    assert(await page.evaluate(() => window.__historyAnchorArticle === document.querySelector('.message')),
      'append updates should preserve existing article nodes and expanded states');
    assert(Math.abs(await page.evaluate(() => window.scrollY) - beforeAppend) < 3,
      'new messages should not change the current reading position');
    assert((await page.locator('#conversation-latest').innerText()).includes('25 new messages'),
      'new messages should have an explicit Latest action');
    await page.locator('#conversation-latest').click();
    await page.waitForFunction(() => document.getElementById('conversation-page-label')?.textContent
      .startsWith('168 / 168') && document.querySelectorAll('.message').length === 5);
    assert(await page.locator('.message').count() === 5, 'Latest should load only the newly requested page');

    await page.locator('#conversation-page-input').fill('167');
    await page.locator('#conversation-page-input').press('Enter');
    await page.waitForFunction(() => document.getElementById('conversation-page-label')?.textContent
      .startsWith('167 / 168'));

    await page.locator('#conversation-previous').click();
    await page.waitForFunction(() => document.body.textContent.includes('message body 9900'));
    assert(await page.locator('.message').count() <= 60,
      'older-page navigation should not retain previous-page DOM');
    assert(deliveredPageSizes.every((size) => size <= 60),
      'the host should send at most one page of 60 messages to the Webview');

    await page.locator('#conversation-first').click();
    await page.waitForFunction(() => document.getElementById('conversation-page-label')?.textContent
      .startsWith('1 / 168') && document.querySelector('.message')?.dataset.messageLine === '1');
    const firstMessage = page.locator('.message').first();
    assert(await firstMessage.locator(':scope > details').count() === 3 &&
      await firstMessage.locator('details .markdown-content, details .tool-code').count() === 0,
    'collapsed thinking and tool bodies should not create rich content DOM');
    await firstMessage.locator('.thinking-block > summary').click();
    await firstMessage.locator('.thinking-block .katex').first().waitFor();
    await page.evaluate(() => { window.__expandedThinking = document.querySelector('.thinking-block .markdown-content'); });
    await firstMessage.locator('.thinking-block > summary').click();
    await firstMessage.locator('.thinking-block > summary').click();
    assert(await page.evaluate(() => window.__expandedThinking === document.querySelector('.thinking-block .markdown-content')),
      'reopening a disclosure should reuse its rendered body');
    await firstMessage.locator('.thinking-block > summary').click();
    await firstMessage.locator('.tool-block > summary').click();
    await page.waitForFunction(() => document.querySelector('.tool-block code.hljs'));
    assert(await firstMessage.locator('.tool-block code').innerText() === conversationMessages[0].blocks[2].text,
      'lazy tool rendering should preserve its complete source');
    await firstMessage.locator('.tool-block > summary').click();
    assert(await firstMessage.locator('.tool-result .tool-code').count() === 0,
      'opening another disclosure must not render a collapsed tool result');

    await page.locator('#search').fill('deferred-thinking');
    await page.locator('#search').dispatchEvent('input');
    await page.waitForFunction(() => document.querySelectorAll('.conversation-search-hit').length === 1);
    await page.locator('.conversation-search-hit').click();
    await page.locator('.thinking-block[open] .katex').first().waitFor();
    assert(await firstMessage.locator('.tool-block[open], .tool-result[open]').count() === 0,
      'search navigation should reveal only matching disclosures');

    await page.locator('#search').fill('needle-7777');
    await page.locator('#search').dispatchEvent('input');
    await page.waitForFunction(() => document.querySelectorAll('.conversation-search-hit').length === 1);
    assert(searchBatchSizes.at(-1) === 1,
      'full-history search should find a match outside the currently loaded page');
    await page.locator('.conversation-search-hit').click();
    await page.waitForFunction(() => document.body.textContent.includes('needle-7777'));
    assert(await page.locator('.message').count() <= 60,
      'jumping to an old search result should load only its page');

    await page.locator('#search').fill('message body');
    await page.locator('#search').dispatchEvent('input');
    await page.waitForFunction(() => document.querySelectorAll('.conversation-search-hit').length === 50);
    assert(searchBatchSizes.at(-1) === 50,
      'history search should stream bounded batches instead of all results');
    await page.locator('#conversation-search-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.conversation-search-hit').length === 100);
    assert(await page.locator('.conversation-search-hit').count() <= 300,
      'search results should keep Webview result DOM bounded');
    for (let count = 150; count <= 400; count += 50) {
      await page.locator('#conversation-search-more').click();
      await page.waitForFunction((expected) => document.getElementById('conversation-search-summary')?.textContent
        .startsWith(`${expected} matches`), count);
      assert(await page.locator('.conversation-search-hit').count() <= 300,
        'later search batches should replace old snippets within a bounded DOM');
    }
    assert(await page.locator('#conversation-search-more').isVisible(),
      'history search should continue beyond the first 300 matches');
    const cancellationsBeforeAppend = cancelledSearches;
    await page.evaluate((transcript) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'conversationUpdate', messagesChanged: true,
        transcript: { ...transcript, messageCount: 10026 },
      } }));
    }, conversationMetadata);
    assert(await page.locator('#search').inputValue() === 'message body' &&
      await page.locator('.conversation-search-hit').count() === 300 && cancelledSearches === cancellationsBeforeAppend,
    'live appends should preserve the search query, results, and continuation');

    const batchesBeforeLongQuery = searchBatchSizes.length;
    await page.locator('#search').fill('x'.repeat(513));
    await page.locator('#search').dispatchEvent('input');
    await page.waitForFunction(() => document.getElementById('conversation-search-summary')?.textContent.includes('512 characters'));
    assert(searchBatchSizes.length === batchesBeforeLongQuery,
      'queries above the documented limit should be rejected before file search');

    await page.locator('#search').fill('unsafe-marker');
    await page.locator('#search').dispatchEvent('input');
    await page.waitForFunction(() => document.querySelectorAll('.conversation-search-hit').length === 1);
    await page.locator('.conversation-search-hit').click();
    await page.waitForFunction(() => document.body.textContent.includes('unsafe-marker'));
    assert(await page.locator('#transcript script, #transcript img').count() === 0 &&
      await page.evaluate(() => window.__historyXss !== true),
    'untrusted conversation Markdown should remain non-executable');
    await page.locator('#search').fill('');
    await page.locator('#search').dispatchEvent('input');
    await page.waitForFunction(() => document.getElementById('conversation-search-results').hidden);
    assert(cancelledSearches >= 1, 'clearing or replacing a query should cancel its in-flight search');
    assert(await page.evaluate(() => JSON.stringify(window.__savedState)) ===
      JSON.stringify(savedStateBeforeConversation),
      'conversation-history browsing should not overwrite persisted sub-agent transcript UI state');

    console.log('transcript browser regression passed (10,025 messages, DOM caps, connected window reuse, time-budgeted filtering, lazy disclosures, page jumps, stable reading position)');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
