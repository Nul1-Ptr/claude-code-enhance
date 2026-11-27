'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compactLabel,
  defaultProjectsRoot,
  findSubagentFilesAsync,
} = require('./subagent-transcripts');
const conversationHistory = require('./conversation-history');
const { richWorkerConfiguration } = require('./rich-content-assets');

const VIEW_ID = 'claude-code-enhance.subagents';
const OPEN_VIEW_COMMAND = 'claude-code-enhance.openSubagentTranscripts';
const OPEN_TRANSCRIPT_COMMAND = 'claude-code-enhance.openSubagentTranscript';
const OPEN_CONVERSATION_HISTORY_COMMAND = 'claude-code-enhance.openConversationHistory';
const OPEN_RAW_COMMAND = 'claude-code-enhance.openRawSubagentTranscript';
const REFRESH_COMMAND = 'claude-code-enhance.refreshSubagents';
const SHOW_ALL_COMMAND = 'claude-code-enhance.showAllSubagentProjects';
const SHOW_WORKSPACE_COMMAND = 'claude-code-enhance.showWorkspaceSubagentProjects';
const SCOPE_CONTEXT_KEY = 'claudeCodeEnhance.subagentScope';
const SCOPE_ALL = 'all';
const SCOPE_WORKSPACE = 'workspace';
const WATCH_REFRESH_DEBOUNCE_MS = 250;
const WATCH_FALLBACK_INTERVAL_MS = 45 * 1000;
const MAX_HISTORY_WATCHERS = 128;
const REFRESH_INTERVAL_MS = WATCH_FALLBACK_INTERVAL_MS;

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

