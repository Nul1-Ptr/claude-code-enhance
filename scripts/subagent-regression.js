'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  contentBlocks,
  defaultProjectsRoot,
  findSubagentFiles,
  findSubagentFilesAsync,
  readSubagentTranscript,
  streamSubagentTranscript,
  transcriptStatus,
  updateSubagentTranscript,
} = require('../lib/subagent-transcripts');
const sidebar = require('../lib/subagent-sidebar');
const marked = require('../vendor/marked.min.js');
const view = require('../vendor/subagent-view');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonLine(record) {
  return JSON.stringify(record) + '\n';
}

function testFixtureParsing() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-regression-'));
  const projectId = '-tmp-fixture-project';
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const project = path.join(root, projectId);
  const subagents = path.join(project, sessionId, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(project, sessionId + '.jsonl'), [
    jsonLine({ type: 'queue-operation', operation: 'enqueue' }),
    jsonLine({
      type: 'user',
      cwd: '/tmp/fixture-project',
      message: { role: 'user', content: [{ type: 'text', text: 'Review the numerical derivation.' }] },
    }),
  ].join(''));

  const filePath = path.join(subagents, 'agent-a1b2c3d4.jsonl');
  fs.writeFileSync(filePath, [
    jsonLine({
      type: 'user',
      uuid: 'u1',
      cwd: '/tmp/fixture-project',
      timestamp: '2026-08-18T00:00:00Z',
      message: { role: 'user', content: 'Check formulas, tables, and code.' },
    }),
    jsonLine({
      type: 'assistant',
      uuid: 'a1',
      attributionAgent: 'general-purpose',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Inspect the source.' }] },
    }),
    '{malformed}\n',
    jsonLine({
      type: 'assistant',
      uuid: 'a2',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a.py' } }],
      },
    }),
    jsonLine({
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'not found' }],
      },
    }),
    jsonLine({
      type: 'assistant',
      uuid: 'a3',
      error: 'server_error',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '| Name | Formula |\n|---|---|\n| asym V | $\\operatorname{asymV}(A)$ |' }],
      },
    }),
    '{"still":"streaming"',
  ].join(''));

  const descriptors = findSubagentFiles(root);
  assert(descriptors.length === 1, 'fixture discovery should find one transcript');
  const descriptor = descriptors[0];
  assert(descriptor.projectLabel === 'fixture-project', 'project label should come from cwd');
  assert(descriptor.sessionLabel.startsWith('Review the numerical'), 'session label should come from parent prompt');
  assert(descriptor.label === 'Check formulas, tables, and code.', 'agent label should come from child prompt');
  assert(descriptor.agentType === 'general-purpose', 'agent type should be retained');
  assert(descriptor.status === 'failed', 'last API error should mark the transcript failed');

  const transcript = readSubagentTranscript(descriptor);
  assert(transcript.messages.length === 5, 'fixture should expose five renderable messages');
  assert(transcript.malformedLines === 1, 'interior malformed JSON should be reported');
  assert(transcript.partialLine, 'actively written final JSON should be reported as partial');
  assert(transcript.messages[3].role === 'tool-result', 'tool results should have a distinct role');
  assert(transcript.messages[3].blocks[0].isError, 'tool result error metadata should survive parsing');
  assert(transcript.messages[4].error === 'server_error', 'API error metadata should survive parsing');

  fs.appendFileSync(filePath, '}\n');
  const completedPartial = updateSubagentTranscript(transcript, descriptor);
  assert(completedPartial.append, 'completing a partial JSONL record should use an incremental read');
  assert(!completedPartial.transcript.partialLine, 'completed partial JSONL should no longer be pending');
  assert(completedPartial.transcript.messages.length === 5, 'non-message JSONL records should not add messages');
  const immutableMessages = completedPartial.transcript.messages;

  fs.appendFileSync(filePath, jsonLine({
    type: 'assistant',
    uuid: 'a4',
    message: { role: 'assistant', stop_reason: 'end_turn', content: 'Incremental answer.' },
  }));
  const appended = updateSubagentTranscript(completedPartial.transcript, descriptor);
  assert(appended.append && appended.appendedMessages.length === 1, 'new JSONL messages should be returned as a delta');
  assert(appended.transcript.messages.length === 6, 'incremental reads should preserve prior messages');
  assert(appended.appendedMessages[0].line === appended.transcript.lines, 'incremental line numbers should remain absolute');
  assert(appended.transcript.messages !== immutableMessages && immutableMessages.length === 5,
    'default incremental reads should preserve immutable transcript snapshots');

  fs.appendFileSync(filePath, jsonLine({
    type: 'assistant',
    uuid: 'a5',
    message: { role: 'assistant', stop_reason: 'end_turn', content: 'Owned incremental answer.' },
  }));
  const ownedMessages = appended.transcript.messages;
  const reused = updateSubagentTranscript(appended.transcript, descriptor, { reuseMessages: true });
  assert(reused.append && reused.transcript.messages === ownedMessages,
    'panel-owned incremental reads should reuse their message array');
  assert(reused.transcript.messages.length === 7 && reused.appendedMessages.length === 1,
    'panel-owned incremental reads should append only the parsed delta');

  fs.writeFileSync(filePath, jsonLine({
    type: 'assistant',
    uuid: 'replacement',
    message: { role: 'assistant', content: 'Replacement transcript.' },
  }));
  const replaced = updateSubagentTranscript(reused.transcript, descriptor);
  assert(!replaced.append, 'truncated or replaced JSONL should fall back to a full read');
  assert(replaced.transcript.messages.length === 1, 'fallback reads should discard stale messages');

  const otherProjectId = '-tmp-other-project';
  const otherSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const otherProject = path.join(root, otherProjectId);
  const otherSubagents = path.join(otherProject, otherSessionId, 'subagents');
  fs.mkdirSync(otherSubagents, { recursive: true });
  fs.writeFileSync(path.join(otherProject, otherSessionId + '.jsonl'), jsonLine({
    cwd: '/tmp/other-project',
    message: { role: 'user', content: 'Other project.' },
  }));
  fs.writeFileSync(path.join(otherSubagents, 'agent-other.jsonl'), jsonLine({
    cwd: '/tmp/other-project',
    message: { role: 'user', content: 'Other agent.' },
  }));
  const selected = findSubagentFiles(root, { projectIds: new Set([projectId]) });
  assert(selected.length === 1 && selected[0].projectId === projectId, 'selected discovery should scan only requested projects');
  const parentSelected = findSubagentFiles(root, {
    projectIds: new Set(['-tmp']),
    includeDescendants: true,
  });
  assert(parentSelected.length === 2, 'selected discovery should optionally include projects below a workspace parent');
  assert(findSubagentFiles(root).length === 2, 'unscoped discovery should continue to scan every project');
}

async function testStreamingAndAsyncDiscovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-streaming-'));
  const projectId = '-tmp-streaming-project';
  const sessionId = '99999999-8888-7777-6666-555555555555';
  const project = path.join(root, projectId);
  const subagents = path.join(project, sessionId, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(project, sessionId + '.jsonl'), jsonLine({
    type: 'user',
    cwd: '/tmp/streaming-project',
    message: { role: 'user', content: 'Exercise streamed transcript reads.' },
  }));

  const filePath = path.join(subagents, 'agent-streaming.jsonl');
  const completeRecords = Array.from({ length: 80 }, (_, index) => ({
    type: index % 2 ? 'assistant' : 'user',
    uuid: `stream-${index}`,
    cwd: '/tmp/streaming-project',
    attributionAgent: 'general-purpose',
    message: {
      role: index % 2 ? 'assistant' : 'user',
      content: `streamed message ${index}: ${'payload '.repeat(120)}`,
    },
  }));
  const partialRecord = {
    type: 'assistant',
    uuid: 'stream-partial',
    attributionAgent: 'general-purpose',
    message: { role: 'assistant', content: 'completed across cursor reads' },
  };
  const partialSource = JSON.stringify(partialRecord);
  const partialOffset = Math.floor(partialSource.length * 0.6);
  fs.writeFileSync(
    filePath,
    completeRecords.map(jsonLine).join('') + partialSource.slice(0, partialOffset)
  );

  const synchronous = findSubagentFiles(root);
  const asynchronous = await findSubagentFilesAsync(root);
  const comparable = (descriptor) => ({
    filePath: descriptor.filePath,
    projectId: descriptor.projectId,
    sessionId: descriptor.sessionId,
    agentId: descriptor.agentId,
    agentType: descriptor.agentType,
    label: descriptor.label,
    status: descriptor.status,
    size: descriptor.size,
  });
  assert(
    JSON.stringify(asynchronous.map(comparable)) === JSON.stringify(synchronous.map(comparable)),
    'async transcript discovery should match synchronous discovery'
  );
  assert(asynchronous.length === 1, 'async discovery should find the streaming fixture');

  const firstChunks = [];
  const firstEvents = [];
  const first = await streamSubagentTranscript(asynchronous[0], {
    chunkBytes: 16 * 1024,
    batchSize: 7,
    onStart(event) { firstEvents.push(['start', event.append]); },
    onChunk(event) {
      firstEvents.push(['chunk', event.append]);
      firstChunks.push(event.messages);
    },
    onComplete(event) { firstEvents.push(['complete', event.append]); },
  });
  const firstMessages = firstChunks.flat();
  assert(!first.append, 'the first streamed read should replace transcript data');
  assert(firstChunks.length > 1, 'large transcripts should be emitted in multiple message batches');
  assert(firstMessages.length === completeRecords.length, 'streaming should emit every complete JSONL message');
  assert(
    firstMessages[0].line === 1 && firstMessages.at(-1).line === completeRecords.length,
    'streamed replacement messages should retain absolute JSONL line numbers'
  );
  assert(
    first.transcript.partialLine && first.transcript.lines === completeRecords.length + 1,
    'a final incomplete JSONL record should remain pending without becoming malformed'
  );
  assert(
    first.cursor.completeLines === completeRecords.length && first.cursor.completeBytes < first.cursor.bytes,
    'the stream cursor should stop before a partial final JSONL record'
  );
  assert(
    firstEvents[0][0] === 'start' && firstEvents.at(-1)[0] === 'complete' &&
      firstEvents.every(([, append]) => append === false),
    'replacement stream callbacks should use a consistent protocol mode'
  );

  fs.appendFileSync(filePath, partialSource.slice(partialOffset) + '\n' + jsonLine({
    type: 'assistant',
    uuid: 'stream-appended',
    attributionAgent: 'general-purpose',
    message: { role: 'assistant', stop_reason: 'end_turn', content: 'appended after cursor' },
  }));
  const appendedChunks = [];
  const second = await streamSubagentTranscript(asynchronous[0], {
    cursor: first.cursor,
    chunkBytes: 16 * 1024,
    batchSize: 1,
    onChunk(event) { appendedChunks.push(event.messages); },
  });
  const appendedMessages = appendedChunks.flat();
  assert(second.append, 'a growing file with the same identity should use cursor-based append');
  assert(
    appendedChunks.length === 2 && appendedMessages.length === 2,
    'cursor append should batch only newly completed messages'
  );
  assert(
    appendedMessages[0].line === completeRecords.length + 1 &&
      appendedMessages[1].line === completeRecords.length + 2,
    'cursor append should preserve absolute line numbers across a completed partial record'
  );
  assert(
    !second.transcript.partialLine && second.transcript.lines === completeRecords.length + 2,
    'completing the final record should clear partial-line state'
  );
  assert(
    second.transcript.messageCount === completeRecords.length + 2 &&
      second.cursor.completeBytes === second.cursor.bytes,
    'cursor metadata should include the complete replacement and append history'
  );

  const replacementRecord = {
    type: 'assistant',
    uuid: 'stream-rewritten',
    attributionAgent: 'general-purpose',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: `rewritten in place ${'large payload '.repeat(30_000)}`,
    },
  };
  fs.writeFileSync(filePath, jsonLine(replacementRecord));
  const replacementChunks = [];
  const rewritten = await streamSubagentTranscript(asynchronous[0], {
    cursor: second.cursor,
    chunkBytes: 16 * 1024,
    batchSize: 1,
    onChunk(event) { replacementChunks.push(event.messages); },
  });
  const replacementMessages = replacementChunks.flat();
  assert(!rewritten.append,
    'same-inode rewrites that invalidate the cursor tail should force a full replacement');
  assert(replacementMessages.length === 1 && replacementMessages[0].id === 'stream-rewritten',
    'a long JSONL record spanning many byte chunks should be emitted exactly once');
  assert(rewritten.cursor.completeBytes === rewritten.cursor.bytes && !rewritten.transcript.partialLine,
    'the rewritten long record should produce a complete validated cursor');
}

