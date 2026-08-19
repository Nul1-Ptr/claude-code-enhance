'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  contentBlocks,
  defaultProjectsRoot,
  findSubagentFiles,
  readSubagentTranscript,
  transcriptStatus,
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
  assert(!html.includes('unsafe-eval'), 'transcript CSP should forbid eval');
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
      showTextDocument: () => Promise.resolve(),
    },
  };
  const context = { extensionUri: '/extension', subscriptions: [] };
  const registration = sidebar.registerSubagentSidebar(vscode, context);
  assert(registration.provider.root === root, 'sidebar should honor the configured history root');
  assert(registration.provider.scope === sidebar.SCOPE_WORKSPACE, 'sidebar should default to active-workspace scope');
  assert(contexts.get(sidebar.SCOPE_CONTEXT_KEY) === sidebar.SCOPE_WORKSPACE, 'workspace scope context should initialize');
  assert(commands.has(sidebar.OPEN_VIEW_COMMAND), 'open-sidebar command should register');
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

testFixtureParsing();
testBlockExtractionAndStatus();
testMarkdownArchitecture();
testSidebarHelpers();
testSidebarRegistration();
const history = testRealHistory();
console.log(`sub-agent regression passed (${history.files} real files, ${history.messages} messages, ${Math.round(history.bytes / 1024 / 1024)} MB)`);