function conversationHistoryErrorMessage(error) {
  if (error?.code === 'ENOENT') return 'The selected conversation file is no longer available.';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'The selected conversation file cannot be read.';
  if (error?.code === 'CONVERSATION_INDEX_STALE') {
    return 'Conversation history changed while it was being read; refreshing the view.';
  }
  if (error?.code === 'ABORT_ERR' || error?.name === 'AbortError') return '';
  return 'Unable to read conversation history.';
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
    this.refreshPromise = null;
    this.refreshQueued = false;
    this.refreshQueuedForce = false;
    this.generation = 0;
    this.disposed = false;
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
  }

  setScope(scope) {
    const next = scope === SCOPE_ALL ? SCOPE_ALL : SCOPE_WORKSPACE;
    if (next === this.scope) return false;
    this.scope = next;
    this.fingerprint = '';
    this.generation++;
    if (this.refreshPromise) this.refreshQueued = true;
    return true;
  }

  async refresh(force = false) {
    if (this.disposed) return false;
    if (this.refreshPromise) {
      this.refreshQueued = true;
      this.refreshQueuedForce = this.refreshQueuedForce || force;
      return this.refreshPromise;
    }
    const generation = this.generation;
    this.refreshPromise = this.refreshNow(force, generation).finally(() => {
      this.refreshPromise = null;
      if (this.refreshQueued && !this.disposed) {
        const queuedForce = this.refreshQueuedForce;
        this.refreshQueued = false;
        this.refreshQueuedForce = false;
        void this.refresh(queuedForce);
      }
    });
    return this.refreshPromise;
  }

  async refreshNow(force = false, generation = this.generation) {
    this.root = resolveProjectsRoot(this.vscode);
    const workspacePaths = activeWorkspacePaths(this.vscode);
    const discovered = this.scope === SCOPE_ALL
      ? await findSubagentFilesAsync(this.root)
      : await findSubagentFilesAsync(this.root, {
          projectIds: activeWorkspaceProjectIds(this.vscode),
          includeDescendants: true,
        });
    const descriptors = this.scope === SCOPE_ALL
      ? discovered
      : filterWorkspaceDescriptors(discovered, workspacePaths);
    if (generation !== this.generation || this.disposed) return false;
    const fingerprint = [this.scope, ...workspacePaths, ...descriptors.map((descriptor) => (
      `${descriptor.filePath}:${descriptor.size}:${descriptor.mtimeMs}:${descriptor.status}`
    ))].join('\n');
    if (!force && fingerprint === this.fingerprint) return false;
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
    this.disposed = true;
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
  const katexCss = webviewUri(vscode, webview, extensionUri, 'vendor', 'katex-woff2.min.css');
  const highlightCss = webviewUri(vscode, webview, extensionUri, 'vendor', 'highlight-vs2015.min.css');
  const viewCss = webviewUri(vscode, webview, extensionUri, 'vendor', 'subagent-view.css');
  const markedJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'marked.min.js');
  const katexJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'katex.min.js');
  const highlightJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'highlight.min.js');
  const runtimeJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'runtime-core.js');
  const mathJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'math-core.js');
  const viewJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'subagent-view.js');
  const richJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'rich-content.js');
  const richDocumentJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'rich-document.js');
  const richFragmentsJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'rich-fragments.js');
  const richRowsJs = webviewUri(vscode, webview, extensionUri, 'vendor', 'rich-rows.js');
  const csp = [
    "default-src 'none'",
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    'worker-src blob:',
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
    <div id="filter-group" class="filters" role="group" aria-label="Message filter">
      <button type="button" data-filter="all" aria-pressed="true">All</button>
      <button type="button" data-filter="assistant" aria-pressed="false">Answers</button>
      <button type="button" data-filter="thinking" aria-pressed="false">Thinking</button>
      <button type="button" data-filter="tools" aria-pressed="false">Tools</button>
      <button type="button" data-filter="errors" aria-pressed="false">Errors</button>
    </div>
    <button id="latest" class="icon-button" type="button" title="Jump to latest" aria-label="Jump to latest">&darr;</button>
  </header>
  <nav id="conversation-pagination" class="conversation-pagination" hidden aria-label="Conversation pages">
    <button id="conversation-first" type="button">First</button>
    <button id="conversation-previous" type="button">Older</button>
    <span id="conversation-page-label"></span>
    <button id="conversation-next" type="button">Newer</button>
    <form id="conversation-jump">
      <label for="conversation-page-input">Page</label>
      <input id="conversation-page-input" type="number" min="1" step="1" value="1" required>
      <button type="submit">Go</button>
    </form>
    <button id="conversation-latest" type="button">Latest</button>
  </nav>
  <section id="conversation-search-results" class="conversation-search-results" hidden aria-live="polite">
    <div class="conversation-search-heading"><strong id="conversation-search-summary"></strong><button id="conversation-search-more" type="button" hidden>More results</button></div>
    <div id="conversation-search-list" class="conversation-search-list"></div>
  </section>
  <section id="summary" class="summary" aria-live="polite"></section>
  <main id="transcript" class="transcript" aria-busy="true">
    <div class="empty-state">Loading transcript...</div>
  </main>
  <div id="status" class="live-status" aria-live="polite"></div>
  <script nonce="${nonce}" src="${markedJs}"></script>
  <script nonce="${nonce}" src="${katexJs}"></script>
  <script nonce="${nonce}" src="${highlightJs}"></script>
  <script nonce="${nonce}" src="${runtimeJs}"></script>
  <script nonce="${nonce}" src="${mathJs}"></script>
  <script nonce="${nonce}" src="${viewJs}"></script>
  <script nonce="${nonce}" src="${richFragmentsJs}"></script>
  <script nonce="${nonce}" src="${richDocumentJs}"></script>
  <script nonce="${nonce}" src="${richRowsJs}"></script>
  <script nonce="${nonce}">${richWorkerConfiguration(path.join(__dirname, '..', 'vendor'))}</script>
  <script nonce="${nonce}" src="${richJs}"></script>
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
    this.cursor = null;
    this.ready = false;
    this.mode = 'subagent';
    this.historyIndex = null;
    this.historyRoot = null;
    this.historyPageIndex = -1;
    this.historyPageRequestId = null;
    this.historyPageController = null;
    this.pageAcknowledgements = new Map();
    this.historyViewNeedsReload = false;
    this.historyGeneration = 0;
    this.historyController = null;
    this.searchControllers = new Map();
    this.searchContinuations = new Map();
    this.historyLoadPromise = null;
    this.historyLoadQueued = false;
    this.historyLoadQueuedForce = false;
    this.refreshPromise = null;
    this.refreshQueued = false;
    this.refreshQueuedForce = false;
    this.generation = 0;
    this.abortController = null;
    this.fileWatcher = null;
    this.fileRefreshTimer = null;
  }

  hasOpenPanel() {
    return !!this.panel;
  }

  isVisible() {
    return !!this.panel && this.panel.visible !== false;
  }

  show(descriptor) {
    return this.showConversation({ ...descriptor, kind: 'subagent' }, resolveProjectsRoot(this.vscode));
  }

  showConversation(descriptor, projectsRoot) {
    if (!descriptor?.filePath || !conversationHistory.withinRoot(projectsRoot, descriptor.filePath)) return;
    this.mode = 'conversation';
    this.historyIndex = null;
    this.historyRoot = path.resolve(projectsRoot);
    this.historyPageIndex = -1;
    this.historyPageRequestId = null;
    this.historyPageController?.abort?.();
    this.historyPageController = null;
    this.historyViewNeedsReload = true;
    this.historyController?.abort?.();
    this.historyController = null;
    this.historyLoadQueued = false;
    this.historyLoadQueuedForce = false;
    this.historyGeneration++;
    this.cancelConversationSearches();
    this.descriptor = descriptor;
    this.transcript = null;
    this.cursor = null;
    this.generation++;
    this.refreshQueued = false;
    this.refreshQueuedForce = false;
    this.abortController?.abort?.();
    this.watchTranscriptFile();

    if (!this.panel) this.createPanel();
    this.panel.title = compactLabel(descriptor.label, 48) || 'Conversation History';
    this.panel.reveal(this.vscode.ViewColumn.Beside, false);
    if (this.ready) {
      void this.panel.webview.postMessage({
        type: 'conversationLoading',
        label: this.panel.title,
      });
      void this.loadConversation(true);
    }
  }

  cancelConversationSearches() {
    for (const controller of this.searchControllers.values()) controller.abort();
    this.searchControllers.clear();
    this.searchContinuations.clear();
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
      this.cursor = null;
      this.historyIndex = null;
      this.historyPageIndex = -1;
      this.historyPageRequestId = null;
      this.historyPageController?.abort?.();
      this.historyPageController = null;
      this.historyViewNeedsReload = false;
      this.historyController?.abort?.();
      this.historyController = null;
      this.cancelConversationSearches();
      this.mode = 'subagent';
      this.historyLoadQueued = false;
      this.historyLoadQueuedForce = false;
      this.abortController?.abort?.();
      this.fileWatcher?.close?.();
      this.fileWatcher = null;
      clearTimeout(this.fileRefreshTimer);
      this.ready = false;
    }, null, this.context.subscriptions);
    this.panel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.visible) {
        this.ready = false;
        this.transcript = null;
        this.cursor = null;
        this.historyViewNeedsReload = this.mode === 'conversation';
        this.historyPageRequestId = null;
        this.historyPageController?.abort?.();
        this.historyPageController = null;
        this.historyController?.abort?.();
        this.historyController = null;
        this.historyLoadQueued = false;
        this.historyLoadQueuedForce = false;
        this.abortController?.abort?.();
        this.cancelConversationSearches();
        if (this.mode === 'conversation') this.panel?.webview.postMessage({ type: 'conversationPaused' });
        this.refreshQueued = false;
        this.refreshQueuedForce = false;
        this.fileWatcher?.close?.();
        this.fileWatcher = null;
      } else {
        this.watchTranscriptFile();
      }
    }, null, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'ready') {
        this.ready = true;
        if (this.mode === 'conversation') {
          void this.panel.webview.postMessage({
            type: 'conversationLoading',
            label: this.panel.title || 'Conversation History',
          });
          void this.loadConversation(false);
        } else {
          void this.refresh(true);
        }
      } else if (message?.type === 'openRaw' && this.descriptor) {
        if (this.mode === 'conversation') void this.openConversationRaw(message.line);
        else openRawTranscript(this.vscode, this.descriptor, message.line);
      } else if (this.mode === 'conversation' && message?.type === 'loadPage') {
        if (message.ackToken) this.acknowledgePageChunk(message);
        else void this.loadConversationPage(message);
      } else if (this.mode === 'conversation' && message?.type === 'search') {
        void this.searchConversation(message);
      } else if (this.mode === 'conversation' && message?.type === 'cancelSearch') {
        const requestId = String(message.requestId || '');
        this.searchControllers.get(requestId)?.abort();
        for (const [token, continuation] of this.searchContinuations) {
          if (continuation.requestId === requestId) this.searchContinuations.delete(token);
        }
      }
    }, null, this.context.subscriptions);
  }

  watchTranscriptFile() {
    this.fileWatcher?.close?.();
    this.fileWatcher = null;
    clearTimeout(this.fileRefreshTimer);
    if (!this.descriptor?.filePath) return;
    try {
      const watcher = fs.watch(this.descriptor.filePath, { persistent: false }, (eventType) => {
        if (eventType === 'rename') {
          if (this.fileWatcher === watcher) this.fileWatcher = null;
          watcher.close?.();
        }
        clearTimeout(this.fileRefreshTimer);
        this.fileRefreshTimer = setTimeout(() => {
          if (!this.isVisible()) return;
          if (this.mode === 'conversation') void this.loadConversation(false);
          else void this.refresh();
        }, WATCH_REFRESH_DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        if (this.fileWatcher === watcher) this.fileWatcher = null;
        watcher.close?.();
      });
      this.fileWatcher = watcher;
    } catch {}
  }

  async refresh(force = false) {
    return this.loadConversation(force);
  }

  conversationMetadata() {
    if (!this.historyIndex || !this.descriptor) return null;
    return {
      descriptor: {
        sessionId: this.descriptor.sessionId,
        label: this.descriptor.label,
        projectLabel: this.descriptor.projectLabel,
        status: this.descriptor.status,
        kind: this.descriptor.kind || 'conversation',
        agentType: this.descriptor.agentType,
        viewId: crypto.createHash('sha256').update(this.descriptor.filePath).digest('hex').slice(0, 24),
      },
      bytes: this.historyIndex.bytes,
      lines: this.historyIndex.lines,
      malformedLines: this.historyIndex.malformedLines,
      partialLine: this.historyIndex.partialLine,
      messageCount: this.historyIndex.messageCount,
    };
  }

  async openConversationRaw(lineNumber) {
    const descriptor = this.descriptor;
    const historyRoot = this.historyRoot;
    const generation = this.generation;
    if (!descriptor?.filePath || !historyRoot ||
        !conversationHistory.withinRoot(historyRoot, descriptor.filePath)) return;
    try {
      const actualRoot = await fs.promises.realpath(historyRoot);
      const actualPath = await fs.promises.realpath(descriptor.filePath);
      if (!conversationHistory.withinRoot(actualRoot, actualPath)) return;
      if (generation !== this.generation || this.mode !== 'conversation') return;
      await openRawTranscript(this.vscode, { ...descriptor, filePath: actualPath }, lineNumber);
    } catch (error) {
      if (this.panel && this.mode === 'conversation' && generation === this.generation) {
        await this.panel.webview.postMessage({
          type: 'error',
          message: conversationHistoryErrorMessage(error),
        });
      }
    }
  }

  loadConversation(force = false) {
    if (this.historyLoadPromise) {
      this.historyLoadQueued = true;
      this.historyLoadQueuedForce = this.historyLoadQueuedForce || force;
      return this.historyLoadPromise;
    }
    this.historyLoadPromise = this.loadConversationNow(force).finally(() => {
      this.historyLoadPromise = null;
      if (this.historyLoadQueued && this.panel && this.ready && this.mode === 'conversation') {
        const queuedForce = this.historyLoadQueuedForce;
        this.historyLoadQueued = false;
        this.historyLoadQueuedForce = false;
        void this.loadConversation(queuedForce);
      }
    });
    return this.historyLoadPromise;
  }

  async loadConversationNow(force = false) {
    if (!this.panel || !this.ready || !this.descriptor || !this.historyRoot || !this.isVisible()) return;
    const generation = this.generation;
    const historyGeneration = this.historyGeneration;
    const descriptor = this.descriptor;
    const historyRoot = this.historyRoot;
    const previousIndex = this.historyIndex;
    const controller = new AbortController();
    this.historyController?.abort?.();
    this.historyController = controller;
    try {
      if (!conversationHistory.withinRoot(historyRoot, descriptor.filePath)) {
        throw new Error('The selected conversation is outside the configured history directory.');
      }
      const actualPath = await fs.promises.realpath(descriptor.filePath);
      const actualRoot = await fs.promises.realpath(historyRoot);
      if (!conversationHistory.withinRoot(actualRoot, actualPath)) {
        throw new Error('Conversation history resolves outside the configured history directory.');
      }
      const actualDescriptor = { ...descriptor, filePath: actualPath };
      const nextIndex = force || !previousIndex
        ? await conversationHistory.buildConversationIndex(actualDescriptor, { signal: controller.signal })
        : await conversationHistory.updateConversationIndex(previousIndex, actualDescriptor, { signal: controller.signal });
      if (generation !== this.generation || historyGeneration !== this.historyGeneration ||
          controller.signal.aborted || !this.panel || !this.isVisible()) return;
      const previousPageIndex = this.historyPageIndex;
      if (previousIndex && nextIndex !== previousIndex && nextIndex.updateType !== 'appended') {
        this.cancelConversationSearches();
      }
      this.descriptor = actualDescriptor;
      this.historyIndex = nextIndex;
      if (!this.fileWatcher) this.watchTranscriptFile();

      if (this.historyViewNeedsReload) {
        const lastPage = Math.max(0, Math.ceil(this.historyIndex.messageCount /
          conversationHistory.CONVERSATION_PAGE_SIZE) - 1);
        const pageIndex = previousPageIndex < 0 ? lastPage : Math.min(previousPageIndex, lastPage);
        const requestId = `initial-${historyGeneration}-${Date.now()}`;
        this.historyViewNeedsReload = false;
        await this.panel.webview.postMessage({
          type: 'conversationStart',
          requestId,
          transcript: this.conversationMetadata(),
        });
        await this.loadConversationPage({ pageIndex, requestId }, { signal: controller.signal });
        return;
      }

      if (previousIndex && !force && this.historyIndex === previousIndex) return;

      if (previousIndex && !force && this.historyIndex.updateType === 'appended') {
        const messagesChanged = this.historyIndex.messageCount !== previousIndex.messageCount;
        await this.panel.webview.postMessage({
          type: 'conversationUpdate',
          messagesChanged,
          transcript: this.conversationMetadata(),
        });
        return;
      }

      const metadata = this.conversationMetadata();
      this.historyViewNeedsReload = false;
      const requestId = `initial-${historyGeneration}-${Date.now()}`;
      await this.panel.webview.postMessage({ type: 'conversationStart', requestId, transcript: metadata });
      const lastPage = Math.max(0, Math.ceil(this.historyIndex.messageCount /
        conversationHistory.CONVERSATION_PAGE_SIZE) - 1);
      this.historyPageIndex = lastPage;
      await this.loadConversationPage({ pageIndex: lastPage, requestId }, {
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.code === 'CONVERSATION_INDEX_STALE' && generation === this.generation &&
          historyGeneration === this.historyGeneration) {
        void this.loadConversation(true);
      } else if (error?.name !== 'AbortError' && error?.code !== 'ABORT_ERR' &&
          generation === this.generation && historyGeneration === this.historyGeneration && this.panel) {
        this.panel.webview.postMessage({
          type: 'error',
          message: conversationHistoryErrorMessage(error),
        });
      }
    } finally {
      if (this.historyController === controller) this.historyController = null;
    }
  }

  async loadConversationPage(message, options = {}) {
    if (!this.historyIndex || !this.panel || !this.isVisible()) return;
    const requestedPageIndex = Number(message.pageIndex);
    if (!Number.isInteger(requestedPageIndex)) return;
    const lastPage = Math.max(0, Math.ceil(this.historyIndex.messageCount /
      conversationHistory.CONVERSATION_PAGE_SIZE) - 1);
    const pageIndex = Math.max(0, Math.min(lastPage, requestedPageIndex));
    if (!Number.isInteger(pageIndex) || pageIndex < 0) return;
    this.historyPageIndex = pageIndex;
    const generation = this.generation;
    const historyGeneration = this.historyGeneration;
    const requestId = String(message.requestId || '').slice(0, 100);
    if (!requestId) return;
    this.historyPageController?.abort?.();
    const controller = new AbortController();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    this.historyPageController = controller;
    this.historyPageRequestId = requestId;
    try {
      let chunk = [];
      let chunkBytes = 0;
      let streamed = false;
      const flush = async () => {
        if (!chunk.length) return;
        await this.postPageChunk(requestId, chunk, controller.signal);
        chunk = [];
        chunkBytes = 0;
        streamed = true;
      };
      const page = await conversationHistory.loadConversationPage(this.historyIndex, pageIndex, {
        ...options,
        signal: controller.signal,
        onMessage: async (record) => {
          const bytes = Buffer.byteLength(JSON.stringify(record));
          if (chunk.length && chunkBytes + bytes > 512 * 1024) await flush();
          chunk.push(record);
          chunkBytes += bytes;
        },
      });
      if (streamed) await flush();
      else page.messages = chunk;
      if (generation !== this.generation || historyGeneration !== this.historyGeneration ||
          controller.signal.aborted || this.historyPageRequestId !== requestId ||
          !this.panel || !this.isVisible()) return;
      this.historyPageIndex = pageIndex;
      await this.panel.webview.postMessage({
        type: 'conversationPage',
        requestId,
        preserveScroll: message.preserveScroll === true,
        transcript: this.conversationMetadata(),
        ...page,
        streamed,
      });
    } catch (error) {
      if (generation !== this.generation || historyGeneration !== this.historyGeneration ||
          controller.signal.aborted || this.historyPageRequestId !== requestId || !this.panel || !this.isVisible()) return;
      if (error?.code === 'CONVERSATION_INDEX_STALE') {
        void this.loadConversation(true);
        return;
      }
      this.panel.webview.postMessage({ type: 'error', message: conversationHistoryErrorMessage(error) });
    } finally {
      if (this.historyPageController === controller) this.historyPageController = null;
    }
  }

  acknowledgePageChunk(message) {
    const pending = this.pageAcknowledgements.get(String(message.ackToken));
    if (pending?.requestId === message.requestId) pending.finish();
  }

  postPageChunk(requestId, messages, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        const error = new Error('Page loading cancelled.');
        error.name = 'AbortError';
        reject(error);
        return;
      }
      const ackToken = crypto.randomBytes(18).toString('base64url');
      const finish = (error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.pageAcknowledgements.delete(ackToken);
        if (error) reject(error); else resolve();
      };
      const abort = () => {
        const error = new Error('Page loading cancelled.');
        error.name = 'AbortError';
        finish(error);
      };
      const timer = setTimeout(() => finish(new Error('The history viewer stopped responding. Reopen it to retry.')), 15000);
      this.pageAcknowledgements.set(ackToken, { requestId, finish });
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(this.panel?.webview.postMessage({ type: 'conversationPageChunk', requestId, ackToken, messages }))
        .then((delivered) => { if (delivered === false) abort(); }, finish);
    });
  }

  async searchConversation(message) {
    if (!this.historyIndex || !this.panel || !this.isVisible()) return;
    const requestId = String(message.requestId || '').slice(0, 80);
    const query = String(message.query || '').trim();
    const filter = ['assistant', 'thinking', 'tools', 'errors'].includes(message.filter) ? message.filter : 'all';
    if (!requestId || (!query && filter === 'all') || query.length > 512) return;
    for (const [activeRequestId, activeController] of this.searchControllers) {
      if (activeRequestId === requestId) continue;
      activeController.abort();
      this.searchControllers.delete(activeRequestId);
    }
    for (const [token, continuation] of this.searchContinuations) {
      if (continuation.requestId !== requestId) this.searchContinuations.delete(token);
    }
    let cursor = null;
    let searchIndex = this.historyIndex;
    if (message.continuationToken) {
      const continuation = this.searchContinuations.get(String(message.continuationToken));
      if (!continuation || continuation.requestId !== requestId || continuation.query !== query || continuation.filter !== filter) return;
      cursor = continuation.cursor;
      searchIndex = continuation.index;
      this.searchContinuations.delete(String(message.continuationToken));
    } else {
      for (const [token, continuation] of this.searchContinuations) {
        if (continuation.requestId === requestId) this.searchContinuations.delete(token);
      }
    }
    this.searchControllers.get(requestId)?.abort();
    const controller = new AbortController();
    this.searchControllers.set(requestId, controller);
    const generation = this.generation;
    const historyGeneration = this.historyGeneration;
    try {
      const result = await conversationHistory.searchConversationPage(
        searchIndex,
        query,
        cursor,
        { signal: controller.signal, filter }
      );
      if (controller.signal.aborted || generation !== this.generation ||
          historyGeneration !== this.historyGeneration || !this.panel || !this.isVisible()) return;
      let continuationToken = null;
      if (!result.done && result.nextCursor) {
        continuationToken = crypto.randomBytes(18).toString('base64url');
        this.searchContinuations.set(continuationToken, { requestId, query, filter, cursor: result.nextCursor, index: searchIndex });
        while (this.searchContinuations.size > 64) {
          this.searchContinuations.delete(this.searchContinuations.keys().next().value);
        }
      }
      await this.panel.webview.postMessage({
        type: 'searchResults',
        requestId,
        query,
        hits: result.hits,
        continuationToken,
        done: result.done,
      });
    } catch (error) {
      if (error?.code === 'CONVERSATION_INDEX_STALE' && generation === this.generation &&
          historyGeneration === this.historyGeneration) {
        this.panel?.webview.postMessage({
          type: 'searchError',
          requestId,
          message: conversationHistoryErrorMessage(error),
        });
        void this.loadConversation(true);
        return;
      }
      if (error?.name !== 'AbortError' && error?.code !== 'ABORT_ERR' && this.panel &&
          generation === this.generation && historyGeneration === this.historyGeneration && this.isVisible()) {
        this.panel.webview.postMessage({
          type: 'searchError',
          requestId,
          message: conversationHistoryErrorMessage(error),
        });
      }
    } finally {
      if (this.searchControllers.get(requestId) === controller) this.searchControllers.delete(requestId);
    }
  }

  dispose() {
    this.panel?.dispose();
    this.abortController?.abort?.();
    this.historyController?.abort?.();
    this.historyController = null;
    this.historyPageController?.abort?.();
    this.historyPageController = null;
    this.historyLoadQueued = false;
    this.historyLoadQueuedForce = false;
    this.cancelConversationSearches();
    this.fileWatcher?.close?.();
    clearTimeout(this.fileRefreshTimer);
  }
}

