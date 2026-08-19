'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compactLabel,
  defaultProjectsRoot,
  findSubagentFiles,
  readSubagentTranscript,
  updateSubagentTranscript,
} = require('./subagent-transcripts');

const VIEW_ID = 'claude-code-enhance.subagents';
const OPEN_VIEW_COMMAND = 'claude-code-enhance.openSubagentTranscripts';
const OPEN_TRANSCRIPT_COMMAND = 'claude-code-enhance.openSubagentTranscript';
const OPEN_RAW_COMMAND = 'claude-code-enhance.openRawSubagentTranscript';
const REFRESH_COMMAND = 'claude-code-enhance.refreshSubagents';
const SHOW_ALL_COMMAND = 'claude-code-enhance.showAllSubagentProjects';
const SHOW_WORKSPACE_COMMAND = 'claude-code-enhance.showWorkspaceSubagentProjects';
const SCOPE_CONTEXT_KEY = 'claudeCodeEnhance.subagentScope';
const SCOPE_ALL = 'all';
const SCOPE_WORKSPACE = 'workspace';
const REFRESH_INTERVAL_MS = 3000;

function resolveProjectsRoot(vscode) {
  const configured = vscode.workspace.getConfiguration('claudeCodeEnhance')
    .get('subagentProjectsRoot', '');
  if (!configured || !String(configured).trim()) return defaultProjectsRoot();
  const value = String(configured).trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function canonicalPath(filePath) {
  if (!filePath) return '';
  const resolved = path.resolve(filePath);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // Histories can refer to worktrees or directories that no longer exist.
  }
  canonical = path.normalize(canonical);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function pathContains(rootPath, candidatePath) {
  const root = canonicalPath(rootPath);
  const candidate = canonicalPath(candidatePath);
  if (!root || !candidate) return false;
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function claudeProjectId(filePath, resolveSymlinks = true) {
  let projectPath = resolveSymlinks ? canonicalPath(filePath) : path.normalize(path.resolve(filePath));
  if (process.platform === 'win32') projectPath = projectPath.toLowerCase();
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function activeWorkspacePaths(vscode) {
  return (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder?.uri?.fsPath)
    .filter(Boolean)
    .map(canonicalPath);
}

function activeWorkspaceProjectIds(vscode) {
  const ids = new Set();
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const workspacePath = folder?.uri?.fsPath;
    if (!workspacePath) continue;
    ids.add(claudeProjectId(workspacePath, false));
    ids.add(claudeProjectId(workspacePath));
  }
  return ids;
}

function filterWorkspaceDescriptors(descriptors, workspacePaths) {
  if (!workspacePaths.length) return [];
  const projectIds = new Set(workspacePaths.map(claudeProjectId));
  return descriptors.filter((descriptor) => {
    if (descriptor.projectPath) {
      return workspacePaths.some((workspacePath) => pathContains(workspacePath, descriptor.projectPath));
    }
    return projectIds.has(descriptor.projectId);
  });
}

function groupDescriptors(descriptors) {
  const projects = new Map();
  for (const descriptor of descriptors) {
    let project = projects.get(descriptor.projectId);
    if (!project) {
      project = {
        type: 'project',
        id: descriptor.projectId,
        label: descriptor.projectLabel || descriptor.projectId,
        projectPath: descriptor.projectPath,
        children: new Map(),
        latest: 0,
        count: 0,
      };
      projects.set(descriptor.projectId, project);
    }
    let session = project.children.get(descriptor.sessionId);
    if (!session) {
      session = {
        type: 'session',
        id: descriptor.sessionId,
        label: descriptor.sessionLabel || descriptor.sessionId,
        prompt: descriptor.sessionPrompt,
        parentPath: descriptor.parentPath,
        children: [],
        latest: 0,
      };
      project.children.set(descriptor.sessionId, session);
    }
    session.children.push({ type: 'agent', descriptor });
    session.latest = Math.max(session.latest, descriptor.mtimeMs);
    project.latest = Math.max(project.latest, descriptor.mtimeMs);
    project.count++;
  }

  return Array.from(projects.values())
    .sort((a, b) => b.latest - a.latest || a.label.localeCompare(b.label))
    .map((project) => ({
      ...project,
      children: Array.from(project.children.values())
        .sort((a, b) => b.latest - a.latest || a.label.localeCompare(b.label)),
    }));
}

class SubagentTreeProvider {
  constructor(vscode) {
    this.vscode = vscode;
    this.root = resolveProjectsRoot(vscode);
    this.scope = SCOPE_WORKSPACE;
    this.nodes = [];
    this.descriptors = [];
    this.fingerprint = '';
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
    this.refresh();
  }

  setScope(scope) {
    const next = scope === SCOPE_ALL ? SCOPE_ALL : SCOPE_WORKSPACE;
    if (next === this.scope) return false;
    this.scope = next;
    this.fingerprint = '';
    this.refresh();
    return true;
  }

  refresh() {
    this.root = resolveProjectsRoot(this.vscode);
    const workspacePaths = activeWorkspacePaths(this.vscode);
    const discovered = this.scope === SCOPE_ALL
      ? findSubagentFiles(this.root)
      : findSubagentFiles(this.root, {
          projectIds: activeWorkspaceProjectIds(this.vscode),
          includeDescendants: true,
        });
    const descriptors = this.scope === SCOPE_ALL
      ? discovered
      : filterWorkspaceDescriptors(discovered, workspacePaths);
    const fingerprint = [this.scope, ...workspacePaths, ...descriptors.map((descriptor) => (
      `${descriptor.filePath}:${descriptor.size}:${descriptor.mtimeMs}:${descriptor.status}`
    ))].join('\n');
    if (fingerprint === this.fingerprint) return false;
    this.fingerprint = fingerprint;
    this.descriptors = descriptors;
    this.nodes = groupDescriptors(descriptors);
    this.changeEmitter.fire(undefined);
    return true;
  }

  getTreeItem(element) {
    const vscode = this.vscode;
    if (element.type === 'project') {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = `${element.count} sub-agents`;
      item.tooltip = element.projectPath || element.id;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'subagentProject';
      return item;
    }
    if (element.type === 'session') {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = `${element.children.length}`;
      item.tooltip = element.prompt || element.id;
      item.iconPath = new vscode.ThemeIcon('history');
      item.contextValue = 'subagentSession';
      return item;
    }

    const descriptor = element.descriptor;
    const item = new vscode.TreeItem(
      descriptor.label,
      vscode.TreeItemCollapsibleState.None
    );
    const identity = descriptor.agentType || `agent-${descriptor.agentId.slice(0, 8)}`;
    item.description = `${identity} | ${descriptor.status}`;
    item.tooltip = [
      descriptor.prompt || descriptor.label,
      '',
      `Agent: ${descriptor.agentId}`,
      `Status: ${descriptor.status}`,
      `Size: ${formatBytes(descriptor.size)}`,
      `File: ${descriptor.filePath}`,
    ].join('\n');
    item.iconPath = new vscode.ThemeIcon(
      descriptor.status === 'failed' ? 'error' :
        (descriptor.status === 'active' ? 'sync~spin' : 'account')
    );
    item.contextValue = 'subagentTranscript';
    item.command = {
      command: OPEN_TRANSCRIPT_COMMAND,
      title: 'Open Sub-agent Transcript',
      arguments: [descriptor],
    };
    return item;
  }

  getChildren(element) {
    return element ? element.children : this.nodes;
  }

  dispose() {
    this.changeEmitter.dispose();
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function webviewUri(vscode, webview, extensionUri, ...segments) {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
}

function transcriptHtml(vscode, webview, extensionUri) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const katexCss = webviewUri(vscode, webview, extensionUri, 'vendor', 'katex.min.css');
  const highlightCss = webviewUri(vscode, webview, extensionUri, 'vendor', 'highlight-vs2015.min.css');
  const viewCss = webviewUri(vscode, webview, extensionUri, 'vendor', 'subagent-view.css');
  const markedJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'marked.min.js');
  const katexJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'katex.min.js');
  const highlightJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'highlight.min.js');
  const viewJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'subagent-view.js');
  const csp = [
    "default-src 'none'",
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    'img-src data:',
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${katexCss}">
  <link rel="stylesheet" href="${highlightCss}">
  <link rel="stylesheet" href="${viewCss}">
  <title>Sub-agent Transcript</title>
</head>
<body>
  <header class="toolbar">
    <input id="search" type="search" aria-label="Search transcript" placeholder="Search transcript">
    <div class="filters" role="group" aria-label="Message filter">
      <button type="button" data-filter="all" aria-pressed="true">All</button>
      <button type="button" data-filter="assistant" aria-pressed="false">Answers</button>
      <button type="button" data-filter="thinking" aria-pressed="false">Thinking</button>
      <button type="button" data-filter="tools" aria-pressed="false">Tools</button>
      <button type="button" data-filter="errors" aria-pressed="false">Errors</button>
    </div>
    <button id="latest" class="icon-button" type="button" title="Jump to latest" aria-label="Jump to latest">&darr;</button>
  </header>
  <section id="summary" class="summary" aria-live="polite"></section>
  <main id="transcript" class="transcript" aria-busy="true">
    <div class="empty-state">Loading transcript...</div>
  </main>
  <div id="status" class="live-status" aria-live="polite"></div>
  <script nonce="${nonce}" src="${markedJs}"></script>
  <script nonce="${nonce}" src="${katexJs}"></script>
  <script nonce="${nonce}" src="${highlightJs}"></script>
  <script nonce="${nonce}" src="${viewJs}"></script>
</body>
</html>`;
}

function isAppendOnly(previous, next) {
  if (!previous || previous.filePath !== next.filePath) return false;
  if (next.messages.length < previous.messages.length) return false;
  for (let index = 0; index < previous.messages.length; index++) {
    if (previous.messages[index].id !== next.messages[index].id) return false;
  }
  return true;
}

function publicTranscript(transcript, includeMessages = true) {
  const { readState, messages, ...metadata } = transcript;
  return includeMessages ? { ...metadata, messages } : metadata;
}

class TranscriptPanelManager {
  constructor(vscode, context) {
    this.vscode = vscode;
    this.context = context;
    this.panel = null;
    this.descriptor = null;
    this.transcript = null;
    this.ready = false;
  }

  hasOpenPanel() {
    return !!this.panel;
  }

  isVisible() {
    return !!this.panel && this.panel.visible !== false;
  }

  show(descriptor) {
    if (!descriptor?.filePath) return;
    this.descriptor = descriptor;
    this.transcript = null;

    if (!this.panel) this.createPanel();
    this.panel.title = compactLabel(descriptor.label, 48) || 'Sub-agent Transcript';
    this.panel.reveal(this.vscode.ViewColumn.Beside, false);
    if (this.ready) this.refresh(true);
  }

  createPanel() {
    const localResourceRoots = [
      this.vscode.Uri.joinPath(this.context.extensionUri, 'vendor'),
    ];
    this.panel = this.vscode.window.createWebviewPanel(
      'claude-code-enhance.subagentTranscript',
      'Sub-agent Transcript',
      this.vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots,
        enableCommandUris: false,
      }
    );
    this.panel.webview.html = transcriptHtml(
      this.vscode,
      this.panel.webview,
      this.context.extensionUri
    );
    this.panel.onDidDispose(() => {
      this.panel = null;
      this.descriptor = null;
      this.transcript = null;
      this.ready = false;
    }, null, this.context.subscriptions);
    this.panel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.visible) {
        this.ready = false;
        this.transcript = null;
      }
    }, null, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'ready') {
        this.ready = true;
        this.refresh(true);
      } else if (message?.type === 'openRaw' && this.descriptor) {
        openRawTranscript(this.vscode, this.descriptor);
      }
    }, null, this.context.subscriptions);
  }

  refresh(force = false) {
    if (!this.panel || !this.ready || !this.descriptor) return;
    let stat;
    try {
      stat = fs.statSync(this.descriptor.filePath);
    } catch (error) {
      this.panel.webview.postMessage({ type: 'error', message: String(error.message || error) });
      return;
    }
    if (!force && this.transcript &&
        stat.size === this.transcript.bytes &&
        stat.mtimeMs === this.transcript.descriptor.mtimeMs) return;

    try {
      const update = this.transcript
        ? updateSubagentTranscript(this.transcript, this.descriptor)
        : { append: false, transcript: readSubagentTranscript(this.descriptor) };
      const next = update.transcript;
      const payload = update.append ? {
        type: 'append',
        transcript: publicTranscript(next, false),
        messages: update.appendedMessages,
      } : { type: 'replace', transcript: publicTranscript(next) };
      this.transcript = next;
      this.descriptor = next.descriptor;
      this.panel.webview.postMessage(payload);
    } catch (error) {
      this.panel.webview.postMessage({ type: 'error', message: String(error.message || error) });
    }
  }

  dispose() {
    this.panel?.dispose();
  }
}

function openRawTranscript(vscode, descriptor) {
  if (!descriptor?.filePath) return Promise.resolve();
  return vscode.workspace.openTextDocument(vscode.Uri.file(descriptor.filePath))
    .then((document) => vscode.window.showTextDocument(document, { preview: false }));
}

function pickDescriptor(vscode, descriptors, placeHolder) {
  const items = descriptors.map((descriptor) => ({
    label: descriptor.label,
    description: `${descriptor.projectLabel} | ${descriptor.agentType || descriptor.agentId}`,
    detail: descriptor.filePath,
    descriptor,
  }));
  return vscode.window.showQuickPick(items, {
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder,
  }).then((item) => item?.descriptor || null);
}

function registerSubagentSidebar(vscode, context) {
  const provider = new SubagentTreeProvider(vscode);
  const panels = new TranscriptPanelManager(vscode, context);
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const updateScopeUi = () => {
    const isAll = provider.scope === SCOPE_ALL;
    treeView.description = isAll ? 'All Projects' : 'Workspace';
    treeView.message = provider.descriptors.length
      ? undefined
      : (isAll ? 'No sub-agent histories found.' : 'No sub-agent history for this workspace.');
    return vscode.commands.executeCommand('setContext', SCOPE_CONTEXT_KEY, provider.scope);
  };

  updateScopeUi();

  context.subscriptions.push(
    provider,
    panels,
    treeView,
    vscode.commands.registerCommand(OPEN_VIEW_COMMAND, () => {
      provider.refresh();
      updateScopeUi();
      return vscode.commands.executeCommand('workbench.view.extension.claude-code-enhance');
    }),
    vscode.commands.registerCommand(OPEN_TRANSCRIPT_COMMAND, (descriptor) => panels.show(descriptor)),
    vscode.commands.registerCommand(OPEN_RAW_COMMAND, (nodeOrDescriptor) => {
      const descriptor = nodeOrDescriptor?.descriptor || nodeOrDescriptor;
      if (descriptor?.filePath) return openRawTranscript(vscode, descriptor);
      return pickDescriptor(vscode, provider.descriptors, 'Select a sub-agent transcript')
        .then((selected) => selected ? openRawTranscript(vscode, selected) : undefined);
    }),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      provider.refresh();
      panels.refresh(true);
      return updateScopeUi();
    }),
    vscode.commands.registerCommand(SHOW_ALL_COMMAND, () => {
      provider.setScope(SCOPE_ALL);
      return updateScopeUi();
    }),
    vscode.commands.registerCommand(SHOW_WORKSPACE_COMMAND, () => {
      provider.setScope(SCOPE_WORKSPACE);
      return updateScopeUi();
    })
  );

  const timer = setInterval(() => {
    if (treeView.visible && provider.refresh()) updateScopeUi();
    if (panels.isVisible()) panels.refresh();
  }, REFRESH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('claudeCodeEnhance.subagentProjectsRoot')) {
        provider.refresh();
        updateScopeUi();
      }
    }));
  }
  if (vscode.workspace.onDidChangeWorkspaceFolders) {
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.refresh();
      updateScopeUi();
    }));
  }

  return { provider, panels, treeView };
}

module.exports = {
  OPEN_RAW_COMMAND,
  OPEN_TRANSCRIPT_COMMAND,
  OPEN_VIEW_COMMAND,
  REFRESH_COMMAND,
  SHOW_ALL_COMMAND,
  SHOW_WORKSPACE_COMMAND,
  SCOPE_ALL,
  SCOPE_CONTEXT_KEY,
  SCOPE_WORKSPACE,
  REFRESH_INTERVAL_MS,
  VIEW_ID,
  SubagentTreeProvider,
  TranscriptPanelManager,
  formatBytes,
  activeWorkspacePaths,
  activeWorkspaceProjectIds,
  claudeProjectId,
  filterWorkspaceDescriptors,
  groupDescriptors,
  isAppendOnly,
  publicTranscript,
  pathContains,
  pickDescriptor,
  registerSubagentSidebar,
  resolveProjectsRoot,
  transcriptHtml,
};