function testBlockExtractionAndStatus() {
  const blocks = contentBlocks([
    { type: 'text', text: 'answer' },
    { type: 'thinking', thinking: 'reasoning' },
    { type: 'tool_use', id: '1', name: 'Bash', input: { command: 'pwd' } },
    { type: 'tool_result', tool_use_id: '1', is_error: true, content: [{ type: 'text', text: 'failed' }] },
  ]);
  assert(blocks.map((block) => block.kind).join(',') === 'text,thinking,tool,tool-result', 'all block kinds should be extracted');
  assert(blocks[2].text.includes('"command": "pwd"'), 'tool input should remain structured JSON');
  assert(blocks[3].isError, 'nested tool-result errors should be retained');
  assert(transcriptStatus({ message: { stop_reason: 'end_turn', content: [] } }, 0) === 'completed', 'end_turn should be completed');
  assert(transcriptStatus({ error: 'server_error' }, 0) === 'failed', 'API errors should be failed');
}

function testMarkdownArchitecture() {
  const engine = view.createMarkdownEngine(marked);
  const source = [
    '| Quantity | Formula | Code |',
    '|---|---|---|',
    '| asym V | $\\operatorname{asymV}(A)=\\{B\\in V | B^T=-B\\}$ | `x $HOME | y` |',
    '',
    '$$\\begin{aligned}a&=b\\\\c&=d\\end{aligned}$$',
    '',
    'Caveat: grid $256{\\times}256{\\times}128$ -> fDNS $64{\\times}64{\\times}32$.',
    '',
    '```python',
    'value = "$not_math$"',
    '```',
    '',
    '<script>alert("not executable")</script>',
  ].join('\n');
  const html = view.parseMarkdown(engine, source);
  assert(html.includes('<table>'), 'GFM table should render');
  assert((html.match(/ce-math-source/g) || []).length === 4, 'all intended formulas should tokenize before Markdown');
  assert(html.includes('\\operatorname{asymV}'), 'operatorname should remain intact');
  assert(html.includes('B\\in V | B^T=-B'), 'formula pipes should survive table parsing');
  assert(html.includes('<code>x $HOME | y</code>'), 'code pipes should survive table parsing');
  assert(html.includes('class="language-python"'), 'fenced code language should survive');
  assert(html.includes('$not_math$'), 'math inside fenced code should remain literal');
  assert(!html.includes('<script>'), 'raw transcript HTML must not become executable');
  assert(!view.parseMarkdown(engine, 'Cost is $5 and $10.').includes('ce-math-source'), 'currency-like prose should not become math');
  assert(!view.parseMarkdown(engine, 'Literal \\$x\\$ text.').includes('ce-math-source'), 'escaped delimiters should stay literal');
  assert(!view.parseMarkdown(engine, 'Literal \\$x$ text.').includes('ce-math-source'), 'escaped opening delimiters should stay literal');
  assert(view.wholeMathCandidate('$x_1$')?.formula === 'x_1', 'math-only inline code should be recoverable');
}

