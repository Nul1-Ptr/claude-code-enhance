'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const history = require('../lib/conversation-history');
const sidebar = require('../lib/subagent-sidebar');
const { isDisplayableTranscriptRecord, parseTranscriptRecord } = require('../lib/subagent-transcripts');
const { createJsonlSearch } = require('../lib/jsonl-search');

function jsonLine(record) {
  return `${JSON.stringify(record)}\n`;
}

function record(index, text = `message body ${index}`) {
  const role = index % 2 ? 'assistant' : 'user';
  return {
    type: role,
    uuid: `message-${index}`,
    cwd: '/tmp/conversation-history-fixture',
    timestamp: '2026-10-21T12:00:00.000Z',
    message: { role, content: text },
  };
}

async function testConversationSelectionRace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-conversation-race-'));
  const firstPath = path.join(root, 'first.jsonl');
  const secondPath = path.join(root, 'second.jsonl');
  fs.writeFileSync(firstPath, jsonLine(record(0)));
  fs.writeFileSync(secondPath, jsonLine(record(1)));
  const firstDescriptor = { filePath: firstPath, sessionId: 'first', label: 'first' };
  const secondDescriptor = { filePath: secondPath, sessionId: 'second', label: 'second' };
  const pending = new Map();
  const originalBuild = history.buildConversationIndex;
  const postedMessages = [];
  history.buildConversationIndex = (descriptor) => new Promise((resolve) => {
    pending.set(descriptor.filePath, resolve);
  });
  const manager = new sidebar.TranscriptPanelManager({}, { subscriptions: [] });
  manager.panel = {
    visible: true,
    webview: { postMessage: (message) => { postedMessages.push(message); return Promise.resolve(); } },
    dispose() {},
  };
  manager.ready = true;
  manager.mode = 'conversation';
  manager.historyRoot = root;
  manager.historyViewNeedsReload = true;
  manager.descriptor = firstDescriptor;
  manager.loadConversationPage = async () => {};

  const createIndex = (descriptor) => ({
    filePath: descriptor.filePath,
    sessionId: descriptor.sessionId,
    bytes: 0,
    lines: 0,
    malformedLines: 0,
    partialLine: false,
    messageCount: 0,
  });

  try {
    const firstLoad = manager.loadConversationNow(true);
    manager.generation++;
    manager.historyGeneration++;
    manager.descriptor = secondDescriptor;
    manager.historyIndex = null;
    manager.historyPageIndex = -1;
    manager.historyViewNeedsReload = true;
    const secondLoad = manager.loadConversationNow(true);
    while (!pending.has(firstPath) || !pending.has(secondPath)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    pending.get(secondPath)(createIndex(secondDescriptor));
    await secondLoad;
    pending.get(firstPath)(createIndex(firstDescriptor));
    await firstLoad;
    assert(manager.historyIndex.filePath === secondPath,
      'a stale indexing request must not overwrite the newly selected conversation index');
    const startMessage = postedMessages.find((message) => message.type === 'conversationStart');
    assert(startMessage && !Object.prototype.hasOwnProperty.call(startMessage.transcript, 'filePath') &&
      !Object.prototype.hasOwnProperty.call(startMessage.transcript.descriptor, 'filePath'),
    'conversation metadata sent to the Webview must not expose local file paths');
  } finally {
    history.buildConversationIndex = originalBuild;
    manager.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testPagedIndexSearchAndRecovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-conversation-history-'));
  const projectId = '-tmp-conversation-history-fixture';
  const projectPath = path.join(root, projectId);
  const filePath = path.join(projectPath, '11111111-2222-3333-4444-555555555555.jsonl');
  fs.mkdirSync(projectPath, { recursive: true });
  const source = [];
  for (let index = 0; index < 10_000; index++) {
    if (index === 31) source.push('{not valid json}\n');
    if (index === 3) {
      source.push(jsonLine({
        type: 'assistant',
        uuid: `message-${index}`,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'sample.js' } }] },
      }));
    } else if (index === 4) {
      source.push(jsonLine({
        type: 'user',
        uuid: `message-${index}`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: `batch-hit result ${index}` }] }] },
      }));
    } else if (index === 5) {
      source.push(jsonLine({
        ...record(index, 'diagnostic detail'),
        error: 'service unavailable',
      }));
    } else if (index === 6) {
      source.push(jsonLine({
        type: 'assistant',
        uuid: `message-${index}`,
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning marker' }] },
      }));
    } else {
      const text = index === 7_777
        ? 'needle-7777 plus λambda Unicode result'
        : `batch-hit ${index} ${'payload '.repeat(8)}`;
      source.push(jsonLine(record(index, text)));
    }
  }
  const largeRecord = JSON.stringify(record(10_000,
    `needle-in-large-record ${'x'.repeat(history.CONVERSATION_MAX_RECORD_BYTES + 32)}`));
  source.push(`${largeRecord}\n`);
  const partialRecord = JSON.stringify(record(10_001, 'completed partial record'));
  const partialCut = Math.floor(partialRecord.length * 0.63);
  source.push(partialRecord.slice(0, partialCut));
  fs.writeFileSync(filePath, source.join(''));

  const descriptors = await history.listConversationFiles(root);
  assert(descriptors.length === 1, 'session discovery should find local main conversation JSONL only');
  const descriptor = descriptors[0];
  assert(descriptor.sessionId === path.basename(filePath, '.jsonl'), 'session id should derive from filename');
  assert(descriptor.label.includes('batch-hit 0'), 'session label should use an initial user prompt');
  assert(sidebar.OPEN_CONVERSATION_HISTORY_COMMAND === 'claude-code-enhance.openConversationHistory',
    'conversation history should expose a stable command id');
  assert(history.withinRoot(root, filePath), 'selected history should remain inside its configured root');
  assert(!history.withinRoot(root, path.join(os.tmpdir(), 'outside.jsonl')),
    'history path validation should reject paths outside its configured root');
  assert(history.withinPath('/workspace/project', '/workspace/project/subdir'),
    'workspace filtering should include nested directories');
  assert(!history.withinPath('/workspace/project', '/workspace/project-old'),
    'workspace filtering should reject similarly prefixed sibling directories');

  const index = await history.buildConversationIndex(descriptor);
  assert(index.messageCount === 10_001, `expected all complete visible records, got ${index.messageCount}`);
  assert(index.malformedLines === 1, 'malformed complete lines should be counted');
  assert(index.partialLine, 'an incomplete trailing line should be reported without indexing it');
  assert(index.checkpoints.length === Math.ceil(index.messageCount / history.CONVERSATION_INDEX_BLOCK_SIZE),
    'the host should retain only one sparse checkpoint per index block');
  assert(!Object.prototype.hasOwnProperty.call(index, 'messages'), 'the index must not retain message bodies');

  const firstPage = await history.loadConversationPage(index, 0);
  assert(firstPage.messages.length === history.CONVERSATION_PAGE_SIZE,
    'conversation pages should be capped at 60 messages');
  assert(firstPage.messages[3].blocks[0].kind === 'tool', 'tool-call blocks should parse on demand');
  assert(firstPage.messages[4].blocks[0].kind === 'tool-result', 'tool results should parse on demand');
  assert(firstPage.messages[5].error === 'service unavailable', 'API error metadata should be preserved');
  assert((await history.searchConversationPage(index, 'sample.js')).hits[0]?.messageIndex === 3,
    'search should include structured tool-call inputs');
  assert((await history.searchConversationPage(index, 'batch-hit result')).hits[0]?.messageIndex === 4,
    'search should include tool-result content');
  assert((await history.searchConversationPage(index, 'private reasoning')).hits[0]?.messageIndex === 6,
    'search should include thinking content');
  assert((await history.searchConversationPage(index, 'service unavailable')).hits[0]?.messageIndex === 5,
    'search should include API error content');

  const middlePage = await history.loadConversationPage(index, 30);
  assert(middlePage.messages.length === 60 && middlePage.messages[0].conversationIndex === 1_800,
    'sparse checkpoints should support bounded loading for older pages');
  const lastPageIndex = Math.ceil(index.messageCount / history.CONVERSATION_PAGE_SIZE) - 1;
  const lastPage = await history.loadConversationPage(index, lastPageIndex);
  assert(lastPage.messages.length === 41, 'the last page should contain only the remaining messages');
  assert(lastPage.messages.at(-1).largeRecord, 'oversized JSONL records should use a lightweight placeholder');
  assert(lastPage.messages.at(-1).rawOffset >= 0 && lastPage.messages.at(-1).rawLength > 0,
    'oversized placeholders should retain raw-record location metadata');

  const targeted = await history.searchConversationPage(index, 'needle-7777');
  assert(targeted.hits.length === 1 && targeted.hits[0].messageIndex === 7_777,
    'global search should locate a historical message outside the loaded page');
  const unicode = await history.searchConversationPage(index, 'λAMBDA');
  assert(unicode.hits.length === 1, 'global search should be case-insensitive for Unicode text');
  const oversized = await history.searchConversationPage(index, 'needle-in-large-record');
  assert(oversized.hits.length === 1 && oversized.hits[0].messageIndex === 10_000,
    'global search should scan oversized raw JSONL lines without parsing them into memory');

  const firstBatch = await history.searchConversationPage(index, 'batch-hit');
  assert(firstBatch.hits.length === history.CONVERSATION_SEARCH_BATCH_SIZE && !firstBatch.done && firstBatch.nextCursor,
    'large search results should be returned in bounded batches');
  const secondBatch = await history.searchConversationPage(index, 'batch-hit', firstBatch.nextCursor);
  assert(secondBatch.hits.length === history.CONVERSATION_SEARCH_BATCH_SIZE,
    'continuation should resume after the previous batch without rescanning its hits');
  assert(secondBatch.hits[0].line > firstBatch.hits.at(-1).line,
    'search continuation should advance monotonically through JSONL lines');

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    history.searchConversationPage(index, 'batch-hit', null, { signal: cancelled.signal }),
    (error) => error.name === 'AbortError',
    'cancelled searches should stop before reading the file'
  );

  fs.appendFileSync(filePath, partialRecord.slice(partialCut) + '\n' + jsonLine(record(10_002, 'new appended record')));
  const appended = await history.updateConversationIndex(index, descriptor);
  assert.notStrictEqual(appended, index, 'append-only updates should atomically replace the sparse index snapshot');
  assert(appended.updateType === 'appended', 'append-only index updates should be identified as incremental');
  assert(appended.messageCount === 10_003 && !appended.partialLine,
    'appended data should complete the pending record and index subsequent records');
  assert((await history.loadConversationPage(appended, lastPageIndex)).messages.length <= 60,
    'append updates should keep page loading bounded');

  fs.writeFileSync(filePath, jsonLine(record(0, 'replacement session')));
  const replaced = await history.updateConversationIndex(appended, descriptor);
  assert(replaced.messageCount === 1, 'file truncation or rewrite should rebuild rather than reuse stale checkpoints');
  assert(replaced.updateType === 'rebuilt', 'truncate recovery should be reported as a full reindex');
  assert((await history.loadConversationPage(replaced, 0)).messages[0].blocks[0].text.includes('replacement session'),
    'rebuilt pages should expose replacement file contents');

  const sameSizeRewrite = jsonLine(record(0, 'replacement prompts'));
  assert(Buffer.byteLength(sameSizeRewrite) === Buffer.byteLength(jsonLine(record(0, 'replacement session'))),
    'same-size rewrite fixture should preserve byte length');
  fs.writeFileSync(filePath, sameSizeRewrite);
  fs.utimesSync(filePath, new Date(replaced.mtimeMs), new Date(replaced.mtimeMs));
  const rewritten = await history.updateConversationIndex(replaced, descriptor);
  assert.notStrictEqual(rewritten, replaced,
    'same-size in-place rewrites should rebuild after restoring the mtime');
  assert((await history.loadConversationPage(rewritten, 0)).messages[0].blocks[0].text.includes('replacement prompts'),
    'same-size rewrite recovery should expose the replaced message body');

  const replacementFile = path.join(projectPath, '33333333-4444-5555-6666-777777777777.jsonl');
  fs.writeFileSync(replacementFile, jsonLine(record(0, 'rotated session')));
  const replacementDescriptor = {
    ...descriptor,
    filePath: replacementFile,
    sessionId: path.basename(replacementFile, '.jsonl'),
  };
  const rotated = await history.updateConversationIndex(rewritten, replacementDescriptor);
  assert(rotated.filePath === replacementFile && rotated.messageCount === 1,
    'a replaced path should rebuild the sparse index for the new file');
  const atomicReplacement = `${replacementFile}.tmp`;
  fs.writeFileSync(atomicReplacement, jsonLine(record(0, 'renamed session')));
  fs.renameSync(atomicReplacement, replacementFile);
  const atomicallyReplaced = await history.updateConversationIndex(rotated, replacementDescriptor);
  assert(atomicallyReplaced.updateType === 'rebuilt' &&
    (await history.loadConversationPage(atomicallyReplaced, 0)).messages[0].blocks[0].text.includes('renamed session'),
  'same-path atomic file replacement should invalidate and rebuild the sparse index');

  const emptyFile = path.join(projectPath, 'empty-session.jsonl');
  fs.writeFileSync(emptyFile, '');
  const emptyIndex = await history.buildConversationIndex({ filePath: emptyFile, sessionId: 'empty' });
  assert((await history.loadConversationPage(emptyIndex, 0)).messages.length === 0,
    'empty local session files should load as an empty page');

  const filtered = await history.listConversationFiles(root, {
    workspacePaths: ['/tmp/conversation-history-fixture'],
  });
  assert(filtered.length === 3, 'workspace file discovery should match cwd data or the encoded project directory');
  assert((await history.listConversationFiles(root, { workspacePaths: ['/tmp/not-this-workspace'] })).length === 0,
    'workspace file discovery should exclude sessions from a different cwd');
}

