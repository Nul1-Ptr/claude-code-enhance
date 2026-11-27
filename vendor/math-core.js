(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__CLAUDE_ENHANCE_MATH_CORE__ = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  const TEXT_COMMANDS = new Set(['texttt', 'textrm', 'textsf', 'textit', 'textbf', 'textnormal',
    'textmd', 'textup', 'emph', 'hbox', 'text', 'mbox']);
  const KATEX_OPTIONS = Object.freeze({ output: 'htmlAndMathml', strict: 'ignore',
    throwOnError: true, trust: false, maxExpand: 1000, maxSize: 50 });
  const caches = new WeakMap();

  function isEscapedLatexCharacter(text, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes++;
    return slashes % 2 === 1;
  }

  function escapeUnescapedTextSpecials(text) {
    let output = '';
    for (let index = 0; index < text.length; index++) {
      if ('_%#&$'.includes(text[index]) && !isEscapedLatexCharacter(text, index)) output += '\\';
      output += text[index];
    }
    return output;
  }

  function findBalancedLatexGroupEnd(text, openIndex) {
    if (text[openIndex] !== '{') return -1;
    let depth = 1;
    for (let index = openIndex + 1; index < text.length; index++) {
      if (isEscapedLatexCharacter(text, index)) continue;
      if (text[index] === '{') depth++;
      if (text[index] === '}' && --depth === 0) return index;
    }
    return -1;
  }

  function normalizeLatexTextCommands(formula) {
    const source = String(formula || '');
    let output = '';
    for (let index = 0; index < source.length;) {
      if (source[index] !== '\\' || isEscapedLatexCharacter(source, index)) {
        output += source[index++];
        continue;
      }
      const commandMatch = source.slice(index + 1).match(/^([A-Za-z]+)/);
      if (!commandMatch || !TEXT_COMMANDS.has(commandMatch[1])) {
        output += source[index++];
        continue;
      }
      const command = commandMatch[1];
      const commandEnd = index + 1 + command.length;
      let openIndex = commandEnd;
      while (openIndex < source.length && /\s/.test(source[openIndex])) openIndex++;
      if (source[openIndex] !== '{') { output += source[index++]; continue; }
      const closeIndex = findBalancedLatexGroupEnd(source, openIndex);
      if (closeIndex === -1) { output += source.slice(index); break; }
      const content = normalizeLatexTextCommands(source.slice(openIndex + 1, closeIndex));
      output += `\\${command === 'mbox' ? 'text' : command}${source.slice(commandEnd, openIndex)}{${escapeUnescapedTextSpecials(content)}}`;
      index = closeIndex + 1;
    }
    return output;
  }

  function repairUnsupportedKatexMacros(formula) {
    return String(formula || '').replace(/\\mathds(?=\s*\{)/g, '\\mathbb');
  }

  function uniqueLatexCandidates(items) {
    return Array.from(new Set(items.filter((item) => typeof item === 'string' && item.trim())));
  }

  function repairLatexForKatexError(formula, error, displayMode) {
    const message = String(error?.message || '');
    const candidates = [];
    if (/Undefined control sequence/.test(message)) candidates.push(repairUnsupportedKatexMacros(formula));
    if (/got '[_#&$]'|Unexpected end of input in a macro argument|Expected '\$'/.test(message)) {
      candidates.push(normalizeLatexTextCommands(formula));
    }
    if (displayMode && /got '&'|Expected 'EOF'/.test(message) && formula.includes('&')) {
      candidates.push(`\\begin{aligned}\n${formula}\n\\end{aligned}`);
    }
    candidates.push(normalizeLatexTextCommands(repairUnsupportedKatexMacros(formula)));
    return uniqueLatexCandidates(candidates);
  }

  function normalizeLatexFormula(formula) {
    return normalizeLatexTextCommands(formula)
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
      .replace(/\\(sum|prod|int|lim|inf|sup|max|min)\{([^}]+)\}/g, '\\$1_{$2}');
  }

  function normalizeLatexForRender(formula, displayMode) {
    return displayMode ? normalizeDisplayLatexFormula(formula) : normalizeLatexFormula(formula);
  }

  function stripToolOutputLinePrefix(line, mode) {
    if (mode === 'numbered-quote') return line.replace(/^[ \t]*\d+[ \t]*>[ \t]*/, '');
    if (mode === 'numbered') return line.replace(/^[ \t]*\d+[ \t]*[|:][ \t]*/, '');
    if (mode === 'numbered-tab') return line.replace(/^[ \t]*\d+\t[ \t]*/, '');
    if (!mode.startsWith('quote:')) return line;
    const depth = Number.parseInt(mode.slice('quote:'.length), 10) || 1;
    let output = line;
    for (let index = 0; index < depth; index++) {
      const next = output.replace(/^[ \t]*>[ \t]?/, '');
      if (next === output) break;
      output = next;
    }
    return output;
  }

  function normalizeToolOutputMathFormula(formula, mode) {
    const source = String(formula || '');
    return mode && source.includes('\n')
      ? source.split('\n').map((line) => stripToolOutputLinePrefix(line, mode)).join('\n').trim() : source;
  }

  function looksLikeCodeDollarFormula(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return false;
    if (/\$(?:\{?[A-Za-z_][\w]*|\d+)/.test(cleaned) || /^\{?[A-Za-z_][\w]*(?:\{|\[)$/.test(cleaned)) return true;
    return /(?:;|&&|\|\||=>|::|\+\+|--|<\w+>|["'`]\s*\w)/.test(cleaned) &&
      /\b(?:if|else|while|for|foreach|print|next|return|defined|keys|open|close)\b/.test(cleaned);
  }

  function analyzeFormulaSignals(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    return { cleaned,
      macroCount: (cleaned.match(/\\[A-Za-z]+/g) || []).length,
      wordCount: (cleaned.match(/[A-Za-z]{2,}/g) || []).length,
      operatorCount: (cleaned.match(/[_^=+\-*/<>×]/g) || []).length,
      hasStructure: /[{}\[\]]/.test(cleaned), hasDigit: /\d/.test(cleaned),
      hasMathFunction: /\b(?:sin|cos|tan|log|ln|exp|det|rank|dim|max|min|arg)\b/i.test(cleaned),
      hasProseConnector: /\b(?:and|or|is|are|was|were|the|to|of|for|with|from|then|shell|cost)\b/i.test(cleaned) };
  }

  function looksLikeAmbiguousDollarProse(text) {
    const signals = analyzeFormulaSignals(text);
    if (!signals.cleaned || !signals.wordCount || !/\s/.test(signals.cleaned)) return false;
    if (signals.macroCount || signals.operatorCount || signals.hasStructure || signals.hasMathFunction) return false;
    return signals.hasProseConnector || signals.wordCount > 1;
  }

  function hasMarkdownUnderscoreEmphasis(text) {
    return /(^|[^\w\\])_[^_\n]{2,}_(?=[^\w]|$)/.test(text);
  }

  function isProseHeavyLatex(text, displayMode) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return true;
    const macros = (cleaned.match(/\\[a-zA-Z]+/g) || []).length;
    const cjk = (cleaned.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const words = (cleaned.match(/[A-Za-z]{3,}/g) || []).length;
    const punctuation = (cleaned.match(/[，。；：、]|[.!?]\s+[A-Z]/g) || []).length;
    if (!displayMode && cleaned.length > 240 && words > 20 && macros < 4) return true;
    if (cleaned.length > 120 && macros < 4 && hasMarkdownUnderscoreEmphasis(cleaned)) return true;
    if (cleaned.length > 120 && cjk > 12 && macros < 4) return true;
    if (cleaned.length > 180 && cjk > 12 && punctuation > 1) return true;
    return cleaned.length > 220 && words > 20 && macros < 4;
  }

  function create(katex, onCandidate) {
    let state = caches.get(katex);
    if (!state) { state = { cache: new Map(), characters: 0 }; caches.set(katex, state); }
    const cache = state.cache;
    function remember(key, result) {
      const characters = key.length + (result.html?.length || 0);
      if (key.length > 4096 || characters > 256 * 1024) return result;
      cache.set(key, { result, characters });
      state.characters += characters;
      while (cache.size > 512 || state.characters > 1024 * 1024) {
        const oldest = cache.keys().next().value;
        state.characters -= cache.get(oldest).characters;
        cache.delete(oldest);
      }
      return result;
    }

    function prepareLatexForKatex(formula, displayMode) {
      const original = String(formula || '');
      const key = `${displayMode ? 'D' : 'I'}:${original}`;
      const cached = cache.get(key);
      if (cached) { cache.delete(key); cache.set(key, cached); return cached.result; }
      const queue = uniqueLatexCandidates([normalizeLatexForRender(original, displayMode)]);
      const seen = new Set(queue);
      let lastError = null;
      for (let index = 0; index < queue.length && index < 8; index++) {
        const candidate = queue[index];
        try {
          const html = katex.renderToString(candidate, { ...KATEX_OPTIONS, displayMode });
          return remember(key, { ok: true, formula: candidate, original, html,
            repaired: candidate !== original, attempts: index + 1, error: null });
        } catch (error) {
          lastError = error;
          for (const next of repairLatexForKatexError(candidate, error, displayMode)) {
            if (!seen.has(next)) { seen.add(next); queue.push(next); }
          }
        }
      }
      return remember(key, { ok: false, formula: queue.at(-1) || original, original, repaired: false,
        attempts: Math.min(queue.length, 8), error: lastError });
    }

    function classifyStructuredMathCandidate(candidate) {
      const formula = String(candidate?.formula || '').trim();
      const source = normalizeToolOutputMathFormula(formula, candidate?.toolOutputLinePrefixMode || '');
      const signals = analyzeFormulaSignals(source);
      let reason = '';
      if (!formula || !source) reason = 'empty';
      else if (looksLikeCodeDollarFormula(source) || (candidate?.delimiter === 'dollar-inline' && candidate?.raw?.startsWith('${'))) reason = 'code-like';
      else if (looksLikeAmbiguousDollarProse(source)) reason = 'ambiguous-prose';
      else if (isProseHeavyLatex(source, !!candidate?.displayMode)) reason = 'prose-heavy';
      const preparation = reason ? { ok: false, formula, original: formula, repaired: false,
        attempts: 0, skipped: true, error: null, reason } : prepareLatexForKatex(source, !!candidate?.displayMode);
      const decision = preparation.ok ? 'render' : 'literal';
      reason ||= preparation.ok ? preparation.repaired ? 'validated-after-repair' : 'validated' : 'invalid-latex';
      const confidence = decision === 'render'
        ? candidate?.delimiterConfidence === 'high' || signals.macroCount || signals.operatorCount || signals.hasStructure ? 'high' : 'medium'
        : 'low';
      const result = { ...candidate, formula, renderFormula: preparation.ok ? preparation.formula : formula,
        preparation, decision, reason, confidence, signals };
      onCandidate?.(result);
      return result;
    }

    function render(formula, displayMode) {
      const prepared = prepareLatexForKatex(formula, displayMode);
      if (!prepared.ok) throw prepared.error || new Error('Unable to render formula');
      return prepared.html;
    }

    return Object.freeze({ prepareLatexForKatex, classifyStructuredMathCandidate, render });
  }

  return Object.freeze({ create, KATEX_OPTIONS, normalizeLatexForRender, normalizeLatexTextCommands,
    repairUnsupportedKatexMacros, repairLatexForKatexError, analyzeFormulaSignals,
    looksLikeCodeDollarFormula, looksLikeAmbiguousDollarProse, isProseHeavyLatex,
    hasMarkdownUnderscoreEmphasis, normalizeToolOutputMathFormula });
});
