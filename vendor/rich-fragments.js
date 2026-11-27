(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__CLAUDE_ENHANCE_RICH_FRAGMENTS__ = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  const tokens = () => /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|&(?:#x[\da-f]+|#\d+|\w+);|[^<&]+|[<&]/gi;
  const voidTags = new Set(['br', 'hr', 'img', 'input', 'wbr', 'source', 'area', 'col', 'embed', 'link', 'meta', 'param']);
  const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

  function decode(value) {
    return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|#39|#x27|nbsp);/gi, (raw, entity) => {
      if (entity[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })[entity.toLowerCase()] || raw;
      const point = Number.parseInt(entity.slice(/^#x/i.test(entity) ? 2 : 1), /^#x/i.test(entity) ? 16 : 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd';
    });
  }

  function splitHtml(html, limit = 8192) {
    const parts = [];
    const stack = [];
    const pattern = tokens();
    let current = '';
    let text = '';
    let atomic = 0;
    let match;
    const flush = () => {
      if (!text && !current) return;
      parts.push({ html: current + stack.slice().reverse().map((entry) => `</${entry.tag}>`).join(''), text });
      current = stack.map((entry) => entry.open).join('');
      text = '';
    };
    while ((match = pattern.exec(html))) {
      const value = match[0];
      const tag = /^<(\/?)([\w-]+)/.exec(value);
      if (!tag && !atomic && text && current.length >= 32768) flush();
      if (tag) {
        const name = tag[2].toLowerCase();
        if (tag[1]) {
          current += value;
          const index = stack.findLastIndex((entry) => entry.tag === name);
          if (index >= 0) {
            for (const entry of stack.splice(index)) if (entry.atomic) atomic--;
          }
        } else {
          const protectedNode = /\bce-math-source\b/.test(value);
          if (protectedNode && text.length >= limit) flush();
          current += value;
          if (!voidTags.has(name) && !value.endsWith('/>')) {
            stack.push({ tag: name, open: value, atomic: protectedNode });
            if (protectedNode) atomic++;
          }
        }
        continue;
      }
      if (value.startsWith('<!')) continue;
      const segments = !atomic && value.length > limit ? graphemes?.segment(value) : null;
      for (let offset = 0; offset < value.length;) {
        if (!atomic && text.length >= limit) flush();
        let end = atomic || value[0] === '&' ? value.length : Math.min(value.length, offset + limit - text.length);
        if (segments && end < value.length) {
          const segment = segments.containing(end);
          if (segment.index < end) end = segment.index + segment.segment.length;
        }
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end++;
        while (end < value.length && /[\p{Mark}\u200d\ufe0f]/u.test(String.fromCodePoint(value.codePointAt(end)))) {
          const joining = value[end] === '\u200d';
          end += String.fromCodePoint(value.codePointAt(end)).length;
          if (joining && end < value.length) end += String.fromCodePoint(value.codePointAt(end)).length;
        }
        const piece = value.slice(offset, end);
        current += piece;
        text += decode(piece);
        offset = end;
      }
    }
    if (text || !parts.length) flush();
    else if (current) parts.at(-1).html += current;
    return parts;
  }

  function splitMath(html, limit = 32768) {
    const pattern = tokens();
    const stack = [];
    const bases = [];
    let visualDepth = -1;
    let visualStart = -1;
    let visualHtml = '';
    let baseStart = -1;
    let match;
    while ((match = pattern.exec(html))) {
      const tag = /^<(\/?)([\w-]+)/.exec(match[0]);
      if (!tag) continue;
      if (!tag[1]) {
        if (/class="katex-html"/.test(match[0])) { visualDepth = stack.length; visualStart = pattern.lastIndex; }
        else if (stack.length === visualDepth + 1 && /class="base"/.test(match[0])) baseStart = match.index;
        if (!voidTags.has(tag[2]) && !match[0].endsWith('/>')) stack.push(tag[2]);
      } else {
        stack.pop();
        if (baseStart >= 0 && stack.length === visualDepth + 1) {
          bases.push(html.slice(baseStart, pattern.lastIndex));
          baseStart = -1;
        }
        if (stack.length === visualDepth) {
          visualHtml = html.slice(visualStart, match.index);
          visualDepth = -1;
        }
      }
    }
    if (bases.length < 2 || bases.join('') !== visualHtml) return [{ html, text: '' }];
    const parts = [];
    let current = '';
    const display = /class="katex-display"/.test(html);
    const flush = () => {
      if (!current) return;
      const visual = `<span class="katex"><span class="katex-html">${current}</span></span>`;
      parts.push({ html: display ? `<span class="katex-display">${visual}</span>` : visual, text: '' });
      current = '';
    };
    for (const base of bases) {
      if (current.length + base.length > limit) flush();
      current += base;
    }
    flush();
    return parts;
  }

  return { splitHtml, splitMath, decode };
});