async function appendDuringRead(filePath, contents, operation) {
  const originalOpen = fs.promises.open;
  let appended = false;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] !== filePath) return handle;
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!appended && readArgs[2] > history.CONVERSATION_TAIL_VALIDATION_BYTES) {
        appended = true;
        fs.appendFileSync(filePath, contents);
      }
      return result;
    };
    return handle;
  };
  try {
    const result = await operation();
    assert(appended, 'the fixture should append during an active file scan');
    return result;
  } finally {
    fs.promises.open = originalOpen;
  }
}

async function testConcurrentAppendSnapshots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-append-'));
  const filePath = path.join(root, 'streaming.jsonl');
  const descriptor = { filePath, sessionId: 'streaming' };
  try {
    fs.writeFileSync(filePath, Array.from({ length: 2000 }, (_, index) => jsonLine(record(index))).join(''));
    const index = await appendDuringRead(filePath, jsonLine(record(2000)), () => history.buildConversationIndex(descriptor));
    assert(index.messageCount === 2000, 'index construction should finish at its original byte boundary during append');
    const page = await appendDuringRead(filePath, jsonLine(record(2001)), () => history.loadConversationPage(index, 0));
    assert(page.messages.length === 60 && page.totalMessages === 2000,
      'old pages should remain readable while the session is streaming');
    const batch = await appendDuringRead(filePath, jsonLine(record(2002)), () => history.searchConversationPage(index, 'body'));
    assert(batch.hits.length === 50 && batch.nextCursor, 'search should return a stable batch during append');
    assert((await history.searchConversationPage(index, 'body 2000')).hits.length === 0,
      'a search snapshot should exclude content appended after its index boundary');
    const updated = await history.updateConversationIndex(index, descriptor);
    assert(updated.updateType === 'appended' && updated.messageCount === 2003,
      'a subsequent update should index appended data without rebuilding existing checkpoints');
    const cancelled = new AbortController();
    let processed = 0;
    await assert.rejects(history.scanJsonl(filePath, {
      signal: cancelled.signal,
      onLine() {
        if (++processed === 5) setImmediate(() => cancelled.abort());
      },
    }), (error) => error.name === 'AbortError');
    assert(processed >= 5 && processed <= history.CONVERSATION_INDEX_BLOCK_SIZE,
      'the scanner should yield for cancellation within one index block');

    const manager = new sidebar.TranscriptPanelManager({}, { subscriptions: [] });
    const responses = [];
    manager.panel = { visible: true, webview: { postMessage(message) { responses.push(message); } }, dispose() {} };
    manager.historyIndex = index;
    const search = { requestId: 'pinned-search', query: 'body' };
    await manager.searchConversation(search);
    const token = responses.at(-1).continuationToken;
    assert(manager.searchContinuations.get(token).index === index, 'host continuation tokens should pin their sparse index');
    manager.historyIndex = updated;
    await manager.searchConversation({ ...search, continuationToken: token });
    assert(responses.at(-1).hits[0].messageIndex === 50,
      'continuations should advance within the original search snapshot after host index updates');
    assert(manager.searchContinuations.get(responses.at(-1).continuationToken).index === index,
      'later batches should keep using the original snapshot');
    manager.dispose();

    const originalContents = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, originalContents.replace('message body 2002', 'changed body 2002') + jsonLine(record(2003)));
    await assert.rejects(history.loadConversationPage(updated, 0), (error) => error.code === 'CONVERSATION_INDEX_STALE');
    const rebuilt = await history.updateConversationIndex(updated, descriptor);
    assert(rebuilt.updateType === 'rebuilt', 'a rewrite followed by growth must invalidate the saved tail fingerprint');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testConversationReadingPosition() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-reading-'));
  const filePath = path.join(root, 'reading.jsonl');
  const responses = [];
  const manager = new sidebar.TranscriptPanelManager({}, { subscriptions: [] });
  manager.panel = { visible: true, webview: { postMessage(message) { responses.push(message); } }, dispose() {} };
  manager.ready = true;
  manager.mode = 'conversation';
  manager.historyRoot = root;
  manager.historyViewNeedsReload = true;
  manager.descriptor = { filePath, sessionId: 'reading' };
  manager.watchTranscriptFile = () => {};
  try {
    fs.writeFileSync(filePath, Array.from({ length: 120 }, (_, index) => jsonLine(record(index))).join(''));
    await manager.loadConversationNow(true);
    assert(manager.historyPageIndex === 1 && responses.at(-1).messages.length === 60,
      'initial conversation browsing should open the latest page');
    responses.length = 0;
    fs.appendFileSync(filePath, Array.from({ length: 65 }, (_, index) => jsonLine(record(index + 120))).join(''));
    await manager.loadConversationNow();
    assert(manager.historyPageIndex === 1 && responses.length === 1 && responses[0].type === 'conversationUpdate',
      'new pages must not replace the reader\'s current page or resend its message bodies');
    assert(responses[0].transcript.messageCount === 185 && !responses[0].pageRequestId,
      'append notifications should carry new counts without forcing a navigation request');
    await manager.loadConversationPage({ pageIndex: 3, requestId: 'latest-page' });
    assert(responses.at(-1).messages.length === 5 && responses.at(-1).messages[0].conversationIndex === 180,
      'explicit Latest navigation should fetch the new last page');
    responses.length = 0;
    fs.appendFileSync(filePath, jsonLine(record(185)));
    await manager.loadConversationNow();
    assert(responses.length === 1 && responses[0].type === 'conversationUpdate',
      'same-page appends should also preserve expanded content until the reader requests an update');
    await manager.loadConversationPage({ pageIndex: 3, requestId: 'refresh-current-page' });
    assert(responses.at(-1).messages.length === 6, 'Latest should also refresh a partially filled last page');
  } finally {
    manager.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testLightweightIndexAndPaging() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-index-work-'));
  const filePath = path.join(root, 'messages.jsonl');
  const descriptor = { filePath, sessionId: 'index-work' };
  const contents = [
    null, false, 0, '', ' ', 'plain text', [], [null, ''],
    { type: 'text', text: '' }, { type: 'text', text: 'text' },
    { type: 'thinking', thinking: '' }, { type: 'thinking', thinking: 'reasoning' },
    { type: 'tool_use' }, { type: 'tool_use', input: { command: 'example' } },
    { type: 'tool_result' }, { type: 'tool_result', content: [] },
    { type: 'tool_result', content: [{ type: 'thinking', thinking: 'nested' }] },
    { type: 'image' }, { type: 'unknown', content: '' },
    { type: 'unknown', content: [null, { text: 'nested text' }] },
    { type: 'unknown', text: '' }, { type: 'unknown', payload: { sample: true } },
    [[null, [{ text: 'nested arrays' }]]], {},
  ];
  try {
    const records = [];
    for (let repeat = 0; repeat < 25; repeat++) {
      for (const content of contents) {
        records.push({ ...record(records.length), message: { role: 'assistant', content } });
        records.push({ ...record(records.length), error: 'fixture error', message: { content } });
      }
    }
    records.push(null, false, {}, { type: 'queue-operation' }, { error: 'service error' });
    const expected = records.map((value, index) => parseTranscriptRecord(value, descriptor, index + 1)).filter(Boolean);
    for (const value of records) {
      assert.strictEqual(isDisplayableTranscriptRecord(value), !!parseTranscriptRecord(value),
        'lightweight visibility must agree with the full parser for nested, empty, error, and unknown blocks');
    }
    fs.writeFileSync(filePath, records.map(jsonLine).join(''));
    const index = await history.buildConversationIndex(descriptor);
    assert.strictEqual(index.messageCount, expected.length);
    const actual = [];
    for (let pageIndex = 0; pageIndex < Math.ceil(expected.length / 60); pageIndex++) {
      actual.push(...(await history.loadConversationPage(index, pageIndex)).messages);
    }
    assert.deepStrictEqual(actual.map(({ conversationIndex, ...message }) => message), expected,
      'lightweight skipping must preserve messages and line positions across sparse checkpoints');

    const toolRecords = Array.from({ length: 300 }, (_, index) => ({
      ...record(index),
      message: { role: 'assistant', content: [{ type: 'tool_use', input: { index, payload: 'x'.repeat(4096) } }] },
    }));
    fs.writeFileSync(filePath, toolRecords.map(jsonLine).join(''));
    const originalStringify = JSON.stringify;
    const formattedInputs = [];
    JSON.stringify = (value, replacer, space) => {
      if (space === 2) formattedInputs.push(value.index);
      return originalStringify(value, replacer, space);
    };
    try {
      const toolIndex = await history.buildConversationIndex(descriptor);
      assert.strictEqual(formattedInputs.length, 0, 'indexing must not format any tool body');
      const page = await history.loadConversationPage(toolIndex, 4);
      assert.deepStrictEqual(formattedInputs, Array.from({ length: 60 }, (_, offset) => 240 + offset),
        'page loads must format only requested messages, excluding the sparse checkpoint prefix');
      assert(page.messages[0].blocks[0].text.includes('"index": 240'), 'requested tools should keep formatted JSON');
      formattedInputs.length = 0;
      fs.appendFileSync(filePath, originalStringify(toolRecords[0]) + '\n');
      const appended = await history.updateConversationIndex(toolIndex, descriptor);
      assert.strictEqual(appended.messageCount, 301);
      assert.strictEqual(formattedInputs.length, 0, 'incremental indexing must also skip tool-body formatting');
    } finally {
      JSON.stringify = originalStringify;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testScanTimeBudget() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-scan-budget-'));
  const filePath = path.join(root, 'messages.jsonl');
  fs.writeFileSync(filePath, Array.from({ length: 80 }, (_, index) => jsonLine(record(index))).join(''));
  const controller = new AbortController();
  let processed = 0;
  try {
    await assert.rejects(history.scanJsonl(filePath, {
      signal: controller.signal,
      onLine() {
        processed++;
        if (processed !== 1) return;
        setImmediate(() => controller.abort());
        const startedAt = performance.now();
        while (performance.now() - startedAt < history.CONVERSATION_SCAN_SLICE_MS + 1) {}
      },
    }), (error) => error.name === 'AbortError');
    assert.strictEqual(processed, 1,
      'one expensive record must yield for cancellation without waiting for 256 records');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testSearchRecordSizeParity() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-search-parity-'));
  try {
    for (const padding of [100, history.CONVERSATION_MAX_RECORD_BYTES + 1]) {
      const filePath = path.join(root, `${padding}.jsonl`);
      const sample = record(0, [
        { type: 'text', text: 'x'.repeat(padding) + ' 中文 C:\\project\\src 😀 ΣΟΣ' },
        { type: 'thinking', thinking: 'private reasoning sample' },
        { type: 'tool_use', id: 'hidden-tool-id', name: 'Read', input: { file_path: '目录\\文件' } },
        { type: 'tool_result', tool_use_id: 'hidden-tool-id', content: 'result content' },
      ]);
      const encoded = JSON.stringify(sample).replaceAll('中文', '\\u4e2d\\u6587');
      fs.writeFileSync(filePath, encoded + '\n');
      const index = await history.buildConversationIndex({ filePath, sessionId: 'parity' });
      for (const query of ['中文', 'C:\\project\\src', '😀', 'σοσ', 'reasoning', 'Read', '目录\\文件', 'result content']) {
        assert.strictEqual((await history.searchConversationPage(index, query)).hits.length, 1,
          `decoded content must remain searchable at ${padding} characters: ${query}`);
      }
      for (const query of ['uuid', 'hidden-tool-id', 'conversation-history-fixture']) {
        assert.strictEqual((await history.searchConversationPage(index, query)).hits.length, 0,
          'record metadata and field names outside displayed content must not become search hits');
      }
    }
    const source = JSON.stringify(record(0, 'x'.repeat(4095) + '𐐀 中文\\path\nsecond line 😀'))
      .replaceAll('中文', '\\u4e2d\\u6587');
    for (const chunkSize of [1, 2, 7, 4096]) {
      for (const query of ['中文\\path', 'line 😀', '𐐨']) {
        const search = createJsonlSearch(query);
        for (let offset = 0; offset < source.length; offset += chunkSize) search.write(source.slice(offset, offset + chunkSize));
        assert(search.finish().matched, 'JSON escapes and Unicode must survive arbitrary input boundaries');
      }
    }
    for (const malformed of ['{"message":{"content":"needle"}', '{"message":{"content":"needle"},}',
      '{"message":{"content":"\\qneedle"}}', '{"message":{"content":"needle"}} trailing']) {
      const search = createJsonlSearch('needle');
      search.write(malformed);
      assert(!search.finish().matched, 'malformed oversized records must not produce valid search hits');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testPagedSubagentAndBackpressure() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-paged-subagent-'));
  const filePath = path.join(root, 'agent-local.jsonl');
  const descriptor = { filePath, agentId: 'local', sessionId: 'local', label: 'Local agent' };
  const responses = [];
  const manager = new sidebar.TranscriptPanelManager({
    workspace: { getConfiguration: () => ({ get: () => root }) }, ViewColumn: { Beside: 2 },
  }, { subscriptions: [] });
  manager.panel = { visible: true, reveal() {}, dispose() {}, webview: { postMessage(message) {
    responses.push(message);
    if (message.type === 'conversationPageChunk') setImmediate(() => manager.acknowledgePageChunk(message));
    return Promise.resolve(true);
  } } };
  manager.watchTranscriptFile = () => {};
  try {
    const contents = [
      [{ type: 'text', text: 'plain' }],
      [{ type: 'thinking', thinking: 'thought' }],
      [{ type: 'tool_use', name: 'shell', input: { value: 1 } }],
      [{ type: 'tool_result', is_error: true, content: 'failed' }],
    ];
    fs.writeFileSync(filePath, Array.from({ length: 60 }, (_, index) => jsonLine({ ...record(index), message: {
      role: index % 2 ? 'assistant' : 'user', content: [...contents[index % 4], { type: 'text', text: 'padding '.repeat(8000) }],
    } })).join(''));
    manager.show(descriptor);
    manager.ready = true;
    await manager.loadConversationNow(true);
    assert(manager.mode === 'conversation' && manager.descriptor.kind === 'subagent',
      'sub-agent entry must use the shared sparse paging service');
    const chunks = responses.filter((message) => message.type === 'conversationPageChunk');
    assert(chunks.length > 1 && chunks.flatMap((chunk) => chunk.messages).length === 60);
    assert(chunks.every((chunk) => Buffer.byteLength(JSON.stringify(chunk.messages)) <= 512 * 1024));
    assert(responses.at(-1).streamed && !responses.at(-1).messages.length && manager.pageAcknowledgements.size === 0);
    assert(!manager.transcript && !manager.cursor && !manager.historyIndex.messages,
      'host storage must retain file metadata and sparse checkpoints rather than transcript bodies');
    for (const [filter, count] of [['assistant', 30], ['thinking', 15], ['tools', 30], ['errors', 15]]) {
      const hits = await history.searchConversationPage(manager.historyIndex, '', null, { filter });
      assert.strictEqual(hits.hits.length, count, `global ${filter} filtering must match parsed message types`);
    }
    const controller = new AbortController();
    manager.panel.webview.postMessage = (message) => { responses.push(message); return Promise.resolve(true); };
    const pending = manager.postPageChunk('cancelled-page', [], controller.signal);
    assert.strictEqual(manager.pageAcknowledgements.size, 1);
    manager.acknowledgePageChunk({ requestId: 'wrong-page', ackToken: responses.at(-1).ackToken });
    assert.strictEqual(manager.pageAcknowledgements.size, 1, 'unrelated acknowledgements cannot release backpressure');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.strictEqual(manager.pageAcknowledgements.size, 0);
  } finally {
    manager.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testSearchLocations() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-locations-'));
  const filePath = path.join(root, 'locations.jsonl');
  const prose = 'İ😀 '.repeat(30) + '\r\n' + 'body '.repeat(18000) + 'ΟΣ exact target';
  const tool = JSON.stringify({ value: 'input '.repeat(5000) + 'tool-target' }, null, 2);
  fs.writeFileSync(filePath, jsonLine({ ...record(1), message: { role: 'assistant', content: [
    { type: 'text', text: 'metadata only' }, { type: 'thinking', thinking: prose },
    { type: 'tool_use', name: 'tool', input: JSON.parse(tool) },
  ] } }) + jsonLine(record(2, 'oversized '.repeat(130000) + 'raw-target')));
  try {
    const index = await history.buildConversationIndex({ filePath, sessionId: 'locations' });
    const page = await history.loadConversationPage(index, 0);
    for (const [query, blockIndex, text] of [['οσ', 1, prose], ['tool-target', 2, tool]]) {
      const result = await history.searchConversationPage(index, query);
      assert.strictEqual(result.hits.length, 1);
      const location = result.hits[0].location;
      assert.strictEqual(location.blockIndex, blockIndex);
      assert.strictEqual(location.start, text.indexOf(query === 'οσ' ? 'ΟΣ' : query));
      assert.strictEqual(page.messages[0].blocks[blockIndex].text.slice(location.start, location.end), query === 'οσ' ? 'ΟΣ' : query,
        'host offsets must address the exact displayed block despite Unicode case expansion and JSON escaping');
    }
    const raw = await history.searchConversationPage(index, 'raw-target');
    assert(raw.hits[0].raw && raw.hits[0].location === null,
      'oversized record matches must honestly point to the raw record');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

testConversationSelectionRace().then(testPagedIndexSearchAndRecovery).then(testConcurrentAppendSnapshots)
  .then(testConversationReadingPosition).then(testLightweightIndexAndPaging).then(testScanTimeBudget)
  .then(testSearchRecordSizeParity).then(testPagedSubagentAndBackpressure).then(testSearchLocations).then(() => {
  console.log('conversation history regression passed (10,003 messages, 60-message pages)');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
