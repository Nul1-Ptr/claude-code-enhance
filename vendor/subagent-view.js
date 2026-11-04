(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__CLAUDE_ENHANCE_SUBAGENT_VIEW__ = api;
  if (root?.document) api.start(root);
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  const PIPE_SENTINEL = '\uE000';
  const MAX_FORMULA_LENGTH = 100000;
  const MAX_HIGHLIGHT_LENGTH = 500 * 1024;
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

  function findClosingDelimiter(source, start, close, allowNewline) {
    for (let cursor = start; cursor <= source.length - close.length; cursor++) {
      if (!allowNewline && (source[cursor] === '\n' || source[cursor] === '\r')) return -1;
      if (!source.startsWith(close, cursor) || isEscaped(source, cursor)) continue;
      if (close === '$' && (source[cursor + 1] === '$' || source[cursor - 1] === '$')) continue;
      return cursor;
    }
    return -1;
  }

  function delimitedCandidate(source, open, close, display, allowNewline) {
    if (!source.startsWith(open)) return null;
    if (open === '$' && source.startsWith('$$')) return null;
    if (isEscaped(source, 0)) return null;
    const end = findClosingDelimiter(source, open.length, close, allowNewline);
    if (end === -1) return null;
    const formula = source.slice(open.length, end).replaceAll(PIPE_SENTINEL, '|');
    if (!formula.trim() || formula.length > MAX_FORMULA_LENGTH) return null;
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
    const { source, commands, operators, words } = formulaSignals(formula);
    if (!source || source.length > MAX_FORMULA_LENGTH || /https?:\/\//i.test(source)) return false;
    if (display) return true;
    if (/^[A-Za-z]$/.test(source) || /^[A-Za-z][A-Za-z0-9]{0,2}$/.test(source)) return true;
    if (/^[\p{L}\p{N}]+$/u.test(source) && source.length > 3) return false;
    if (/^\d+(?:[.,]\d+)?$/.test(source)) return false;
    if (commands || operators) return true;
    if (/\b(?:and|are|for|from|into|is|of|or|the|to|with)\b/i.test(source)) return false;
    if (/^\d[\d.,]*\s+[A-Za-z]/.test(source)) return false;
    if (words.length > 2) return false;
    return /[\p{L}\p{N}]/u.test(source) && !/\s{2,}/.test(source);
  }

  function candidateAt(source) {
    return delimitedCandidate(source, '$$', '$$', true, true) ||
      delimitedCandidate(source, '\\[', '\\]', true, true) ||
      delimitedCandidate(source, '\\(', '\\)', false, true) ||
      delimitedCandidate(source, '$', '$', false, false);
  }

  function guardMathPipes(markdown) {
    const source = String(markdown || '');
    let output = '';
    let cursor = 0;
    while (cursor < source.length) {
      if (source[cursor] === '`' && !isEscaped(source, cursor)) {
        let tickCount = 1;
        while (source[cursor + tickCount] === '`') tickCount++;
        const fence = '`'.repeat(tickCount);
        const end = source.indexOf(fence, cursor + tickCount);
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
      const candidate = candidateAt(source.slice(cursor));
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

  function blockMathToken(source) {
    const indent = /^( {0,3})/.exec(source)?.[1] || '';
    const candidate = candidateAt(source.slice(indent.length));
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
          return blockMathToken(source);
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
          const candidate = candidateAt(source);
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
    engine.use({
      extensions: createMathExtensions(),
      renderer: {
        html(token) {
          return escapeHtml(token.raw).replaceAll(PIPE_SENTINEL, '|');
        },
      },
    });
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
    const transcriptRoot = document.getElementById('transcript');
    const summaryRoot = document.getElementById('summary');
    const searchInput = document.getElementById('search');
    const statusRoot = document.getElementById('status');
    const latestButton = document.getElementById('latest');
    const filterButtons = Array.from(document.querySelectorAll('[data-filter]'));
    const persistedState = typeof vscode.getState === 'function' ? (vscode.getState() || {}) : {};
    const persistedFilter = filterButtons.some((button) => button.dataset.filter === persistedState.filter)
      ? persistedState.filter
      : 'all';
    const state = {
      transcript: null,
      messages: [],
      records: [],
      filteredRecords: [],
      filter: persistedFilter,
      query: typeof persistedState.query === 'string' ? persistedState.query : '',
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
    };
    state.heightIndex = createHeightIndex([], state.heightCache);
    let restoreScrollY = Number.isFinite(persistedState.scrollY) ? persistedState.scrollY : null;
    searchInput.value = state.query;
    for (const button of filterButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
    }

    function persistUiState() {
      if (typeof vscode.setState !== 'function') return;
      vscode.setState({
        filter: state.filter,
        query: state.query,
        scrollY: windowObject.scrollY,
        filePath: state.transcript?.filePath || null,
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
      const displayMode = candidate?.display ?? element.dataset.display === 'true';
      const formula = candidate?.formula ?? element.textContent.replaceAll(PIPE_SENTINEL, '|');
      if (!looksLikeMath(formula, displayMode) || !windowObject.katex?.renderToString) return false;
      try {
        element.innerHTML = windowObject.katex.renderToString(formula, {
          displayMode,
          output: 'htmlAndMathml',
          strict: 'ignore',
          throwOnError: true,
          trust: false,
          maxExpand: 1000,
          maxSize: 50,
        });
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
        const candidate = wholeMathCandidate(code.textContent);
        if (!candidate) continue;
        const replacement = document.createElement(candidate.display ? 'div' : 'span');
        replacement.className = 'ce-math-source ce-math-code';
        replacement.textContent = candidate.formula;
        replacement.dataset.display = String(candidate.display);
        code.replaceWith(replacement);
        renderMathElement(replacement, candidate);
      }
    }

    function highlightCode(root) {
      for (const code of root.querySelectorAll('pre code')) {
        const raw = code.textContent;
        const className = Array.from(code.classList).find((name) => name.startsWith('language-'));
        const requested = className ? className.slice('language-'.length).toLowerCase() : '';
        const language = LANGUAGE_ALIASES[requested] || requested;
        if (raw.length <= MAX_HIGHLIGHT_LENGTH && language && windowObject.hljs?.getLanguage?.(language)) {
          try {
            code.innerHTML = windowObject.hljs.highlight(raw, {
              language,
              ignoreIllegals: true,
            }).value;
            code.classList.add('hljs');
          } catch {
            code.textContent = raw;
          }
        } else if (raw.length > MAX_HIGHLIGHT_LENGTH) {
          code.dataset.highlightSkipped = 'oversized';
        }
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
      for (const source of root.querySelectorAll('.ce-math-source')) renderMathElement(source);
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

    function markdownFragment(source) {
      const fragment = sanitizeMarkdownHtml(parseMarkdown(markdown, source));
      finishRichContent(fragment);
      return fragment;
    }

    function codeShell(text, language) {
      const shell = document.createElement('div');
      shell.className = 'tool-code';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (language) code.className = `language-${language}`;
      code.textContent = text || '';
      pre.appendChild(code);
      shell.appendChild(pre);
      highlightCode(shell);
      return shell;
    }

    function blockElement(block) {
      if (block.kind === 'text') {
        const content = document.createElement('div');
        content.className = 'markdown-content';
        content.appendChild(markdownFragment(block.text));
        return content;
      }
      if (block.kind === 'thinking') {
        const details = document.createElement('details');
        details.className = 'thinking-block';
        const summary = document.createElement('summary');
        summary.textContent = 'Thinking';
        details.appendChild(summary);
        const content = document.createElement('div');
        content.className = 'markdown-content detail-content';
        content.appendChild(markdownFragment(block.text));
        details.appendChild(content);
        return details;
      }
      if (block.kind === 'tool') {
        const details = document.createElement('details');
        details.className = 'tool-block';
        const summary = document.createElement('summary');
        summary.textContent = block.name || 'Tool call';
        details.appendChild(summary);
        details.appendChild(codeShell(block.text, 'json'));
        return details;
      }
      if (block.kind === 'tool-result') {
        const details = document.createElement('details');
        details.className = block.isError ? 'tool-result error-block' : 'tool-result';
        details.open = String(block.text || '').length <= 2400 || block.isError;
        const summary = document.createElement('summary');
        summary.textContent = block.isError ? 'Tool error' : 'Tool result';
        details.appendChild(summary);
        details.appendChild(codeShell(block.text, ''));
        return details;
      }
      if (block.kind === 'api-error') {
        const error = document.createElement('div');
        error.className = 'api-error error-block';
        const title = document.createElement('strong');
        title.textContent = 'API error';
        const source = document.createElement('pre');
        source.textContent = block.text || '';
        error.append(title, source);
        return error;
      }
      const attachment = document.createElement('div');
      attachment.className = 'attachment-block';
      attachment.textContent = block.text || 'Attachment';
      return attachment;
    }

    function roleLabel(message) {
      if (message.role === 'assistant') return message.agentType || 'Sub-agent';
      if (message.role === 'tool-result') return 'Tool';
      if (message.role === 'user') return 'Prompt';
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
      article.appendChild(header);
      for (const block of message.blocks) article.appendChild(blockElement(block));
      return article;
    }

    const resizeObserver = typeof windowObject.ResizeObserver === 'function'
      ? new windowObject.ResizeObserver(() => scheduleMeasureRenderedMessages())
      : null;

    function createVirtualSpacer(edge, height) {
      const spacer = document.createElement('div');
      spacer.className = 'virtual-spacer';
      spacer.dataset.virtualSpacer = edge;
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.height = `${Math.max(0, Math.round(height))}px`;
      return spacer;
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
      resizeObserver?.disconnect?.();
      const previousArticles = state.mountedArticles;
      const nextArticles = new Map();
      transcriptRoot.replaceChildren();

      if (!state.filteredRecords.length) {
        state.mountedArticles = nextArticles;
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = state.messages.length
          ? 'No messages match the current search and filter.'
          : 'No renderable messages in this transcript.';
        transcriptRoot.appendChild(empty);
        return;
      }

      const fragment = document.createDocumentFragment();
      const topHeight = state.heightIndex.sum(0, range.start);
      if (topHeight > 0) fragment.appendChild(createVirtualSpacer('top', topHeight));
      for (let index = range.start; index < range.end; index++) {
        const record = state.filteredRecords[index];
        const article = previousArticles.get(record.key) || renderMessage(record.message);
        article.dataset.virtualIndex = String(index);
        article.dataset.messageKey = record.key;
        nextArticles.set(record.key, article);
        fragment.appendChild(article);
      }
      const bottomHeight = state.heightIndex.sum(range.end, state.filteredRecords.length);
      if (bottomHeight > 0) fragment.appendChild(createVirtualSpacer('bottom', bottomHeight));
      transcriptRoot.appendChild(fragment);
      state.mountedArticles = nextArticles;
      for (const article of transcriptRoot.querySelectorAll('.message[data-virtual-index]')) {
        resizeObserver?.observe?.(article);
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
        timeRemaining: () => 8,
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
        let processed = 0;
        while (index < state.records.length &&
            (processed < 400 || deadline.timeRemaining() > 2)) {
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
      title.textContent = descriptor.label || `agent-${descriptor.agentId || ''}`;
      const raw = document.createElement('button');
      raw.type = 'button';
      raw.textContent = 'Open JSONL';
      raw.addEventListener('click', () => vscode.postMessage({ type: 'openRaw' }));
      heading.append(title, raw);
      const metadata = document.createElement('p');
      const malformed = transcript.malformedLines ? ` | ${transcript.malformedLines} malformed` : '';
      const partial = transcript.partialLine ? ' | receiving data' : '';
      metadata.textContent = `${descriptor.agentType || descriptor.agentId || 'sub-agent'} | ` +
        `${state.messages.length} messages | ${transcript.lines || 0} JSONL lines | ` +
        `${formatBytes(transcript.bytes)} | ${descriptor.status || 'idle'}${malformed}${partial}`;
      summaryRoot.append(heading, metadata);
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    function startTranscriptReplacement(transcript) {
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
        persistUiState();
        state.followingTail = false;
        state.tailRequested = false;
        rebuildFilteredRecords({ resetScroll: true });
      }, 100);
    });
    for (const button of filterButtons) {
      button.addEventListener('click', () => {
        state.filter = button.dataset.filter;
        for (const candidate of filterButtons) {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        }
        persistUiState();
        state.followingTail = false;
        state.tailRequested = false;
        rebuildFilteredRecords({ resetScroll: true });
      });
    }
    latestButton.addEventListener('click', () => {
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

    windowObject.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'replaceStart') {
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
        state.restoringScroll = false;
        transcriptRoot.setAttribute('aria-busy', 'false');
        const error = document.createElement('div');
        error.className = 'api-error error-block';
        error.textContent = message.message || 'Unable to read transcript.';
        transcriptRoot.replaceChildren(error);
      }
    });

    vscode.postMessage({ type: 'ready' });
  }

  return Object.freeze({
    PIPE_SENTINEL,
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
