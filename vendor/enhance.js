/**
 * Claude Code UI enhancement script: zoom, fonts, tables, LaTeX, line breaks,
 * code highlighting, and conversation copy.
 */

(function() {
  'use strict';

  console.log('[Claude Enhance] Loading...');

  const CONTENT_BASE_FONT_SCALE = 1.10;
  const warningKeys = new Set();

  // Guard flag: while an enhancement cycle runs, the Observer ignores its own DOM changes.
  let _enhancing = false;

  // ===== Utilities =====

  function warnOnce(key, error) {
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    console.warn(`[Claude Enhance] ${key} failed:`, error);
  }

  function safeRun(key, fn, fallback) {
    try {
      return fn();
    } catch (error) {
      warnOnce(key, error);
      return fallback;
    }
  }

  function toClassName(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value.baseVal === 'string') return value.baseVal;
    return '';
  }

  function closestSafe(el, selector) {
    if (!el || typeof el.closest !== 'function') return null;
    return safeRun(`closest(${selector})`, () => el.closest(selector), null);
  }

  function querySelectorAllSafe(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    return safeRun(`querySelectorAll(${selector})`, () => Array.from(root.querySelectorAll(selector)), []);
  }

  // ===== Style and asset injection =====

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
        --ce-math-display-bg: var(--vscode-textCodeBlock-background, var(--ce-code-bg));
        --ce-math-inline-bg: var(--vscode-editorWidget-background, var(--ce-code-bg));
        --ce-api-error-bg: rgba(248, 81, 73, 0.10);
        --ce-api-error-border: rgba(248, 81, 73, 0.38);
        --ce-api-error-title: #ffb4ab;
        --ce-api-error-pill-bg: rgba(248, 81, 73, 0.08);
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
        --ce-math-display-bg: var(--vscode-textCodeBlock-background, var(--ce-code-bg));
        --ce-math-inline-bg: var(--vscode-editorWidget-background, var(--ce-code-bg));
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
        --ce-api-error-bg: rgba(207, 34, 46, 0.07);
        --ce-api-error-border: rgba(207, 34, 46, 0.30);
        --ce-api-error-title: #b42318;
        --ce-api-error-pill-bg: rgba(207, 34, 46, 0.06);
      }

      body.vscode-high-contrast,
      body.vscode-high-contrast-light {
        --ce-border: var(--vscode-contrastBorder, var(--vscode-input-border, currentColor));
        --ce-shadow: transparent;
        --ce-math-inline-bg: var(--vscode-editorWidget-background, var(--ce-bg));
        --ce-math-display-bg: var(--vscode-editorWidget-background, var(--ce-bg));
        --ce-api-error-bg: var(--vscode-editorWidget-background, var(--ce-bg));
        --ce-api-error-border: var(--vscode-contrastBorder, currentColor);
        --ce-api-error-title: var(--vscode-editor-foreground, currentColor);
        --ce-api-error-pill-bg: transparent;
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
      .katex,
      .claude-enhance-root .katex {
        font-size: 1.1em;
        line-height: 1.35;
        color: var(--ce-fg);
      }
      .katex:not(.katex-display > .katex),
      .claude-enhance-root .katex:not(.katex-display > .katex) {
        padding: 0.08em 0.24em;
        border-radius: 6px;
        background: var(--ce-math-inline-bg);
        box-shadow: 0 1px 2px var(--ce-shadow);
      }
      .katex.ce-large-inline-math,
      .claude-enhance-root .katex.ce-large-inline-math {
        display: inline-block;
        max-width: min(100%, calc(100vw - 48px));
        box-sizing: border-box;
        vertical-align: middle;
        margin: 0.25em 0.2em;
        padding: 0.55em 0.75em;
        border-radius: 8px;
        border: 1px solid var(--ce-border);
        background: var(--ce-math-inline-bg);
        box-shadow: 0 1px 4px var(--ce-shadow);
        overflow-x: auto;
        overflow-y: hidden;
        line-height: 1.45;
        white-space: nowrap;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: thin;
        scrollbar-color: var(--ce-border) transparent;
      }
      .katex-error,
      .claude-enhance-root .katex-error {
        color: var(--ce-fg) !important;
      }
      .katex-display,
      .claude-enhance-root .katex-display {
        display: block !important;
        width: 100% !important;
        min-width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box;
        align-self: stretch;
        clear: both;
        margin: 1.2em 0 !important;
        overflow-x: auto;
        min-height: 48px;
        padding: 14px 18px !important;
        border-radius: 12px !important;
        border: 1px solid var(--ce-border) !important;
        background: var(--ce-math-display-bg) !important;
        box-shadow: 0 2px 8px var(--ce-shadow) !important;
        position: relative;
        text-align: center;
        -webkit-overflow-scrolling: touch;
        scrollbar-gutter: stable both-edges;
      }
      .katex-display > .katex,
      .claude-enhance-root .katex-display > .katex {
        display: inline-block;
        font-size: 1.6em;
        line-height: 1.6;
        text-align: initial;
        padding: 0;
      }
      /* Display math inside tables keeps the equation-block affordance, but
         sizes to the cell instead of becoming a full transcript-width card. */
      .claude-enhance-root table :is(td, th) .katex-display {
        display: block !important;
        width: fit-content !important;
        min-width: 0 !important;
        max-width: 100% !important;
        min-height: 0 !important;
        margin: 0.35em 0 !important;
        padding: 9px 18px !important;
        padding: clamp(8px, 0.65em, 14px) clamp(16px, 1.35em, 28px) !important;
        border: 1px solid var(--ce-border) !important;
        border-radius: 8px !important;
        background: var(--ce-math-display-bg) !important;
        box-shadow: 0 1px 4px var(--ce-shadow) !important;
        clear: none;
        box-sizing: border-box;
        vertical-align: middle;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-gutter: auto;
      }
      .claude-enhance-root table :is(td, th) .katex-display > .katex {
        font-size: 1.48em !important;
        line-height: 1.5;
        max-width: 100%;
      }
      .claude-enhance-root table :is(td, th) .katex.ce-large-inline-math {
        display: inline-flex;
        max-width: 100%;
        margin: 0.05em 0;
        padding: 0.12em 0.24em;
        border: 0;
        background: transparent;
        box-shadow: none;
        line-height: 1.35;
      }
      .claude-enhance-root table :is(td, th) .katex:not(.katex-display > .katex) {
        font-size: 1.22em;
        padding: 0.04em 0.12em;
        background: transparent;
        box-shadow: none;
      }
      /* Scrollbar polish (WebKit + Firefox) */
      .katex-display,
      .katex.ce-large-inline-math,
      .claude-enhance-root pre,
      .claude-enhance-root .katex.ce-large-inline-math,
      .claude-enhance-root .katex-display,
      .claude-enhance-root table {
        scrollbar-width: thin;
        scrollbar-color: var(--ce-border) transparent;
      }
      .katex-display::-webkit-scrollbar,
      .katex.ce-large-inline-math::-webkit-scrollbar,
      .claude-enhance-root pre::-webkit-scrollbar,
      .claude-enhance-root .katex.ce-large-inline-math::-webkit-scrollbar,
      .claude-enhance-root .katex-display::-webkit-scrollbar,
      .claude-enhance-root table::-webkit-scrollbar {
        height: 10px;
        width: 10px;
      }
      .katex-display::-webkit-scrollbar-thumb,
      .katex.ce-large-inline-math::-webkit-scrollbar-thumb,
      .claude-enhance-root pre::-webkit-scrollbar-thumb,
      .claude-enhance-root .katex.ce-large-inline-math::-webkit-scrollbar-thumb,
      .claude-enhance-root .katex-display::-webkit-scrollbar-thumb,
      .claude-enhance-root table::-webkit-scrollbar-thumb {
        background: var(--ce-border);
        border-radius: 999px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      .katex-display::-webkit-scrollbar-thumb:hover,
      .katex.ce-large-inline-math::-webkit-scrollbar-thumb:hover,
      .claude-enhance-root pre::-webkit-scrollbar-thumb:hover,
      .claude-enhance-root .katex.ce-large-inline-math::-webkit-scrollbar-thumb:hover,
      .claude-enhance-root .katex-display::-webkit-scrollbar-thumb:hover,
      .claude-enhance-root table::-webkit-scrollbar-thumb:hover {
        background: var(--ce-muted);
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      .katex-display::-webkit-scrollbar-track,
      .katex.ce-large-inline-math::-webkit-scrollbar-track,
      .claude-enhance-root pre::-webkit-scrollbar-track,
      .claude-enhance-root .katex.ce-large-inline-math::-webkit-scrollbar-track,
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

      /* API error cards: summarize Claude API failures instead of exposing a
         wall of raw validation payload text in the main transcript flow. */
      .ce-api-error {
        display: block;
        margin: 0.85em 0;
        padding: 12px 14px;
        border: 1px solid var(--ce-api-error-border);
        border-radius: 8px;
        background: var(--ce-api-error-bg);
        color: var(--ce-fg);
        box-shadow: 0 1px 5px var(--ce-shadow);
      }
      .ce-api-error-title {
        display: block;
        font-weight: 700;
        color: var(--ce-api-error-title);
        margin-bottom: 6px;
      }
      .ce-api-error-summary {
        display: block;
        font-size: 0.94em;
        line-height: 1.45;
      }
      .ce-api-error-meta,
      .ce-api-error-fields {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }
      .ce-api-error-meta span,
      .ce-api-error-fields code {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        padding: 2px 7px;
        border: 1px solid var(--ce-api-error-border);
        border-radius: 999px;
        background: var(--ce-api-error-pill-bg);
        color: var(--ce-fg);
        font-size: 0.82em;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }
      .ce-api-error details {
        margin-top: 9px;
      }
      .ce-api-error summary {
        cursor: pointer;
        color: var(--ce-muted);
        font-size: 0.88em;
      }
      .ce-api-error pre {
        margin: 8px 0 0 !important;
        max-height: 260px;
        overflow: auto !important;
        white-space: pre-wrap !important;
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
    (document.head || document.documentElement || document.body)?.appendChild(style);
  }

  function markHighlightJSReady() {
    if (window.hljsLoaded) return;

    console.log('[Claude Enhance] Highlight.js already loaded locally');
    window.hljsLoaded = true;
    highlightAllCode();
  }

  function injectKaTeX() {
    if (window.katexLoaded) return;

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

  const NON_PREVIEW_SELECTOR = [
    INTERACTIVE_SELECTOR,
    USER_MESSAGE_SELECTOR,
    '[class*="thinking_"]',
    '[class*="thinkingContent_"]',
    '[class*="thinkingSummary_"]',
    '[class*="toolUse_"]',
    '[class*="toolResult_"]',
    '[class*="toolBody_"]',
    '[class*="toolBodyGrid_"]',
    '[class*="toolBodyRow_"]',
    '[class*="toolSummary_"]',
    '.ce-api-error',
    '[class*="header"]',
    '[class*="sessionList"]',
    '[class*="sessionsList"]',
    '[class*="sessionItem"]',
    '[class*="sessionName"]'
  ].join(',');

  const DIALOG_SELECTOR = [
    '[role="dialog"]',
    '[class*="dialog"]',
    '[class*="Dialog"]',
    '[class*="modal"]',
    '[class*="Modal"]',
    '[class*="overlay"]',
    '[class*="Overlay"]',
    '[class*="permission"]',
    '[class*="Permission"]',
    '[class*="confirm"]',
    '[class*="Confirm"]',
    '[class*="approval"]',
    '[class*="Approval"]'
  ].join(',');

  function isInsideInteractiveSurface(el) {
    const node = el?.nodeType === Node.ELEMENT_NODE ? el : el?.parentElement;
    return !!closestSafe(node, INTERACTIVE_SELECTOR);
  }

  function isInsideNonPreviewRegion(el) {
    const node = el?.nodeType === Node.ELEMENT_NODE ? el : el?.parentElement;
    return !!closestSafe(node, NON_PREVIEW_SELECTOR);
  }

  function shouldSkipPreviewEnhancement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    return isInsideNonPreviewRegion(el);
  }

  function isInsideDialog(el) {
    const node = el?.nodeType === Node.ELEMENT_NODE ? el : el?.parentElement;
    return !!closestSafe(node, DIALOG_SELECTOR);
  }

  const MSG_CONTENT_SELECTOR = '[class*="timelineMessage_"], [class*="assistantMessage_"], [class*="userMessage_"], .rendered-markdown';
  function isInsideMessageContent(node) {
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return !!closestSafe(el, MSG_CONTENT_SELECTOR);
  }

  function getEnhanceRoots() {
    const selectors = [
      '[class*="messagesContainer_"]',
      '[class*="timelineMessage_"]',
      '[class*="messageContent_"]',
      '[class*="assistantMessage_"]',
      '.rendered-markdown'
    ].join(',');

    const roots = querySelectorAllSafe(document, selectors)
      .filter((el) => !closestSafe(el, NON_PREVIEW_SELECTOR) && !isInsideDialog(el));

    const topLevelRoots = roots.filter((el) => !roots.some((other) => (
      other !== el && typeof other.contains === 'function' && other.contains(el)
    )));
    topLevelRoots.forEach((el) => el.classList.add('claude-enhance-root'));
    return topLevelRoots;
  }

  // ===== Code highlighting =====

  function highlightAllCode() {
    if (typeof hljs === 'undefined') return;

    getEnhanceRoots().forEach((root) => {
      querySelectorAllSafe(root, 'pre code').forEach((block) => {
        if (shouldSkipPreviewEnhancement(block)) return;
        safeRun('highlightCodeBlock', () => {
          highlightCodeBlock(block);
          addCodeBlockCopyButton(block);
        });
      });
    });
  }

  function getCodeLanguage(block) {
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
    const normalize = (language) => aliases[String(language || '').toLowerCase()] || String(language || '').toLowerCase();
    const dataLanguage = block.getAttribute('data-language') || block.parentElement?.getAttribute('data-language') || '';
    if (/^[A-Za-z0-9_+#.-]+$/.test(dataLanguage)) return normalize(dataLanguage);

    const candidates = [
      toClassName(block.className),
      toClassName(block.parentElement?.className),
      dataLanguage
    ].join(' ');
    const match = candidates.match(/(?:^|\s)(?:language|lang)-([A-Za-z0-9_+#.-]+)/);
    if (!match) return '';
    return normalize(match[1]);
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
    if (Array.from(pre.children || []).some((child) => child.classList?.contains('claude-code-copy-btn'))) return;

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

  // ===== LaTeX rendering =====

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

  function normalizeDisplayLatexFormula(formula) {
    return normalizeLatexFormula(formula)
      .replace(/\\\s*\n/g, '\\\\\n')
      .replace(/\\\[(\d+(?:\.\d+)?[a-z]*)\]/gi, '\\\\[$1]')
      .replace(/&\s*\\\[6pt\]/g, '& \\\\')
      .replace(/\\(sum|prod|int|lim|inf|sup|max|min)\{([^}]+)\}/g, '\\\\$1_{$2}')
      .replace(/\\operatorname\{(\w+)\}(\()/g, '\\\\operatorname{$1}$2');
  }

  function normalizeLatexForRender(formula, displayMode) {
    return displayMode ? normalizeDisplayLatexFormula(formula) : normalizeLatexFormula(formula);
  }

  function renderLatexHtml(formula, displayMode) {
    return katex.renderToString(normalizeLatexForRender(formula, displayMode), {
      displayMode,
      strict: 'ignore',
      throwOnError: false
    });
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

  function isDimensionLatexFormula(text) {
    const cleaned = normalizeDimensionLatexFormula(text);
    return /^\d+(?:\s*(?:\{\\times\}|\\times|×)\s*\d+){1,}$/.test(cleaned);
  }

  function normalizeDimensionLatexFormula(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\\(?=\d)/, '');
  }

  function parseMalformedDimensionText(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    const dimension = '(\\\\?\\d+(?:\\s*(?:\\{\\\\times\\}|\\\\times|×)\\s*\\d+){1,})';
    const re = new RegExp(`^${dimension}\\s*(→|->|\\\\to)\\s*([A-Za-z][A-Za-z0-9]*?)(?:\\s*([\\\\$])\\s*|\\s+|(?=\\\\?\\d))${dimension}$`);
    const match = cleaned.match(re);
    if (!match) return null;
    return {
      left: normalizeDimensionLatexFormula(match[1]),
      arrow: match[2] === '\\to' || match[2] === '->' ? '→' : match[2],
      label: match[3],
      right: normalizeDimensionLatexFormula(match[5]),
    };
  }

  function renderLatexToFragment(formula, displayMode) {
    const fragment = document.createDocumentFragment();
    appendHtmlFragment(fragment, renderLatexHtml(formula, displayMode));
    return fragment;
  }

  function renderMalformedDimensionFragment(parts) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(renderLatexToFragment(parts.left, false));
    fragment.appendChild(document.createTextNode(` ${parts.arrow} ${parts.label} `));
    fragment.appendChild(renderLatexToFragment(parts.right, false));
    return fragment;
  }

  function renderLatexFragment(fragment, displayMode, fallback) {
    const latex = /<[^>]+>/.test(fragment) ? htmlFragmentToLatex(fragment) : fragment;
    if (!isRenderableLatexFormula(latex, displayMode)) return fallback;
    try {
      return renderLatexHtml(latex, displayMode);
    } catch {
      return fallback;
    }
  }

  function htmlFragmentToLatex(html) {

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

      if (!isText && prevWasText) {

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
    if (!next || /\s/.test(next)) return false;
    if (prev && !/\s|[(\[{,;:]/.test(prev) && !/\d/.test(next)) return false;
    return true;
  }

  function isLikelyInlineDollarEnd(text, index) {
    const prev = text[index - 1];
    return !!prev && !/\s/.test(prev);
  }

  function isLikelyInlineDollarFormula(formula) {
    const cleaned = formula.replace(/\s+/g, ' ').trim();
    if (!cleaned) return false;

    if (/^\d/.test(cleaned) && !/[\\{}_^=+\-*/<>×]/.test(cleaned)) return false;
    return isRenderableLatexFormula(cleaned, false);
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
          if (isLikelyInlineDollarFormula(formula)) spans.push({ start: i, end: end + 1, formula, displayMode: false });
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
      closestSafe(el, '.katex') ||
      isInsideNonPreviewRegion(el) ||
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
      html = renderLatexHtml(span.formula, span.displayMode);
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

  function appendHtmlFragment(target, html) {
    const wrapper = document.createElement('span');
    wrapper.innerHTML = html;
    while (wrapper.firstChild) target.appendChild(wrapper.firstChild);
  }

  function renderMathInTextNode(textNode) {
    const text = textNode.textContent || '';
    const spans = findMathSpans(text);
    if (!spans.length) return false;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let changed = false;

    spans.forEach((span) => {
      if (span.start < cursor) return;
      if (span.start > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, span.start)));
      }

      try {
        appendHtmlFragment(fragment, renderLatexHtml(span.formula, span.displayMode));
        changed = true;
      } catch {
        fragment.appendChild(document.createTextNode(text.slice(span.start, span.end)));
      }
      cursor = span.end;
    });

    if (!changed) return false;
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }
    if (textNode.parentNode) {
      textNode.parentNode.replaceChild(fragment, textNode);
    }
    return true;
  }

  function renderBareDimensionMathInTextNode(textNode) {
    const text = textNode.textContent || '';
    if (!text.includes('\\times') && !text.includes('×')) return false;

    const re = /(^|[^_$])((?:\\)?\d+(?:\s*(?:\{\\times\}|\\times|×)\s*\d+){1,})(?=$|[^A-Za-z0-9_$\\])/g;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let changed = false;
    let match;

    while ((match = re.exec(text))) {
      const prefix = match[1] || '';
      const formula = match[2];
      if (/[A-Za-z0-9]$/.test(prefix) && !formula.startsWith('\\')) continue;
      const formulaStart = match.index + prefix.length;
      const formulaEnd = formulaStart + formula.length;
      if (!isDimensionLatexFormula(formula)) continue;

      if (formulaStart > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, formulaStart)));
      }

      try {
        fragment.appendChild(renderLatexToFragment(normalizeDimensionLatexFormula(formula), false));
        changed = true;
      } catch {
        fragment.appendChild(document.createTextNode(formula));
      }
      cursor = formulaEnd;
    }

    if (!changed) return false;
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
    return true;
  }

  function repairBareDimensionMath(root) {

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentNode;
          if (!parent || parent.nodeType !== 1 ||
              closestSafe(parent, '.katex') ||
              isInsideNonPreviewRegion(parent) ||
              ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'BUTTON', 'INPUT', 'TEXTAREA'].includes(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          const text = node.textContent || '';
          return (text.includes('\\times') || text.includes('×'))
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );

    const nodes = [];
    let node;
    while (node = walker.nextNode()) nodes.push(node);
    nodes.forEach((textNode) => safeRun('renderBareDimensionMathInTextNode', () => {
      renderBareDimensionMathInTextNode(textNode);
    }));
  }

  function repairMalformedDimensionKatex(root) {
    querySelectorAllSafe(root, '.katex').forEach((el) => safeRun('repairMalformedDimensionKatex item', () => {
      if (el.dataset.ceRepaired) return;
      if (closestSafe(el.parentElement, '.katex')) { el.dataset.ceRepaired = 'true'; return; }
      const annotation = querySelectorAllSafe(el, 'annotation[encoding="application/x-tex"]')[0];
      const parts = parseMalformedDimensionText(annotation?.textContent || '');
      if (!parts) { el.dataset.ceRepaired = 'true'; return; }
      el.dataset.ceRepaired = 'true';
      el.replaceWith(renderMalformedDimensionFragment(parts));
    }));
  }

  function preprocessHTMLMath(root) {
    const selector = [
      'p', 'li', 'td', 'th', 'blockquote',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'div', 'span'
    ].join(',');
    const candidates = [root, ...querySelectorAllSafe(root, selector)]
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
    querySelectorAllSafe(root, '.katex-error').forEach((el) => {
      const text = (el.textContent || '').trim();
      if (!text) return;
      const malformed = parseMalformedDimensionText(text);
      if (malformed) {
        try {
          el.replaceWith(renderMalformedDimensionFragment(malformed));
          return;
        } catch {}
      }
      if (isDimensionLatexFormula(text)) {
        try {
          el.replaceWith(renderLatexToFragment(normalizeDimensionLatexFormula(text), false));
          return;
        } catch {}
      }
      if (!isProseHeavyLatex(text, true)) return;
      el.replaceWith(document.createTextNode(text));
    });
  }

  function shouldSkipRelaxedMarkdownElement(el) {
    return !el || el.nodeType !== 1 ||
      closestSafe(el, '.katex') ||
      isInsideNonPreviewRegion(el) ||
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

  function isLineBoundaryNode(node) {
    return node?.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR';
  }

  function textBeforeLastLineBreakIsWhitespace(text) {
    const lastBreak = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
    const relevant = lastBreak === -1 ? text : text.slice(lastBreak + 1);
    return !relevant.trim();
  }

  function textAfterFirstLineBreakIsWhitespace(text) {
    const breaks = [text.indexOf('\n'), text.indexOf('\r')].filter((idx) => idx !== -1);
    const firstBreak = breaks.length ? Math.min(...breaks) : -1;
    const relevant = firstBreak === -1 ? text : text.slice(0, firstBreak);
    return !relevant.trim();
  }

  function isWhitespaceLikeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return !(node.textContent || '').trim();
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    return node.tagName === 'BR' || node.classList?.contains('katex-mathml');
  }

  function hasOnlyStandaloneMathOnLine(katexEl) {
    for (let node = katexEl.previousSibling; node; node = node.previousSibling) {
      if (isLineBoundaryNode(node)) break;
      if (node.nodeType === Node.TEXT_NODE) {
        if (!textBeforeLastLineBreakIsWhitespace(node.textContent || '')) return false;
        if ((node.textContent || '').includes('\n') || (node.textContent || '').includes('\r')) break;
        continue;
      }
      if (!isWhitespaceLikeNode(node)) return false;
    }

    for (let node = katexEl.nextSibling; node; node = node.nextSibling) {
      if (isLineBoundaryNode(node)) break;
      if (node.nodeType === Node.TEXT_NODE) {
        if (!textAfterFirstLineBreakIsWhitespace(node.textContent || '')) return false;
        if ((node.textContent || '').includes('\n') || (node.textContent || '').includes('\r')) break;
        continue;
      }
      if (!isWhitespaceLikeNode(node)) return false;
    }

    return true;
  }

  function meaningfulTextWithoutMath(el) {
    const clone = el.cloneNode(true);
    querySelectorAllSafe(clone, '.katex, .katex-display, script, style, button').forEach((node) => node.remove());
    return (clone.textContent || '').replace(/[\s\u00a0]+/g, '').trim();
  }

  function isOnlyMathInContainer(katexEl) {
    const container = closestSafe(katexEl, 'p, li, blockquote, td, th, div, section');
    if (!container || container === document.body || isInsideNonPreviewRegion(container)) return false;
    const mathNodes = querySelectorAllSafe(container, '.katex:not(.katex-display .katex)')
      .filter((el) => !closestSafe(el, '.katex-display'));
    if (mathNodes.length !== 1 || mathNodes[0] !== katexEl) return false;
    return meaningfulTextWithoutMath(container) === '';
  }

  function isOnlyMathInTableCell(katexEl) {
    const cell = closestSafe(katexEl, 'td, th');
    if (!cell || isInsideNonPreviewRegion(cell)) return false;
    const mathNodes = querySelectorAllSafe(cell, '.katex:not(.katex-display .katex)')
      .filter((el) => !closestSafe(el, '.katex-display'));
    if (mathNodes.length !== 1 || mathNodes[0] !== katexEl) return false;
    return meaningfulTextWithoutMath(cell) === '';
  }

  function shouldPromoteInlineMath(katexEl) {
    if (!katexEl?.parentNode ||
        closestSafe(katexEl, '.katex-display') ||
        isInsideNonPreviewRegion(katexEl)) {
      return false;
    }
    return isOnlyMathInTableCell(katexEl) ||
      hasOnlyStandaloneMathOnLine(katexEl) ||
      isOnlyMathInContainer(katexEl);
  }

  function promoteStandaloneInlineMath(root) {
    const candidates = querySelectorAllSafe(root, '.katex:not(.katex-display .katex)')
      .filter((el) => !closestSafe(el, '.katex-display') && !isInsideNonPreviewRegion(el));

    candidates.forEach((katexEl) => {
      if (katexEl.dataset.cePromoted) return;
      katexEl.dataset.cePromoted = 'true';
      if (!shouldPromoteInlineMath(katexEl)) return;

      const display = document.createElement('span');
      display.className = 'katex-display';
      katexEl.parentNode.insertBefore(display, katexEl);
      display.appendChild(katexEl);
    });
  }

  function isLargeInlineMath(katexEl) {
    if (querySelectorAllSafe(katexEl, '.mtable, .mfrac, .sqrt').length) return true;

    const rect = katexEl.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;

    const container = closestSafe(katexEl, 'p, li, blockquote, td, th, div, section') || katexEl.parentElement;
    const containerWidth = container?.getBoundingClientRect?.().width || window.innerWidth || 0;
    const wideInlineLimit = containerWidth ? Math.min(360, containerWidth * 0.58) : 360;

    return rect.height > 34 || rect.width > wideInlineLimit;
  }

  function adaptInlineMathSize(root) {
    const candidates = querySelectorAllSafe(root, '.katex')
      .filter((el) => !closestSafe(el, '.katex-display') && !isInsideNonPreviewRegion(el));

    candidates.forEach((katexEl) => {
      // Per-element marker: measure each formula once. isLargeInlineMath calls
      // getBoundingClientRect (forced reflow), so skipping processed elements avoids O(n^2).
      if (katexEl.dataset.ceAdapted) return;
      katexEl.classList.toggle('ce-large-inline-math', isLargeInlineMath(katexEl));
      katexEl.dataset.ceAdapted = 'true';
    });
  }

  // ===== API error rendering =====

  function singleLineText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function apiErrorSummary(text, status) {
    const validationMatch = text.match(/(\d+)\s+request validation errors?/i);
    if (validationMatch) return `${validationMatch[1]} request validation errors`;

    let summary = text.replace(/^API Error:\s*\d+\s*/i, '').trim();
    summary = summary.replace(/\s*\(request id:\s*[^)]+\)/i, '').trim();
    summary = summary.replace(/\.{2,}/g, '.');
    if (status && summary.startsWith(String(status))) {
      summary = summary.slice(String(status).length).trim();
    }
    return summary.length <= 220 ? summary : summary.slice(0, 217).trimEnd() + '...';
  }

  function extractApiErrorTextFields(text) {
    const fields = [];
    const keyRe = /['"]text['"]\s*:/g;
    let match;

    while ((match = keyRe.exec(text))) {
      let i = keyRe.lastIndex;
      while (i < text.length && /\s/.test(text[i])) i++;
      const quote = text[i];
      if (quote !== '"' && quote !== "'") continue;

      i++;
      let value = '';
      let escaped = false;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
          if (ch === 'n') value += '\n';
          else if (ch === 'r') value += '\r';
          else if (ch === 't') value += '\t';
          else value += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === quote) break;
        value += ch;
      }
      if (value.trim()) fields.push(value);
      keyRe.lastIndex = i + 1;
    }

    return fields;
  }

  function parseApiErrorText(text) {
    const raw = String(text || '').trim();
    if (!raw.startsWith('API Error:')) return null;

    const statusMatch = raw.match(/^API Error:\s*(\d+)/i);
    const status = statusMatch ? statusMatch[1] : '';
    const requestIdMatch = raw.match(/request id:\s*([^)]+)/i);
    const expectedFormatMatch = raw.match(/Expected format:\s*(.+?)\./i);
    const gatewayMatch = raw.match(/inference gateway\s*\(([^)]+)\)/i);
    const fields = [];
    const fieldRe = /field:\s*'?([^,'\n]+)'?/gi;
    let fieldMatch;
    while ((fieldMatch = fieldRe.exec(raw))) {
      const field = fieldMatch[1].trim();
      if (field && !fields.includes(field)) fields.push(field);
    }

    return {
      status,
      summary: apiErrorSummary(raw, status),
      requestId: requestIdMatch ? requestIdMatch[1].trim() : '',
      expectedFormat: expectedFormatMatch ? expectedFormatMatch[1].trim() : '',
      gateway: gatewayMatch ? gatewayMatch[1].trim() : '',
      fields,
      textFields: extractApiErrorTextFields(raw),
      raw,
    };
  }

  function appendTextElement(parent, tagName, className, text) {
    const el = document.createElement(tagName);
    if (className) el.className = className;
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function appendPills(parent, className, values) {
    const cleanValues = values.map(singleLineText).filter(Boolean);
    if (!cleanValues.length) return;
    const wrap = document.createElement('span');
    wrap.className = className;
    cleanValues.forEach((value) => appendTextElement(wrap, 'span', '', value));
    parent.appendChild(wrap);
  }

  function appendDetails(parent, summaryText, bodyText) {
    if (!String(bodyText || '').trim()) return;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = summaryText;
    const pre = document.createElement('pre');
    pre.textContent = bodyText;
    details.appendChild(summary);
    details.appendChild(pre);
    parent.appendChild(details);
  }

  function createApiErrorCard(info) {
    const card = document.createElement('span');
    card.className = 'ce-api-error';
    appendTextElement(card, 'span', 'ce-api-error-title', `API Error ${info.status}`.trim());
    appendTextElement(card, 'span', 'ce-api-error-summary', info.summary || 'Claude API error');

    appendPills(card, 'ce-api-error-meta', [
      info.status ? `Status ${info.status}` : '',
      info.requestId ? `Request ${info.requestId}` : '',
      info.expectedFormat ? `Expected ${info.expectedFormat}` : '',
      info.gateway ? `Gateway ${info.gateway}` : '',
    ]);

    if (info.fields.length) {
      const fieldsWrap = document.createElement('span');
      fieldsWrap.className = 'ce-api-error-fields';
      info.fields.forEach((field) => appendTextElement(fieldsWrap, 'code', '', field));
      card.appendChild(fieldsWrap);
    }

    appendDetails(card, 'Show message text fields', info.textFields.join('\n\n'));
    appendDetails(card, 'Show raw API error', info.raw);
    return card;
  }

  function textForApiErrorParse(el) {
    return (el?.innerText || el?.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  function canContainWholeApiError(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName;
    if (tag === 'BODY' || tag === 'HTML' || tag === 'SCRIPT' || tag === 'STYLE') return false;

    const className = toClassName(el.className);
    if (className.includes('messagesContainer') ||
        className.includes('sessionsList') ||
        className.includes('sessionItem') ||
        className.includes('timelineMessage') ||
        className.includes('toolUse') ||
        className.includes('toolResult') ||
        className.includes('thinking')) {
      return false;
    }
    return !closestSafe(el, '.ce-api-error') && !isInsideNonPreviewRegion(el);
  }

  function parseApiErrorFromElement(el) {
    const text = textForApiErrorParse(el);
    const start = text.indexOf('API Error:');
    if (start === -1) return null;

    const prefix = text.slice(0, start).replace(/[•·]/g, '').trim();
    if (prefix) return null;
    return parseApiErrorText(text.slice(start));
  }

  function findApiErrorContainer(textNode, root) {
    let best = null;
    for (let el = textNode?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (root && el !== root && !root.contains(el)) break;
      if (!canContainWholeApiError(el)) continue;

      const info = parseApiErrorFromElement(el);
      if (!info) {
        if (best) break;
        continue;
      }

      best = { el, info };
      const className = toClassName(el.className);
      if (className.includes('rendered-markdown') ||
          className.includes('messageContent') ||
          className.includes('assistantMessage')) {
        break;
      }
    }
    return best;
  }

  function replaceElementWithApiErrorCard(el, info) {
    if (!el || querySelectorAllSafe(el, ':scope > .ce-api-error').length) return;
    const card = createApiErrorCard(info);
    el.replaceChildren(card);
    el.setAttribute('data-ce-api-error-rendered', 'true');
  }

  function renderApiErrors() {
    getEnhanceRoots().forEach((root) => safeRun('renderApiErrors root', () => {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentNode;
            if (!parent || parent.nodeType !== 1) return NodeFilter.FILTER_REJECT;
            if (closestSafe(parent, '.ce-api-error') ||
                isInsideNonPreviewRegion(parent) ||
                ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'BUTTON', 'INPUT', 'TEXTAREA'].includes(parent.tagName)) {
              return NodeFilter.FILTER_REJECT;
            }
            return (node.textContent || '').includes('API Error:')
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          }
        }
      );

      const nodes = [];
      let node;
      while (node = walker.nextNode()) nodes.push(node);

      const containerJobs = new Map();
      const fallbackNodes = [];

      nodes.forEach((textNode) => safeRun('renderApiError collect', () => {
        const container = findApiErrorContainer(textNode, root);
        if (container) {
          containerJobs.set(container.el, container.info);
        } else {
          fallbackNodes.push(textNode);
        }
      }));

      containerJobs.forEach((info, el) => safeRun('renderApiError container', () => {
        replaceElementWithApiErrorCard(el, info);
      }));

      fallbackNodes.forEach((textNode) => safeRun('renderApiError text', () => {
        if (!textNode.parentNode || closestSafe(textNode.parentNode, '.ce-api-error')) return;
        const text = textNode.textContent || '';
        const start = text.indexOf('API Error:');
        if (start === -1) return;
        const info = parseApiErrorText(text.slice(start));
        if (!info) return;

        const fragment = document.createDocumentFragment();
        if (start > 0) fragment.appendChild(document.createTextNode(text.slice(0, start)));
        fragment.appendChild(createApiErrorCard(info));
        textNode.parentNode?.replaceChild(fragment, textNode);
      }));
    }));
  }

  function renderLaTeX() {
    if (typeof katex === 'undefined') return;
    if (window._claudeRenderingLaTeX) return;
    window._claudeRenderingLaTeX = true;

    try {
      getEnhanceRoots().forEach((root) => safeRun('renderLaTeX root', () => {

        preprocessHTMLMath(root);

        const walker = document.createTreeWalker(
          root,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentNode;
              if (!parent || parent.nodeType !== 1) return NodeFilter.FILTER_REJECT;
              if (parent.classList?.contains('katex') ||
                  closestSafe(parent, '.katex') ||
                  isInsideNonPreviewRegion(parent) ||
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
          safeRun('renderMathInTextNode', () => renderMathInTextNode(textNode));
        });

        repairBareDimensionMath(root);
        repairMalformedDimensionKatex(root);
        repairProseKatexErrors(root);
        renderRelaxedMarkdownBold(root);
        promoteStandaloneInlineMath(root);
        adaptInlineMathSize(root);
      }));
    } finally {
      window._claudeRenderingLaTeX = false;
    }
  }

  // ===== Conversation copy =====

  const _turnMessagesMap = new WeakMap();

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

  function shouldExclude(element) {
    if (!element || !element.className) return false;
    const className = toClassName(element.className);
    return EXCLUDE_PREFIXES.some(prefix => className.includes(prefix));
  }

  function htmlToMarkdown(element) {
    if (!element) return '';

    const IGNORE_TAGS = new Set(['BUTTON', 'STYLE', 'SCRIPT', 'SVG', 'MAT-ICON']);

    function traverse(node, context = {}) {

      if (node.nodeType === 3) {
        const text = node.textContent;
        if (context.inPre) return text;
        return text.replace(/\s+/g, ' ');
      }

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

      const childrenContent = children
        .map(c => traverse(c, newContext))
        .join('');

      if (tag === 'SPAN' && node.classList?.contains('katex')) {
        const annotation = querySelectorAllSafe(node, 'annotation[encoding="application/x-tex"]')[0];
        if (annotation) {
          const tex = annotation.textContent;

          const cleaned = tex.replace(/\s+/g, ' ').trim();
          const isDisplay = node.classList.contains('katex-display');
          return isDisplay ? `$$${cleaned}$$` : `$${cleaned}$`;
        }
      }

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
          const codeEl = querySelectorAllSafe(node, 'code')[0];
          const lang = toClassName(codeEl?.className).match(/language-([A-Za-z0-9_+#.-]+)/)?.[1] || '';
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
              const nested = querySelectorAllSafe(li, 'ul, ol')[0];
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
          const rows = querySelectorAllSafe(node, 'tr');
          if (rows.length === 0) return '';
          let result = '';
          rows.forEach((row, rowIdx) => {
            const cells = querySelectorAllSafe(row, 'th, td');
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

    return safeRun('htmlToMarkdown', () => traverse(element)
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
      .replace(/[ \t]+$/gm, '')
      .trim(), '');
  }

  function groupMessagesByTurn() {
    const container = querySelectorAllSafe(document, '[class*="messagesContainer_"]')[0];
    if (!container) return [];

    const turns = [];
    let currentTurn = [];

    for (const child of container.children) {
      const className = toClassName(child.className);

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

  function addCopyButton(messageEl) {
    if (!messageEl || messageEl.nodeType !== 1 || shouldSkipPreviewEnhancement(messageEl)) return;
    if (querySelectorAllSafe(messageEl, '.claude-copy-btn').length) return;

    const btn = document.createElement('button');
    btn.className = 'claude-copy-btn';
    btn.textContent = '复制';
    btn.title = '复制完整 Markdown 内容 (不含思维链和工具调用)';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();

      try {

        const turnMessages = _turnMessagesMap.get(messageEl) || [messageEl];

        const contents = turnMessages.map(msg => htmlToMarkdown(msg)).filter(c => c.trim());
        const finalContent = contents.join('\n\n');
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable');
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

  function scanAndAddCopyButtons() {
    const turns = groupMessagesByTurn();

    turns.forEach(turnMessages => {
      if (turnMessages.length === 0) return;

      const lastMessage = turnMessages[turnMessages.length - 1];

      _turnMessagesMap.set(lastMessage, turnMessages);

      safeRun('addCopyButton', () => addCopyButton(lastMessage));
    });
  }

  // ===== Zoom =====

  function getStoredZoom() {
    const zoom = safeRun('read zoom', () => parseFloat(localStorage.getItem('claude-zoom') || '1.0'), 1.0);
    return Number.isFinite(zoom) ? zoom : 1.0;
  }

  function setStoredZoom(zoom) {
    safeRun('write zoom', () => localStorage.setItem('claude-zoom', zoom.toString()));
  }

  function setupZoom() {
    let zoom = getStoredZoom();
    applyContentZoom(zoom);

    document.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        zoom = Math.max(0.5, Math.min(2.0, zoom + delta));
        applyContentZoom(zoom);
        setStoredZoom(zoom);
        showZoomIndicator(zoom);
      }
    }, { passive: false });
  }

  function applyContentZoom(zoom) {
    if (!document.body) return;
    document.body.style.zoom = '';
    const effectiveZoom = Number.isFinite(zoom) ? zoom * CONTENT_BASE_FONT_SCALE : CONTENT_BASE_FONT_SCALE;
    getEnhanceRoots().forEach((root) => {
      root.style.fontSize = `${effectiveZoom}em`;
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
      (document.body || document.documentElement)?.appendChild(indicator);
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

  // ===== DOM observer =====

  function setupObserver() {
    if (typeof MutationObserver === 'undefined' || !document.body) return;
    let debounceTimer = null;
    const DEBOUNCE_DELAY = 100;

    function isInsideKatex(node) {
      return !!closestSafe(node?.nodeType === Node.TEXT_NODE ? node.parentElement : node, '.katex, .katex-display, .katex-mathml');
    }

    // Detect DOM changes produced by the enhancement script itself (KaTeX output, hljs,
    // copy buttons, etc.) so they don't re-trigger the cycle and cause an infinite loop.
    // Detects DOM changes produced by the enhancement script itself (KaTeX output, highlighting,
    // copy buttons, etc.) so they don't re-trigger the cycle and cause an infinite render loop.
    function isSelfMutation(m) {
      const target = m.target;
      if (isInsideKatex(target)) return true;
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const cls = toClassName(node.className);
          if (cls.includes('katex') || cls.includes('hljs') ||
              cls.includes('zoom-indicator') || cls.includes('claude-code-copy-btn') ||
              cls.includes('claude-copy-btn') || cls.includes('ce-api-error') ||
              cls.includes('claude-enhance-root')) continue;
        }
        if (node.nodeType === Node.TEXT_NODE && isInsideKatex(node)) continue;
        return false;
      }
      return m.addedNodes.length > 0;
    }

    function classifyMutations(mutations) {
      let needFull = false;
      let needMath = false;
      let needHighlight = false;

      for (const m of mutations) {
        if (isSelfMutation(m)) continue;

        if (m.type === 'characterData') {
          const text = m.target?.textContent || '';
          if (text.includes('$') || text.includes('\\(') || text.includes('\\[')) needMath = true;
          if (text.includes('**')) needMath = true;
        }

        for (const node of m.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            if (isInsideKatex(node)) continue;
            const text = node.textContent || '';
            if (text.includes('$') || text.includes('\\(') || text.includes('\\[')) needMath = true;
            needFull = true;
          }
          if (node.nodeType === Node.ELEMENT_NODE) {
            const cls = toClassName(node.className);
            if (cls.includes('katex') || cls.includes('hljs') ||
                cls.includes('zoom-indicator') || cls.includes('claude-code-copy-btn') ||
                cls.includes('claude-copy-btn') || cls.includes('ce-api-error') ||
                cls.includes('claude-enhance-root')) continue;
            const tag = node.tagName;
            if (tag === 'PRE' || tag === 'CODE') needHighlight = true;
            needFull = true;
          }
        }
        if (needFull) break;
      }

      return { needFull, needMath, needHighlight };
    }

    const observer = new MutationObserver((mutations) => {
      if (_enhancing) return;

      safeRun('mutation observer', () => {
        const { needFull, needMath, needHighlight } = classifyMutations(mutations);
        if (!needFull && !needMath && !needHighlight) return;

        if (!debounceTimer) {

          if (needFull) {
            runEnhancementCycle();
          } else if (needMath) {
            _enhancing = true;
            try {
              scrollToBottomIfNeeded();
              safeRun('renderLaTeX', renderLaTeX);
              scrollToBottomIfNeeded();
            } finally { _enhancing = false; }
          } else if (needHighlight) {
            _enhancing = true;
            try {
              scrollToBottomIfNeeded();
              safeRun('highlightAllCode', highlightAllCode);
              scrollToBottomIfNeeded();
            } finally { _enhancing = false; }
          }
        }

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (needFull) runEnhancementCycle();
        }, DEBOUNCE_DELAY);
      });
    });

    // Switching conversations unmounts the old messagesContainer and mounts a new one,
    // so we track the current container and re-attach whenever it is replaced or removed.
    let currentContainer = null;
    function attachToContainer(container) {
      observer.disconnect();
      currentContainer = container;
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      console.log('[Claude Enhance] Observer attached to messagesContainer');
      runEnhancementCycle();
      // Content may not be rendered yet when the container first appears.
      setTimeout(runEnhancementCycle, 500);
    }

    function ensureAttached() {
      // Fast path: still attached to a live container, nothing to do.
      if (currentContainer && currentContainer.isConnected) return;
      const container = document.querySelector('[class*="messagesContainer_"]');
      if (container && container !== currentContainer) {
        attachToContainer(container);
      }
    }

    ensureAttached();

    // Persistent bridge: body-level childList changes signal a container swap. Never disconnected.
    const bridge = new MutationObserver(() => { safeRun('bridge ensureAttached', ensureAttached); });
    bridge.observe(document.body, { childList: true, subtree: true });
    console.log('[Claude Enhance] Bridge observer watching for messagesContainer changes');

    // Low-frequency poll as a backstop in case the bridge misses a swap.
    setInterval(() => { safeRun('interval ensureAttached', ensureAttached); }, 2000);
  }

  // ===== DOM inspector (Ctrl+Shift+D) =====

  function setupDOMInspector() {
    document.addEventListener('keydown', (e) => {

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

    querySelectorAllSafe(document, '*').forEach(el => {
      const className = toClassName(el.className);
      if (className) {
        className.split(/\s+/).forEach(cls => {
          if (cls) result.allClassNames.add(cls);
        });
      }
    });

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
        const elements = querySelectorAllSafe(document, selector);
        if (elements.length > 0) {
          result.potentialMessageSelectors.push({
            selector,
            count: elements.length,
            sampleClasses: Array.from(elements).slice(0, 3).map(el => toClassName(el.className))
          });
        }
      } catch (e) {}
    });

    const root = document.getElementById('root');
    if (root) {
      result.rootStructure = analyzeElement(root, 0, 4);
    }

    const textContainers = [];
    querySelectorAllSafe(document, 'div, section, article').forEach(el => {
      const text = el.innerText || '';
      if (text.length > 200 && text.length < 50000) {
        const children = el.children.length;
        if (children < 50) {
          textContainers.push({
            tag: el.tagName,
            className: toClassName(el.className),
            textLength: text.length,
            childCount: children,
            preview: text.substring(0, 100) + '...'
          });
        }
      }
    });
    result.textContainers = textContainers.slice(0, 20);

    result.allClassNames = Array.from(result.allClassNames).sort();

    const output = JSON.stringify(result, null, 2);
    if (!navigator.clipboard?.writeText) {
      console.log('[Claude Enhance] DOM Structure:\n', output);
      showNotification('复制失败, 请查看控制台 (F12)');
      return;
    }
    navigator.clipboard.writeText(output).then(() => {
      showNotification('DOM 结构已复制到剪贴板! 请粘贴给 Claude 分析~');
      console.log('[Claude Enhance] DOM structure copied to clipboard');
    }).catch(err => {
      console.error('[Claude Enhance] Failed to copy:', err);

      console.log('[Claude Enhance] DOM Structure:\n', output);
      showNotification('复制失败, 请查看控制台 (F12)');
    });
  }

  function analyzeElement(el, depth, maxDepth) {
    if (depth > maxDepth) return { truncated: true };

    const info = {
      tag: el.tagName,
      className: toClassName(el.className) || null,
      id: el.id || null,
      childCount: el.children.length
    };

    const attrs = ['role', 'data-message', 'data-turn', 'data-type', 'data-testid'];
    attrs.forEach(attr => {
      if (el.hasAttribute(attr)) {
        info[attr] = el.getAttribute(attr);
      }
    });

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
      (document.body || document.documentElement)?.appendChild(notification);
    }
    notification.textContent = message;
    notification.style.display = 'block';
    notification.style.opacity = '1';
    setTimeout(() => {
      notification.style.opacity = '0';
      setTimeout(() => { notification.style.display = 'none'; }, 300);
    }, 2000);
  }

  // ===== Enhancement cycle and init =====

  function scrollToBottomIfNeeded() {

    const msgContainer = document.querySelector('[class*="messagesContainer_"]');
    let container = msgContainer;
    while (container && container !== document.body) {
      const style = window.getComputedStyle(container);
      if (/(auto|scroll)/.test(style.overflowY)) break;
      container = container.parentElement;
    }
    if (!container || container === document.body) {
      container = document.scrollingElement || document.documentElement;
    }
    if (!container) return;

    const threshold = 150;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    if (atBottom) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }

  let _lastContentHash = '';

  function getContentHash() {
    const roots = getEnhanceRoots();
    if (!roots.length) return '';

    return roots.map(r => `${r.textContent?.length || 0}:${(r.textContent || '').slice(0, 50)}`).join('|');
  }

  // Full enhancement pass. Sets _enhancing so the Observer ignores the DOM
  // changes it makes; zoom only re-applies when content actually changed.
  function runEnhancementCycle() {
    _enhancing = true;
    try {

      scrollToBottomIfNeeded();
      safeRun('renderApiErrors', renderApiErrors);
      safeRun('highlightAllCode', highlightAllCode);
      safeRun('renderLaTeX', renderLaTeX);
      safeRun('scanAndAddCopyButtons', scanAndAddCopyButtons);

      const hash = getContentHash();
      if (hash !== _lastContentHash) {
        _lastContentHash = hash;
        safeRun('applyContentZoom', () => applyContentZoom(getStoredZoom()));
      }

      scrollToBottomIfNeeded();
    } finally {
      _enhancing = false;
    }
  }

  function init() {
    console.log('[Claude Enhance] Initializing...');
    safeRun('injectStyles', injectStyles);
    safeRun('markHighlightJSReady', markHighlightJSReady);
    safeRun('injectKaTeX', injectKaTeX);
    safeRun('setupZoom', setupZoom);
    safeRun('setupObserver', setupObserver);
    safeRun('setupDOMInspector', setupDOMInspector);

    runEnhancementCycle();

    setTimeout(runEnhancementCycle, 1000);
    setTimeout(runEnhancementCycle, 3000);
  }

  if (window.__CLAUDE_ENHANCE_TEST_MODE__) {
    window.__CLAUDE_ENHANCE_TEST_API__ = {
      findMathSpans,
      getCodeLanguage,
      hasMarkdownUnderscoreEmphasis,
      parseApiErrorText,
      isProseHeavyLatex,
      isDimensionLatexFormula,
      parseMalformedDimensionText,
      isRenderableLatexFormula,
      looksLikeLatex,
      normalizeLatexForRender,
      renderLatexHtml,
    };
    return;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
