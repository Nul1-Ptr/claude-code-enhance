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
      filter: persistedFilter,
      query: typeof persistedState.query === 'string' ? persistedState.query : '',
    };
    let restoreScrollY = Number.isFinite(persistedState.scrollY) ? persistedState.scrollY : null;
    searchInput.value = state.query;
    for (const button of filterButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
    }

    function persistUiState() {
      if (typeof vscode.setState !== 'function') return;
      vscode.setState({ filter: state.filter, query: state.query, scrollY: windowObject.scrollY });
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
        if (language && windowObject.hljs?.getLanguage?.(language)) {
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
            await windowObject.navigator.clipboard.writeText(raw);
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
      article.dataset.facets = [
        message.role === 'assistant' ? 'assistant' : '',
        message.blocks.some((block) => block.kind === 'thinking') ? 'thinking' : '',
        message.blocks.some((block) => ['tool', 'tool-result'].includes(block.kind)) ? 'tools' : '',
        message.error || message.blocks.some((block) => block.isError || block.kind === 'api-error') ? 'errors' : '',
      ].filter(Boolean).join(' ');
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
        `${transcript.messages?.length ?? state.messages.length} messages | ${transcript.lines} JSONL lines | ` +
        `${formatBytes(transcript.bytes)} | ${descriptor.status || 'idle'}${malformed}${partial}`;
      summaryRoot.append(heading, metadata);
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    function applyFilters() {
      const query = state.query.toLocaleLowerCase();
      let shown = 0;
      for (const article of transcriptRoot.querySelectorAll('.message')) {
        const filterMatch = state.filter === 'all' || article.dataset.facets.split(' ').includes(state.filter);
        const searchMatch = !query || article.textContent.toLocaleLowerCase().includes(query);
        article.hidden = !(filterMatch && searchMatch);
        if (!article.hidden) shown++;
      }
      statusRoot.textContent = query || state.filter !== 'all' ? `${shown} messages shown` : '';
    }

    function replaceTranscript(transcript) {
      state.transcript = transcript;
      state.messages = transcript.messages || [];
      transcriptRoot.replaceChildren();
      const fragment = document.createDocumentFragment();
      for (const message of state.messages) fragment.appendChild(renderMessage(message));
      transcriptRoot.appendChild(fragment);
      transcriptRoot.setAttribute('aria-busy', 'false');
      if (!state.messages.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No renderable messages in this transcript.';
        transcriptRoot.appendChild(empty);
      }
      renderSummary();
      applyFilters();
      if (restoreScrollY !== null) {
        const scrollY = restoreScrollY;
        restoreScrollY = null;
        windowObject.requestAnimationFrame(() => windowObject.scrollTo(0, scrollY));
      }
    }

    function appendTranscript(metadata, messages) {
      const nearBottom = document.documentElement.scrollHeight -
        (windowObject.scrollY + windowObject.innerHeight) < 180;
      state.messages.push(...messages);
      state.transcript = {
        ...state.transcript,
        ...metadata,
        descriptor: { ...state.transcript?.descriptor, ...metadata.descriptor },
        messages: state.messages,
      };
      const fragment = document.createDocumentFragment();
      for (const message of messages) fragment.appendChild(renderMessage(message));
      transcriptRoot.appendChild(fragment);
      renderSummary();
      applyFilters();
      if (nearBottom) windowObject.requestAnimationFrame(() => windowObject.scrollTo(0, document.body.scrollHeight));
    }

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      windowObject.clearTimeout(searchTimer);
      searchTimer = windowObject.setTimeout(() => {
        state.query = searchInput.value.trim();
        persistUiState();
        applyFilters();
      }, 100);
    });
    for (const button of filterButtons) {
      button.addEventListener('click', () => {
        state.filter = button.dataset.filter;
        for (const candidate of filterButtons) {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        }
        persistUiState();
        applyFilters();
      });
    }
    latestButton.addEventListener('click', () => windowObject.scrollTo({
      top: document.body.scrollHeight,
      behavior: 'smooth',
    }));
    let scrollTimer = null;
    windowObject.addEventListener('scroll', () => {
      windowObject.clearTimeout(scrollTimer);
      scrollTimer = windowObject.setTimeout(persistUiState, 150);
    }, { passive: true });

    windowObject.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'replace') {
        replaceTranscript(message.transcript);
      } else if (message?.type === 'append') {
        appendTranscript(message.transcript || {}, message.messages || []);
      } else if (message?.type === 'error') {
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
    parseMarkdown,
    start,
    wholeMathCandidate,
  });
});
