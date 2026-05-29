/**
 * Claude Code UI 增强脚本 v10
 * 功能: 滚轮缩放, 字体, 表格, LaTeX, 换行, 代码高亮, AI对话复制
 */

(function() {
  'use strict';

  console.log('[Claude Enhance] Loading...');

  // 注入样式
  function injectStyles() {
    const styleId = 'claude-enhance-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      :root {
        --ce-fg: var(--vscode-editor-foreground, #d4d4d4);
        --ce-bg: var(--vscode-editor-background, #1e1e1e);
        --ce-panel: var(--vscode-editorWidget-background, var(--vscode-input-background, rgba(127, 127, 127, 0.10)));
        --ce-code-bg: var(--vscode-textCodeBlock-background, var(--vscode-input-background, rgba(127, 127, 127, 0.12)));
        --ce-code-fg: var(--vscode-textPreformat-foreground, var(--ce-fg));
        --ce-border: var(--vscode-widget-border, var(--vscode-input-border, rgba(127, 127, 127, 0.32)));
        --ce-muted: var(--vscode-descriptionForeground, var(--ce-fg));
        --ce-hover: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.16));
        --ce-shadow: rgba(0, 0, 0, 0.18);
        --ce-success: var(--vscode-testing-iconPassed, var(--vscode-terminal-ansiGreen, #2ea043));
        /* One Dark inspired syntax palette. */
        --ce-syntax-fg: #abb2bf;
        --ce-syntax-keyword: #c678dd;
        --ce-syntax-type: #e5c07b;
        --ce-syntax-string: #98c379;
        --ce-syntax-number: #d19a66;
        --ce-syntax-comment: #7f848e;
        --ce-syntax-attr: #61afef;
        --ce-syntax-variable: #e06c75;
        --ce-syntax-title: #61afef;
        --ce-syntax-meta: #56b6c2;
        --ce-syntax-tag: #e06c75;
        --ce-syntax-regexp: #56b6c2;
        --ce-syntax-addition: #98c379;
        --ce-syntax-deletion: #e06c75;
        --ce-markdown-text: #c8d3f5;
        --ce-inline-code-fg: var(--ce-syntax-string);
      }

      :is(body.vscode-light, html.vscode-light) {
        --ce-shadow: rgba(0, 0, 0, 0.10);
        /* One Light inspired syntax palette. */
        --ce-syntax-fg: #383a42;
        --ce-syntax-keyword: #a626a4;
        --ce-syntax-type: #c18401;
        --ce-syntax-string: #50a14f;
        --ce-syntax-number: #986801;
        --ce-syntax-comment: #7c7f85;
        --ce-syntax-attr: #4078f2;
        --ce-syntax-variable: #e45649;
        --ce-syntax-title: #4078f2;
        --ce-syntax-meta: #0184bc;
        --ce-syntax-tag: #e45649;
        --ce-syntax-regexp: #0184bc;
        --ce-syntax-addition: #50a14f;
        --ce-syntax-deletion: #e45649;
        --ce-markdown-text: #34516d;
        --ce-inline-code-fg: var(--ce-syntax-string);
      }

      body.vscode-high-contrast,
      body.vscode-high-contrast-light {
        --ce-border: var(--vscode-contrastBorder, var(--vscode-input-border, currentColor));
        --ce-shadow: transparent;
        --ce-syntax-fg: var(--vscode-editor-foreground, currentColor);
        --ce-syntax-comment: var(--vscode-descriptionForeground, var(--vscode-editor-foreground, currentColor));
        --ce-markdown-text: var(--vscode-editor-foreground, currentColor);
      }

      /* Monospace baseline */
      .claude-enhance-root code,
      .claude-enhance-root pre code,
      .claude-enhance-root .hljs {
        font-family: 'JetBrains Mono NL', 'LXGW WenKai GB Screen R', 'Consolas',
          'Monaco', 'Ubuntu Mono', 'Source Code Pro', 'Fira Code', 'DejaVu Sans Mono',
          'Courier New', monospace !important;
      }

      /* Inline code (keep blocks untouched via overrides below) */
      .claude-enhance-root code {
        font-size: 0.92em;
        padding: 0.15em 0.4em;
        border-radius: 6px;
        border: 1px solid var(--ce-border);
        background: var(--ce-code-bg);
        color: var(--ce-inline-code-fg);
        box-shadow: 0 1px 2px var(--ce-shadow);
      }
      .claude-enhance-root pre code,
      .claude-enhance-root code.hljs {
        padding: 0 !important;
        border: none !important;
        background: transparent !important;
        font-size: inherit;
        color: inherit;
        box-shadow: none;
      }

      /* Code block layout */
      .claude-enhance-root pre {
        white-space: pre-wrap !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
        max-width: 100% !important;
        padding: 16px 20px !important;
        border-radius: 12px !important;
        border: 1px solid var(--ce-border) !important;
        background: var(--ce-code-bg) !important;
        color: var(--ce-fg) !important;
        box-shadow: 0 2px 8px var(--ce-shadow) !important;
        line-height: 1.6;
        position: relative;
      }
      .claude-enhance-root pre code {
        white-space: pre-wrap !important;
        word-break: break-word !important;
        line-height: inherit;
      }
      .claude-enhance-root pre[data-ce-language]::before {
        content: attr(data-ce-language);
        position: absolute;
        top: 6px;
        left: 10px;
        color: var(--ce-muted);
        font-size: 11px;
        line-height: 1;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        pointer-events: none;
        user-select: none;
      }
      .claude-code-copy-btn {
        position: absolute;
        top: 6px;
        right: 8px;
        z-index: 2;
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid var(--ce-border);
        background: var(--vscode-button-secondaryBackground, var(--vscode-button-background, var(--ce-panel)));
        color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground, var(--ce-fg)));
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
        opacity: 0.68;
        transition: opacity 0.16s ease, background 0.16s ease, transform 0.16s ease;
      }
      .claude-enhance-root pre:hover .claude-code-copy-btn,
      .claude-code-copy-btn:focus-visible {
        opacity: 1;
      }
      .claude-code-copy-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground, var(--ce-hover)));
        transform: translateY(-1px);
      }
      .claude-code-copy-btn.copied {
        background: var(--ce-success);
        color: var(--vscode-button-foreground, var(--ce-bg));
        border-color: var(--ce-success);
        opacity: 1;
      }

      /* Common Highlight.js palette. Overrides the bundled theme with theme-aware colors. */
      .claude-enhance-root pre code.hljs,
      .claude-enhance-root pre .hljs {
        color: var(--ce-syntax-fg) !important;
      }
      .claude-enhance-root pre[data-ce-language="markdown"] code.hljs,
      .claude-enhance-root pre[data-ce-language="markdown"] .hljs {
        color: var(--ce-markdown-text) !important;
      }
      .claude-enhance-root .hljs-keyword,
      .claude-enhance-root .hljs-literal,
      .claude-enhance-root .hljs-name,
      .claude-enhance-root .hljs-selector-tag,
      .claude-enhance-root .hljs-symbol,
      .claude-enhance-root .hljs-doctag {
        color: var(--ce-syntax-keyword) !important;
      }
      .claude-enhance-root .hljs-built_in,
      .claude-enhance-root .hljs-type,
      .claude-enhance-root .hljs-class,
      .claude-enhance-root .hljs-selector-class,
      .claude-enhance-root .hljs-selector-id {
        color: var(--ce-syntax-type) !important;
      }
      .claude-enhance-root .hljs-string,
      .claude-enhance-root .hljs-meta .hljs-string,
      .claude-enhance-root .hljs-template-tag {
        color: var(--ce-syntax-string) !important;
      }
      .claude-enhance-root .hljs-number,
      .claude-enhance-root .hljs-bullet {
        color: var(--ce-syntax-number) !important;
      }
      .claude-enhance-root .hljs-comment,
      .claude-enhance-root .hljs-quote {
        color: var(--ce-syntax-comment) !important;
      }
      .claude-enhance-root .hljs-attr,
      .claude-enhance-root .hljs-attribute,
      .claude-enhance-root .hljs-property,
      .claude-enhance-root .hljs-selector-attr {
        color: var(--ce-syntax-attr) !important;
      }
      .claude-enhance-root .hljs-variable,
      .claude-enhance-root .hljs-template-variable,
      .claude-enhance-root .hljs-params {
        color: var(--ce-syntax-variable) !important;
      }
      .claude-enhance-root .hljs-title,
      .claude-enhance-root .hljs-title.function_,
      .claude-enhance-root .hljs-title.class_,
      .claude-enhance-root .hljs-function,
      .claude-enhance-root .hljs-section {
        color: var(--ce-syntax-title) !important;
      }
      .claude-enhance-root .hljs-meta,
      .claude-enhance-root .hljs-tag,
      .claude-enhance-root .hljs-operator,
      .claude-enhance-root .hljs-punctuation {
        color: var(--ce-syntax-meta) !important;
      }
      .claude-enhance-root .hljs-regexp,
      .claude-enhance-root .hljs-link,
      .claude-enhance-root .hljs-selector-pseudo {
        color: var(--ce-syntax-regexp) !important;
      }
      .claude-enhance-root .hljs-subst,
      .claude-enhance-root .hljs-formula {
        color: var(--ce-syntax-fg) !important;
      }
      .claude-enhance-root .hljs-addition {
        color: var(--ce-syntax-addition) !important;
        background: transparent !important;
      }
      .claude-enhance-root .hljs-deletion {
        color: var(--ce-syntax-deletion) !important;
        background: transparent !important;
      }
      .claude-enhance-root .hljs-emphasis {
        font-style: italic;
      }
      .claude-enhance-root .hljs-strong {
        font-weight: 700;
      }
      .claude-enhance-root pre[data-ce-language="markdown"] .hljs-section {
        color: var(--ce-syntax-title) !important;
      }
      .claude-enhance-root pre[data-ce-language="markdown"] .hljs-strong {
        color: var(--ce-markdown-text) !important;
      }
      .claude-enhance-root pre[data-ce-language="markdown"] .hljs-emphasis {
        color: var(--ce-markdown-text) !important;
      }
      .claude-enhance-root pre[data-ce-language="markdown"] .hljs-code {
        color: var(--ce-syntax-string) !important;
      }
      .claude-enhance-root pre[data-ce-language="markdown"] .hljs-link {
        color: var(--ce-syntax-regexp) !important;
      }
      .claude-enhance-root pre[data-ce-language="markdown"] .hljs-bullet {
        color: var(--ce-syntax-number) !important;
      }

      /* Keep prompt/editable text readable across VS Code themes. */
      input:not([type="checkbox"]):not([type="radio"]),
      textarea {
        color: var(--vscode-input-foreground, var(--vscode-editor-foreground, #e6edf3)) !important;
        -webkit-text-fill-color: var(--vscode-input-foreground, var(--vscode-editor-foreground, #e6edf3)) !important;
        caret-color: var(--vscode-editorCursor-foreground, #aeafad) !important;
      }
      input::placeholder,
      textarea::placeholder {
        color: var(--vscode-input-placeholderForeground, rgba(255, 255, 255, 0.45)) !important;
        -webkit-text-fill-color: var(--vscode-input-placeholderForeground, rgba(255, 255, 255, 0.45)) !important;
      }

      /* Claude's chat composer can use rich-editor internals with pre/code
         measurement layers. Never apply preview/code-block layout there. */
      [contenteditable="true"],
      [role="textbox"] {
        caret-color: var(--vscode-editorCursor-foreground, #aeafad) !important;
      }
      [contenteditable="true"] pre,
      [contenteditable="true"] code,
      [role="textbox"] pre,
      [role="textbox"] code {
        white-space: pre !important;
        word-wrap: normal !important;
        overflow-wrap: normal !important;
        word-break: normal !important;
        max-width: none !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        line-height: inherit !important;
        position: static !important;
      }

      /* KaTeX: inline + display */
      .claude-enhance-root .katex {
        font-size: 1.1em;
        line-height: 1.35;
        color: var(--ce-fg);
      }
      .claude-enhance-root .katex-error {
        color: var(--ce-fg) !important;
      }
      .claude-enhance-root .katex-display {
        margin: 1.2em 0;
        overflow-x: auto;
        padding: 18px 22px;
        border-radius: 12px;
        border: 1px solid var(--ce-border);
        background: var(--ce-panel);
        box-shadow: 0 2px 10px var(--ce-shadow);
        position: relative;
        -webkit-overflow-scrolling: touch;
        scrollbar-gutter: stable both-edges;
      }
      .claude-enhance-root .katex-display > .katex {
        display: inline-block;
        padding: 0;
      }

      /* Scrollbar polish (WebKit + Firefox) */
      .claude-enhance-root pre,
      .claude-enhance-root .katex-display,
      .claude-enhance-root table {
        scrollbar-width: thin;
        scrollbar-color: var(--ce-border) transparent;
      }
      .claude-enhance-root pre::-webkit-scrollbar,
      .claude-enhance-root .katex-display::-webkit-scrollbar,
      .claude-enhance-root table::-webkit-scrollbar {
        height: 10px;
        width: 10px;
      }
      .claude-enhance-root pre::-webkit-scrollbar-thumb,
      .claude-enhance-root .katex-display::-webkit-scrollbar-thumb,
      .claude-enhance-root table::-webkit-scrollbar-thumb {
        background: var(--ce-border);
        border-radius: 999px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      .claude-enhance-root pre::-webkit-scrollbar-thumb:hover,
      .claude-enhance-root .katex-display::-webkit-scrollbar-thumb:hover,
      .claude-enhance-root table::-webkit-scrollbar-thumb:hover {
        background: var(--ce-muted);
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      .claude-enhance-root pre::-webkit-scrollbar-track,
      .claude-enhance-root .katex-display::-webkit-scrollbar-track,
      .claude-enhance-root table::-webkit-scrollbar-track {
        background: transparent;
      }

      /* Lists: fix clipped markers + comfortable spacing */
      .claude-enhance-root ol,
      .claude-enhance-root ul {
        padding-left: 2em !important;
        list-style-position: outside !important;
        margin: 0.65em 0 0.9em;
      }
      .claude-enhance-root ol {
        list-style-type: decimal !important;
      }
      .claude-enhance-root li {
        margin: 0.25em 0;
      }
      .claude-enhance-root li > p {
        margin: 0.25em 0;
      }

      /* Tables: theme-aware, improved readability, allow horizontal scroll */
      .claude-enhance-root table {
        display: table;
        table-layout: auto;
        word-break: break-word;
        /* Remove block/overflow to let table scale natively */
        border-collapse: separate;
        border-spacing: 0;
        width: 100%;
        margin: 1.5em 0;
        font-size: 0.95em;
        line-height: 1.5;
        color: var(--ce-fg);
        border-radius: 12px;
        border: 1px solid var(--ce-border);
        background: var(--ce-panel);
        box-shadow: 0 2px 10px var(--ce-shadow);
      }
      .claude-enhance-root table thead {
        background: var(--ce-hover);
      }
      .claude-enhance-root table th,
      .claude-enhance-root table td {
        padding: 12px 16px;
        text-align: left;
        vertical-align: middle;
        border-right: 1px solid var(--ce-border);
        border-bottom: 1px solid var(--ce-border);
        white-space: normal;
        min-width: 80px;
      }
      .claude-enhance-root table th {
        font-weight: 600;
        color: var(--ce-fg);
        letter-spacing: 0.02em;
      }
      .claude-enhance-root table tbody tr:nth-child(even) {
        background-color: color-mix(in srgb, var(--ce-hover) 45%, transparent);
      }
      .claude-enhance-root table tbody tr {
        transition: background-color 0.15s ease, transform 0.15s ease;
      }
      .claude-enhance-root table tbody tr:hover {
        background-color: var(--ce-hover);
      }
      .claude-enhance-root table tr > *:last-child {
        border-right: none;
      }
      .claude-enhance-root table tbody tr:last-child td {
        border-bottom: none;
      }
      .claude-enhance-root table td code {
        background: var(--ce-code-bg);
        border: 1px solid var(--ce-border);
      }

      /* Copy button */
      .claude-copy-btn {
        position: absolute;
        bottom: 8px;
        right: 8px;
        background: var(--vscode-button-secondaryBackground, var(--vscode-button-background, var(--ce-panel)));
        border: 1px solid var(--ce-border);
        border-radius: 10px;
        color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground, var(--ce-fg)));
        padding: 6px 10px;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
        opacity: 0;
        transform: translateY(2px);
        transition: opacity 0.18s ease, background 0.18s ease, transform 0.18s ease;
        z-index: 100;
        user-select: none;
      }
      .claude-copy-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground, var(--ce-hover)));
        color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground, var(--ce-fg)));
        transform: translateY(0);
      }
      .claude-copy-btn:active {
        transform: translateY(1px);
      }
      .claude-copy-btn.copied {
        background: var(--ce-success);
        color: var(--vscode-button-foreground, var(--ce-bg));
        border-color: var(--ce-success);
        opacity: 1;
      }
      [class*="timelineMessage"]:hover .claude-copy-btn {
        opacity: 1;
      }
      [class*="timelineMessage"] {
        position: relative;
      }
    `;
    document.head.appendChild(style);
  }

  // 注入 Highlight.js
  function injectHighlightJS() {
    if (window.hljsLoaded) return;
    // Loaded via extension.js injection
    console.log('[Claude Enhance] Highlight.js already loaded locally');
    window.hljsLoaded = true;
    highlightAllCode();
  }

  // 注入 KaTeX
  function injectKaTeX() {
    if (window.katexLoaded) return;
    // Loaded via extension.js injection
    const checkKatex = () => {
      if (typeof katex !== 'undefined') {
        window.katexLoaded = true;
        console.log('[Claude Enhance] KaTeX ready:', typeof katex);
      } else {
        setTimeout(checkKatex, 100);
      }
    };
    checkKatex();
  }

  const INTERACTIVE_SELECTOR = [
    'button',
    'input',
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[role="button"]'
  ].join(',');

  const USER_MESSAGE_SELECTOR = [
    '[class*="userMessage_"]',
    '[class*="userMessageContainer_"]'
  ].join(',');

  function isInsideInteractiveSurface(el) {
    const node = el?.nodeType === Node.ELEMENT_NODE ? el : el?.parentElement;
    return !!node?.closest(INTERACTIVE_SELECTOR);
  }

  function shouldSkipPreviewEnhancement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    return isInsideInteractiveSurface(el) || !!el.closest(USER_MESSAGE_SELECTOR);
  }

  // 高亮代码块
  function getEnhanceRoots() {
    const selectors = [
      '[class*="messagesContainer_"]',
      '[class*="timelineMessage_"]',
      '[class*="messageContent_"]',
      '[class*="assistantMessage_"]',
      '.rendered-markdown'
    ].join(',');

    const roots = Array.from(document.querySelectorAll(selectors))
      .filter((el) => !el.closest([
        INTERACTIVE_SELECTOR,
        '[class*="header"]',
        '[class*="sessionList"]',
        '[class*="sessionItem"]',
        '[class*="sessionName"]'
      ].join(',')));

    const topLevelRoots = roots.filter((el) => !roots.some((other) => other !== el && other.contains(el)));
    topLevelRoots.forEach((el) => el.classList.add('claude-enhance-root'));
    return topLevelRoots;
  }

  function highlightAllCode() {
    if (typeof hljs === 'undefined') return;

    getEnhanceRoots().forEach((root) => root.querySelectorAll('pre code').forEach((block) => {
      if (shouldSkipPreviewEnhancement(block)) return;
      highlightCodeBlock(block);
      addCodeBlockCopyButton(block);
    }));
  }

  function getCodeLanguage(block) {
    const candidates = [
      block.className || '',
      block.parentElement?.className || '',
      block.getAttribute('data-language') || '',
      block.parentElement?.getAttribute('data-language') || ''
    ].join(' ');
    const match = candidates.match(/(?:^|\s)(?:language|lang)-([A-Za-z0-9_+#.-]+)/);
    if (!match) return '';
    const aliases = {
      js: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      rb: 'ruby',
      sh: 'bash',
      shell: 'bash',
      zsh: 'bash',
      yml: 'yaml',
      md: 'markdown',
      tex: 'latex'
    };
    const language = match[1].toLowerCase();
    return aliases[language] || language;
  }

  function getCodeFingerprint(text) {
    return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
  }

  function markCodeBlockPlain(block, text, language) {
    block.textContent = text;
    block.classList.add('hljs');
    block.dataset.ceHighlighted = getCodeFingerprint(text);

    if (block.parentElement?.tagName === 'PRE') {
      if (language) {
        block.parentElement.dataset.ceLanguage = language;
      } else {
        delete block.parentElement.dataset.ceLanguage;
      }
    }
  }

  function highlightCodeBlock(block) {
    const text = block.textContent || '';
    if (!text.trim()) return;

    const fingerprint = getCodeFingerprint(text);
    if (block.dataset.ceHighlighted === fingerprint) return;

    const language = getCodeLanguage(block) || 'markdown';
    if (!language || !hljs.getLanguage(language)) {
      markCodeBlockPlain(block, text, language);
      return;
    }

    try {
      const result = hljs.highlight(text, { language, ignoreIllegals: true });

      block.innerHTML = result.value;
      block.classList.add('hljs');
      block.dataset.ceHighlighted = fingerprint;

      if (block.parentElement?.tagName === 'PRE') {
        block.parentElement.dataset.ceLanguage = language;
      }
    } catch {
      markCodeBlockPlain(block, text, language);
    }
  }

  function addCodeBlockCopyButton(block) {
    const pre = block?.parentElement;
    if (!pre || pre.tagName !== 'PRE') return;
    if (pre.querySelector(':scope > .claude-code-copy-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'claude-code-copy-btn';
    btn.textContent = 'Copy';
    btn.title = 'Copy code block';
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(block.textContent || '');
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 1400);
      } catch {
        btn.textContent = 'Failed';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1400);
      }
    });
    pre.appendChild(btn);
  }

  // Make \text{} labels with underscores KaTeX-safe
  function escapeUnderscoresInText(formula) {
    return formula.replace(/\\text\{([^}]*)\}/g, (match, content) => {
      return `\\text{${content.replace(/_/g, '\\_')}}`;
    });
  }

  function normalizeLatexFormula(formula) {
    return escapeUnderscoresInText(formula)
      .replace(/(\\(?:mathbf|mathrm|mathit|mathsf|mathtt|boldsymbol)\{[^{}]+\})\s*\{\\text\{([^{}]+)\}\}/g, '$1_{\\text{$2}}')
      .replace(/((?:\\[a-zA-Z]+\{[^{}]+\})|[A-Za-z])\^(?=([)}_\s,.;]|$))/g, '$1^*')
      .replace(/([A-Za-z0-9}\\]+)\s*\/\|([^|]+)\|/g, '\\frac{$1}{\\lvert $2\\rvert}')
      .replace(/\\ (?=[a-zA-Z0-9_{}])/g, '\\\\ ');
  }

  function looksLikeLatex(text) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.length <= 2 || cleaned.includes('\\') ||
      cleaned.includes('^') || cleaned.includes('{') ||
      /\b(alpha|beta|gamma|delta|theta|lambda|mu|sigma|pi|omega|sum|int|frac|sqrt|nabla|mathbf|text|tilde)\b/i.test(cleaned);
  }

  function containsCjk(text) {
    return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
  }

  function hasMarkdownUnderscoreEmphasis(text) {
    return /(^|[^\w\\])_[^_\n]{2,}_(?=[^\w]|$)/.test(text);
  }

  function isProseHeavyLatex(text, displayMode) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return true;

    const macroCount = (cleaned.match(/\\[a-zA-Z]+/g) || []).length;
    const cjkCount = (cleaned.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const wordCount = (cleaned.match(/[A-Za-z]{3,}/g) || []).length;
    const prosePunctuationCount = (cleaned.match(/[，。；：、]|[.!?]\s+[A-Z]/g) || []).length;

    if (!displayMode && cleaned.length > 240) return true;
    if (cleaned.length > 120 && hasMarkdownUnderscoreEmphasis(cleaned)) return true;
    if (cleaned.length > 120 && cjkCount > 12 && macroCount < 4) return true;
    if (cleaned.length > 180 && cjkCount > 12 && prosePunctuationCount > 1) return true;
    if (cleaned.length > 220 && wordCount > 20 && macroCount < 4) return true;
    return false;
  }

  function isRenderableLatexFormula(text, displayMode) {
    return looksLikeLatex(text) && !isProseHeavyLatex(text, displayMode);
  }

  function renderLatexFragment(fragment, displayMode, fallback) {
    const latex = /<[^>]+>/.test(fragment) ? htmlFragmentToLatex(fragment) : fragment;
    if (!isRenderableLatexFormula(latex, displayMode)) return fallback;
    try {
      return katex.renderToString(normalizeLatexFormula(latex), { displayMode, throwOnError: false });
    } catch {
      return fallback;
    }
  }

  // Render LaTeX
  // Restore LaTeX from Markdown emphasis markup inside math delimiters.
  function htmlFragmentToLatex(html) {
    // Restore markdown emphasis that was converted to HTML tags
    // The tags might be UNPAIRED because markdown can split *...* or _..._ across multiple $$ blocks!
    let processed = html
      .replace(/(.?)(<\/?(?:em|i)\b[^>]*>)/gi, (match, prefix, tag) => {
        if (prefix === '^') return prefix + '*';
        return prefix + '_';
      })
      .replace(/(.?)(<\/?(?:strong|b)\b[^>]*>)/gi, (match, prefix, tag) => {
        if (prefix === '^') return prefix + '**';
        return prefix + '__';
      });

    const tmp = document.createElement('div');
    tmp.innerHTML = processed;
    let out = '';
    let prevWasText = false;
    tmp.childNodes.forEach((node) => {
      const txt = node.textContent || '';
      const isText = node.nodeType === Node.TEXT_NODE;
      // If there was no separator and an element sits between text-like tokens, insert a star operator as fallback
      if (!isText && prevWasText) {
        // Heuristic: insert a literal operator if adjacent tokens look like identifiers.
        if (/\w$/.test(out) && /^\w/.test(txt)) out += '\\ast';
      }
      out += txt;
      prevWasText = /\S$/.test(out) && /\S/.test(txt);
    });
    return out;
  }

  function isEscapedDelimiter(text, index) {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashCount++;
    return slashCount % 2 === 1;
  }

  function findClosingDelimiter(text, start, open, close) {
    for (let i = start + open.length; i <= text.length - close.length; i++) {
      if (text.startsWith(close, i) && !isEscapedDelimiter(text, i)) return i;
    }
    return -1;
  }

  function isLikelyInlineDollarStart(text, index) {
    const next = text[index + 1];
    const prev = text[index - 1];
    if (!next || /\s|\d/.test(next)) return false;
    if (prev && !/\s|[(\[{,;:]/.test(prev)) return false;
    return true;
  }

  function isLikelyInlineDollarEnd(text, index) {
    const prev = text[index - 1];
    return !!prev && !/\s/.test(prev);
  }

  function findMathSpans(text) {
    const spans = [];
    let i = 0;
    while (i < text.length) {
      if (text.startsWith('$$', i) && !isEscapedDelimiter(text, i)) {
        const end = findClosingDelimiter(text, i, '$$', '$$');
        if (end !== -1) {
          const formula = text.slice(i + 2, end);
          if (isRenderableLatexFormula(formula, true)) spans.push({ start: i, end: end + 2, formula, displayMode: true });
          i = end + 2;
          continue;
        }
      }

      if (text[i] === '$' && !isEscapedDelimiter(text, i) && isLikelyInlineDollarStart(text, i)) {
        let end = i + 1;
        while ((end = text.indexOf('$', end)) !== -1) {
          if (!isEscapedDelimiter(text, end) && isLikelyInlineDollarEnd(text, end)) break;
          end++;
        }
        if (end !== -1) {
          const formula = text.slice(i + 1, end).trim();
          if (isRenderableLatexFormula(formula, false)) spans.push({ start: i, end: end + 1, formula, displayMode: false });
          i = end + 1;
          continue;
        }
      }

      if (text.startsWith('\\(', i) && !isEscapedDelimiter(text, i)) {
        const end = findClosingDelimiter(text, i, '\\(', '\\)');
        if (end !== -1) {
          const formula = text.slice(i + 2, end).trim();
          if (isRenderableLatexFormula(formula, false)) spans.push({ start: i, end: end + 2, formula, displayMode: false });
          i = end + 2;
          continue;
        }
      }

      if (text.startsWith('\\[', i) && !isEscapedDelimiter(text, i)) {
        const end = findClosingDelimiter(text, i, '\\[', '\\]');
        if (end !== -1) {
          const formula = text.slice(i + 2, end);
          if (isRenderableLatexFormula(formula, true)) spans.push({ start: i, end: end + 2, formula, displayMode: true });
          i = end + 2;
          continue;
        }
      }

      i++;
    }
    return spans;
  }

  function shouldSkipMathElement(el) {
    return !el || el.nodeType !== 1 ||
      el.closest('.katex') ||
      el.closest(INTERACTIVE_SELECTOR) ||
      ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'BUTTON', 'INPUT', 'TEXTAREA'].includes(el.tagName);
  }

  function markdownMarkerForElement(el) {
    const tag = el.tagName;
    if (tag === 'EM' || tag === 'I') return '_';
    if (tag === 'STRONG' || tag === 'B') return '__';
    return '';
  }

  function markerText(marker, previousChar) {
    if (!marker) return '';
    if (previousChar === '^') return marker.length === 2 ? '**' : '*';
    return marker;
  }

  function linearizeMathContainer(el) {
    const chars = [];
    const refs = [];

    const append = (text, refFactory) => {
      for (let i = 0; i < text.length; i++) {
        chars.push(text[i]);
        refs.push(refFactory ? refFactory(i) : null);
      }
    };

    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        append(node.textContent || '', (i) => ({ node, offset: i }));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || shouldSkipMathElement(node)) return;

      const marker = markdownMarkerForElement(node);
      append(markerText(marker, chars[chars.length - 1]), null);
      Array.from(node.childNodes).forEach(visit);
      append(markerText(marker, chars[chars.length - 1]), null);
    };

    visit(el);
    return { text: chars.join(''), refs };
  }

  function replaceMathRange(span, refs) {
    if (!isRenderableLatexFormula(span.formula, span.displayMode)) return false;

    const startRef = refs[span.start];
    const endRef = refs[span.end - 1];
    if (!startRef || !endRef) return false;

    let html;
    try {
      html = katex.renderToString(normalizeLatexFormula(span.formula), {
        displayMode: span.displayMode,
        throwOnError: false
      });
    } catch {
      return false;
    }

    const range = document.createRange();
    range.setStart(startRef.node, startRef.offset);
    range.setEnd(endRef.node, endRef.offset + 1);

    const wrapper = document.createElement('span');
    wrapper.innerHTML = html;
    const fragment = document.createDocumentFragment();
    while (wrapper.firstChild) fragment.appendChild(wrapper.firstChild);

    range.deleteContents();
    range.insertNode(fragment);
    return true;
  }

  function renderMathRangesInElement(el) {
    if (shouldSkipMathElement(el)) return false;
    const textContent = el.textContent || '';
    if (!textContent.includes('$') && !textContent.includes('\\(') && !textContent.includes('\\[')) return false;

    const { text, refs } = linearizeMathContainer(el);
    const spans = findMathSpans(text);
    if (!spans.length) return false;

    let changed = false;
    spans.reverse().forEach((span) => {
      changed = replaceMathRange(span, refs) || changed;
    });
    return changed;
  }

  // Preprocess rendered Markdown whose inline math was split by emphasis tags.
  function preprocessHTMLMath(root) {
    const selector = [
      'p', 'li', 'td', 'th', 'blockquote',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'div', 'span'
    ].join(',');
    const candidates = [root, ...root.querySelectorAll(selector)]
      .filter((el) => {
        if (shouldSkipMathElement(el)) return false;
        const text = el.textContent || '';
        return text.includes('$') || text.includes('\\(') || text.includes('\\[');
      })
      .sort((a, b) => {
        if (a.contains(b)) return 1;
        if (b.contains(a)) return -1;
        return 0;
      });

    candidates.forEach((el) => {
      try {
        renderMathRangesInElement(el);
      } catch (e) {}
    });
  }

  function repairProseKatexErrors(root) {
    root.querySelectorAll('.katex-error').forEach((el) => {
      const text = el.textContent || '';
      if (!text || !isProseHeavyLatex(text, true)) return;
      el.replaceWith(document.createTextNode(text));
    });
  }

  function shouldSkipRelaxedMarkdownElement(el) {
    return !el || el.nodeType !== 1 ||
      el.closest('.katex') ||
      el.closest(INTERACTIVE_SELECTOR) ||
      ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'BUTTON', 'INPUT', 'TEXTAREA', 'STRONG', 'B'].includes(el.tagName);
  }

  function renderRelaxedBoldInTextNode(textNode) {
    const text = textNode.textContent || '';
    if (!text.includes('**')) return false;

    const re = /\*\*\s*([^*\n](?:[^*]|\*(?!\*))*?)\s*\*\*/g;
    let match;
    let lastIndex = 0;
    let changed = false;
    const fragment = document.createDocumentFragment();

    while ((match = re.exec(text))) {
      const rawContent = match[1];
      const content = rawContent.trim();
      if (!content) continue;

      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      const strong = document.createElement('strong');
      strong.textContent = content;
      fragment.appendChild(strong);
      lastIndex = re.lastIndex;
      changed = true;
    }

    if (!changed) return false;
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.parentNode.replaceChild(fragment, textNode);
    return true;
  }

  function renderRelaxedMarkdownBold(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentNode;
          if (!parent || parent.nodeType !== 1 || shouldSkipRelaxedMarkdownElement(parent)) {
            return NodeFilter.FILTER_REJECT;
          }
          return (node.textContent || '').includes('**')
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );

    const nodes = [];
    let node;
    while (node = walker.nextNode()) nodes.push(node);
    nodes.forEach((textNode) => {
      try {
        renderRelaxedBoldInTextNode(textNode);
      } catch (e) {}
    });
  }

  function renderLaTeX() {
    if (typeof katex === 'undefined') return;
    if (window._claudeRenderingLaTeX) return;
    window._claudeRenderingLaTeX = true;

    try {
      getEnhanceRoots().forEach((root) => {
        repairProseKatexErrors(root);
        renderRelaxedMarkdownBold(root);

        // Preprocess HTML-based math (handles markup inside $$...$$)
        preprocessHTMLMath(root);

        const walker = document.createTreeWalker(
          root,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentNode;
              if (!parent || parent.nodeType !== 1) return NodeFilter.FILTER_REJECT;
              // Skip rendered KaTeX, controls, and session/navigation UI.
              if (parent.classList?.contains('katex') ||
                  parent.closest('.katex') ||
                  parent.closest(INTERACTIVE_SELECTOR) ||
                  parent.closest('[class*="header"]') ||
                  parent.closest('[class*="sessionsList"]') ||
                  parent.closest('[class*="sessionItem"]') ||
                  parent.closest('[class*="sessionName"]') ||
                  ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'BUTTON', 'INPUT', 'TEXTAREA'].includes(parent.tagName)) {
                return NodeFilter.FILTER_REJECT;
              }
              const text = node.textContent;
              if (text && (text.includes('$$') || text.includes('$') || text.includes('\\(') || text.includes('\\['))) {
                return NodeFilter.FILTER_ACCEPT;
              }
              return NodeFilter.FILTER_REJECT;
            }
          }
        );

        const nodesToRender = [];
        let node;
        while (node = walker.nextNode()) {
          nodesToRender.push(node);
        }

        nodesToRender.forEach((textNode) => {
          const text = textNode.textContent;
          if (!text || !text.trim()) return;

          try {
            let resultHTML = text;
            let hasFormula = false;

            // $$...$$ block formulas.
            resultHTML = resultHTML.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
              if (!isRenderableLatexFormula(formula, true)) return match;
              hasFormula = true;
              try {
                let fixed = normalizeLatexFormula(formula);
                fixed = fixed.replace(/\\\s*\n/g, '\\\\\n');
                fixed = fixed.replace(/\\\[(\d+(?:\.\d+)?[a-z]*)\]/gi, '\\\\[$1]');
                fixed = fixed.replace(/&\s*\\\[6pt\]/g, '& \\\\');
                fixed = fixed.replace(/\\(sum|prod|int|lim|inf|sup|max|min)\{([^}]+)\}/g, '\\\\$1_{$2}');
                fixed = fixed.replace(/\\operatorname\{(\w+)\}(\()/g, '\\\\operatorname{$1}$2');
                return katex.renderToString(fixed, { displayMode: true, throwOnError: false });
              } catch {
                return match;
              }
            });

            // \(...\) inline formulas.
            resultHTML = resultHTML.replace(/\\\(([\s\S]+?)\\\)/g, (match, formula) => {
              if (!isRenderableLatexFormula(formula.trim(), false)) return match;
              hasFormula = true;
              try {
                return katex.renderToString(normalizeLatexFormula(formula.trim()), { displayMode: false, throwOnError: false });
              } catch {
                return match;
              }
            });

            // \[...\] block formulas.
            resultHTML = resultHTML.replace(/\\\[([\s\S]+?)\\\]/g, (match, formula) => {
              if (!isRenderableLatexFormula(formula, true)) return match;
              hasFormula = true;
              try {
                return katex.renderToString(normalizeLatexFormula(formula), { displayMode: true, throwOnError: false });
              } catch {
                return match;
              }
            });

            // $...$ inline formulas.
            resultHTML = resultHTML.replace(/\$([\s\S]+?)\$/g, (match, formula) => {
              const content = formula.trim();
              const cleaned = content.replace(/\s+/g, ' ').trim();
              if (!isRenderableLatexFormula(cleaned, false)) return match;
              hasFormula = true;
              try {
                const fixed = normalizeLatexFormula(cleaned);
                return katex.renderToString(fixed, { displayMode: false, throwOnError: false });
              } catch {
                return match;
              }
            });

            if (hasFormula && resultHTML !== text && resultHTML.includes('katex')) {
              const span = document.createElement('span');
              span.innerHTML = resultHTML;
              textNode.parentNode.replaceChild(span, textNode);
            }
          } catch (e) {}
        });

        repairProseKatexErrors(root);
        renderRelaxedMarkdownBold(root);
      });
    } finally {
      window._claudeRenderingLaTeX = false;
    }
  }

  // ========== AI 对话复制功能 ==========

  // 需要排除的类名前缀 (思维链和工具调用)
  const EXCLUDE_PREFIXES = [
    'thinking_',
    'thinkingContent_',
    'thinkingSummary_',
    'toolUse_',
    'toolResult_',
    'toolBody_',
    'toolBodyGrid_',
    'toolBodyRow_',
    'toolSummary_',
    'root_ZUQaOA',
    'userMessage_',
    'userMessageContainer_'
  ];

  // 检查元素是否应该被排除
  function shouldExclude(element) {
    if (!element || !element.className) return false;
    const className = typeof element.className === 'string' ? element.className : '';
    return EXCLUDE_PREFIXES.some(prefix => className.includes(prefix));
  }

  // 从 HTML 元素提取 Markdown 格式内容 (紧凑版)
  function htmlToMarkdown(element) {
    if (!element) return '';

    const IGNORE_TAGS = new Set(['BUTTON', 'STYLE', 'SCRIPT', 'SVG', 'MAT-ICON']);

    function traverse(node, context = {}) {
      // 文本节点
      if (node.nodeType === 3) {
        const text = node.textContent;
        if (context.inPre) return text;
        return text.replace(/\s+/g, ' ');
      }

      // 非元素节点跳过
      if (node.nodeType !== 1) return '';
      if (IGNORE_TAGS.has(node.tagName)) return '';
      if (shouldExclude(node)) return '';

      const tag = node.tagName;
      const children = Array.from(node.childNodes);
      const newContext = {
        ...context,
        inPre: context.inPre || tag === 'PRE',
        inList: context.inList || tag === 'LI',
      };

      // 先递归处理子节点
      const childrenContent = children
        .map(c => traverse(c, newContext))
        .join('');

      // KaTeX 公式处理
      if (tag === 'SPAN' && node.classList?.contains('katex')) {
        const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
        if (annotation) {
          const tex = annotation.textContent;
          // 清理换行和多余空格, 保持单行 (Obsidian 兼容)
          const cleaned = tex.replace(/\s+/g, ' ').trim();
          const isDisplay = node.classList.contains('katex-display');
          return isDisplay ? `$$${cleaned}$$` : `$${cleaned}$`;
        }
      }

      // 根据标签类型返回格式化内容
      switch (tag) {
        case 'H1': return '\n# ' + childrenContent + '\n';
        case 'H2': return '\n## ' + childrenContent + '\n';
        case 'H3': return '\n### ' + childrenContent + '\n';
        case 'H4': return '\n#### ' + childrenContent + '\n';
        case 'H5': return '\n##### ' + childrenContent + '\n';
        case 'H6': return '\n###### ' + childrenContent + '\n';

        case 'P':
          return context.inList ? childrenContent : '\n' + childrenContent.trim() + '\n';

        case 'BR':
          return '\n';

        case 'STRONG':
        case 'B':
          return `**${childrenContent}**`;

        case 'EM':
        case 'I':
          return `*${childrenContent}*`;

        case 'CODE':
          if (context.inPre) return childrenContent;
          return `\`${childrenContent}\``;

        case 'PRE': {
          const codeEl = node.querySelector('code');
          const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] || '';
          const content = codeEl ? codeEl.textContent : node.textContent;
          return `\`\`\`${lang}\n${content}\n\`\`\``;
        }

        case 'A': {
          const href = node.getAttribute('href') || '';
          const text = node.textContent;
          return `[${text}](${href})`;
        }

        case 'UL': {
          const items = children
            .filter(c => c.tagName === 'LI')
            .map(li => {
              const text = li.textContent.trim();
              const nested = li.querySelector('ul, ol');
              if (nested) {
                const nestedMd = traverse(nested, {});
                return `- ${text.replace(nested.textContent.trim(), '').trim()}\n  ${nestedMd}`;
              }
              return `- ${text}`;
            })
            .join('\n');
          return '\n' + items + '\n';
        }

        case 'OL': {
          let idx = 1;
          const items = children
            .filter(c => c.tagName === 'LI')
            .map(li => {
              const text = li.textContent.trim();
              return `${idx++}. ${text}`;
            })
            .join('\n');
          return '\n' + items + '\n';
        }

        case 'LI':
          return childrenContent.trim();

        case 'TABLE': {
          const rows = node.querySelectorAll('tr');
          if (rows.length === 0) return '';
          let result = '';
          rows.forEach((row, rowIdx) => {
            const cells = row.querySelectorAll('th, td');
            const cellTexts = Array.from(cells).map(c =>
              c.textContent.trim().replace(/\|/g, '\\|')
            );
            result += `| ${cellTexts.join(' | ')} |\n`;
            if (rowIdx === 0) {
              result += `| ${cellTexts.map(() => '---').join(' | ')} |\n`;
            }
          });
          return '\n' + result.trim() + '\n';
        }

        case 'BLOCKQUOTE': {
          const quoteLines = node.textContent.trim().split('\n');
          return '\n' + quoteLines.map(l => `> ${l}`).join('\n') + '\n';
        }

        case 'HR':
          return '\n\n---\n\n';

        case 'DIV':
        case 'SECTION':
        case 'ARTICLE':
        case 'SPAN':
        default:
          return childrenContent;
      }
    }

    // 执行转换并紧凑化换行
    return traverse(element)
      .replace(/\n{3,}/g, '\n\n')      // 3+ 个换行 → 最多1个空行
      .replace(/^\n+/, '')             // 移除开头换行
      .replace(/\n+$/, '')             // 移除末尾换行
      .replace(/[ \t]+$/gm, '')        // 移除行尾空格
      .trim();
  }

  // 按轮次分组消息
  function groupMessagesByTurn() {
    const container = document.querySelector('[class*="messagesContainer_"]');
    if (!container) return [];

    const turns = [];
    let currentTurn = [];

    for (const child of container.children) {
      const className = child.className || '';

      if (className.includes('userMessage')) {
        if (currentTurn.length > 0) {
          turns.push([...currentTurn]);
          currentTurn = [];
        }
      } else if (className.includes('timelineMessage')) {
        currentTurn.push(child);
      }
    }

    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    return turns;
  }

  // 为消息添加复制按钮
  function addCopyButton(messageEl) {
    if (messageEl.querySelector('.claude-copy-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'claude-copy-btn';
    btn.textContent = '复制';
    btn.title = '复制完整 Markdown 内容 (不含思维链和工具调用)';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();

      // 获取整轮消息
      const turnMessages = messageEl._turnMessages || [messageEl];

      // 合并所有消息的 Markdown 内容
      const contents = turnMessages.map(msg => htmlToMarkdown(msg)).filter(c => c.trim());
      const finalContent = contents.join('\n\n');

      try {
        await navigator.clipboard.writeText(finalContent);
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '复制';
          btn.classList.remove('copied');
        }, 1500);
      } catch (err) {
        console.error('[Claude Enhance] Copy failed:', err);
        btn.textContent = '失败';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      }
    });

    messageEl.appendChild(btn);
  }

  // 扫描并添加复制按钮 (只在每轮末尾添加)
  function scanAndAddCopyButtons() {
    const turns = groupMessagesByTurn();

    turns.forEach(turnMessages => {
      if (turnMessages.length === 0) return;

      // 只在每轮最后一个消息上添加按钮
      const lastMessage = turnMessages[turnMessages.length - 1];

      // 存储整轮消息的引用
      lastMessage._turnMessages = turnMessages;

      addCopyButton(lastMessage);
    });
  }

  // ========== 滚轮缩放功能 ==========

  function setupZoom() {
    let zoom = parseFloat(localStorage.getItem('claude-zoom') || '1.0');
    if (!Number.isFinite(zoom)) zoom = 1.0;
    applyContentZoom(zoom);

    document.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        zoom = Math.max(0.5, Math.min(2.0, zoom + delta));
        applyContentZoom(zoom);
        localStorage.setItem('claude-zoom', zoom.toString());
        showZoomIndicator(zoom);
      }
    }, { passive: false });
  }

  function applyContentZoom(zoom) {
    document.body.style.zoom = '';
    getEnhanceRoots().forEach((root) => {
      root.style.fontSize = `${zoom}em`;
    });
  }

  function showZoomIndicator(zoom) {
    let indicator = document.getElementById('zoom-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'zoom-indicator';
      indicator.style.cssText = `
        position: fixed; top: 20px; right: 20px;
        background: var(--vscode-editorWidget-background, var(--vscode-input-background, rgba(40, 40, 40, 0.95)));
        color: var(--vscode-editorWidget-foreground, var(--vscode-input-foreground, var(--vscode-editor-foreground, #fff)));
        border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, rgba(127, 127, 127, 0.32)));
        padding: 8px 16px; border-radius: 6px; font-size: 14px;
        z-index: 10000; transition: opacity 0.3s;
        box-shadow: 0 2px 10px rgba(0,0,0,0.18);
        pointer-events: none;
      `;
      document.body.appendChild(indicator);
    }
    indicator.textContent = `缩放: ${Math.round(zoom * 100)}%`;
    indicator.style.display = 'block';
    indicator.style.pointerEvents = 'none';
    indicator.style.opacity = '1';
    setTimeout(() => {
      indicator.style.opacity = '0';
      setTimeout(() => { indicator.style.display = 'none'; }, 300);
    }, 1000);
  }

  // DOM 监听 - 防抖处理, 避免输出过程中抽搐
  function setupObserver() {
    let debounceTimer = null;
    const DEBOUNCE_DELAY = 500; // 等待 500ms 无变化后再渲染

    const observer = new MutationObserver((mutations) => {
      // 跳过我们自己添加的元素
      let hasRealChange = false;
      for (const m of mutations) {
        if (isInsideInteractiveSurface(m.target)) continue;

        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            const cls = node.className?.toString() || '';
            if (isInsideInteractiveSurface(node)) continue;

            if (
              !cls.includes('hljs') &&
              !cls.includes('katex') &&
              !cls.includes('zoom-indicator') &&
              !cls.includes('claude-code-copy-btn') &&
              !cls.includes('claude-copy-btn')
            ) {
              hasRealChange = true;
              break;
            }
          }
        }
        if (hasRealChange) break;
      }

      if (!hasRealChange) return;

      // 清除之前的定时器, 重新计时
      if (debounceTimer) clearTimeout(debounceTimer);

      // 等待输出稳定后再渲染
      debounceTimer = setTimeout(() => {
        highlightAllCode();
        renderLaTeX();
        scanAndAddCopyButtons();
        const zoom = parseFloat(localStorage.getItem('claude-zoom') || '1.0');
        if (Number.isFinite(zoom)) applyContentZoom(zoom);
      }, DEBOUNCE_DELAY);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // DOM 探测工具 - 按 Ctrl+Shift+D 导出 DOM 结构
  function setupDOMInspector() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Shift+D 触发 DOM 导出
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        exportDOMStructure();
      }
    });
  }

  function exportDOMStructure() {
    console.log('[Claude Enhance] Exporting DOM structure...');

    const result = {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      rootClasses: [],
      messageContainers: [],
      allClassNames: new Set(),
      potentialMessageSelectors: []
    };

    // 收集所有类名
    document.querySelectorAll('*').forEach(el => {
      if (el.className && typeof el.className === 'string') {
        el.className.split(/\s+/).forEach(cls => {
          if (cls) result.allClassNames.add(cls);
        });
      }
    });

    // 查找可能的消息容器 (基于常见模式)
    const messagePatterns = [
      '[class*="message"]', '[class*="Message"]',
      '[class*="chat"]', '[class*="Chat"]',
      '[class*="response"]', '[class*="Response"]',
      '[class*="assistant"]', '[class*="Assistant"]',
      '[class*="human"]', '[class*="Human"]',
      '[class*="user"]', '[class*="User"]',
      '[class*="turn"]', '[class*="Turn"]',
      '[class*="content"]', '[class*="Content"]',
      '[role="article"]', '[role="listitem"]',
      '[data-message]', '[data-turn]'
    ];

    messagePatterns.forEach(selector => {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          result.potentialMessageSelectors.push({
            selector,
            count: elements.length,
            sampleClasses: Array.from(elements).slice(0, 3).map(el => el.className)
          });
        }
      } catch (e) {}
    });

    // 分析 #root 下的结构
    const root = document.getElementById('root');
    if (root) {
      result.rootStructure = analyzeElement(root, 0, 4);
    }

    // 查找包含大量文本的容器
    const textContainers = [];
    document.querySelectorAll('div, section, article').forEach(el => {
      const text = el.innerText || '';
      if (text.length > 200 && text.length < 50000) {
        const children = el.children.length;
        if (children < 50) {
          textContainers.push({
            tag: el.tagName,
            className: el.className,
            textLength: text.length,
            childCount: children,
            preview: text.substring(0, 100) + '...'
          });
        }
      }
    });
    result.textContainers = textContainers.slice(0, 20);

    // 转换 Set 为数组
    result.allClassNames = Array.from(result.allClassNames).sort();

    // 复制到剪贴板
    const output = JSON.stringify(result, null, 2);
    navigator.clipboard.writeText(output).then(() => {
      showNotification('DOM 结构已复制到剪贴板! 请粘贴给 Claude 分析~');
      console.log('[Claude Enhance] DOM structure copied to clipboard');
    }).catch(err => {
      console.error('[Claude Enhance] Failed to copy:', err);
      // 降级: 打印到控制台
      console.log('[Claude Enhance] DOM Structure:\n', output);
      showNotification('复制失败, 请查看控制台 (F12)');
    });
  }

  function analyzeElement(el, depth, maxDepth) {
    if (depth > maxDepth) return { truncated: true };

    const info = {
      tag: el.tagName,
      className: el.className || null,
      id: el.id || null,
      childCount: el.children.length
    };

    // 检查特殊属性
    const attrs = ['role', 'data-message', 'data-turn', 'data-type', 'data-testid'];
    attrs.forEach(attr => {
      if (el.hasAttribute(attr)) {
        info[attr] = el.getAttribute(attr);
      }
    });

    // 递归分析子元素 (只分析前几个)
    if (el.children.length > 0 && depth < maxDepth) {
      info.children = Array.from(el.children)
        .slice(0, 5)
        .map(child => analyzeElement(child, depth + 1, maxDepth));
      if (el.children.length > 5) {
        info.moreChildren = el.children.length - 5;
      }
    }

    return info;
  }

  function showNotification(message) {
    let notification = document.getElementById('claude-notification');
    if (!notification) {
      notification = document.createElement('div');
      notification.id = 'claude-notification';
      notification.style.cssText = `
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: var(--vscode-editorWidget-background, var(--vscode-input-background, rgba(30, 30, 30, 0.95)));
        color: var(--vscode-testing-iconPassed, var(--vscode-terminal-ansiGreen, #2ea043));
        padding: 16px 24px; border-radius: 8px; font-size: 14px;
        z-index: 10001;
        border: 1px solid var(--vscode-testing-iconPassed, var(--vscode-terminal-ansiGreen, #2ea043));
        box-shadow: 0 4px 20px rgba(0,0,0,0.22);
      `;
      document.body.appendChild(notification);
    }
    notification.textContent = message;
    notification.style.display = 'block';
    notification.style.opacity = '1';
    setTimeout(() => {
      notification.style.opacity = '0';
      setTimeout(() => { notification.style.display = 'none'; }, 300);
    }, 2000);
  }

  // 初始化
  function init() {
    console.log('[Claude Enhance] Initializing...');
    injectStyles();
    injectHighlightJS();
    injectKaTeX();
    setupZoom();
    setupObserver();
    setupDOMInspector();
    highlightAllCode();
    renderLaTeX();
    scanAndAddCopyButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
