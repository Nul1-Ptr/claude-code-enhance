(function(root, factory) {
  'use strict';

  const runtime = typeof module === 'object' && module.exports
    ? require('./runtime-core') : root.__CLAUDE_ENHANCE_RUNTIME_CORE__;
  const math = typeof module === 'object' && module.exports
    ? require('./math-core') : root.__CLAUDE_ENHANCE_MATH_CORE__;
  const katex = typeof module === 'object' && module.exports
    ? require('./katex.min') : root.katex;
  const api = factory(runtime, math, katex);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__CLAUDE_ENHANCE_SUBAGENT_VIEW__ = api;
  if (root?.document?.getElementById('transcript')) api.start(root);
})(typeof window !== 'undefined' ? window : globalThis, function(runtime, math, katex) {
  'use strict';

  const PIPE_SENTINEL = '\uE000';
  const MAX_HIGHLIGHT_LENGTH = runtime.CONTENT_LIMITS.codeCharacters;
  const FILTER_SLICE_MS = 6;
  const FILTER_SLICE_RECORDS = 400;
  const mathCore = math.create(katex);
  const LANGUAGE_ALIASES = Object.freeze({
    bash: 'bash',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    csharp: 'csharp',
    css: 'css',
    go: 'go',
    html: 'xml',
    java: 'java',
    javascript: 'javascript',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    latex: 'latex',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    python: 'python',
    rs: 'rust',
    rust: 'rust',
    sh: 'bash',
    shell: 'bash',
    sql: 'sql',
    tex: 'latex',
    ts: 'typescript',
    tsx: 'typescript',
    typescript: 'typescript',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    zsh: 'bash',
  });

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isEscaped(source, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) slashes++;
    return slashes % 2 === 1;
  }

  function delimiterIndex(source) {
    const positions = new Map();
    const markers = /\\[()[\]]|\$\$|\$|`+|\r\n|[\r\n]/g;
    let match;
    while ((match = markers.exec(source))) {
      if (isEscaped(source, match.index)) continue;
      let marker = match[0];
      if (marker === '$' && source[match.index - 1] === '$') continue;
      if (/^[\r\n]/.test(marker)) marker = '\n';
      if (!positions.has(marker)) positions.set(marker, []);
      positions.get(marker).push(match.index);
    }
    return { length: source.length, next(marker, start) {
      const entries = positions.get(marker) || [];
      let low = 0;
      let high = entries.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (entries[middle] < start) low = middle + 1;
        else high = middle;
      }
      return entries[low] ?? -1;
    } };
  }

  function delimitedCandidate(source, open, close, display, allowNewline, index, offset) {
    if (!source.startsWith(open) || (open === '$' && source.startsWith('$$'))) return null;
    const closing = index.next(close, offset + open.length);
    const newline = allowNewline ? -1 : index.next('\n', offset);
    const end = closing < 0 || (newline >= 0 && closing > newline) ? -1 : closing - offset;
    if (end === -1) return null;
    const formula = source.slice(open.length, end).replaceAll(PIPE_SENTINEL, '|');
    if (!formula.trim()) return null;
    return {
      raw: source.slice(0, end + close.length),
      formula,
      display,
      open,
      close,
    };
  }

  function formulaSignals(formula) {
    const source = formula.trim();
    const commands = (source.match(/\\[A-Za-z]+/g) || []).length;
    const operators = (source.match(/[=+*/^_<>{}\[\]]|\\\\|\\[,:;!]/g) || []).length;
    const words = source.match(/[A-Za-z]{2,}/g) || [];
    return { source, commands, operators, words };
  }

  function looksLikeMath(formula, display = false) {
    return mathCore.classifyStructuredMathCandidate({ formula, displayMode: display,
      delimiter: display ? 'dollar-display' : 'dollar-inline' }).decision === 'render';
  }

  function candidateAt(source, index = null, offset = 0) {
    if (!source.startsWith('$') && !source.startsWith('\\[') && !source.startsWith('\\(')) return null;
    index ||= delimiterIndex(source);
    return delimitedCandidate(source, '$$', '$$', true, true, index, offset) ||
      delimitedCandidate(source, '\\[', '\\]', true, true, index, offset) ||
      delimitedCandidate(source, '\\(', '\\)', false, true, index, offset) ||
      delimitedCandidate(source, '$', '$', false, false, index, offset);
  }

  function guardMathPipes(markdown) {
    const source = String(markdown || '');
    const index = delimiterIndex(source);
    let output = '';
    let cursor = 0;
    while (cursor < source.length) {
      if (source[cursor] === '`' && !isEscaped(source, cursor)) {
        let tickCount = 1;
        while (source[cursor + tickCount] === '`') tickCount++;
        const fence = '`'.repeat(tickCount);
        const end = index.next(fence, cursor + tickCount);
        if (end !== -1) {
          const raw = source.slice(cursor, end + tickCount);
          output += raw.replace(/(?<!\\)\|/g, PIPE_SENTINEL);
          cursor = end + tickCount;
          continue;
        }
      }
      if ((source[cursor] === '$' || source[cursor] === '\\') && isEscaped(source, cursor)) {
        output += source[cursor++];
        continue;
      }
      if (source[cursor] !== '$' && source[cursor] !== '\\') {
        output += source[cursor++];
        continue;
      }
      if (source[cursor] === '\\' && source[cursor + 1] !== '[' && source[cursor + 1] !== '(') {
        output += source[cursor++];
        continue;
      }
      const candidate = candidateAt(source.slice(cursor), index, cursor);
      if (!candidate || !looksLikeMath(candidate.formula, candidate.display)) {
        output += source[cursor++];
        continue;
      }
      const guarded = candidate.raw.replace(/(?<!\\)\|/g, PIPE_SENTINEL);
      output += guarded;
      cursor += candidate.raw.length;
    }
    return output;
  }

  function mathSourceHtml(candidate, blockContainer = candidate.display) {
    const tag = blockContainer ? 'div' : 'span';
    const delimiter = `${candidate.open} ${candidate.close}`;
    return `<${tag} class="ce-math-source" data-display="${candidate.display ? 'true' : 'false'}" ` +
      `data-delimiter="${escapeHtml(delimiter)}">${escapeHtml(candidate.formula)}</${tag}>`;
  }

  function blockMathToken(source, index) {
    const indent = /^( {0,3})/.exec(source)?.[1] || '';
    const candidate = candidateAt(source.slice(indent.length), index,
      index ? index.length - source.length + indent.length : 0);
    if (!candidate?.display) return null;
    const rest = source.slice(indent.length + candidate.raw.length);
    if (rest && !/^\s*(?:\n|$)/.test(rest)) return null;
    const trailing = /^\s*\n/.exec(rest)?.[0] || '';
    return {
      type: 'ceMathBlock',
      raw: indent + candidate.raw + trailing,
      candidate,
    };
  }

  function createMathExtensions() {
    return [
      {
        name: 'ceMathBlock',
        level: 'block',
        start(source) {
          const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
          return match ? match.index + (match[0][0] === '\n' ? 1 : 0) : undefined;
        },
        tokenizer(source) {
          return blockMathToken(source, this.lexer.ceBlockMathIndex);
        },
        renderer(token) {
          return mathSourceHtml(token.candidate) + '\n';
        },
      },
      {
        name: 'ceMathInline',
        level: 'inline',
        start(source) {
          const positions = [source.indexOf('$'), source.indexOf('\\('), source.indexOf('\\[')]
            .filter((position) => position >= 0);
          return positions.length ? Math.min(...positions) : undefined;
        },
        tokenizer(source) {
          const index = this.lexer.ceInlineMathIndex;
          const candidate = candidateAt(source, index, index ? index.length - source.length : 0);
          if (!candidate || !looksLikeMath(candidate.formula, candidate.display)) return undefined;
          return { type: 'ceMathInline', raw: candidate.raw, candidate };
        },
        renderer(token) {
          return mathSourceHtml(token.candidate, false);
        },
      },
    ];
  }

  function createMarkdownEngine(markedNamespace) {
    if (!markedNamespace?.Marked) throw new Error('Marked is unavailable.');
    const engine = new markedNamespace.Marked({
      async: false,
      breaks: false,
      gfm: true,
      pedantic: false,
    });
    class MathLexer extends markedNamespace.Lexer {
      blockTokens(source, ...argumentsRest) {
        const previous = this.ceBlockMathIndex;
        this.ceBlockMathIndex = delimiterIndex(source);
        try { return super.blockTokens(source, ...argumentsRest); }
        finally { this.ceBlockMathIndex = previous; }
      }
      inlineTokens(source, ...argumentsRest) {
        const previous = this.ceInlineMathIndex;
        this.ceInlineMathIndex = delimiterIndex(source);
        try { return super.inlineTokens(source, ...argumentsRest); }
        finally { this.ceInlineMathIndex = previous; }
      }
    }
    const lexer = (source, options) => {
      const instance = new MathLexer(options || engine.defaults);
      if (options?.ceReferenceLinks) Object.assign(instance.tokens.links, options.ceReferenceLinks);
      return instance.lex(source);
    };
    engine.use({
      hooks: { provideLexer() { return lexer; } },
      extensions: createMathExtensions(),
      renderer: {
        html(token) {
          return escapeHtml(token.raw).replaceAll(PIPE_SENTINEL, '|');
        },
      },
    });
    engine.lexer = lexer;
    return engine;
  }

  function parseMarkdown(engine, source) {
    return engine.parse(guardMathPipes(String(source || ''))).replaceAll(PIPE_SENTINEL, '|');
  }

  function wholeMathCandidate(source) {
    const candidate = candidateAt(String(source || '').trim());
    if (!candidate || candidate.raw.length !== String(source || '').trim().length) return null;
    return looksLikeMath(candidate.formula, candidate.display) ? candidate : null;
  }

  const VIRTUAL_WINDOW_MESSAGES = 60;
  const VIRTUAL_WINDOW_OVERSCAN = 12;
  const VIRTUAL_MAX_MESSAGES = 100;
  const VIRTUAL_ESTIMATED_MESSAGE_HEIGHT = 240;
  const VIRTUAL_HEIGHT_BLOCK_SIZE = 128;

  function messageFacets(message) {
    return [
      message?.role === 'assistant' ? 'assistant' : '',
      message?.blocks?.some((block) => block.kind === 'thinking') ? 'thinking' : '',
      message?.blocks?.some((block) => ['tool', 'tool-result'].includes(block.kind)) ? 'tools' : '',
      message?.error || message?.blocks?.some((block) => block.isError || block.kind === 'api-error')
        ? 'errors'
        : '',
    ].filter(Boolean);
  }

  function messageSearchText(message) {
    const values = [
      message?.role,
      message?.agentType,
      message?.model,
      message?.error,
      message?.stopReason,
      message?.timestamp,
      ...(message?.blocks || []).flatMap((block) => [block.kind, block.name, block.text]),
    ];
    return values.filter(Boolean).join('\n').toLocaleLowerCase();
  }

  function createMessageRecord(message, sourceIndex) {
    const facets = messageFacets(message);
    return {
      message,
      sourceIndex,
      key: `${message?.id ?? 'message'}:${message?.line ?? sourceIndex}:${sourceIndex}`,
      facets,
      facetSet: new Set(facets),
      searchText: null,
    };
  }

  function recordSearchText(record) {
    if (record.searchText === null) record.searchText = messageSearchText(record.message);
    return record.searchText;
  }

  function recordMatches(record, filter, query) {
    const filterMatch = filter === 'all' || record.facetSet.has(filter);
    return filterMatch && (!query || recordSearchText(record).includes(query));
  }

  function createHeightIndex(records, heightCache, estimate = VIRTUAL_ESTIMATED_MESSAGE_HEIGHT) {
    const values = records.map((record) => heightCache.get(record.key) || estimate);
    const blocks = [];

    function rebuildBlock(blockIndex) {
      const start = blockIndex * VIRTUAL_HEIGHT_BLOCK_SIZE;
      const end = Math.min(values.length, start + VIRTUAL_HEIGHT_BLOCK_SIZE);
      let total = 0;
      for (let index = start; index < end; index++) total += values[index];
      blocks[blockIndex] = total;
    }

    function rebuildBlocks() {
      blocks.length = Math.ceil(values.length / VIRTUAL_HEIGHT_BLOCK_SIZE);
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) rebuildBlock(blockIndex);
    }

    function sum(start, end) {
      const safeStart = Math.max(0, Math.min(values.length, Number(start) || 0));
      const safeEnd = Math.max(safeStart, Math.min(values.length, Number(end) || 0));
      let cursor = safeStart;
      let total = 0;
      while (cursor < safeEnd && cursor % VIRTUAL_HEIGHT_BLOCK_SIZE) total += values[cursor++];
      while (cursor + VIRTUAL_HEIGHT_BLOCK_SIZE <= safeEnd) {
        total += blocks[Math.floor(cursor / VIRTUAL_HEIGHT_BLOCK_SIZE)] || 0;
        cursor += VIRTUAL_HEIGHT_BLOCK_SIZE;
      }
      while (cursor < safeEnd) total += values[cursor++];
      return total;
    }

    function update(index, height) {
      const safeHeight = Number(height);
      if (!Number.isFinite(safeHeight) || safeHeight <= 0 || index < 0 || index >= values.length) {
        return false;
      }
      if (Math.abs(values[index] - safeHeight) < 0.5) return false;
      values[index] = safeHeight;
      rebuildBlock(Math.floor(index / VIRTUAL_HEIGHT_BLOCK_SIZE));
      return true;
    }

    function append(record) {
      values.push(heightCache.get(record.key) || estimate);
      rebuildBlock(Math.floor((values.length - 1) / VIRTUAL_HEIGHT_BLOCK_SIZE));
    }

    function indexAt(offset) {
      if (!values.length) return 0;
      let remaining = Math.max(0, Number(offset) || 0);
      let blockIndex = 0;
      while (blockIndex < blocks.length && remaining >= blocks[blockIndex]) {
        remaining -= blocks[blockIndex];
        blockIndex++;
      }
      let index = blockIndex * VIRTUAL_HEIGHT_BLOCK_SIZE;
      const limit = Math.min(values.length, index + VIRTUAL_HEIGHT_BLOCK_SIZE);
      while (index < limit && remaining >= values[index]) remaining -= values[index++];
      return Math.max(0, Math.min(values.length - 1, index));
    }

    rebuildBlocks();
    return Object.freeze({
      get length() { return values.length; },
      append,
      indexAt,
      sum,
      update,
      values,
    });
  }

  function start(windowObject) {
    const document = windowObject.document;
    const vscode = typeof windowObject.acquireVsCodeApi === 'function'
      ? windowObject.acquireVsCodeApi()
      : { postMessage() {} };
    const markdown = createMarkdownEngine(windowObject.marked);
    const richQueue = runtime.createRenderQueue({
      schedule: (callback) => windowObject.requestAnimationFrame(callback),
      now: () => windowObject.performance.now(),
      isUsable: (element) => !element.closest('details:not([open])'),
      onError: () => {},
    });
    const transcriptRoot = document.getElementById('transcript');
    const summaryRoot = document.getElementById('summary');
    const searchInput = document.getElementById('search');
    const statusRoot = document.getElementById('status');
    const latestButton = document.getElementById('latest');
    const filterGroup = document.getElementById('filter-group');
    const conversationPagination = document.getElementById('conversation-pagination');
    const conversationPrevious = document.getElementById('conversation-previous');
    const conversationNext = document.getElementById('conversation-next');
    const conversationPageLabel = document.getElementById('conversation-page-label');
    const conversationFirst = document.getElementById('conversation-first');
    const conversationLatest = document.getElementById('conversation-latest');
    const conversationJump = document.getElementById('conversation-jump');
    const conversationPageInput = document.getElementById('conversation-page-input');
    const conversationSearchResults = document.getElementById('conversation-search-results');
    const conversationSearchSummary = document.getElementById('conversation-search-summary');
    const conversationSearchList = document.getElementById('conversation-search-list');
    const conversationSearchMore = document.getElementById('conversation-search-more');
    const filterButtons = Array.from(document.querySelectorAll('[data-filter]'));
    const persistedState = typeof vscode.getState === 'function' ? (vscode.getState() || {}) : {};
    const persistedFilter = filterButtons.some((button) => button.dataset.filter === persistedState.filter)
      ? persistedState.filter
      : 'all';
    const state = {
      mode: 'subagent',
      transcript: null,
      messages: [],
      records: [],
      filteredRecords: [],
      filter: persistedFilter,
      query: typeof persistedState.query === 'string' ? persistedState.query : '',
      subagentFilter: persistedFilter,
      subagentQuery: typeof persistedState.query === 'string' ? persistedState.query : '',
      shownMessages: 0,
      heightCache: new Map(),
      heightIndex: null,
      renderStart: -1,
      renderEnd: -1,
      renderScheduled: false,
      measureScheduled: false,
      followingTail: false,
      tailRequested: false,
      mountedArticles: new Map(),
      pendingAnchor: null,
      restoringScroll: false,
      filtering: false,
      filterGeneration: 0,
      loadingReplacement: false,
      pendingScrollRestore: null,
      pageIndex: 0,
      pageSize: 60,
      totalMessages: 0,
      loadedTotalMessages: 0,
      pendingConversationLine: null,
      pendingConversationLocation: null,
      navigationGeneration: 0,
      searchGeneration: 0,
      searchRequestId: null,
      searchContinuationToken: null,
      searchResultCount: 0,
      searchSnapshotStale: false,
      pageRequestId: null,
      pageStartRequestId: null,
    };
    state.heightIndex = createHeightIndex([], state.heightCache);
    let restoreScrollY = Number.isFinite(persistedState.scrollY) ? persistedState.scrollY : null;
    searchInput.value = state.query;
    for (const button of filterButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
    }

    function persistUiState() {
      if ((state.mode === 'conversation' && !state.pagedSubagent) || typeof vscode.setState !== 'function') return;
      vscode.setState({
        filter: state.filter,
        query: state.query,
        scrollY: windowObject.scrollY,
        filePath: state.transcript?.filePath || null,
        pageIndex: state.pageIndex,
        viewId: state.transcript?.descriptor?.viewId || null,
      });
    }

    const allowedTags = new Set([
      'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3',
      'H4', 'H5', 'H6', 'HR', 'INPUT', 'LI', 'OL', 'P', 'PRE', 'SPAN', 'STRONG',
      'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
    ]);

    function sanitizeMarkdownHtml(html) {
      const template = document.createElement('template');
      template.innerHTML = html;
      const elements = Array.from(template.content.querySelectorAll('*'));
      for (const element of elements) {
        if (!allowedTags.has(element.tagName)) {
          element.replaceWith(document.createTextNode(element.textContent || ''));
          continue;
        }
        for (const attribute of Array.from(element.attributes)) {
          const name = attribute.name.toLowerCase();
          const keepClass = name === 'class' && ['CODE', 'SPAN', 'DIV'].includes(element.tagName);
          const keepMathData = element.classList.contains('ce-math-source') &&
            (name === 'data-display' || name === 'data-delimiter');
          const keepTable = ['colspan', 'rowspan', 'align'].includes(name) &&
            ['TD', 'TH'].includes(element.tagName);
          const keepList = name === 'start' && element.tagName === 'OL';
          const keepCheckbox = ['type', 'checked', 'disabled'].includes(name) &&
            element.tagName === 'INPUT' && element.getAttribute('type') === 'checkbox';
          if (name === 'href' && element.tagName === 'A') {
            const href = element.getAttribute('href') || '';
            if (/^(https?:|mailto:|#)/i.test(href)) {
              element.setAttribute('target', '_blank');
              element.setAttribute('rel', 'noopener noreferrer');
              continue;
            }
          }
          if (!keepClass && !keepMathData && !keepTable && !keepList && !keepCheckbox &&
              name !== 'target' && name !== 'rel') {
            element.removeAttribute(attribute.name);
          }
        }
      }
      const walker = document.createTreeWalker(template.content, windowObject.NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.includes(PIPE_SENTINEL)) {
          node.nodeValue = node.nodeValue.replaceAll(PIPE_SENTINEL, '|');
        }
      }
      return template.content;
    }

    function renderMathElement(element, candidate) {
      if (element.dataset.ceMathProcessed) return false;
      element.dataset.ceMathProcessed = 'true';
      const displayMode = candidate?.display ?? element.dataset.display === 'true';
      const formula = candidate?.formula ?? element.textContent.replaceAll(PIPE_SENTINEL, '|');
      if (!looksLikeMath(formula, displayMode) || !windowObject.katex?.renderToString) return false;
      try {
        element.innerHTML = mathCore.render(formula, displayMode);
        element.classList.add(displayMode ? 'ce-math-display' : 'ce-math-inline');
        element.classList.remove('ce-math-source');
        element.dataset.tex = formula;
        element.title = formula;
        return true;
      } catch (error) {
        element.classList.add('ce-math-error');
        element.title = `Formula kept as source: ${String(error.message || error)}`;
        return false;
      }
    }

    function recoverMathCode(root) {
      for (const code of root.querySelectorAll('code:not(pre code)')) {
        richQueue.enqueue(code, () => {
          const candidate = wholeMathCandidate(code.textContent);
          if (!candidate) return;
          const replacement = document.createElement(candidate.display ? 'div' : 'span');
          replacement.className = 'ce-math-source ce-math-code';
          replacement.textContent = candidate.formula;
          replacement.dataset.display = String(candidate.display);
          code.replaceWith(replacement);
          renderMathElement(replacement, candidate);
        });
      }
    }

    function highlightCode(root) {
      for (const code of root.querySelectorAll('pre code')) {
        if (!code.dataset.ceViewHighlighted) richQueue.enqueue(code, () => {
          if (code.dataset.ceViewHighlighted) return;
          code.dataset.ceViewHighlighted = 'true';
          const raw = code.textContent;
          const className = Array.from(code.classList).find((name) => name.startsWith('language-'));
          const requested = className ? className.slice('language-'.length).toLowerCase() : '';
          const language = LANGUAGE_ALIASES[requested] || requested;
          if (raw.length > MAX_HIGHLIGHT_LENGTH && windowObject.__CLAUDE_ENHANCE_RICH__) {
            windowObject.__CLAUDE_ENHANCE_RICH__.highlight(code, language).then((completed) => {
              if (!completed) delete code.dataset.ceViewHighlighted;
            });
          } else if (language && windowObject.hljs?.getLanguage?.(language)) {
            try {
              code.innerHTML = windowObject.hljs.highlight(raw, {
                language,
                ignoreIllegals: true,
              }).value;
              code.classList.add('hljs');
            } catch {
              code.textContent = raw;
            }
          }
        });
        const pre = code.parentElement;
        if (!pre || pre.parentElement?.classList.contains('code-shell')) continue;
        const shell = document.createElement('div');
        shell.className = 'code-shell';
        pre.replaceWith(shell);
        shell.appendChild(pre);
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'copy-button';
        copy.textContent = 'Copy';
        copy.addEventListener('click', async () => {
          try {
            await windowObject.navigator.clipboard.writeText(code.textContent || '');
            copy.textContent = 'Copied';
          } catch {
            copy.textContent = 'Failed';
          }
          windowObject.setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
        });
        shell.appendChild(copy);
      }
    }

    function finishRichContent(root) {
      for (const source of root.querySelectorAll('.ce-math-source')) {
        if (!source.dataset.ceMathProcessed) richQueue.enqueue(source, () => renderMathElement(source));
      }
      recoverMathCode(root);
      highlightCode(root);
      for (const table of Array.from(root.querySelectorAll('table'))) {
        if (table.parentElement?.classList.contains('table-scroll')) continue;
        const wrapper = document.createElement('div');
        wrapper.className = 'table-scroll';
        table.replaceWith(wrapper);
        wrapper.appendChild(table);
      }
    }

    function markdownFragment(source, defer = false) {
      const text = String(source || '');
      if ((defer || runtime.richSourceReason(text)) && windowObject.__CLAUDE_ENHANCE_RICH__) {
        const deferred = document.createElement('ce-rich-message');
        deferred.textContent = text;
        return deferred;
      }
      const fragment = sanitizeMarkdownHtml(parseMarkdown(markdown, source));
      finishRichContent(fragment);
      return fragment;
    }

    function codeShell(text, language) {
      const shell = document.createElement('div');
      shell.className = 'tool-code';
      if (windowObject.__CLAUDE_ENHANCE_RICH__ && (String(text || '').length > MAX_HIGHLIGHT_LENGTH ||
          String(text || '').split('\n', 122).length > 121)) {
        const code = document.createElement('ce-rich-code');
        code.setAttribute('language', language || '');
        code.textContent = text || '';
        shell.append(code);
        return shell;
      }
      if (String(text || '').length > MAX_HIGHLIGHT_LENGTH) shell.classList.add('large-message-source');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (language) code.className = `language-${language}`;
      code.textContent = text || '';
      pre.appendChild(code);
      shell.appendChild(pre);
      highlightCode(shell);
      return shell;
    }

    function disclosureBlock(className, label, open, renderContent) {
      const details = document.createElement('details');
      details.className = className;
      details.open = open;
      const summary = document.createElement('summary');
      summary.textContent = label;
      details.appendChild(summary);
      let rendered = false;
      let scheduled = false;
      const render = () => {
        if (rendered || !details.open) return;
        details.appendChild(renderContent());
        rendered = true;
      };
      if (open) render();
      details.addEventListener('toggle', () => {
        if (!details.open || scheduled) return;
        if (rendered) {
          finishRichContent(details);
          return;
        }
        scheduled = true;
        windowObject.requestAnimationFrame(() => {
          scheduled = false;
          if (details.isConnected) render();
        });
      });
      return details;
    }

    function blockElement(block, defer = false) {
      if (block.kind === 'text') {
        const content = document.createElement('div');
        content.className = 'markdown-content';
        content.appendChild(markdownFragment(block.text, defer));
        return content;
      }
      if (block.kind === 'thinking') {
        return disclosureBlock('thinking-block', 'Thinking', false, () => {
          const content = document.createElement('div');
          content.className = 'markdown-content detail-content';
          content.appendChild(markdownFragment(block.text, defer));
          return content;
        });
      }
      if (block.kind === 'tool') {
        return disclosureBlock('tool-block', block.name || 'Tool call', false, () => codeShell(block.text, 'json'));
      }
      if (block.kind === 'tool-result') {
        return disclosureBlock(block.isError ? 'tool-result error-block' : 'tool-result',
          block.isError ? 'Tool error' : 'Tool result',
          String(block.text || '').length <= 2400 || block.isError === true,
          () => codeShell(block.text, ''));
      }
      if (block.kind === 'api-error') {
        const error = document.createElement('div');
        error.className = 'api-error error-block';
        const title = document.createElement('strong');
        title.textContent = 'API error';
        const source = document.createElement('pre');
        source.textContent = block.text || '';
        if (String(block.text || '').length > MAX_HIGHLIGHT_LENGTH) error.classList.add('large-message-source');
        error.append(title, source);
        return error;
      }
      const attachment = document.createElement('div');
      attachment.className = 'attachment-block';
      attachment.textContent = block.text || 'Attachment';
      return attachment;
    }

    function roleLabel(message) {
      if (message.role === 'assistant') {
        return state.mode === 'conversation' ? 'Assistant' : (message.agentType || 'Sub-agent');
      }
      if (message.role === 'tool-result') return 'Tool';
      if (message.role === 'user') return state.mode === 'conversation' ? 'You' : 'Prompt';
      return message.role || 'Event';
    }

    function formatTime(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) return '';
      return date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }

    function renderMessage(message) {
      const article = document.createElement('article');
      article.className = `message message-${message.role || 'event'}`;
      article.dataset.messageId = message.id;
      article.dataset.messageLine = String(message.line || '');
      article.dataset.role = message.role || 'event';
      article.dataset.facets = messageFacets(message).join(' ');
      if (article.dataset.facets.includes('errors')) article.classList.add('message-error');

      const header = document.createElement('header');
      const role = document.createElement('strong');
      role.textContent = roleLabel(message);
      const metadata = document.createElement('span');
      metadata.textContent = [message.error, formatTime(message.timestamp), `line ${message.line}`]
        .filter(Boolean).join(' | ');
      header.append(role, metadata);
      if (message.largeRecord) {
        const raw = document.createElement('button');
        raw.type = 'button';
        raw.className = 'message-raw-link';
        raw.textContent = 'Open raw record';
        raw.addEventListener('click', () => vscode.postMessage({ type: 'openRaw', line: message.line }));
        header.appendChild(raw);
      }
      article.appendChild(header);
      const sources = [];
      let characters = 0;
      for (const block of message.blocks) {
        if (block.kind !== 'text') continue;
        const text = String(block.text || '');
        characters += text.length;
        if (characters > runtime.CONTENT_LIMITS.sourceCharacters) break;
        sources.push(text);
      }
      const defer = characters > runtime.CONTENT_LIMITS.sourceCharacters || !!runtime.richSourceReason(sources.join('\n'));
      for (const [blockIndex, block] of message.blocks.entries()) {
        const element = blockElement(block, defer);
        element.dataset.blockIndex = String(blockIndex);
        article.appendChild(element);
      }
      return article;
    }

    function revealMatchingDisclosures(article, message) {
      const query = state.query.toLocaleLowerCase();
      if (!query) return;
      for (const details of article?.querySelectorAll('details[data-block-index]') || []) {
        const block = message?.blocks[Number(details.dataset.blockIndex)];
        if ([block?.name, block?.text].filter(Boolean).join('\n').toLocaleLowerCase().includes(query)) {
          details.open = true;
        }
      }
    }

    const resizeObserver = typeof windowObject.ResizeObserver === 'function'
      ? new windowObject.ResizeObserver(() => scheduleMeasureRenderedMessages())
      : null;
    const disclosureQueries = new WeakMap();

    function createVirtualSpacer(edge, height) {
      const spacer = document.createElement('div');
      spacer.className = 'virtual-spacer';
      spacer.dataset.virtualSpacer = edge;
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.height = `${Math.max(0, Math.round(height))}px`;
      return spacer;
    }

    const virtualSpacers = {
      top: createVirtualSpacer('top', 0),
      bottom: createVirtualSpacer('bottom', 0),
    };

    function updateVirtualSpacer(edge, height) {
      const spacer = virtualSpacers[edge];
      const value = `${Math.max(0, Math.round(height))}px`;
      if (spacer.style.height !== value) spacer.style.height = value;
      return spacer;
    }

    function reconcileTranscriptChildren(children) {
      const retained = new Set(children);
      for (const child of Array.from(transcriptRoot.children)) {
        if (retained.has(child)) continue;
        resizeObserver?.unobserve?.(child);
        child.remove();
      }
      let cursor = transcriptRoot.firstChild;
      for (const child of children) {
        if (child === cursor) cursor = cursor.nextSibling;
        else transcriptRoot.insertBefore(child, cursor);
      }
    }

    function visibleRange() {
      const total = state.filteredRecords.length;
      if (!total) return { start: 0, end: 0 };
      if (state.followingTail) {
        return { start: Math.max(0, total - VIRTUAL_WINDOW_MESSAGES), end: total };
      }
      const scrollTop = Math.max(0, Number(windowObject.scrollY) || 0);
      const viewportHeight = Math.max(1, Number(windowObject.innerHeight) || 800);
      const summaryOffset = transcriptRoot.offsetTop || 0;
      const relativeTop = Math.max(0, scrollTop - summaryOffset);
      const first = state.heightIndex.indexAt(relativeTop);
      const last = state.heightIndex.indexAt(relativeTop + viewportHeight);
      let start = Math.max(0, first - VIRTUAL_WINDOW_OVERSCAN);
      let end = Math.min(total, Math.max(first + 1, last + VIRTUAL_WINDOW_OVERSCAN + 1));
      if (end - start < VIRTUAL_WINDOW_MESSAGES) {
        const missing = VIRTUAL_WINDOW_MESSAGES - (end - start);
        start = Math.max(0, start - Math.ceil(missing / 2));
        end = Math.min(total, Math.max(end, start + VIRTUAL_WINDOW_MESSAGES));
        start = Math.max(0, Math.min(start, end - VIRTUAL_WINDOW_MESSAGES));
      }
      if (end - start > VIRTUAL_MAX_MESSAGES) {
        start = Math.max(0, Math.min(first - VIRTUAL_WINDOW_OVERSCAN, total - VIRTUAL_MAX_MESSAGES));
        end = Math.min(total, start + VIRTUAL_MAX_MESSAGES);
      }
      return {
        start,
        end,
      };
    }

    function scheduleMeasureRenderedMessages() {
      if (state.measureScheduled) return;
      state.measureScheduled = true;
      windowObject.requestAnimationFrame(() => {
        state.measureScheduled = false;
        measureRenderedMessages();
      });
    }

    function captureVirtualAnchor() {
      if (state.followingTail) return null;
      for (const article of transcriptRoot.querySelectorAll('.message[data-message-key]')) {
        const rect = article.getBoundingClientRect?.();
        if (!rect || rect.bottom <= 0 || rect.top >= windowObject.innerHeight) continue;
        return { key: article.dataset.messageKey, offset: rect.top };
      }
      return null;
    }

    function restoreVirtualAnchor() {
      const anchor = state.pendingAnchor;
      state.pendingAnchor = null;
      if (!anchor || state.followingTail) return;
      const article = state.mountedArticles.get(anchor.key);
      const rect = article?.getBoundingClientRect?.();
      if (!rect) return;
      const delta = rect.top - anchor.offset;
      if (Math.abs(delta) >= 0.5) windowObject.scrollTo(0, windowObject.scrollY + delta);
    }

    function measureRenderedMessages() {
      let changed = false;
      let heightDeltaAboveViewport = 0;
      const articles = transcriptRoot.querySelectorAll('.message[data-virtual-index]');
      for (const article of articles) {
        const index = Number(article.dataset.virtualIndex);
        const record = state.filteredRecords[index];
        if (!record) continue;
        const rect = article.getBoundingClientRect?.();
        const height = rect?.height || article.offsetHeight || 0;
        const previousHeight = state.heightIndex.values[index];
        if (!state.heightIndex.update(index, height)) continue;
        state.heightCache.set(record.key, height);
        const previousBottom = rect ? rect.top + previousHeight : Infinity;
        if (!state.followingTail && previousBottom <= 0) {
          heightDeltaAboveViewport += height - previousHeight;
        }
        changed = true;
      }
      if (changed) {
        if (Math.abs(heightDeltaAboveViewport) >= 0.5) {
          windowObject.scrollTo(0, Math.max(0, windowObject.scrollY + heightDeltaAboveViewport));
        }
        state.pendingAnchor = captureVirtualAnchor();
        scheduleVirtualRender(true);
      }
    }

    function scheduleVirtualRender(force = false) {
      if (force) state.renderStart = -1;
      if (state.renderScheduled) return;
      state.renderScheduled = true;
      windowObject.requestAnimationFrame(() => {
        state.renderScheduled = false;
        renderVirtualWindow();
      });
    }

    function renderVirtualWindow() {
      const range = visibleRange();
      if (range.start === state.renderStart && range.end === state.renderEnd) return;
      state.renderStart = range.start;
      state.renderEnd = range.end;
      const previousArticles = state.mountedArticles;
      const nextArticles = new Map();

      if (!state.filteredRecords.length) {
        state.mountedArticles = nextArticles;
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = state.messages.length
          ? 'No messages match the current search and filter.'
          : (state.mode === 'conversation'
            ? 'No displayable messages in this conversation.'
            : 'No renderable messages in this transcript.');
        reconcileTranscriptChildren([empty]);
        return;
      }

      const children = [];
      const topHeight = state.heightIndex.sum(0, range.start);
      if (topHeight > 0) children.push(updateVirtualSpacer('top', topHeight));
      for (let index = range.start; index < range.end; index++) {
        const record = state.filteredRecords[index];
        const article = previousArticles.get(record.key) || renderMessage(record.message);
        if (state.mode !== 'conversation' && disclosureQueries.get(article) !== state.query) {
          revealMatchingDisclosures(article, record.message);
          disclosureQueries.set(article, state.query);
        }
        article.dataset.virtualIndex = String(index);
        article.dataset.messageKey = record.key;
        nextArticles.set(record.key, article);
        children.push(article);
      }
      const bottomHeight = state.heightIndex.sum(range.end, state.filteredRecords.length);
      if (bottomHeight > 0) children.push(updateVirtualSpacer('bottom', bottomHeight));
      reconcileTranscriptChildren(children);
      state.mountedArticles = nextArticles;
      for (const [key, article] of nextArticles) {
        if (previousArticles.get(key) !== article) resizeObserver?.observe?.(article);
      }
      scheduleMeasureRenderedMessages();
      if (state.followingTail) {
        windowObject.requestAnimationFrame(() => windowObject.scrollTo(0, document.body.scrollHeight));
      } else if (state.pendingAnchor) {
        windowObject.requestAnimationFrame(() => restoreVirtualAnchor());
      }
    }

    function runWhenIdle(callback) {
      if (typeof windowObject.requestIdleCallback === 'function') {
        return windowObject.requestIdleCallback(callback, { timeout: 50 });
      }
      return windowObject.setTimeout(() => callback({
        didTimeout: true,
        timeRemaining: () => 0,
      }), 0);
    }

    function rebuildFilteredRecords(options = {}) {
      const generation = ++state.filterGeneration;
      const query = state.query.toLocaleLowerCase();
      const filtered = [];
      let index = 0;
      state.filtering = true;
      statusRoot.textContent = 'Searching transcript...';
      if (options.resetScroll) {
        state.pendingAnchor = null;
        state.pendingScrollRestore = null;
        state.restoringScroll = false;
        windowObject.scrollTo(0, transcriptRoot.offsetTop || 0);
      }
      const processSlice = (deadline) => {
        if (generation !== state.filterGeneration) return;
        const startedAt = windowObject.performance.now();
        let processed = 0;
        while (index < state.records.length &&
            (processed === 0 || (processed < FILTER_SLICE_RECORDS &&
              windowObject.performance.now() - startedAt < FILTER_SLICE_MS &&
              (deadline.didTimeout || deadline.timeRemaining() > 2)))) {
          const record = state.records[index++];
          if (!query) record.searchText = null;
          if (recordMatches(record, state.filter, query)) filtered.push(record);
          processed++;
        }
        if (index < state.records.length) {
          runWhenIdle(processSlice);
          return;
        }
        state.filtering = false;
        state.filteredRecords = filtered;
        state.shownMessages = filtered.length;
        state.heightIndex = createHeightIndex(filtered, state.heightCache);
        state.renderStart = -1;
        state.renderEnd = -1;
        statusRoot.textContent = query || state.filter !== 'all'
          ? `${state.shownMessages} messages shown`
          : (state.loadingReplacement ? 'Loading transcript...' : '');
        scheduleVirtualRender(true);
        if (state.pendingScrollRestore) {
          const restore = state.pendingScrollRestore;
          state.pendingScrollRestore = null;
          windowObject.requestAnimationFrame(() => {
            if (restore.mode === 'anchor') {
              const anchorIndex = state.filteredRecords.findIndex((record) => record.key === restore.key);
              if (anchorIndex >= 0) {
                const target = (transcriptRoot.offsetTop || 0) +
                  state.heightIndex.sum(0, anchorIndex) - restore.offset;
                state.pendingAnchor = { key: restore.key, offset: restore.offset };
                windowObject.scrollTo(0, Math.max(0, target));
              } else {
                windowObject.scrollTo(0, restore.value);
              }
            } else {
              windowObject.scrollTo(0, restore.mode === 'top' ? 0 : restore.value);
            }
            scheduleVirtualRender(true);
            windowObject.requestAnimationFrame(() => {
              windowObject.requestAnimationFrame(() => { state.restoringScroll = false; });
            });
          });
        }
      };
      runWhenIdle(processSlice);
    }

    function renderSummary() {
      const transcript = state.transcript;
      summaryRoot.replaceChildren();
      if (!transcript) return;
      const descriptor = transcript.descriptor || {};
      const heading = document.createElement('div');
      heading.className = 'summary-heading';
      const title = document.createElement('h1');
      title.textContent = descriptor.label || `agent-${descriptor.agentId || descriptor.sessionId || ''}`;
      const raw = document.createElement('button');
      raw.type = 'button';
      raw.textContent = 'Open JSONL';
      raw.addEventListener('click', () => vscode.postMessage({ type: 'openRaw' }));
      heading.append(title, raw);
      const metadata = document.createElement('p');
      const malformed = transcript.malformedLines ? ` | ${transcript.malformedLines} malformed` : '';
      const partial = transcript.partialLine ? ' | receiving data' : '';
      const currentCount = state.mode === 'conversation' ? state.totalMessages : state.messages.length;
      metadata.textContent = `${descriptor.agentType || descriptor.projectLabel || descriptor.agentId || descriptor.sessionId || 'sub-agent'} | ` +
        `${currentCount} messages | ${transcript.lines || 0} JSONL lines | ` +
        `${formatBytes(transcript.bytes)} | ${descriptor.status || 'idle'}${malformed}${partial}`;
      summaryRoot.append(heading, metadata);
    }

    function resetConversationState(metadata, requestId) {
      richQueue.clear();
      if (state.searchRequestId) {
        vscode.postMessage({ type: 'cancelSearch', requestId: state.searchRequestId });
      }
      if (state.mode !== 'conversation') {
        state.subagentFilter = state.filter;
        state.subagentQuery = state.query;
      }
      state.mode = 'conversation';
      state.transcript = metadata || {};
      state.pagedSubagent = metadata?.descriptor?.kind === 'subagent';
      state.messages = [];
      state.records = [];
      state.filteredRecords = [];
      state.shownMessages = 0;
      state.pageIndex = 0;
      state.pageSize = 60;
      state.totalMessages = Number(metadata?.messageCount) || 0;
      state.loadedTotalMessages = state.totalMessages;
      state.pendingConversationLine = null;
      state.followingTail = false;
      state.tailRequested = false;
      state.filterGeneration++;
      state.searchGeneration++;
      state.searchRequestId = null;
      state.searchContinuationToken = null;
      state.searchResultCount = 0;
      state.searchSnapshotStale = false;
      state.pageRequestId = null;
      state.pageStartRequestId = requestId ? String(requestId) : null;
      state.pageChunks = null;
      state.filter = state.pagedSubagent ? state.subagentFilter : 'all';
      state.query = state.pagedSubagent ? state.subagentQuery : '';
      state.initialPagedSearch = !!state.query || state.filter !== 'all';
      state.renderStart = -1;
      state.renderEnd = -1;
      state.heightCache.clear();
      state.heightIndex = createHeightIndex([], state.heightCache);
      state.mountedArticles.clear();
      searchInput.value = state.query;
      searchInput.disabled = true;
      searchInput.setAttribute('aria-label', 'Search complete conversation history');
      searchInput.placeholder = 'Search complete conversation history';
      if (filterGroup) filterGroup.hidden = !state.pagedSubagent;
      for (const button of filterButtons) button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
      if (latestButton) latestButton.hidden = true;
      if (conversationSearchResults) conversationSearchResults.hidden = true;
      if (conversationPagination) conversationPagination.hidden = false;
      transcriptRoot.setAttribute('aria-busy', 'true');
      renderSummary();
      updateConversationPagination();
    }

    function showConversationLoading(label = 'Conversation History') {
      richQueue.clear();
      if (state.mode !== 'conversation') {
        state.subagentFilter = state.filter;
        state.subagentQuery = state.query;
      }
      state.mode = 'conversation';
      state.pagedSubagent = false;
      state.transcript = {
        descriptor: { label },
        bytes: 0,
        lines: 0,
        malformedLines: 0,
        partialLine: false,
        messageCount: 0,
      };
      state.messages = [];
      state.records = [];
      state.filteredRecords = [];
      state.totalMessages = 0;
      state.loadedTotalMessages = 0;
      state.pageIndex = 0;
      state.pageSize = 60;
      state.filterGeneration++;
      state.searchGeneration++;
      state.searchRequestId = null;
      state.searchContinuationToken = null;
      state.searchResultCount = 0;
      state.searchSnapshotStale = false;
      state.pageRequestId = null;
      state.pageStartRequestId = null;
      state.pageChunks = null;
      state.renderStart = -1;
      state.renderEnd = -1;
      state.heightCache.clear();
      state.heightIndex = createHeightIndex([], state.heightCache);
      state.mountedArticles.clear();
      state.filter = 'all';
      state.query = '';
      searchInput.value = '';
      searchInput.disabled = true;
      searchInput.setAttribute('aria-label', 'Search complete conversation history');
      searchInput.placeholder = 'Search complete conversation history';
      if (filterGroup) filterGroup.hidden = true;
      if (latestButton) latestButton.hidden = true;
      if (conversationPagination) conversationPagination.hidden = false;
      if (conversationSearchResults) conversationSearchResults.hidden = true;
      conversationPageLabel.textContent = 'Indexing local history…';
      conversationPrevious.disabled = true;
      conversationNext.disabled = true;
      if (conversationFirst) conversationFirst.disabled = true;
      if (conversationLatest) conversationLatest.disabled = true;
      if (conversationPageInput) conversationPageInput.disabled = true;
      conversationSearchList.replaceChildren();
      transcriptRoot.setAttribute('aria-busy', 'true');
      resizeObserver?.disconnect?.();
      transcriptRoot.replaceChildren();
      const loading = document.createElement('div');
      loading.className = 'empty-state';
      loading.textContent = 'Indexing local conversation history…';
      transcriptRoot.appendChild(loading);
      summaryRoot.replaceChildren();
      statusRoot.textContent = 'Preparing the sparse history index…';
    }

    function updateConversationPagination() {
      if (state.mode !== 'conversation' || !conversationPagination) return;
      const pageCount = Math.ceil(state.totalMessages / state.pageSize);
      const busy = !!state.pageRequestId || !!state.pageStartRequestId || searchInput.disabled;
      const newMessages = Math.max(0, state.totalMessages - state.loadedTotalMessages);
      conversationPagination.hidden = false;
      conversationPrevious.disabled = busy || state.pageIndex <= 0;
      conversationNext.disabled = busy || state.pageIndex + 1 >= pageCount;
      if (conversationFirst) conversationFirst.disabled = busy || state.pageIndex <= 0;
      if (conversationLatest) {
        conversationLatest.disabled = busy || !pageCount || (state.pageIndex + 1 >= pageCount && !newMessages);
        conversationLatest.textContent = newMessages ? `Latest · ${newMessages} new messages` : 'Latest';
      }
      if (conversationPageInput) {
        conversationPageInput.max = String(Math.max(1, pageCount));
        conversationPageInput.disabled = busy || !pageCount;
        if (document.activeElement !== conversationPageInput) conversationPageInput.value = String(state.pageIndex + 1);
      }
      conversationPageLabel.textContent = `${state.totalMessages ? state.pageIndex + 1 : 0} / ${pageCount} · ${state.totalMessages} messages`;
    }

    function requestConversationPage(pageIndex, lineNumber, preserveScroll = false, location = null) {
      if (state.mode !== 'conversation' || !Number.isInteger(pageIndex) || pageIndex < 0) return;
      state.pendingConversationLine = Number.isInteger(lineNumber) ? lineNumber : null;
      state.pendingConversationLocation = location ? { ...location, query: state.query } : null;
      state.navigationGeneration++;
      state.pageRequestId = `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      state.pageChunks = null;
      statusRoot.textContent = 'Loading conversation page...';
      transcriptRoot.setAttribute('aria-busy', 'true');
      updateConversationPagination();
      vscode.postMessage({
        type: 'loadPage',
        pageIndex,
        requestId: state.pageRequestId,
        preserveScroll,
      });
    }

    function appendConversationSearchHits(hits) {
      for (const hit of hits || []) {
        if (conversationSearchList.childElementCount >= 300) {
          conversationSearchList.firstElementChild.remove();
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'conversation-search-hit';
        button.dataset.messageIndex = Number.isInteger(hit.messageIndex) && hit.messageIndex >= 0
          ? String(hit.messageIndex)
          : '';
        const heading = document.createElement('strong');
        heading.textContent = `#${hit.line} · ${hit.role}`;
        const preview = document.createElement('span');
        preview.textContent = hit.preview || '';
        button.append(heading, preview);
        button.addEventListener('click', () => {
          const rawMessageIndex = button.dataset.messageIndex;
          const messageIndex = rawMessageIndex ? Number(rawMessageIndex) : NaN;
          if (!Number.isInteger(messageIndex) || messageIndex < 0 || hit.raw) {
            vscode.postMessage({ type: 'openRaw', line: hit.line });
            return;
          }
          requestConversationPage(Math.floor(messageIndex / state.pageSize), hit.line, false, hit.location);
        });
        conversationSearchList.appendChild(button);
        state.searchResultCount++;
      }
    }

    function runConversationSearch(query, append = false) {
      const normalized = String(query || '').trim();
      if (state.mode !== 'conversation') return;
      if ((!normalized && state.filter === 'all') || normalized.length > 512) {
        if (state.searchRequestId) {
          vscode.postMessage({ type: 'cancelSearch', requestId: state.searchRequestId });
        }
        state.searchGeneration++;
        state.searchRequestId = null;
        state.searchContinuationToken = null;
        state.searchResultCount = 0;
        state.searchSnapshotStale = false;
        conversationSearchList.replaceChildren();
        if (normalized.length > 512) {
          if (conversationSearchResults) conversationSearchResults.hidden = false;
          conversationSearchSummary.textContent = 'Search queries are limited to 512 characters.';
          conversationSearchMore.hidden = true;
        } else if (conversationSearchResults) {
          conversationSearchResults.hidden = true;
        }
        return;
      }
      if (!append) {
        if (state.searchRequestId) {
          vscode.postMessage({ type: 'cancelSearch', requestId: state.searchRequestId });
        }
        state.searchGeneration++;
        state.searchRequestId = `search-${state.searchGeneration}-${Date.now()}`;
        state.searchContinuationToken = null;
        state.searchResultCount = 0;
        state.searchSnapshotStale = false;
        conversationSearchList.replaceChildren();
      }
      if (append && !state.searchContinuationToken) return;
      const requestId = state.searchRequestId;
      if (conversationSearchResults) conversationSearchResults.hidden = false;
      conversationSearchSummary.textContent = append
        ? `${state.searchResultCount} matches · loading more...`
        : 'Searching complete local history...';
      conversationSearchMore.hidden = true;
      vscode.postMessage({
        type: 'search',
        requestId,
        query: normalized,
        filter: state.filter,
        continuationToken: append ? state.searchContinuationToken : undefined,
      });
    }

    async function revealConversationLocation(article, location, generation) {
      if (!article || !location || generation !== state.navigationGeneration) return;
      const block = Array.from(article.children).find((element) => element.dataset.blockIndex === String(location.blockIndex));
      if (!block) return;
      if (block.tagName === 'DETAILS') block.open = true;
      await new Promise(windowObject.requestAnimationFrame);
      await new Promise(windowObject.requestAnimationFrame);
      if (!article.isConnected || generation !== state.navigationGeneration) return;
      block.scrollIntoView({ block: 'center' });
      const rich = block.querySelector('ce-rich-message, ce-rich-code');
      if (rich) await rich.revealLocation(location.start, location.query, () => generation === state.navigationGeneration);
      else windowObject.__CLAUDE_ENHANCE_RICH__?.revealText(block, location.query);
    }

    function installConversationPage(message) {
      const page = Number(message.pageIndex);
      if (!Number.isInteger(page) || page < 0) return;
      const previousPageIndex = state.pageIndex;
      const restorePagedPosition = state.pagedSubagent && state.pageStartRequestId &&
        persistedState.viewId === message.transcript?.descriptor?.viewId && persistedState.pageIndex === page &&
        Number.isFinite(persistedState.scrollY);
      const previousPage = state.messages;
      const previousAnchor = message.preserveScroll ? captureVirtualAnchor() : null;
      const wasNearBottom = document.documentElement.scrollHeight -
        (windowObject.scrollY + windowObject.innerHeight) < 180;
      if (previousPageIndex !== page) state.heightCache.clear();
      state.mode = 'conversation';
      state.pageIndex = page;
      state.pageSize = Math.max(1, Math.min(60, Number(message.pageSize) || 60));
      state.loadedTotalMessages = Number(message.totalMessages) || 0;
      state.totalMessages = Math.max(state.totalMessages, state.loadedTotalMessages);
      state.transcript = message.transcript || state.transcript;
      state.messages = Array.isArray(message.messages) ? message.messages.slice(0, state.pageSize) : [];
      state.records = state.messages.map((record, index) => createMessageRecord(
        record,
        Number.isInteger(record.conversationIndex) ? record.conversationIndex : page * state.pageSize + index
      ));
      state.filteredRecords = state.records;
      state.shownMessages = state.records.length;
      state.heightIndex = createHeightIndex(state.records, state.heightCache);
      state.renderStart = -1;
      state.renderEnd = -1;
      state.pendingAnchor = null;
      state.pendingScrollRestore = null;
      state.restoringScroll = false;
      state.pageRequestId = null;
      state.pageStartRequestId = null;
      state.followingTail = false;
      state.loadingReplacement = false;
      searchInput.disabled = false;
      if (state.initialPagedSearch) {
        state.initialPagedSearch = false;
        runConversationSearch(state.query);
      }
      transcriptRoot.setAttribute('aria-busy', 'false');
      scheduleVirtualRender(true);
      const targetLine = state.pendingConversationLine;
      const targetLocation = state.pendingConversationLocation;
      const navigationGeneration = state.navigationGeneration;
      state.pendingConversationLine = null;
      state.pendingConversationLocation = null;
      requestAnimationFrame(() => {
        const previousPageIsPrefix = previousPage.length > 0 &&
          state.messages.length >= previousPage.length &&
          previousPage.every((record, index) => record.id === state.messages[index]?.id);
        if (message.preserveScroll && previousPageIndex === page && previousPageIsPrefix) {
          if (wasNearBottom) {
            windowObject.scrollTo({ top: document.body.scrollHeight });
          } else {
            const article = previousAnchor && state.mountedArticles.get(previousAnchor.key);
            const rect = article?.getBoundingClientRect?.();
            if (rect && previousAnchor) {
              windowObject.scrollTo(0, windowObject.scrollY + rect.top - previousAnchor.offset);
            }
          }
          statusRoot.textContent = 'Conversation history updated.';
          return;
        }
        if (message.preserveScroll && previousPageIndex < page && wasNearBottom) {
          windowObject.scrollTo({ top: document.body.scrollHeight });
          statusRoot.textContent = 'Conversation history updated.';
          return;
        }
        if (targetLine) {
          const target = transcriptRoot.querySelector(`.message[data-message-line="${targetLine}"]`);
          const targetMessage = state.messages.find((record) => record.line === targetLine);
          revealMatchingDisclosures(target, targetMessage);
          target?.scrollIntoView?.({ block: 'center' });
          void revealConversationLocation(target, targetLocation, navigationGeneration).catch(() => {
            if (navigationGeneration === state.navigationGeneration) statusRoot.textContent = 'Message loaded. Open Source to inspect the match.';
          });
        } else if (restorePagedPosition) {
          windowObject.scrollTo(0, Math.max(0, persistedState.scrollY));
        } else {
          windowObject.scrollTo(0, transcriptRoot.offsetTop || 0);
        }
      });
      const malformed = state.transcript?.malformedLines || 0;
      statusRoot.textContent = `${malformed} malformed records skipped${state.transcript?.partialLine ? ' · final record is still being written' : ''}`
        .replace(/^0 malformed records skipped$/, '');
      updateConversationPagination();
      renderSummary();
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    function startTranscriptReplacement(transcript) {
      richQueue.clear();
      const previousFilePath = state.transcript?.filePath || persistedState.filePath || null;
      const changedTranscript = !!previousFilePath && previousFilePath !== transcript.filePath;
      const currentScrollY = Math.max(0, Number(windowObject.scrollY) || 0);
      const currentAnchor = changedTranscript ? null : captureVirtualAnchor();
      state.transcript = transcript;
      state.messages = [];
      if (changedTranscript) state.heightCache.clear();
      state.records = [];
      state.filteredRecords = [];
      state.heightIndex = createHeightIndex([], state.heightCache);
      state.mountedArticles.clear();
      state.followingTail = false;
      state.tailRequested = false;
      state.restoringScroll = true;
      state.loadingReplacement = true;
      state.filterGeneration++;
      state.filtering = false;
      state.renderStart = -1;
      state.renderEnd = -1;
      state.pendingScrollRestore = changedTranscript
        ? { mode: 'top' }
        : (currentAnchor ? {
            mode: 'anchor',
            key: currentAnchor.key,
            offset: currentAnchor.offset,
            value: restoreScrollY !== null ? restoreScrollY : currentScrollY,
          } : {
            mode: 'position',
            value: restoreScrollY !== null ? restoreScrollY : currentScrollY,
          });
      restoreScrollY = null;
      transcriptRoot.setAttribute('aria-busy', 'true');
      renderSummary();
      statusRoot.textContent = 'Loading transcript...';
      scheduleVirtualRender(true);
    }

    function appendMessageBatch(messages, options = {}) {
      if (!messages.length) return;
      const nearBottom = document.documentElement.scrollHeight -
        (windowObject.scrollY + windowObject.innerHeight) < 180;
      const startIndex = state.messages.length;
      state.messages.push(...messages);
      const appendedRecords = messages.map((message, index) => (
        createMessageRecord(message, startIndex + index)
      ));
      state.records.push(...appendedRecords);
      const query = state.query.toLocaleLowerCase();
      if (!state.filtering) {
        for (const record of appendedRecords) {
          if (!recordMatches(record, state.filter, query)) continue;
          state.filteredRecords.push(record);
          state.heightIndex.append(record);
        }
      }
      state.shownMessages = state.filteredRecords.length;
      statusRoot.textContent = state.loadingReplacement
        ? `Loading transcript... ${state.messages.length} messages`
        : (query || state.filter !== 'all'
        ? `${state.shownMessages} messages shown`
        : '');
      state.followingTail = options.followTail !== false && nearBottom;
      renderSummary();
      scheduleVirtualRender(true);
    }

    function completeTranscriptReplacement(transcript) {
      state.transcript = {
        ...state.transcript,
        ...transcript,
        descriptor: { ...state.transcript?.descriptor, ...transcript.descriptor },
      };
      state.loadingReplacement = false;
      transcriptRoot.setAttribute('aria-busy', 'false');
      renderSummary();
      rebuildFilteredRecords();
    }

    function appendTranscriptMetadata(metadata) {
      state.transcript = {
        ...state.transcript,
        ...metadata,
        descriptor: { ...state.transcript?.descriptor, ...metadata.descriptor },
      };
      transcriptRoot.setAttribute('aria-busy', 'false');
      renderSummary();
    }

    function replaceTranscript(transcript) {
      startTranscriptReplacement(transcript);
      appendMessageBatch(transcript.messages || [], { followTail: false });
      completeTranscriptReplacement(transcript);
    }

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      windowObject.clearTimeout(searchTimer);
      searchTimer = windowObject.setTimeout(() => {
        state.query = searchInput.value.trim();
        if (state.mode === 'conversation') {
          if (state.pagedSubagent) {
            state.subagentQuery = state.query;
            persistUiState();
          }
          runConversationSearch(state.query);
          return;
        }
        state.subagentQuery = state.query;
        persistUiState();
        state.followingTail = false;
        state.tailRequested = false;
        rebuildFilteredRecords({ resetScroll: true });
      }, 100);
    });
    for (const button of filterButtons) {
      button.addEventListener('click', () => {
        state.filter = button.dataset.filter;
        if (state.mode === 'subagent' || state.pagedSubagent) state.subagentFilter = state.filter;
        for (const candidate of filterButtons) {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        }
        persistUiState();
        if (state.mode === 'conversation') {
          runConversationSearch(state.query);
          return;
        }
        state.followingTail = false;
        state.tailRequested = false;
        rebuildFilteredRecords({ resetScroll: true });
      });
    }
    latestButton.addEventListener('click', () => {
      if (state.mode === 'conversation') {
        requestConversationPage(Math.max(0, Math.ceil(state.totalMessages / state.pageSize) - 1));
        return;
      }
      state.followingTail = true;
      state.tailRequested = true;
      scheduleVirtualRender(true);
      windowObject.requestAnimationFrame(() => windowObject.scrollTo({
        top: document.body.scrollHeight,
        behavior: 'smooth',
      }));
    });
    let scrollTimer = null;
    windowObject.addEventListener('scroll', () => {
      if (state.restoringScroll) {
        scheduleVirtualRender();
        return;
      }
      const bottomDistance = document.documentElement.scrollHeight -
        (windowObject.scrollY + windowObject.innerHeight);
      if (state.tailRequested) {
        state.followingTail = true;
        if (bottomDistance < 180) state.tailRequested = false;
      } else {
        state.followingTail = bottomDistance < 180;
      }
      scheduleVirtualRender();
      windowObject.clearTimeout(scrollTimer);
      scrollTimer = windowObject.setTimeout(persistUiState, 150);
    }, { passive: true });
    windowObject.addEventListener('resize', () => scheduleVirtualRender(true), { passive: true });

    conversationPrevious?.addEventListener('click', () => {
      requestConversationPage(state.pageIndex - 1);
    });
    conversationNext?.addEventListener('click', () => {
      requestConversationPage(state.pageIndex + 1);
    });
    conversationFirst?.addEventListener('click', () => requestConversationPage(0));
    conversationLatest?.addEventListener('click', () => {
      requestConversationPage(Math.max(0, Math.ceil(state.totalMessages / state.pageSize) - 1));
    });
    conversationJump?.addEventListener('submit', (event) => {
      event.preventDefault();
      const pageNumber = Number(conversationPageInput?.value);
      const pageCount = Math.ceil(state.totalMessages / state.pageSize);
      if (!state.pageRequestId && Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount) {
        requestConversationPage(pageNumber - 1);
      }
    });
    conversationSearchMore?.addEventListener('click', () => runConversationSearch(state.query, true));

    windowObject.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'conversationLoading') {
        showConversationLoading(message.label);
      } else if (message?.type === 'conversationStart') {
        resetConversationState(message.transcript || {}, message.requestId);
      } else if (message?.type === 'conversationPage') {
        if (message.requestId === state.pageRequestId ||
            message.requestId === state.pageStartRequestId ||
            (String(message.requestId || '').startsWith('refresh-') && !state.pageRequestId)) {
          if (message.streamed) message.messages = state.pageChunks?.requestId === message.requestId ? state.pageChunks.messages : [];
          state.pageChunks = null;
          installConversationPage(message);
        }
      } else if (message?.type === 'conversationPageChunk') {
        if (message.requestId === state.pageRequestId || message.requestId === state.pageStartRequestId) {
          if (state.pageChunks?.requestId !== message.requestId) state.pageChunks = { requestId: message.requestId, messages: [] };
          state.pageChunks.messages.push(...(message.messages || []).slice(0, 60 - state.pageChunks.messages.length));
        }
        vscode.postMessage({ type: 'loadPage', requestId: message.requestId, ackToken: message.ackToken });
      } else if (message?.type === 'searchResults' && message.requestId === state.searchRequestId) {
        state.searchContinuationToken = message.continuationToken || null;
        appendConversationSearchHits(message.hits);
        const shown = conversationSearchList.childElementCount;
        const range = state.searchResultCount > shown
          ? ` · showing ${state.searchResultCount - shown + 1}–${state.searchResultCount}`
          : '';
        conversationSearchSummary.textContent = `${state.searchResultCount} matches${range}${message.done ? ' · complete' : ''}`;
        if (state.searchSnapshotStale) {
          conversationSearchSummary.textContent += ' · New messages available; search again to include them.';
        }
        conversationSearchMore.hidden = !state.searchContinuationToken;
      } else if (message?.type === 'searchError' && message.requestId === state.searchRequestId) {
        conversationSearchSummary.textContent = message.message || 'History search failed.';
        conversationSearchMore.hidden = true;
      } else if (message?.type === 'conversationPaused') {
        if (state.searchRequestId) vscode.postMessage({ type: 'cancelSearch', requestId: state.searchRequestId });
        state.searchGeneration++;
        state.searchRequestId = null;
        state.searchContinuationToken = null;
      } else if (message?.type === 'conversationUpdate') {
        const follow = state.pagedSubagent && state.followingTail && !state.pageRequestId &&
          !state.searchRequestId && state.pageIndex + 1 >= Math.ceil(state.totalMessages / state.pageSize);
        state.transcript = message.transcript || state.transcript;
        state.totalMessages = Number(state.transcript?.messageCount) || state.totalMessages;
        if (message.messagesChanged && state.searchRequestId && !state.searchSnapshotStale) {
          state.searchSnapshotStale = true;
          conversationSearchSummary.textContent += ' · New messages available; search again to include them.';
        }
        if (message.pageRequestId) {
          state.pageRequestId = String(message.pageRequestId);
          state.pendingConversationLine = null;
          statusRoot.textContent = 'Loading updated conversation page...';
          transcriptRoot.setAttribute('aria-busy', 'true');
        }
        updateConversationPagination();
        renderSummary();
        if (follow && message.messagesChanged) {
          requestConversationPage(Math.max(0, Math.ceil(state.totalMessages / state.pageSize) - 1), undefined, true);
        }
      } else if (message?.type === 'replaceStart') {
        state.mode = 'subagent';
        state.pagedSubagent = false;
        state.filter = state.subagentFilter;
        state.query = state.subagentQuery;
        searchInput.value = state.query;
        for (const button of filterButtons) {
          button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
        }
        if (state.searchRequestId) vscode.postMessage({ type: 'cancelSearch', requestId: state.searchRequestId });
        state.searchGeneration++;
        state.searchRequestId = null;
        state.searchContinuationToken = null;
        state.searchResultCount = 0;
        conversationSearchList.replaceChildren();
        searchInput.disabled = false;
        searchInput.setAttribute('aria-label', 'Search transcript');
        searchInput.placeholder = 'Search transcript';
        if (filterGroup) filterGroup.hidden = false;
        if (latestButton) latestButton.hidden = false;
        if (conversationPagination) conversationPagination.hidden = true;
        if (conversationSearchResults) conversationSearchResults.hidden = true;
        startTranscriptReplacement(message.transcript || {});
      } else if (message?.type === 'replaceChunk') {
        appendMessageBatch(message.messages || [], { followTail: false });
      } else if (message?.type === 'replaceComplete') {
        completeTranscriptReplacement(message.transcript || {});
      } else if (message?.type === 'appendStart') {
        appendTranscriptMetadata(message.transcript || {});
      } else if (message?.type === 'appendComplete') {
        appendTranscriptMetadata(message.transcript || {});
      } else if (message?.type === 'replace') {
        replaceTranscript(message.transcript);
      } else if (message?.type === 'append') {
        appendMessageBatch(message.messages || []);
        if (message.transcript) appendTranscriptMetadata(message.transcript);
      } else if (message?.type === 'error') {
        richQueue.clear();
        state.restoringScroll = false;
        state.pageRequestId = null;
        state.pageStartRequestId = null;
        searchInput.disabled = false;
        updateConversationPagination();
        transcriptRoot.setAttribute('aria-busy', 'false');
        const error = document.createElement('div');
        error.className = 'api-error error-block';
        error.textContent = message.message || 'Unable to read transcript.';
        resizeObserver?.disconnect?.();
        state.mountedArticles.clear();
        transcriptRoot.replaceChildren(error);
      }
    });

    if (state.mode !== 'conversation') {
      if (conversationPagination) conversationPagination.hidden = true;
      if (conversationSearchResults) conversationSearchResults.hidden = true;
    }

    vscode.postMessage({ type: 'ready' });
  }

  return Object.freeze({
    PIPE_SENTINEL,
    LANGUAGE_ALIASES,
    candidateAt,
    createMarkdownEngine,
    createMathExtensions,
    escapeHtml,
    formulaSignals,
    guardMathPipes,
    looksLikeMath,
    messageFacets,
    messageSearchText,
    parseMarkdown,
    createHeightIndex,
    createMessageRecord,
    recordSearchText,
    recordMatches,
    start,
    wholeMathCandidate,
    VIRTUAL_ESTIMATED_MESSAGE_HEIGHT,
    VIRTUAL_HEIGHT_BLOCK_SIZE,
    VIRTUAL_WINDOW_MESSAGES,
    VIRTUAL_WINDOW_OVERSCAN,
    VIRTUAL_MAX_MESSAGES,
    MAX_HIGHLIGHT_LENGTH,
  });
});
