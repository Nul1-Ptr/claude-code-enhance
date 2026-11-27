(function(root) {
  'use strict';
  if (!root.document) return;
  const document = root.document;

  class RichParts extends root.HTMLElement {
    constructor() {
      super();
      this.partIndex = 0;
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      if (!this.content) {
        if (this.options.position) {
          this.partIndex = Math.min(this.options.count - 1, this.options.position.part || 0);
          this.expanded = this.options.position.expanded;
          this.initialPosition = this.options.position;
        }
        for (const link of document.querySelectorAll('link[rel="stylesheet"]')) this.shadowRoot.append(link.cloneNode());
        const style = document.createElement('style');
        style.textContent = `:host{display:block;min-width:0;white-space:normal}.content{overflow:auto;max-height:60vh;overflow-wrap:anywhere}
          :host([data-code]) .content{white-space:pre;font-family:var(--vscode-editor-font-family,monospace)}
          .katex{font-size:var(--ce-inline-math-size,1.1em)}.katex-display>.katex{font-size:var(--ce-display-math-size,1.6em)}
          nav{display:flex;gap:8px;align-items:center;font:12px sans-serif;white-space:normal}
          button{font:inherit;cursor:pointer}::highlight(ce-search){background:Highlight;color:HighlightText}`;
        this.content = document.createElement('div');
        this.content.className = 'content';
        this.content.tabIndex = 0;
        this.content.setAttribute('role', 'region');
        this.content.setAttribute('aria-label', this.options.math ? 'Formula fragment' : 'Content fragment');
        const navigation = document.createElement('nav');
        navigation.setAttribute('aria-label', 'Content fragments');
        this.label = document.createElement('span');
        this.label.setAttribute('role', 'status');
        this.previous = document.createElement('button');
        this.previous.textContent = 'Previous fragment';
        this.next = document.createElement('button');
        this.next.textContent = 'Next fragment';
        this.expand = document.createElement('button');
        this.expand.textContent = 'Show entire block';
        this.previous.onclick = () => { this.partIndex--; this.ready = this.renderPart(); };
        this.next.onclick = () => { this.partIndex++; this.ready = this.renderPart(); };
        this.expand.onclick = () => { this.expanded = !this.expanded; this.ready = this.renderPart(); };
        navigation.append(this.previous, this.label, this.next, this.expand);
        this.shadowRoot.append(style, navigation, this.content);
        this.dataset.totalParts = String(this.options.count);
      }
      this.ready = this.renderPart();
    }

    disconnectedCallback() { this.controller?.abort(); }

    async renderPart(query, isCurrent = () => true) {
      this.controller?.abort();
      const controller = new AbortController();
      this.controller = controller;
      this.previous.disabled = this.next.disabled = this.expand.disabled = true;
      try {
        const result = await this.options.request({ part: this.partIndex, expanded: !!this.expanded, pair: !!query }, controller.signal);
        const content = await this.options.fragment(result.html, controller.signal, this.options.code || result.trusted);
        if (controller.signal.aborted || !this.isConnected || !isCurrent()) return;
        this.content.replaceChildren(content);
        await this.options.hydrate(this.content, controller.signal);
        if (controller.signal.aborted || !this.isConnected || !isCurrent()) return;
        this.dataset.part = String(this.partIndex);
        this.dataset.expanded = String(!!this.expanded);
        this.label.textContent = this.expanded ? `All ${result.count} fragments` : `Fragment ${this.partIndex + 1} / ${result.count}`;
        this.expand.textContent = this.expanded ? 'Show fragments' : 'Show entire block';
        this.content.scrollTop = this.initialPosition?.top || 0;
        this.content.scrollLeft = this.initialPosition?.left || 0;
        this.initialPosition = null;
        this.dispatchEvent(new root.CustomEvent('ce-rich-resize', { bubbles: true, composed: true }));
        if (query) this.dataset.searchMatch = String(this.options.reveal(this.content, query));
      } catch (error) {
        if (error.name !== 'AbortError') this.label.textContent = 'Fragment could not be loaded. Try again.';
      } finally {
        if (this.controller === controller) {
          this.previous.disabled = this.expanded || this.partIndex <= 0;
          this.next.disabled = this.expanded || this.partIndex + 1 >= this.options.count;
          this.expand.disabled = false;
        }
      }
    }

    async reveal(part, query, isCurrent = () => true) {
      if (!this.isConnected || !isCurrent()) return;
      this.partIndex = Math.max(0, Math.min(this.options.count - 1, Number(part) || 0));
      this.expanded = false;
      this.ready = this.renderPart(query, isCurrent);
      await this.ready;
      if (this.isConnected && isCurrent()) this.content.focus({ preventScroll: true });
    }

    position() {
      return { part: this.partIndex, expanded: !!this.expanded, top: this.content.scrollTop, left: this.content.scrollLeft };
    }
  }

  class RichRows extends root.HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.start = -1;
      this.frame = null;
      this.generation = 0;
    }

    connectedCallback() {
      if (!this.viewport) this.createShell();
      this.ready = this.renderRows();
    }

    disconnectedCallback() {
      this.controller?.abort();
      root.cancelAnimationFrame(this.frame);
      this.generation++;
    }

    createShell() {
      const { count, kind, config } = this.options;
      this.initialPosition = this.options.position;
      this.dataset.totalRows = String(count);
      for (const link of document.querySelectorAll('link[rel="stylesheet"]')) this.shadowRoot.append(link.cloneNode());
      const style = document.createElement('style');
      style.textContent = `:host{display:block;min-width:0}.viewport{height:min(60vh,420px);overflow:auto;overflow-anchor:none}
        .lines{font-family:var(--vscode-editor-font-family,monospace);line-height:22px;min-width:max-content}
        .line{min-height:22px;white-space:pre}.line:has(ce-rich-parts){height:auto;max-width:min(80vw,1000px)}
        table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--vscode-panel-border);padding:6px;max-width:80vw}
        ::highlight(ce-search){background:Highlight;color:HighlightText}
        button{font:inherit;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:3px 8px}
        .status{font-size:12px;color:var(--vscode-descriptionForeground)}`;
      this.viewport = document.createElement('div');
      this.viewport.className = 'viewport';
      this.viewport.tabIndex = 0;
      this.viewport.setAttribute('role', 'region');
      this.viewport.setAttribute('aria-label', kind === 'code' ? 'Code output' : 'Table output');
      this.status = document.createElement('div');
      this.status.className = 'status';
      this.heights = root.__CLAUDE_ENHANCE_SUBAGENT_VIEW__.createHeightIndex(
        Array.from({ length: count }, (_, index) => ({ key: index })), new Map(), kind === 'code' ? 22 : 36);
      this.viewport.addEventListener('scroll', () => {
        if (this.frame !== null) return;
        this.frame = root.requestAnimationFrame(() => { this.frame = null; this.ready = this.renderRows(); });
      }, { passive: true });
      this.addEventListener('ce-rich-resize', () => this.measureRows());
      this.shadowRoot.append(style, this.status, this.viewport);
      if (config.copyButtons !== false) {
        const copy = document.createElement('button');
        copy.textContent = kind === 'code' ? 'Copy code' : 'Copy table';
        copy.onclick = async () => {
          try {
            const result = await this.options.request({ copy: true });
            await root.navigator.clipboard.writeText(result.source);
            copy.textContent = 'Copied';
          } catch { copy.textContent = 'Copy failed'; }
        };
        this.shadowRoot.append(copy);
      }
    }

    async renderRows() {
      const { count, kind, fragment, config } = this.options;
      const first = this.initialPosition?.row ?? this.heights.indexAt(this.viewport.scrollTop);
      const start = Math.max(0, Math.min(count - 1, first) - 8);
      if (start === this.start && this.viewport.childNodes.length) return;
      const generation = ++this.generation;
      this.controller?.abort();
      const controller = new AbortController();
      this.controller = controller;
      try {
        const result = await this.options.request({ start, highlight: config.syntaxHighlighting !== false }, controller.signal);
        if (!this.isConnected || controller.signal.aborted || generation !== this.generation) return;
        const content = document.createDocumentFragment();
        const top = document.createElement('div');
        const bottom = document.createElement('div');
        top.style.height = `${this.heights.sum(0, start)}px`;
        bottom.style.height = `${this.heights.sum(result.end, count)}px`;
        content.append(top);
        let rows;
        if (kind === 'code') {
          const lines = document.createElement('code');
          lines.className = 'lines hljs';
          lines.style.display = 'block';
          let started = root.performance.now();
          for (const [offset, html] of result.lines.entries()) {
            const line = document.createElement('div');
            line.className = 'line';
            line.dataset.row = String(start + offset);
            if (html.parts) line.append(this.options.parts(html.parts, { code: true,
              position: this.initialPosition?.parts?.[html.parts.partKey] }));
            else line.append(await fragment(html || ' ', controller.signal, true));
            lines.append(line);
            if (root.performance.now() - started >= 6) {
              await new Promise(root.requestAnimationFrame);
              if (controller.signal.aborted) return;
              started = root.performance.now();
            }
          }
          rows = Array.from(lines.children);
          content.append(lines);
        } else {
          const table = await fragment(result.html, controller.signal);
          for (const cell of result.cells || []) {
            const row = cell.row < 0 ? table.querySelector('thead tr') : table.querySelectorAll('tbody tr')[cell.row - start];
            row?.children[cell.column]?.append(this.options.parts(cell.parts, { position: this.initialPosition?.parts?.[cell.parts.partKey] }));
          }
          await this.options.hydrate(table, controller.signal);
          rows = Array.from(table.querySelectorAll('tbody tr'));
          rows.forEach((row, offset) => { row.dataset.row = String(start + offset); });
          content.append(table);
        }
        content.append(bottom);
        if (!this.isConnected || controller.signal.aborted || generation !== this.generation) return;
        const scrollTop = this.viewport.scrollTop;
        const anchor = this.heights.indexAt(scrollTop);
        const previousTop = this.heights.sum(0, anchor);
        this.viewport.replaceChildren(content);
        await Promise.all(Array.from(this.viewport.querySelectorAll('ce-rich-parts'), (part) => part.ready));
        if (controller.signal.aborted || generation !== this.generation) return;
        this.renderedRows = rows;
        this.spacers = { top, bottom, end: result.end };
        for (const [offset, row] of rows.entries()) this.heights.update(start + offset, row.getBoundingClientRect().height);
        top.style.height = `${this.heights.sum(0, start)}px`;
        bottom.style.height = `${this.heights.sum(result.end, count)}px`;
        this.viewport.scrollTop = this.initialPosition
          ? this.heights.sum(0, this.initialPosition.row) + this.initialPosition.offset
          : scrollTop + this.heights.sum(0, anchor) - previousTop;
        if (this.initialPosition) this.viewport.scrollLeft = this.initialPosition.left;
        this.initialPosition = null;
        this.start = start;
        this.status.textContent = count ? `${start + 1}–${result.end} / ${count} ${kind === 'code' ? 'lines' : 'rows'}` : 'Table header';
        this.dataset.mountedRows = String(rows.length);
      } catch (error) {
        if (error.name !== 'AbortError') this.status.textContent = 'Rows could not be loaded. Scroll to retry.';
      }
    }

    measureRows() {
      if (!this.renderedRows || !this.spacers || this.start < 0) return;
      const anchor = this.heights.indexAt(this.viewport.scrollTop);
      const before = this.heights.sum(0, anchor);
      for (const [offset, row] of this.renderedRows.entries()) this.heights.update(this.start + offset, row.getBoundingClientRect().height);
      this.spacers.top.style.height = `${this.heights.sum(0, this.start)}px`;
      this.spacers.bottom.style.height = `${this.heights.sum(this.spacers.end, this.options.count)}px`;
      this.viewport.scrollTop += this.heights.sum(0, anchor) - before;
    }

    position() {
      const row = this.heights.indexAt(this.viewport.scrollTop);
      return { row, offset: this.viewport.scrollTop - this.heights.sum(0, row), left: this.viewport.scrollLeft,
        parts: Object.fromEntries(Array.from(this.viewport.querySelectorAll('ce-rich-parts'), (part) => [part.options.partKey, part.position()])) };
    }

    async reveal(location, isCurrent = () => true) {
      await this.ready;
      if (!this.isConnected || !isCurrent()) return false;
      this.viewport.scrollTop = this.heights.sum(0, Math.max(0, location.row || 0));
      this.start = -1;
      this.ready = this.renderRows();
      await this.ready;
      if (!this.isConnected || !isCurrent()) return false;
      const row = location.row < 0 ? this.viewport.querySelector('thead tr') :
        this.viewport.querySelector(`[data-row="${location.row}"]`);
      const target = Number.isInteger(location.cell) ? row?.children[location.cell] : row;
      target?.scrollIntoView({ block: 'center', inline: 'nearest' });
      const part = target?.querySelector('ce-rich-parts');
      if (part) await part.reveal(location.part, location.query, isCurrent);
      else if (target) this.options.reveal(target, location.query);
      this.measureRows();
      return (part || target)?.dataset.searchMatch === 'true';
    }
  }

  if (!root.customElements.get('ce-rich-parts')) root.customElements.define('ce-rich-parts', RichParts);
  if (!root.customElements.get('ce-rich-rows')) root.customElements.define('ce-rich-rows', RichRows);
})(typeof window !== 'undefined' ? window : globalThis);