function openRawTranscript(vscode, descriptor, lineNumber) {
  if (!descriptor?.filePath) return Promise.resolve();
  return vscode.workspace.openTextDocument(vscode.Uri.file(descriptor.filePath))
    .then((document) => {
      const options = { preview: false };
      const line = Math.max(0, Math.min(document.lineCount - 1, Number(lineNumber) - 1));
      if (Number.isInteger(Number(lineNumber)) && line >= 0 && vscode.Range && vscode.Position) {
        options.selection = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 0));
      }
      return vscode.window.showTextDocument(document, options);
    });
}

function pickDescriptor(vscode, descriptors, placeHolder) {
  const items = descriptors.map((descriptor) => ({
    label: descriptor.label,
    description: [descriptor.projectLabel, descriptor.agentType || descriptor.agentId || descriptor.status]
      .filter(Boolean).join(' | '),
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

  let refreshTimer = null;
  const directoryWatchers = new Map();
  const refreshVisible = () => {
    if (!treeView.visible) return Promise.resolve(false);
    return provider.refresh().then((changed) => {
      if (changed) updateScopeUi();
      return changed;
    });
  };
  const watchedHistoryDirectories = () => {
    const root = resolveProjectsRoot(vscode);
    const directories = new Set();
    const addDirectory = (directory) => {
      if (directories.size < MAX_HISTORY_WATCHERS) directories.add(directory);
    };
    addDirectory(root);
    for (const descriptor of provider.descriptors) {
      const subagents = path.dirname(descriptor.filePath);
      const session = path.dirname(subagents);
      addDirectory(path.dirname(session));
      addDirectory(session);
      addDirectory(subagents);
      if (directories.size >= MAX_HISTORY_WATCHERS) break;
    }
    return directories;
  };
  const syncDirectoryWatchers = () => {
    const required = watchedHistoryDirectories();
    for (const [directory, watcher] of directoryWatchers) {
      if (required.has(directory)) continue;
      watcher.close?.();
      directoryWatchers.delete(directory);
    }
    for (const directory of required) {
      if (directoryWatchers.has(directory)) continue;
      try {
        const watcher = fs.watch(directory, { persistent: false }, () => {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => { void refreshVisibleAndWatch(); }, WATCH_REFRESH_DEBOUNCE_MS);
        });
        watcher.on('error', () => {
          if (directoryWatchers.get(directory) === watcher) directoryWatchers.delete(directory);
          watcher.close?.();
        });
        directoryWatchers.set(directory, watcher);
      } catch {}
    }
  };
  const refreshVisibleAndWatch = () => refreshVisible().then((changed) => {
    syncDirectoryWatchers();
    return changed;
  });

  context.subscriptions.push(
    provider,
    panels,
    treeView,
    vscode.commands.registerCommand(OPEN_VIEW_COMMAND, () => {
      syncDirectoryWatchers();
      void refreshVisibleAndWatch();
      return vscode.commands.executeCommand('workbench.view.extension.claude-code-enhance');
    }),
    vscode.commands.registerCommand(OPEN_CONVERSATION_HISTORY_COMMAND, async () => {
      const root = resolveProjectsRoot(vscode);
      const workspaceFolders = vscode.workspace.workspaceFolders || [];
      const projectIds = workspaceFolders.length ? activeWorkspaceProjectIds(vscode) : null;
      const workspacePaths = workspaceFolders.length ? activeWorkspacePaths(vscode) : null;
      const descriptors = await conversationHistory.listConversationFiles(root, {
        projectIds,
        includeDescendants: true,
        workspacePaths,
      });
      if (!descriptors.length) {
        await vscode.window.showInformationMessage(
          workspaceFolders.length
            ? 'No local Claude conversation history was found for this workspace.'
            : 'No local Claude conversation history was found.'
        );
        return;
      }
      const selected = await pickDescriptor(
        vscode,
        descriptors,
        workspaceFolders.length
          ? 'Select a local Claude conversation from this workspace'
          : 'Select a local Claude conversation'
      );
      if (selected) panels.showConversation(selected, root);
    }),
    vscode.commands.registerCommand(OPEN_TRANSCRIPT_COMMAND, (descriptor) => panels.show(descriptor)),
    vscode.commands.registerCommand(OPEN_RAW_COMMAND, (nodeOrDescriptor) => {
      const descriptor = nodeOrDescriptor?.descriptor || nodeOrDescriptor;
      if (descriptor?.filePath) return openRawTranscript(vscode, descriptor);
      return pickDescriptor(vscode, provider.descriptors, 'Select a sub-agent transcript')
        .then((selected) => selected ? openRawTranscript(vscode, selected) : undefined);
    }),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      return Promise.all([provider.refresh(true), panels.refresh(true)]).then(() => {
        syncDirectoryWatchers();
        return updateScopeUi();
      });
    }),
    vscode.commands.registerCommand(SHOW_ALL_COMMAND, () => {
      provider.setScope(SCOPE_ALL);
      const contextUpdate = updateScopeUi();
      return provider.refresh(true).then(() => {
        syncDirectoryWatchers();
        return updateScopeUi();
      }).catch(() => contextUpdate);
    }),
    vscode.commands.registerCommand(SHOW_WORKSPACE_COMMAND, () => {
      provider.setScope(SCOPE_WORKSPACE);
      const contextUpdate = updateScopeUi();
      return provider.refresh(true).then(() => {
        syncDirectoryWatchers();
        return updateScopeUi();
      }).catch(() => contextUpdate);
    })
  );

  const timer = setInterval(() => {
    if (treeView.visible) void refreshVisibleAndWatch();
    if (panels.isVisible()) void panels.refresh();
  }, WATCH_FALLBACK_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => {
    clearInterval(timer);
    clearTimeout(refreshTimer);
    for (const watcher of directoryWatchers.values()) watcher.close?.();
    directoryWatchers.clear();
  } });
  if (treeView.onDidChangeVisibility) {
    context.subscriptions.push(treeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        syncDirectoryWatchers();
        void refreshVisibleAndWatch();
      } else {
        for (const watcher of directoryWatchers.values()) watcher.close?.();
        directoryWatchers.clear();
      }
    }));
  }

  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('claudeCodeEnhance.subagentProjectsRoot')) {
        for (const watcher of directoryWatchers.values()) watcher.close?.();
        directoryWatchers.clear();
        void provider.refresh(true).then(() => {
          syncDirectoryWatchers();
          return updateScopeUi();
        });
      }
    }));
  }
  if (vscode.workspace.onDidChangeWorkspaceFolders) {
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void provider.refresh(true).then(() => {
        syncDirectoryWatchers();
        return updateScopeUi();
      });
    }));
  }

  return { provider, panels, treeView };
}

module.exports = {
  OPEN_RAW_COMMAND,
  OPEN_CONVERSATION_HISTORY_COMMAND,
  OPEN_TRANSCRIPT_COMMAND,
  OPEN_VIEW_COMMAND,
  REFRESH_COMMAND,
  SHOW_ALL_COMMAND,
  SHOW_WORKSPACE_COMMAND,
  SCOPE_ALL,
  SCOPE_CONTEXT_KEY,
  SCOPE_WORKSPACE,
  REFRESH_INTERVAL_MS,
  WATCH_FALLBACK_INTERVAL_MS,
  MAX_HISTORY_WATCHERS,
  VIEW_ID,
  SubagentTreeProvider,
  TranscriptPanelManager,
  formatBytes,
  conversationHistoryErrorMessage,
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