function testTranscriptVirtualization() {
  const records = Array.from({ length: 10000 }, (_, index) => view.createMessageRecord({
    id: `message-${index}`,
    line: index + 1,
    role: index % 2 ? 'assistant' : 'user',
    agentType: index % 2 ? 'general-purpose' : null,
    blocks: [{
      kind: index % 5 === 0 ? 'tool-result' : 'text',
      text: index === 7777 ? 'needle in the transcript' : `message body ${index}`,
      isError: index === 9999,
    }],
  }, index));
  assert(records[0].searchText === null, 'transcript search text should be built lazily');
  assert(view.recordMatches(records[0], 'all', ''), 'empty searches should not need a text index');
  assert(records[0].searchText === null, 'empty searches should not duplicate transcript text');
  assert(view.recordMatches(records[7777], 'all', 'needle'), 'search should match source message data');
  assert(records[7777].searchText?.includes('needle'), 'queried records should cache their search text');
  assert(view.recordMatches(records[9999], 'errors', ''), 'error facets should be indexed without DOM inspection');

  const heights = new Map([
    [records[0].key, 100],
    [records[1].key, 200],
  ]);
  const index = view.createHeightIndex(records, heights, 240);
  assert(index.length === 10000, 'virtual height index should retain every transcript message');
  assert(index.sum(0, 3) === 540, 'height sums should combine measured and estimated rows');
  assert(index.indexAt(99) === 0 && index.indexAt(100) === 1,
    'height lookup should locate the row containing the requested offset');
  assert(index.update(5000, 480), 'measured rows should update their height block');
  assert(index.sum(5000, 5001) === 480, 'updated row heights should affect spacer totals');
  const appended = view.createMessageRecord({
    id: 'message-10000',
    line: 10001,
    role: 'assistant',
    blocks: [{ kind: 'text', text: 'appended' }],
  }, 10000);
  index.append(appended);
  assert(index.length === 10001 && index.sum(10000, 10001) === 240,
    'append-only transcripts should extend the height index without rebuilding prior blocks');
  assert(view.VIRTUAL_WINDOW_MESSAGES === 60 && view.VIRTUAL_WINDOW_OVERSCAN === 12 &&
      view.VIRTUAL_MAX_MESSAGES === 100,
    'transcript DOM windows should remain bounded');
  assert(view.MAX_HIGHLIGHT_LENGTH === 50 * 1024,
    'sub-agent code highlighting should stop at the oversized-code limit');
}

