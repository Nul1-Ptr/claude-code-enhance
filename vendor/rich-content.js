(function(root) {
  'use strict';

  const view = () => root.__CLAUDE_ENHANCE_SUBAGENT_VIEW__;
  const mathCore = root.__CLAUDE_ENHANCE_MATH_CORE__.create(root.katex);
  let documents;
  let markdown;
  async function execute(kind, payload, signal) {
    if (kind === 'highlight') {
      return root.hljs?.getLanguage(payload.language)
        ? root.hljs.highlight(payload.source, { language: payload.language, ignoreIllegals: true }).value
        : null;
    }
    if (kind === 'math') {
      return mathCore.render(payload.source, payload.display);
    }
    if (kind.startsWith('document')) {
      documents ||= root.__CLAUDE_ENHANCE_RICH_DOCUMENT__.create(view(), root.marked, {
        yieldControl: () => new Promise((resolve) => root.setTimeout(resolve, 0)),
        highlight: (source, language, ceCheckpoints) => root.hljs?.getLanguage(language)
          ? root.hljs.highlight(source, { language, ignoreIllegals: true, ceCheckpoints }) : view().escapeHtml(source),
        math: (source, display) => mathCore.render(source, display),
      });
      if (kind === 'documentUpdate') return documents.update(payload, signal);
      if (kind === 'documentBlocks') return documents.render(payload, signal);
      if (kind === 'documentRows') return documents.rows(payload, signal);
      if (kind === 'documentLocate') return documents.locate(payload, signal);
      if (kind === 'documentDrop') return documents.drop(payload.id);
    }
    markdown ||= view().createMarkdownEngine(root.marked);
    if (kind === 'lex') {
      const tokens = markdown.lexer(view().guardMathPipes(payload.source));
      return { tokens, links: tokens.links };
    }
    if (kind === 'parse') {
      const tokens = [payload.token];
      tokens.links = payload.links;
      return markdown.parser(tokens).replaceAll(view().PIPE_SENTINEL, '|');
    }
    throw new Error('Unknown rendering operation');
  }

  if (!root.document) {
    root.onmessage = async ({ data }) => {
      try { root.postMessage({ id: data.id, value: await execute(data.kind, data.payload) }); }
      catch { root.postMessage({ id: data.id, error: 'Unable to format this content.' }); }
    };
    return;
  }

  const document = root.document;
  const diagnostics = { completed: 0, cancelled: 0, workerTasks: 0, fallbackTasks: 0, domSlices: 0, failures: 0,
    backend: 'pending', workerFailure: null, longTasks: 0, longestTaskMs: 0 };
  if (root.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
    const observer = new root.PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        diagnostics.longTasks++;
        diagnostics.longestTaskMs = Math.max(diagnostics.longestTaskMs, Math.round(entry.duration));
      }
    });
    observer.observe({ type: 'longtask', buffered: false });
  }
  const pending = new Map();
  let nextId = 0;
  let active = null;
  let worker = null;
  let workerUrl = null;
  let workerUnavailable = false;
  let fallbackTimer = null;
  const abortError = () => new DOMException('Rendering cancelled', 'AbortError');
  const nextFrame = () => new Promise((resolve) => root.requestAnimationFrame(resolve));

  function stopWorker() {
    worker?.terminate();
    worker = null;
    if (workerUrl) root.URL.revokeObjectURL(workerUrl);
    workerUrl = null;
  }

  function blobWorkerAllowed() {
    if (!root.Worker) return false;
    if (!root.__CLAUDE_ENHANCE_WORKER_SOURCE__) return false;
    for (const policy of document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')) {
      const directives = new Map(policy.content.split(';').map((directive) => {
        const [name, ...values] = directive.trim().split(/\s+/);
        return [name, values];
      }));
      const sources = directives.get('worker-src') || directives.get('child-src') ||
        directives.get('script-src') || directives.get('default-src');
      if (sources && !sources.includes('blob:')) return false;
    }
    return true;
  }

  function finishTask(task, value, error) {
    if (active !== task) return;
    active = null;
    pending.delete(task.id);
    task.signal?.removeEventListener('abort', task.cancel);
    if (error) { diagnostics.failures++; task.reject(error); }
    else { diagnostics.completed++; task.resolve(value); }
    pump();
  }

  function pump() {
    if (active || !pending.size) return;
    active = pending.values().next().value;
    const task = active;
    const useBlob = blobWorkerAllowed();
    if (!workerUnavailable && root.Worker && (useBlob || root.__CLAUDE_ENHANCE_WORKER_URL__)) {
      try {
        if (!worker) {
          if (useBlob) {
            workerUrl = root.URL.createObjectURL(new Blob([root.__CLAUDE_ENHANCE_WORKER_SOURCE__], { type: 'text/javascript' }));
            worker = new root.Worker(workerUrl);
            diagnostics.backend = 'worker-blob';
          } else {
            worker = new root.Worker(root.__CLAUDE_ENHANCE_WORKER_URL__, { type: 'module' });
            diagnostics.backend = 'worker-module';
          }
          const currentWorker = worker;
          worker.onmessage = ({ data }) => {
            if (worker !== currentWorker) return;
            if (active?.id !== data.id) return;
            finishTask(active, data.value, data.error ? new Error(data.error) : null);
          };
          worker.onerror = (event) => {
            event.preventDefault();
            if (worker !== currentWorker) return;
            stopWorker();
            diagnostics.workerFailure = 'worker-startup';
            workerUnavailable = true;
            active = null;
            pump();
          };
        }
        diagnostics.workerTasks++;
        worker.postMessage({ id: task.id, kind: task.kind, payload: task.payload });
        return;
      } catch (error) {
        stopWorker();
        diagnostics.workerFailure = error.name || 'worker-construction';
        workerUnavailable = true;
      }
    }
    fallbackTimer = root.setTimeout(async () => {
      fallbackTimer = null;
      if (active !== task) return;
      diagnostics.fallbackTasks++;
      diagnostics.backend = 'main-thread';
      try { finishTask(task, await execute(task.kind, task.payload, task.signal)); }
      catch (error) { finishTask(task, null, error); }
    }, 0);
  }

  function request(kind, payload, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const task = { id: ++nextId, kind, payload, signal, resolve, reject };
      task.cancel = () => {
        if (!pending.delete(task.id)) return;
        if (active === task) {
          stopWorker();
          root.clearTimeout(fallbackTimer);
          active = null;
        }
        diagnostics.cancelled++;
        signal?.removeEventListener('abort', task.cancel);
        reject(abortError());
        pump();
      };
      signal?.addEventListener('abort', task.cancel, { once: true });
      pending.set(task.id, task);
      pump();
    });
  }

  const allowedTags = new Set(['A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'HR', 'INPUT', 'LI', 'OL', 'P', 'PRE', 'SPAN', 'STRONG',
    'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);

  async function fragment(html, signal, trusted = false) {
    const result = document.createDocumentFragment();
    const stack = [{ tag: '', element: result, namespace: null }];
    const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</g;
    const attributes = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const voidTags = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
    const decoder = document.createElement('textarea');
    const decode = (text) => {
      if (!text.includes('&')) return text;
      decoder.innerHTML = text;
      return decoder.value;
    };
    let count = 0;
    let startedAt = root.performance.now();
    const yieldIfNeeded = async () => {
      if (++count >= 200 || root.performance.now() - startedAt >= 6) {
        diagnostics.domSlices++;
        await nextFrame();
        count = 0;
        startedAt = root.performance.now();
      }
      if (signal?.aborted) throw abortError();
    };
    let token;
    while ((token = tokens.exec(html))) {
      if (signal?.aborted) throw abortError();
      const value = token[0];
      if (value.startsWith('<!')) continue;
      if (value.startsWith('</')) {
        const tag = /^<\/([^\s>]+)/.exec(value)?.[1].toUpperCase();
        const index = stack.findLastIndex((entry) => entry.tag === tag);
        if (index > 0) stack.length = index;
        continue;
      }
      const parent = stack[stack.length - 1];
      if (!/^<[A-Za-z]/.test(value)) {
        for (let offset = 0; offset < value.length;) {
          let end = Math.min(value.length, offset + 16384);
          const ampersand = value.lastIndexOf('&', end - 1);
          if (end < value.length && ampersand >= offset && end - ampersand < 32 &&
              !value.slice(ampersand, end).includes(';') && ampersand > offset) end = ampersand;
          if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
          parent.element.append(document.createTextNode(decode(value.slice(offset, end))));
          offset = end;
          await yieldIfNeeded();
        }
        continue;
      }
      const match = /^<([^\s/>]+)/.exec(value);
      const localName = match[1];
      const tag = localName.toUpperCase();
      const namespace = tag === 'SVG' ? 'http://www.w3.org/2000/svg' :
        tag === 'MATH' ? 'http://www.w3.org/1998/Math/MathML' : parent.namespace;
      const permitted = trusted ? !['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'LINK'].includes(tag) : allowedTags.has(tag);
      const element = permitted ? (namespace ? document.createElementNS(namespace, localName) : document.createElement(localName)) : parent.element;
      if (permitted) {
        attributes.lastIndex = match[0].length;
        let attribute;
        const values = new Map();
        while ((attribute = attributes.exec(value))) {
          values.set(attribute[1], decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
        }
        for (const [attributeName, attributeValue] of values) {
          const name = attributeName.toLowerCase();
          if (name.startsWith('on') || ['src', 'srcdoc', 'xlink:href'].includes(name)) continue;
          const safeHref = name === 'href' && tag === 'A' && /^(https?:|mailto:|#)/i.test(attributeValue);
          const keep = trusted ? (name !== 'href' || safeHref) :
            (name === 'class' && ['CODE', 'SPAN', 'DIV'].includes(tag)) ||
            (['data-display', 'data-delimiter'].includes(name) && (values.get('class') || '').split(/\s+/).includes('ce-math-source')) ||
            (['colspan', 'rowspan', 'align'].includes(name) && ['TD', 'TH'].includes(tag)) ||
            (name === 'start' && tag === 'OL') ||
            (['type', 'checked', 'disabled'].includes(name) && tag === 'INPUT' && values.get('type') === 'checkbox') || safeHref;
          if (keep) element.setAttribute(attributeName, attributeValue);
        }
        if (tag === 'A') {
          element.setAttribute('target', '_blank');
          element.setAttribute('rel', 'noopener noreferrer');
        }
        if (tag === 'INPUT') element.disabled = true;
        parent.element.append(element);
      }
      if (!voidTags.has(tag) && !value.endsWith('/>')) stack.push({ tag, element, namespace });
      await yieldIfNeeded();
    }
    if (signal?.aborted) throw abortError();
    return result;
  }

  const highlightJobs = new Map();
  const codePreviews = new WeakMap();
  async function highlight(element, language, options = {}) {
    const source = element.textContent;
    if (options.virtualize !== false && (source.length > 50000 || source.split('\n', 122).length > 121)) {
      let preview = codePreviews.get(element);
      if (!preview?.isConnected) {
        preview = document.createElement('ce-rich-code');
        preview.originalElement = element;
        codePreviews.set(element, preview);
        const mount = () => {
          element.hidden = true;
          element.after(preview);
        };
        if (options.mutate) options.mutate(mount); else mount();
      }
      preview.setAttribute('language', language || '');
      if (preview.textContent !== source) preview.textContent = source;
      element.classList.add('hljs');
      options.complete?.(source);
      return true;
    }
    const previousPreview = codePreviews.get(element);
    if (previousPreview) {
      previousPreview.remove();
      element.hidden = false;
      codePreviews.delete(element);
    }
    highlightJobs.get(element)?.abort();
    const controller = new AbortController();
    highlightJobs.set(element, controller);
    const abort = () => controller.abort();
    const disclosure = element.closest('details');
    const onToggle = () => {
      if (element.closest('details:not([open])')) controller.abort();
    };
    disclosure?.addEventListener('toggle', onToggle);
    options.signal?.addEventListener('abort', abort, { once: true });
    delete element.dataset.ceHighlightError;
    try {
      if (options.signal?.aborted) throw abortError();
      const html = await request('highlight', { source, language }, controller.signal);
      if (html === null) return false;
      const content = await fragment(html, controller.signal, true);
      if (!element.isConnected || source !== element.textContent || controller.signal.aborted) return false;
      const commit = () => { element.replaceChildren(content); element.classList.add('hljs'); };
      if (options.mutate) options.mutate(commit); else commit();
      options.complete?.(source);
      return true;
    } catch (error) {
      if (error.name !== 'AbortError') {
        element.dataset.ceHighlightError = 'true';
        element.title = 'Formatting failed; source is available. Reopen to retry.';
      }
      return false;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      disclosure?.removeEventListener('toggle', onToggle);
      if (highlightJobs.get(element) === controller) highlightJobs.delete(element);
    }
  }

  if (root.MutationObserver) {
    new root.MutationObserver(() => {
      for (const [element, controller] of highlightJobs) {
        if (!element.isConnected || element.closest('details:not([open])')) controller.abort();
      }
    }).observe(document, { subtree: true, childList: true });
  }

  const mathScale = Math.min(1.6, Math.max(0.8, Number(root.__CLAUDE_ENHANCE_CONFIG__?.mathScale) || 1));
  const style = `:host{display:block;min-width:0;color:inherit;font:inherit;--ce-inline-math-size:${1.1 * mathScale}em;--ce-display-math-size:${1.6 * mathScale}em}
    ::highlight(ce-search){background:Highlight;color:HighlightText}
    .toolbar{display:flex;gap:10px;align-items:center;font:inherit;color:var(--vscode-descriptionForeground)}
    button{font:inherit;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:3px 8px}
    pre{white-space:pre;overflow:auto;max-height:60vh;padding:12px;background:var(--vscode-textCodeBlock-background)}
    code{font-family:var(--vscode-editor-font-family,monospace)}
    section{content-visibility:auto;contain-intrinsic-size:auto 160px;overflow-wrap:anywhere}
    table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}th,td{border:1px solid var(--vscode-panel-border);padding:6px}
    .ce-math-display{display:block;overflow-x:auto;padding:8px 0}.ce-math-error{white-space:pre-wrap}
    .ce-math-inline>.katex{font-size:${1.1 * mathScale}em}.ce-math-display .katex-display>.katex{font-size:${1.6 * mathScale}em}
    .source{max-height:45vh;overflow:auto}a{color:var(--vscode-textLink-foreground)}`;

  const blockStates = new WeakMap();

  function revealText(container, query, from = 0, scrollContainer = null) {
    const nodes = [];
    const walker = document.createTreeWalker(container, root.NodeFilter.SHOW_TEXT);
    let node;
    let text = '';
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('button, style, nav, .katex-mathml')) continue;
      nodes.push({ node, start: text.length });
      text += node.textContent;
    }
    const found = root.__CLAUDE_ENHANCE_RUNTIME_CORE__.findLiteral(text, query, from);
    if (!found) return false;
    const first = nodes.findLast((entry) => entry.start <= found.start);
    const last = nodes.findLast((entry) => entry.start < found.end);
    if (!first || !last) return false;
    const range = document.createRange();
    range.setStart(first.node, found.start - first.start);
    range.setEnd(last.node, found.end - last.start);
    if (root.CSS?.highlights && root.Highlight) root.CSS.highlights.set('ce-search', new root.Highlight(range));
    first.node.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
    let scrollRoot = scrollContainer || first.node.parentElement;
    while (scrollRoot) {
      if (/(auto|scroll)/.test(root.getComputedStyle(scrollRoot).overflowY)) {
        const bounds = scrollRoot.getBoundingClientRect();
        const target = range.getBoundingClientRect();
        scrollRoot.scrollTop += target.top - bounds.top - scrollRoot.clientHeight / 2;
        scrollRoot.scrollLeft += Math.max(0, target.left - bounds.right + 40);
      }
      scrollRoot = scrollRoot.parentElement || scrollRoot.getRootNode()?.host;
    }
    const bounds = range.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > root.innerHeight) root.scrollBy(0, bounds.top - root.innerHeight / 2);
    container.dataset.searchMatch = 'true';
    return true;
  }
  let nextDocumentId = 0;
  const visibility = root.IntersectionObserver ? new root.IntersectionObserver((entries) => {
    for (const entry of entries) {
      const element = entry.target;
      element.nearViewport = entry.isIntersecting;
      if (entry.isIntersecting && element.dataset.ceRenderState !== 'complete') element.schedule();
      else if (entry.isIntersecting) element.scheduleWindow();
      else if (!entry.isIntersecting && element.dataset.ceRenderState !== 'complete') {
        element.controller?.abort();
        root.clearTimeout(element.timer);
      }
    }
  }, { rootMargin: '1000px' }) : null;

  class RichMessage extends root.HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.revision = 0;
      this.documentId = `rich-${++nextDocumentId}`;
      this.documentSource = null;
      this.documentManifest = null;
      this.mountedBlocks = new Map();
      this.blockHeights = new Map();
      this.heightIndex = null;
      this.windowRange = null;
      this.source = '';
      this.renderedSource = '';
      this.renderSource = null;
      this.waitingSince = null;
      this.nearViewport = !visibility;
      this.observer = new root.MutationObserver(() => this.schedule());
    }

    createShell() {
      const shadow = this.shadowRoot;
      for (const link of document.querySelectorAll('link[rel="stylesheet"]')) shadow.append(link.cloneNode());
      const stylesheet = document.createElement('style');
      stylesheet.textContent = style;
      this.toolbar = document.createElement('div');
      this.toolbar.className = 'toolbar';
      this.status = document.createElement('span');
      this.status.setAttribute('role', 'status');
      this.toolbar.append(this.status);
      if (root.__CLAUDE_ENHANCE_CONFIG__?.copyButtons !== false) {
        const copy = document.createElement('button');
        copy.textContent = 'Copy complete source';
        copy.onclick = async () => {
          try { await root.navigator.clipboard.writeText(this.textContent); copy.textContent = 'Copied'; }
          catch { copy.textContent = 'Copy failed'; }
        };
        this.toolbar.append(copy);
      }
      this.details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Source';
      const raw = document.createElement('pre');
      raw.className = 'source';
      raw.append(document.createElement('slot'));
      this.details.append(summary, raw);
      this.details.open = true;
      this.content = document.createElement('div');
      this.content.className = 'markdown-content';
      this.topSpacer = document.createElement('div');
      this.bottomSpacer = document.createElement('div');
      this.topSpacer.dataset.spacer = 'top';
      this.bottomSpacer.dataset.spacer = 'bottom';
      this.live = document.createElement('pre');
      this.live.className = 'live-tail';
      this.live.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:none;background:transparent;padding:0';
      this.live.hidden = true;
      shadow.append(stylesheet, this.toolbar, this.details, this.content, this.live);
    }

    connectedCallback() {
      if (!this.status) this.createShell();
      this.observer.observe(this, { childList: true, characterData: true, subtree: true });
      this.onDisclosure = () => {
        if (this.closest('details:not([open])')) {
          this.controller?.abort();
          root.clearTimeout(this.timer);
        } else if (this.dataset.ceRenderState !== 'complete') this.schedule();
      };
      this.disclosures = [];
      for (let parent = this.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') {
          this.disclosures.push(parent);
          parent.addEventListener('toggle', this.onDisclosure);
        }
      }
      this.schedule();
      visibility?.observe(this);
      this.onScroll = () => this.scheduleWindow();
      this.onRichResize = () => { this.measureBlocks(); this.scheduleWindow(); };
      document.addEventListener('scroll', this.onScroll, true);
      root.addEventListener('resize', this.onScroll);
      this.addEventListener('ce-rich-resize', this.onRichResize);
    }

    disconnectedCallback() {
      this.observer.disconnect();
      visibility?.unobserve(this);
      root.clearTimeout(this.timer);
      this.controller?.abort();
      request('documentDrop', { id: this.documentId }).catch(() => {});
      this.documentSource = null;
      document.removeEventListener('scroll', this.onScroll, true);
      root.removeEventListener('resize', this.onScroll);
      this.removeEventListener('ce-rich-resize', this.onRichResize);
      this.disclosures?.forEach((details) => details.removeEventListener('toggle', this.onDisclosure));
      this.revision++;
    }

    blockRange() {
      const count = this.documentManifest?.count || 0;
      if (count <= 96 || !this.heightIndex) return { start: 0, end: count };
      if (Number.isInteger(this.forcedBlock)) {
        const start = Math.max(0, this.forcedBlock - 6);
        return { start, end: Math.min(count, start + 32) };
      }
      const relativeTop = Math.max(0, -this.content.getBoundingClientRect().top);
      const first = this.heightIndex.indexAt(relativeTop);
      const last = this.heightIndex.indexAt(relativeTop + root.innerHeight);
      const start = Math.max(0, first - 6);
      return { start, end: Math.min(count, start + 64, Math.max(last + 7, start + 32)) };
    }

    scheduleWindow() {
      if (this.windowScheduled || !this.nearViewport || !this.documentManifest || this.closest('details:not([open])')) return;
      this.windowScheduled = true;
      root.requestAnimationFrame(() => {
        this.windowScheduled = false;
        if (!this.isConnected || this.controller || this.source !== this.documentSource) return;
        const range = this.blockRange();
        if (this.windowRange?.start === range.start && this.windowRange?.end === range.end) return;
        void this.render();
      });
    }

    measureBlocks() {
      if (!this.heightIndex || !this.windowRange) return;
      for (const [key, block] of this.mountedBlocks) {
        const height = block.getBoundingClientRect().height;
        if (height > 0) {
          this.blockHeights.set(key, height);
          this.heightIndex.update(Number(block.dataset.blockIndex), height);
        }
      }
      this.topSpacer.style.height = `${this.heightIndex.sum(0, this.windowRange.start)}px`;
      this.bottomSpacer.style.height = `${this.heightIndex.sum(this.windowRange.end, this.heightIndex.length)}px`;
    }

    async requestRows(key, options, signal) {
      const index = this.documentManifest?.blocks.findIndex((block) => block.key === key);
      const version = this.documentManifest?.version;
      if (!(index >= 0)) throw new Error('This code or table has changed.');
      const payload = { id: this.documentId, version, index,
        highlight: root.__CLAUDE_ENHANCE_CONFIG__?.syntaxHighlighting !== false, ...options };
      let result = await request('documentRows', payload, signal);
      if (result.missing && this.documentSource !== null && this.documentManifest?.version === version) {
        await request('documentUpdate', { id: this.documentId, version, source: this.documentSource,
          code: this.tagName === 'CE-RICH-CODE', language: this.getAttribute('language') }, signal);
        result = await request('documentRows', payload, signal);
      }
      if (result.missing) throw new Error('Message changed while its rows were loading.');
      return result;
    }

    createParts(key, descriptor, extra = {}) {
      const parts = document.createElement('ce-rich-parts');
      if (extra.code) parts.dataset.code = 'true';
      parts.options = { ...descriptor, ...extra, fragment, reveal: revealText,
        request: (options, signal) => this.requestRows(key, { ...options, partKey: descriptor.partKey,
          formula: extra.formula }, signal),
        hydrate: (content, signal) => this.hydrateMath(content, key, signal) };
      return parts;
    }

    async hydrateMath(content, key, signal) {
      for (const code of content.querySelectorAll('code:not(pre code)')) {
        const candidate = view().wholeMathCandidate(code.textContent);
        if (!candidate) continue;
        const math = document.createElement('span');
        math.className = 'ce-math-source';
        math.dataset.display = String(candidate.display);
        math.textContent = candidate.formula;
        code.replaceWith(math);
      }
      for (const math of content.querySelectorAll('.ce-math-source')) {
        const source = math.textContent;
        const display = math.dataset.display === 'true';
        try {
          const result = await this.requestRows(key, { mathSource: source, display }, signal);
          if (result.parts) {
            const parts = this.createParts(key, result.parts, { formula: { source, display } });
            parts.title = 'Show entire block to read or select the complete formula.';
            math.replaceWith(parts);
            if (parts.isConnected) await parts.ready;
          } else {
            math.replaceChildren(await fragment(result.html, signal, true));
            math.className = display ? 'ce-math-display' : 'ce-math-inline';
            math.title = source;
          }
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          math.classList.add('ce-math-error');
          math.title = 'Unable to format this formula; source retained.';
        }
      }
    }

    async revealLocation(offset, query, isCurrent = () => true) {
      const active = () => this.isConnected && isCurrent();
      this.nearViewport = true;
      this.schedule();
      root.clearTimeout(this.timer);
      if (this.rendering) await this.rendering;
      if (!active()) return false;
      await this.render();
      if (!active() || !this.documentManifest) return false;
      const payload = { id: this.documentId, version: this.documentManifest.version, offset, query };
      let location = await request('documentLocate', payload);
      if (location.missing) {
        await request('documentUpdate', { ...payload, source: this.source, code: this.tagName === 'CE-RICH-CODE',
          language: this.getAttribute('language') });
        location = await request('documentLocate', payload);
      }
      if (!active() || location.missing) return false;
      this.forcedBlock = location.index;
      if (this.rendering) await this.rendering;
      if (!active()) { this.forcedBlock = null; return false; }
      await this.render();
      if (!active()) { this.forcedBlock = null; return false; }
      const block = this.content.querySelector(`section[data-block-index="${location.index}"]`);
      block?.scrollIntoView({ block: 'center' });
      const rows = block?.querySelector('ce-rich-rows');
      const parts = block?.querySelector('ce-rich-parts');
      let revealed = false;
      if (!location.source) {
        if (rows) revealed = await rows.reveal(location, active);
        else if (parts) { await parts.reveal(location.part, query, active); revealed = parts.dataset.searchMatch === 'true'; }
        else if (block) revealed = revealText(block, query);
      }
      if (active() && !revealed) {
        this.details.open = true;
        this.details.scrollIntoView({ block: 'center' });
        await nextFrame();
        if (active()) revealText(this, query, offset, this.details.querySelector('.source'));
      }
      this.forcedBlock = null;
      this.measureBlocks();
      return active();
    }

    schedule() {
      root.clearTimeout(this.timer);
      const source = this.textContent;
      if (source === this.source && this.dataset.ceRenderState === 'complete') return;
      this.source = source;
      this.updateLiveTail();
      if (this.controller && !this.controller.signal.aborted && this.renderSource !== null && source.startsWith(this.renderSource)) return;
      this.controller?.abort();
      this.revision++;
      this.dataset.ceRenderState = 'pending';
      this.status.textContent = this.content.childNodes.length ? 'Updating formatting…' : 'Formatting…';
      this.waitingSince ??= root.performance.now();
      const delay = Math.min(250, Math.max(0, 750 - (root.performance.now() - this.waitingSince)));
      if (this.nearViewport) this.timer = root.setTimeout(() => this.render(), delay);
    }

    updateLiveTail() {
      const append = this.renderedSource && this.source.startsWith(this.renderedSource);
      const tail = append ? this.source.slice(this.renderedSource.length) : this.source;
      this.content.hidden = !!this.renderedSource && !append;
      this.live.hidden = !this.renderedSource || !tail;
      this.live.textContent = this.live.hidden ? '' : tail;
    }

    render() {
      if (this.rendering) return this.rendering;
      this.rendering = this.renderDocument().finally(() => { this.rendering = null; });
      return this.rendering;
    }

    async renderDocument() {
      if (!this.isConnected || !this.nearViewport || this.closest('details:not([open])')) return;
      const revision = this.revision;
      const controller = new AbortController();
      this.controller = controller;
      const signal = controller.signal;
      const source = this.source;
      this.renderSource = source;
      this.waitingSince = null;
      const current = () => !signal.aborted && this.isConnected && revision === this.revision && this.source.startsWith(source);
      const { toolbar, status, details, content } = this;
      const anchor = Array.from(this.mountedBlocks.entries()).find(([, block]) => {
        const rect = block.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < root.innerHeight;
      });
      const anchorOffset = anchor?.[1].getBoundingClientRect().top;
      let documentMissing = false;
      toolbar.querySelector('[data-retry]')?.remove();
      this.dataset.ceRenderState = 'pending';
      try {
        const base = this.documentSource;
        const previousManifest = this.documentManifest;
        const payload = { id: this.documentId, version: revision,
          code: this.tagName === 'CE-RICH-CODE', language: this.getAttribute('language'),
          ...(base !== null && source.startsWith(base) ? { baseLength: base.length, append: source.slice(base.length) } : { source }) };
        let parsed = source === base && this.documentManifest?.version === revision ? this.documentManifest
          : await request('documentUpdate', payload, signal);
        if (parsed.missing) parsed = await request('documentUpdate', { ...payload, append: undefined, source }, signal);
        this.documentSource = source;
        this.documentManifest = parsed;
        if (base !== null && source.startsWith(base)) {
          for (const [index, descriptor] of parsed.blocks.entries()) {
            const old = previousManifest?.blocks[index];
            if (old?.start === descriptor.start && old.type === descriptor.type && this.blockHeights.has(old.key)) {
              this.blockHeights.set(descriptor.key, this.blockHeights.get(old.key));
            }
          }
        }
        this.heightIndex = view().createHeightIndex(parsed.blocks, this.blockHeights, 160);
        const keys = new Set(parsed.blocks.map((block) => block.key));
        for (const key of this.blockHeights.keys()) if (!keys.has(key)) this.blockHeights.delete(key);
        diagnostics.document = parsed.stats;
        const range = this.blockRange();
        this.windowRange = range;
        const retained = new Set(parsed.blocks.slice(range.start, range.end).map((block) => block.key));
        const positions = new Map();
        for (const [key, block] of this.mountedBlocks) {
          if (!retained.has(key)) {
            const viewer = block.querySelector('ce-rich-rows, ce-rich-parts');
            if (viewer?.position) positions.set(key, viewer.position());
            block.remove(); this.mountedBlocks.delete(key);
          }
        }
        content.prepend(this.topSpacer);
        content.append(this.bottomSpacer);
        this.topSpacer.style.height = `${this.heightIndex.sum(0, range.start)}px`;
        this.bottomSpacer.style.height = `${this.heightIndex.sum(range.end, parsed.count)}px`;
        let rendered = range.start;
        let batch = new Map();
        let sliceStarted = root.performance.now();
        for (const descriptor of parsed.blocks.slice(range.start, range.end)) {
          if (!current()) throw abortError();
          const previous = this.mountedBlocks.get(descriptor.key);
          const previousState = previous && blockStates.get(previous);
          if (previousState?.key === descriptor.key && previousState.complete) { rendered++; continue; }
          if (!batch.has(rendered)) {
            const result = await request('documentBlocks', { id: this.documentId, version: revision,
              start: rendered, end: Math.min(parsed.count, rendered + 16) }, signal);
            if (result.missing) {
              this.documentSource = null;
              documentMissing = true;
              throw new Error('Document renderer restarted.');
            }
            batch = new Map(result.items.map((item) => [item.index, item]));
            diagnostics.document = result.stats;
          }
          const item = batch.get(rendered);
          const html = item.html;
          if (previousState && previousState.html === html && previousState.complete) {
            previousState.key = descriptor.key;
            rendered++;
            continue;
          }
          const block = document.createElement('section');
          const oldDescriptor = previousManifest?.blocks[rendered];
          const oldPosition = positions.get(descriptor.previousKey) ||
            (base !== null && source.startsWith(base) && oldDescriptor?.start === descriptor.start && oldDescriptor.type === descriptor.type
              ? positions.get(oldDescriptor.key) : undefined);
          let rowViewport;
          if (item.virtual) {
            rowViewport = document.createElement('ce-rich-rows');
            rowViewport.options = { kind: item.virtual.kind, count: item.virtual.rows, fragment,
              position: oldPosition,
              request: this.requestRows.bind(this, descriptor.key),
              parts: (parts, extra) => this.createParts(descriptor.key, parts, extra), reveal: revealText,
              hydrate: (content, signal) => this.hydrateMath(content, descriptor.key, signal),
              config: root.__CLAUDE_ENHANCE_CONFIG__ || {} };
            block.append(rowViewport);
          } else if (item.parts) block.append(this.createParts(descriptor.key, item.parts, { position: oldPosition }));
          else block.append(await fragment(html, signal));
          if (!current()) throw abortError();
          if (previous) previous.replaceWith(block);
          else {
            const next = Array.from(content.children).find((element) => Number(element.dataset.blockIndex) > rendered);
            content.insertBefore(block, next || this.bottomSpacer);
          }
          block.dataset.blockIndex = String(rendered);
          this.mountedBlocks.set(descriptor.key, block);
          blockStates.set(block, { key: descriptor.key, html, complete: false });
          if (rowViewport) await rowViewport.ready;
          if (item.parts) await block.querySelector('ce-rich-parts').ready;
          await this.hydrateMath(block, descriptor.key, signal);
          for (const code of block.querySelectorAll('pre code')) {
            const requested = /(?:^|\s)language-([^\s]+)/.exec(code.className)?.[1] || '';
            const language = ({ js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash' })[requested] || requested;
            if (root.__CLAUDE_ENHANCE_CONFIG__?.syntaxHighlighting !== false) {
              await highlight(code, language, { signal, virtualize: false });
            }
            if (!current()) throw abortError();
            if (code.dataset.ceHighlightError) throw new Error('Code formatting failed');
            if (root.__CLAUDE_ENHANCE_CONFIG__?.copyButtons !== false) {
              const copy = document.createElement('button');
              copy.textContent = 'Copy code';
              copy.onclick = async () => {
                try { await root.navigator.clipboard.writeText(code.textContent); copy.textContent = 'Copied'; }
                catch { copy.textContent = 'Copy failed'; }
              };
              code.parentElement.after(copy);
            }
          }
          if (!current()) throw abortError();
          status.textContent = `Formatting · ${++rendered} blocks`;
          blockStates.get(block).complete = true;
          if (root.performance.now() - sliceStarted >= 6) {
            diagnostics.domSlices++;
            await nextFrame();
            sliceStarted = root.performance.now();
          }
        }
        if (!current()) throw abortError();
        this.measureBlocks();
        if (anchor && this.mountedBlocks.get(anchor[0]) === anchor[1]) {
          const difference = anchor[1].getBoundingClientRect().top - anchorOffset;
          if (Math.abs(difference) > 1) {
            let scrollRoot = this.parentElement;
            while (scrollRoot && !/(auto|scroll)/.test(root.getComputedStyle(scrollRoot).overflowY)) scrollRoot = scrollRoot.parentElement;
            if (scrollRoot) scrollRoot.scrollTop += difference;
            else root.scrollBy(0, difference);
          }
        }
        this.renderedSource = source;
        this.updateLiveTail();
        if (!this.sourceCollapsed) {
          details.open = false;
          this.sourceCollapsed = true;
        }
        status.textContent = '';
        this.dataset.ceRenderState = 'complete';
        this.dataset.ceMountedBlocks = String(this.mountedBlocks.size);
        this.dataset.ceTotalBlocks = String(parsed.count);
      } catch (error) {
        if (!current() || error.name === 'AbortError') return;
        if (documentMissing) return;
        this.dataset.ceRenderState = 'error';
        status.textContent = 'Formatting interrupted. Complete source is available.';
        details.open = true;
        const retry = document.createElement('button');
        retry.textContent = 'Retry formatting';
        retry.dataset.retry = 'true';
        retry.onclick = () => this.schedule();
        toolbar.append(retry);
      } finally {
        if (this.controller === controller) {
          this.controller = null;
          this.renderSource = null;
          if (current() && (source !== this.source || documentMissing)) {
            this.dataset.ceRenderState = 'pending';
            this.schedule();
          } else if (current()) this.scheduleWindow();
        }
      }
    }
  }

  if (!root.customElements.get('ce-rich-message')) root.customElements.define('ce-rich-message', RichMessage);
  if (!root.customElements.get('ce-rich-code')) root.customElements.define('ce-rich-code', class extends RichMessage {
    static get observedAttributes() { return ['language']; }

    attributeChangedCallback(name, previous, next) {
      if (!this.status || previous === next) return;
      this.controller?.abort();
      this.documentSource = null;
      this.dataset.ceRenderState = 'pending';
      this.schedule();
    }

    connectedCallback() {
      super.connectedCallback();
      if (this.originalElement) {
        this.sourceObserver = new root.MutationObserver(() => {
          const source = this.originalElement.textContent;
          if (this.textContent !== source) this.textContent = source;
        });
        this.sourceObserver.observe(this.originalElement, { childList: true, characterData: true, subtree: true });
      }
    }

    disconnectedCallback() {
      this.sourceObserver?.disconnect();
      super.disconnectedCallback();
    }
  });
  root.__CLAUDE_ENHANCE_RICH__ = Object.freeze({ request, highlight, revealText, diagnostics });
})(typeof window !== 'undefined' ? window : globalThis);
