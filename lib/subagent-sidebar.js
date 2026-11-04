'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compactLabel,
  defaultProjectsRoot,
  findSubagentFilesAsync,
  streamSubagentTranscript,
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
    this.cursor = null;
    this.ready = false;
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
    if (!descriptor?.filePath) return;
    this.descriptor = descriptor;
    this.transcript = null;
    this.cursor = null;
    this.generation++;
    this.refreshQueued = false;
    this.refreshQueuedForce = false;
    this.abortController?.abort?.();
    this.watchTranscriptFile();

    if (!this.panel) this.createPanel();
    this.panel.title = compactLabel(descriptor.label, 48) || 'Sub-agent Transcript';
    this.panel.reveal(this.vscode.ViewColumn.Beside, false);
    if (this.ready) void this.refresh(true);
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
        this.abortController?.abort?.();
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
        void this.refresh(true);
      } else if (message?.type === 'openRaw' && this.descriptor) {
        openRawTranscript(this.vscode, this.descriptor);
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
          if (this.isVisible()) void this.refresh();
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
    if (!this.panel || !this.ready || !this.descriptor) return;
    if (this.refreshPromise) {
      this.refreshQueued = true;
      this.refreshQueuedForce = this.refreshQueuedForce || force;
      return this.refreshPromise;
    }
    const generation = this.generation;
    const descriptor = this.descriptor;
    this.refreshPromise = (async () => {
      const controller = new AbortController();
      this.abortController?.abort?.();
      this.abortController = controller;
      try {
        await streamSubagentTranscript(descriptor, {
          signal: controller.signal,
          cursor: force ? null : this.cursor,
          onStart: ({ append, transcript }) => {
            if (generation !== this.generation || controller.signal.aborted) return;
            if (append) {
              return this.panel?.webview.postMessage({ type: 'appendStart', transcript });
            } else {
              return this.panel?.webview.postMessage({ type: 'replaceStart', transcript });
            }
          },
          onChunk: ({ append, messages }) => {
            if (generation !== this.generation || controller.signal.aborted || !messages.length) return;
            return this.panel?.webview.postMessage({
              type: append ? 'append' : 'replaceChunk',
              messages,
            });
          },
          onComplete: ({ append, transcript, cursor }) => {
            if (generation !== this.generation || controller.signal.aborted) return;
            this.cursor = cursor;
            this.transcript = transcript;
            this.descriptor = transcript.descriptor;
            if (!this.fileWatcher && this.isVisible()) this.watchTranscriptFile();
            return this.panel?.webview.postMessage({
              type: append ? 'appendComplete' : 'replaceComplete',
              transcript,
            });
          },
        });
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return;
        if (generation === this.generation) {
          this.panel?.webview.postMessage({ type: 'error', message: String(error.message || error) });
        }
      } finally {
        if (this.abortController === controller) this.abortController = null;
      }
    })().finally(() => {
      this.refreshPromise = null;
      if (this.refreshQueued && this.panel && this.ready && this.descriptor) {
        const queuedForce = this.refreshQueuedForce;
        this.refreshQueued = false;
        this.refreshQueuedForce = false;
        void this.refresh(queuedForce);
      }
    });
    return this.refreshPromise;
  }

  dispose() {
    this.panel?.dispose();
    this.abortController?.abort?.();
    this.fileWatcher?.close?.();
    clearTimeout(this.fileRefreshTimer);
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