function testSidebarHelpers() {
  const descriptors = [
    { projectId: 'p', projectLabel: 'Project', projectPath: '/p', sessionId: 's', sessionLabel: 'Session', agentId: 'a', label: 'Agent A', status: 'completed', size: 10, mtimeMs: 2, filePath: '/a' },
    { projectId: 'p', projectLabel: 'Project', projectPath: '/p', sessionId: 's', sessionLabel: 'Session', agentId: 'b', label: 'Agent B', status: 'active', size: 20, mtimeMs: 3, filePath: '/b' },
  ];
  const groups = sidebar.groupDescriptors(descriptors);
  assert(groups.length === 1 && groups[0].count === 2, 'tree should group agents by project');
  assert(groups[0].children[0].children.length === 2, 'tree should group agents by session');
  assert(sidebar.formatBytes(1170000) === '1.1 MB', 'file sizes should be compact');
  const previous = { filePath: '/a', messages: [{ id: '1' }] };
  const next = { filePath: '/a', messages: [{ id: '1' }, { id: '2' }] };
  assert(sidebar.isAppendOnly(previous, next), 'growing JSONL should use append updates');
  assert(!sidebar.isAppendOnly(next, previous), 'shrinking JSONL should force replacement');
  const publicValue = sidebar.publicTranscript({
    filePath: '/a',
    messages: [{ id: '1' }],
    readState: { completeBytes: 10 },
  });
  assert(!('readState' in publicValue), 'internal incremental read state should not enter webview payloads');
  assert(publicValue.messages.length === 1, 'public transcript payloads should retain messages');

  const scoped = [
    { projectId: '-work-api', projectPath: '/work/api', filePath: '/api' },
    { projectId: '-work-api-old', projectPath: '/work/api-old', filePath: '/api-old' },
    { projectId: '-work-web', projectPath: '/work/web/packages/ui', filePath: '/web' },
    { projectId: '-work-missing', projectPath: '', filePath: '/missing' },
  ];
  assert(
    sidebar.filterWorkspaceDescriptors(scoped, ['/work/api']).map((item) => item.filePath).join() === '/api',
    'workspace scope should reject similarly prefixed sibling projects'
  );
  assert(
    sidebar.filterWorkspaceDescriptors(
      [{ projectId: '-work', projectPath: '/work', filePath: '/parent' }],
      ['/work/api']
    ).length === 0,
    'workspace scope should reject broad parent-directory histories'
  );
  assert(
    sidebar.filterWorkspaceDescriptors(scoped, ['/work/web']).map((item) => item.filePath).join() === '/web',
    'workspace scope should include transcript working directories below the workspace root'
  );
  assert(
    sidebar.filterWorkspaceDescriptors(scoped, ['/work']).length === 3,
    'workspace scope should include multiple projects inside an opened parent folder'
  );
  assert(
    sidebar.filterWorkspaceDescriptors(scoped, []).length === 0,
    'workspace scope should be empty when no folder is open'
  );
  assert(
    sidebar.claudeProjectId('/work/missing') === '-work-missing' &&
      sidebar.filterWorkspaceDescriptors(scoped, ['/work/missing']).at(0)?.filePath === '/missing',
    'workspace scope should fall back to Claude project IDs when transcript cwd metadata is absent'
  );

  const html = sidebar.transcriptHtml(
    { Uri: { joinPath: (base, ...segments) => [base, ...segments].join('/') } },
    { cspSource: 'vscode-webview:', asWebviewUri: (value) => value },
    '/extension'
  );
  assert(html.includes('default-src &#39;none&#39;'), 'transcript webview should deny resources by default');
  assert(html.includes('nonce-'), 'transcript scripts should use a nonce');
  assert(html.includes('subagent-view.js'), 'transcript runtime should be loaded locally');
  assert(html.includes('katex-woff2.min.css'), 'transcript webview should use WOFF2-only KaTeX CSS');
  assert(!html.includes('unsafe-eval'), 'transcript CSP should forbid eval');
  assert(sidebar.MAX_HISTORY_WATCHERS === 128,
    'history directory watchers should remain bounded for large project roots');
  assert(sidebar.conversationHistoryErrorMessage({ code: 'EACCES' }) ===
    'The selected conversation file cannot be read.',
  'filesystem errors should be summarized without exposing local paths');
}

