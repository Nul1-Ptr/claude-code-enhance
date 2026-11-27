(function(root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./rich-fragments') : root.__CLAUDE_ENHANCE_RICH_FRAGMENTS__,
    typeof module === 'object' && module.exports ? require('./runtime-core') : root.__CLAUDE_ENHANCE_RUNTIME_CORE__);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__CLAUDE_ENHANCE_RICH_DOCUMENT__ = api;
})(typeof window !== 'undefined' ? window : globalThis, function(fragments, runtime) {
  'use strict';

  function create(view, marked, options = {}) {
    const engine = view.createMarkdownEngine(marked);
    engine.use({ renderer: { codespan(token) {
      const candidate = view.wholeMathCandidate(token.text);
      if (!candidate) return false;
      return `<span class="ce-math-source" data-display="${candidate.display}">${view.escapeHtml(candidate.formula)}</span>`;
    } } });
    const documents = new Map();
    const maximumBytes = options.maximumBytes || 32 * 1024 * 1024;
    const stats = { fullLexes: 0, tailLexes: 0, lexedCharacters: 0, parsedBlocks: 0, cachedBlocks: 0,
      highlightedCharacters: 0, reusedCodeLines: 0 };
    let nextKey = 0;
    const keyPrefix = Math.random().toString(36).slice(2);
    const yieldControl = options.yieldControl || (() => Promise.resolve());

    function rowCount(block) {
      if (block.token.type === 'table') return block.token.rows.length;
      if (block.token.type === 'code') {
        if (block.lineCount === undefined) {
          block.lineCount = 1;
          for (const character of block.token.text) if (character === '\n') block.lineCount++;
        }
        return block.lineCount;
      }
      return 0;
    }

    function touch(id, value) {
      documents.delete(id);
      documents.set(id, value);
      const bytes = (document) => document.source.length * 6 + document.cachedBytes;
      let retainedBytes = Array.from(documents.values()).reduce((total, document) => total + bytes(document), 0);
      while (documents.size > 1 && (documents.size > 16 || retainedBytes > maximumBytes)) {
        const oldest = documents.keys().next().value;
        retainedBytes -= bytes(documents.get(oldest));
        documents.delete(oldest);
      }
      stats.estimatedBytes = retainedBytes;
      stats.documents = documents.size;
    }

    function lex(source, links) {
      stats.lexedCharacters += source.length;
      return engine.lexer(source, { ...engine.defaults, ceReferenceLinks: links });
    }

    function check(signal) {
      if (signal?.aborted) { const error = new Error('Rendering cancelled'); error.name = 'AbortError'; throw error; }
    }

    async function update(payload, signal) {
      check(signal);
      const previous = documents.get(payload.id);
      if (payload.append !== undefined && (!previous || previous.source.length !== payload.baseLength)) return { missing: true };
      const source = payload.append === undefined ? String(payload.source || '') : previous.source + payload.append;
      let normalized;
      let prefix = [];
      let start = 0;
      let tokens;
      let links;
      let guarded;
      if (payload.code) {
        normalized = source.replace(/\r\n?/g, '\n');
        guarded = normalized;
        tokens = [{ type: 'code', raw: normalized, text: normalized, lang: payload.language || '', verbatim: source }];
        links = {};
      } else if (previous && (payload.append !== undefined || source.startsWith(previous.source)) && previous.blocks.length && !previous.source.endsWith('\r')) {
        const last = previous.blocks.at(-1);
        start = last.start;
        prefix = previous.blocks.slice(0, -1);
        normalized = previous.tail + source.slice(previous.source.length).replace(/\r\n?/g, '\n');
        guarded = view.guardMathPipes(normalized);
        const added = lex(guarded, previous.links);
        links = added.links;
        if (JSON.stringify(links) === JSON.stringify(previous.links)) {
          tokens = added;
          stats.tailLexes++;
        } else { start = 0; prefix = []; }
      }
      if (!tokens) {
        normalized = source.replace(/\r\n?/g, '\n');
        guarded = view.guardMathPipes(normalized);
        tokens = lex(guarded);
        links = tokens.links;
        stats.fullLexes++;
      }
      const blocks = prefix.slice();
      let cursor = start;
      const sameLinks = previous && JSON.stringify(previous.links) === JSON.stringify(links);
      let started = Date.now();
      for (const token of tokens) {
        const position = guarded.indexOf(token.raw, cursor - start);
        const tokenStart = position < 0 ? cursor : start + position;
        cursor = tokenStart + token.raw.length;
        if (token.type === 'space' || token.type === 'def') continue;
        const old = sameLinks ? previous?.blocks[blocks.length] : null;
        const block = old && old.token.raw === token.raw && old.token.type === token.type &&
          old.token.lang === token.lang && old.token.verbatim === token.verbatim ? { ...old, start: tokenStart, end: cursor }
          : { key: `${keyPrefix}-${++nextKey}`, token, start: tokenStart, end: cursor, html: null };
        if (old && block.key !== old.key && token.type === old.token.type && token.raw.startsWith(old.token.raw)) {
          block.previousKey = old.key;
        }
        if (old && block.key !== old.key && token.type === 'code' && old.token.type === 'code' &&
            old.token.lang === token.lang && token.text.startsWith(old.token.text) && old.codeState) {
          block.codeState = old.codeState;
          block.cacheBytes = old.codeState.lines.reduce((total, line) => total + line.length * 2, 0);
          if (old.lineCount !== undefined) block.lineCount = old.lineCount + token.text.slice(old.token.text.length).split('\n').length - 1;
        }
        blocks.push(block);
        if (Date.now() - started >= 6) { await yieldControl(); check(signal); started = Date.now(); }
      }
      check(signal);
      const document = { source, blocks, links, version: payload.version,
        tail: blocks.length ? normalized.slice(blocks.at(-1).start - start) : normalized,
        cachedBytes: blocks.reduce((total, block) => total + (block.cacheBytes || 0), 0) };
      touch(payload.id, document);
      return { version: document.version, count: blocks.length,
        blocks: blocks.map((block) => ({ key: block.key, previousKey: block.previousKey,
          type: block.token.type, start: block.start, end: block.end })), stats: { ...stats } };
    }

    async function render(payload, signal) {
      check(signal);
      const document = documents.get(payload.id);
      if (!document || document.version !== payload.version) return { missing: true };
      touch(payload.id, document);
      const items = [];
      let characters = 0;
      let started = Date.now();
      const end = Math.min(document.blocks.length, payload.end);
      for (let index = Math.max(0, payload.start); index < end; index++) {
        const block = document.blocks[index];
        const rows = rowCount(block);
        if (rows > 120 || ((block.token.type === 'code' || block.token.type === 'table') && block.token.raw.length > 16384)) {
          items.push({ index, key: block.key, virtual: { kind: block.token.type, rows } });
          if (items.length >= 16) break;
          continue;
        }
        if (block.html === null) {
          const tokens = [block.token];
          tokens.links = document.links;
          block.html = engine.parser(tokens).replaceAll(view.PIPE_SENTINEL, '|');
          block.cacheBytes = (block.cacheBytes || 0) + block.html.length * 2;
          document.cachedBytes += block.html.length * 2;
          stats.parsedBlocks++;
        } else stats.cachedBlocks++;
        const parts = ['paragraph', 'heading', 'text'].includes(block.token.type)
          ? storeParts(document, block, 'block', block.html) : null;
        items.push({ index, key: block.key, ...(parts ? { parts } : { html: block.html }) });
        characters += block.html.length;
        if (characters >= 128 * 1024 || items.length >= 16) break;
        if (Date.now() - started >= 6) { await yieldControl(); check(signal); started = Date.now(); }
      }
      touch(payload.id, document);
      return { items, stats: { ...stats } };
    }

    function storeParts(document, block, partKey, html, math = false) {
      if (block.parts?.has(partKey)) return { partKey, count: block.parts.get(partKey).parts.length, math };
      if (html.length <= (math ? 65536 : 16384)) return null;
      const parts = math ? fragments.splitMath(html) : fragments.splitHtml(html);
      if (parts.length <= 1) return null;
      block.parts ||= new Map();
      block.parts.set(partKey, { parts, html, math });
      const bytes = html.length * 2 + parts.reduce((total, part) => total + 2 * (part.html.length + part.text.length), 0);
      block.cacheBytes = (block.cacheBytes || 0) + bytes;
      document.cachedBytes += bytes;
      return { partKey, count: parts.length, math };
    }

    async function codeLines(block, signal) {
      if (block.lines) return block.lines;
      const language = view.LANGUAGE_ALIASES?.[block.token.lang] || block.token.lang || 'markdown';
      const previous = block.codeState;
      const reuse = previous?.language === language && block.token.text.startsWith(previous.source) ? previous.restart : 0;
      const source = block.token.text.slice(reuse);
      const leading = reuse ? '\n' : '';
      const highlighted = options.highlight ? await options.highlight(leading + source, language, true) : view.escapeHtml(leading + source);
      const html = (typeof highlighted === 'string' ? highlighted : highlighted.value).slice(leading.length);
      stats.highlightedCharacters += source.length;
      const stack = [];
      const lines = reuse ? previous.lines.slice(0, previous.restartLine) : [];
      stats.reusedCodeLines += lines.length;
      const tokens = /<span\b[^>]*>|<\/span>|\n|[^<\n]+|</g;
      let line = '';
      let token;
      let started = Date.now();
      while ((token = tokens.exec(html))) {
        const value = token[0];
        if (value === '\n') {
          lines.push(line + '</span>'.repeat(stack.length));
          line = stack.join('');
        } else {
          if (value.startsWith('<span')) stack.push(value);
          else if (value === '</span>') stack.pop();
          line += value;
        }
        if (Date.now() - started >= 6) { await yieldControl(); check(signal); started = Date.now(); }
      }
      lines.push(line);
      const checkpoint = typeof highlighted === 'object' && highlighted._ceCheckpoints?.findLast((offset) =>
        offset >= leading.length && offset <= leading.length + source.length - 1024);
      const restart = checkpoint ? reuse + checkpoint - leading.length : reuse;
      const restartLine = checkpoint ? block.token.text.slice(0, restart).split('\n').length - 1 : reuse ? previous.restartLine : 0;
      block.lines = lines;
      const previousBytes = previous?.lines.reduce((total, value) => total + value.length * 2, 0) || 0;
      block.codeState = { source: block.token.text, language, restart, restartLine, lines };
      block.cacheBytes = (block.cacheBytes || 0) - previousBytes + lines.reduce((total, value) => total + value.length * 2, 0);
      return lines;
    }

    async function rows(payload, signal) {
      check(signal);
      const document = documents.get(payload.id);
      if (!document || document.version !== payload.version) return { missing: true };
      const block = document.blocks[payload.index];
      if (!block) return { missing: true };
      if (payload.mathSource !== undefined) {
        block.formulas ||= new Map();
        const formulaKey = `${payload.display ? 'display' : 'inline'}:${payload.mathSource}`;
        let formula = block.formulas.get(formulaKey);
        if (!formula) {
          const html = await options.math(payload.mathSource, payload.display);
          const parts = storeParts(document, block, `math-${block.formulas.size}`, html, true);
          formula = parts ? { parts } : { html };
          block.formulas.set(formulaKey, formula);
          const bytes = html.length * 2 + formulaKey.length * 2;
          block.cacheBytes = (block.cacheBytes || 0) + bytes;
          document.cachedBytes += bytes;
        }
        touch(payload.id, document);
        return formula;
      }
      if (payload.partKey) {
        let partKey = payload.partKey;
        if (!block.parts?.has(payload.partKey)) {
          await render({ ...payload, start: payload.index, end: payload.index + 1 }, signal);
          if (/^line-\d+$/.test(payload.partKey)) await rows({ ...payload, partKey: undefined,
            start: Number(payload.partKey.slice(5)) }, signal);
          if (/^cell--?\d+-\d+$/.test(payload.partKey)) await rows({ ...payload, partKey: undefined,
            start: Math.max(0, Number(/^cell-(-?\d+)/.exec(payload.partKey)[1])) }, signal);
          if (payload.formula) {
            const formula = await rows({ ...payload, partKey: undefined, mathSource: payload.formula.source,
              display: payload.formula.display }, signal);
            partKey = formula.parts?.partKey;
          }
        }
        const entry = block.parts?.get(partKey);
        if (!entry) return { missing: true };
        const part = Math.max(0, Math.min(entry.parts.length - 1, Number(payload.part) || 0));
        const html = payload.expanded ? entry.html : entry.parts.slice(part, part + (payload.pair ? 2 : 1)).map((item) => item.html).join('');
        touch(payload.id, document);
        return { html, part, count: entry.parts.length, trusted: !!entry.math, stats: { ...stats } };
      }
      if (payload.copy) return { source: block.token.type === 'code'
        ? block.token.verbatim ?? block.token.text.replace(/\n$/, '') + '\n' : block.token.raw.replaceAll(view.PIPE_SENTINEL, '|') };
      const count = rowCount(block);
      const start = Math.max(0, Math.min(count, payload.start || 0));
      const end = Math.min(count, start + 80);
      if (block.token.type === 'code') {
        if (payload.highlight === false) {
          block.rawLines ||= block.token.text.split('\n');
          const lines = block.rawLines.slice(start, end).map((line, offset) => {
            const html = view.escapeHtml(line);
            const parts = storeParts(document, block, `line-${start + offset}`, html);
            return parts ? { parts } : html;
          });
          touch(payload.id, document);
          return { start, end, count, kind: 'code', lines };
        }
        const before = block.cacheBytes || 0;
        const lines = await codeLines(block, signal);
        document.cachedBytes += (block.cacheBytes || 0) - before;
        const visibleLines = lines.slice(start, end).map((html, offset) => {
          const parts = storeParts(document, block, `line-${start + offset}`, html);
          return parts ? { parts } : html;
        });
        touch(payload.id, document);
        return { start, end, count, kind: 'code', lines: visibleLines, stats: { ...stats } };
      }
      const cells = [];
      const prepareCell = (cell, row, column) => {
        if (cell.text.length <= 8192) return cell;
        const html = engine.Parser.parseInline(cell.tokens, engine.defaults).replaceAll(view.PIPE_SENTINEL, '|');
        const parts = storeParts(document, block, `cell-${row}-${column}`, html);
        if (!parts) return cell;
        cells.push({ row, column, parts });
        return { ...cell, tokens: [] };
      };
      const tokens = [{ ...block.token, header: block.token.header.map((cell, column) => prepareCell(cell, -1, column)),
        rows: block.token.rows.slice(start, end).map((row, offset) => row.map((cell, column) => prepareCell(cell, start + offset, column))) }];
      tokens.links = document.links;
      touch(payload.id, document);
      return { start, end, count, kind: 'table', html: engine.parser(tokens).replaceAll(view.PIPE_SENTINEL, '|'), cells };
    }

    async function locate(payload, signal) {
      const document = documents.get(payload.id);
      if (!document || document.version !== payload.version) return { missing: true };
      const offset = document.source.slice(0, Math.max(0, payload.offset || 0)).replace(/\r\n?/g, '\n').length;
      const index = Math.max(0, document.blocks.findIndex((block) => block.end > offset));
      const block = document.blocks[index];
      if (!block) return { index: 0, source: true };
      const result = { index, query: payload.query };
      await render({ ...payload, start: index, end: index + 1 }, signal);
      if (block.token.type === 'code') {
        const contentStart = block.token.raw.indexOf(block.token.text);
        const relative = Math.max(0, offset - block.start - Math.max(0, contentStart));
        const before = block.token.text.slice(0, relative);
        result.row = before.split('\n').length - 1;
        result.column = relative - (before.lastIndexOf('\n') + 1);
        await rows({ ...payload, index, start: result.row }, signal);
        result.partKey = `line-${result.row}`;
      } else if (block.token.type === 'table') {
        for (const [row, cells] of [[-1, block.token.header], ...block.token.rows.map((cells, row) => [row, cells])]) {
          const column = cells.findIndex((cell) => runtime.findLiteral(cell.text, payload.query));
          if (column < 0) continue;
          Object.assign(result, { row, cell: column, partKey: `cell-${row}-${column}` });
          await rows({ ...payload, index, start: Math.max(0, row) }, signal);
          break;
        }
      } else result.partKey = 'block';
      const entry = block.parts?.get(result.partKey);
      if (entry) {
        const text = entry.parts.map((part) => part.text).join('');
        const found = runtime.findLiteral(text, payload.query);
        if (found) {
          let cursor = 0;
          result.part = entry.parts.findIndex((part) => {
            cursor += part.text.length;
            return cursor > found.start;
          });
        } else result.source = true;
      }
      return result;
    }

    return { update, render, rows, locate, drop: (id) => documents.delete(id), stats };
  }

  return { create };
});