function testSidebarRegistration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-sidebar-'));
  const commands = new Map();
  const contexts = new Map();
  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (listener) => {
        this.listeners.push(listener);
        return { dispose() {} };
      };
    }
    fire(value) { this.listeners.forEach((listener) => listener(value)); }
    dispose() { this.listeners = []; }
  }
  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }
  class ThemeIcon {
    constructor(id) { this.id = id; }
  }
  const vscode = {
    EventEmitter,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Beside: 2 },
    Uri: {
      file: (value) => value,
      joinPath: (base, ...segments) => [base, ...segments].join('/'),
    },
    commands: {
      executeCommand(id, key, value) {
        if (id === 'setContext') contexts.set(key, value);
        return Promise.resolve();
      },
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
    },
    workspace: {
      getConfiguration: () => ({ get: () => root }),
      workspaceFolders: [{ uri: { fsPath: '/tmp/fixture-project' } }],
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      openTextDocument: () => Promise.resolve({}),
    },
    window: {
      createTreeView: () => ({ visible: false, dispose() {} }),
      showQuickPick: () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(),
      showTextDocument: () => Promise.resolve(),
    },
  };
  const context = { extensionUri: '/extension', subscriptions: [] };
  const registration = sidebar.registerSubagentSidebar(vscode, context);
  assert(registration.provider.root === root, 'sidebar should honor the configured history root');
  assert(registration.provider.scope === sidebar.SCOPE_WORKSPACE, 'sidebar should default to active-workspace scope');
  assert(contexts.get(sidebar.SCOPE_CONTEXT_KEY) === sidebar.SCOPE_WORKSPACE, 'workspace scope context should initialize');
  assert(commands.has(sidebar.OPEN_VIEW_COMMAND), 'open-sidebar command should register');
  assert(commands.has(sidebar.OPEN_CONVERSATION_HISTORY_COMMAND), 'open-conversation-history command should register');
  assert(commands.has(sidebar.OPEN_TRANSCRIPT_COMMAND), 'open-transcript command should register');
  assert(commands.has(sidebar.OPEN_RAW_COMMAND), 'open-raw command should register');
  assert(commands.has(sidebar.REFRESH_COMMAND), 'refresh command should register');
  assert(commands.has(sidebar.SHOW_ALL_COMMAND), 'show-all-projects command should register');
  assert(commands.has(sidebar.SHOW_WORKSPACE_COMMAND), 'show-workspace command should register');
  commands.get(sidebar.SHOW_ALL_COMMAND)();
  assert(registration.provider.scope === sidebar.SCOPE_ALL, 'show-all command should expose all projects');
  assert(contexts.get(sidebar.SCOPE_CONTEXT_KEY) === sidebar.SCOPE_ALL, 'show-all context should update');
  commands.get(sidebar.SHOW_WORKSPACE_COMMAND)();
  assert(registration.provider.scope === sidebar.SCOPE_WORKSPACE, 'show-workspace command should restore filtering');
  for (const disposable of [...new Set(context.subscriptions)].reverse()) disposable.dispose?.();
}

function testRealHistory() {
  const root = defaultProjectsRoot();
  if (!fs.existsSync(root)) return { files: 0, messages: 0, bytes: 0 };
  const descriptors = findSubagentFiles(root);
  let messages = 0;
  let bytes = 0;
  for (const descriptor of descriptors) {
    const transcript = readSubagentTranscript(descriptor);
    assert(transcript.filePath === descriptor.filePath, `history path should round-trip: ${descriptor.filePath}`);
    assert(transcript.lines > 0, `history transcript should not be empty: ${descriptor.filePath}`);
    assert(transcript.messages.every((message) => message.blocks.length), `history messages should contain blocks: ${descriptor.filePath}`);
    messages += transcript.messages.length;
    bytes += transcript.bytes;
  }
  return { files: descriptors.length, messages, bytes };
}

async function main() {
  testFixtureParsing();
  await testStreamingAndAsyncDiscovery();
  testBlockExtractionAndStatus();
  testMarkdownArchitecture();
  testTranscriptVirtualization();
  testSidebarHelpers();
  testSidebarRegistration();
  const history = testRealHistory();
  console.log(`sub-agent regression passed (${history.files} real files, ${history.messages} messages, ${Math.round(history.bytes / 1024 / 1024)} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
