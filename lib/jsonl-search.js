'use strict';

const { foldSearch: fold } = require('../vendor/runtime-core');

function childContext(parent, key) {
  const area = parent?.context?.area || 'root';
  if (area === 'root') {
    if (key === 'message') return { area: 'message' };
    if (key === 'error') return { area: 'error', search: true };
    if (key === 'type') return { area: 'ignored', role: true };
    return { area: 'ignored', search: ['attributionAgent', 'timestamp'].includes(key) };
  }
  if (area === 'message') {
    if (key === 'content') return { area: 'content', search: true };
    return { area: 'ignored', role: key === 'role', search: ['role', 'model', 'stop_reason'].includes(key) };
  }
  if (area === 'input' || area === 'error') return { area, search: true, keys: true };
  if (area === 'content') {
    if (key === 'input') return { area: 'input', search: true, keys: true };
    return { area, search: !['id', 'tool_use_id', 'type', 'signature'].includes(key), type: key === 'type', error: key === 'is_error' };
  }
  return { area: 'ignored' };
}

function createJsonlSearch(query, filter = 'all') {
  const needle = fold(query);
  const stack = [];
  let rootDone = false;
  let invalid = false;
  let mode = '';
  let context;
  let keyString = false;
  let keyValue = '';
  let keyOverflow = false;
  let escaped = false;
  let unicode = null;
  let literal = '';
  let numberState = '';
  let decoded = '';
  let carry = '';
  let matched = !needle;
  const facets = new Set();

  function matchText(value) {
    if (!needle || matched) return;
    const text = carry + fold(value);
    if (text.includes(needle)) matched = true;
    carry = needle.length > 1 ? text.slice(-(needle.length - 1)) : '';
  }

  function flushString() {
    if (context?.search) matchText(decoded);
    if (!keyString && context?.area === 'error' && decoded) facets.add('errors');
    if (keyString || context?.type || context?.role) {
      if (keyValue.length + decoded.length <= 512) keyValue += decoded;
      else keyOverflow = true;
    }
    decoded = '';
  }

  function finishValue() {
    const parent = stack.at(-1);
    if (!parent) rootDone = true;
    else parent.state = 'separator';
  }

  function valueContext() {
    const parent = stack.at(-1);
    if (!parent) return { area: 'root' };
    return parent.kind === 'array' ? parent.context : childContext(parent, parent.key);
  }

  function beginScalar(nextMode, nextContext) {
    mode = nextMode;
    context = nextContext;
    carry = '';
    decoded = '';
    keyValue = '';
    keyOverflow = false;
  }

  function finishScalar() {
    if (mode === 'number' && !['integer', 'zero', 'fraction', 'exponent'].includes(numberState)) invalid = true;
    if (mode === 'literal' && !['true', 'false', 'null'].includes(literal)) invalid = true;
    if (mode === 'literal' && context.search) matchText(literal);
    if (mode === 'literal' && context.error && literal === 'true') facets.add('errors');
    mode = '';
    finishValue();
  }

  function numberCharacter(character) {
    if (/\d/.test(character)) {
      if (numberState === 'sign') numberState = character === '0' ? 'zero' : 'integer';
      else if (numberState === 'point') numberState = 'fraction';
      else if (['exponent-sign', 'exponent-start'].includes(numberState)) numberState = 'exponent';
      else if (numberState === 'zero') invalid = true;
    } else if (character === '.' && ['integer', 'zero'].includes(numberState)) numberState = 'point';
    else if (/[eE]/.test(character) && ['integer', 'zero', 'fraction'].includes(numberState)) numberState = 'exponent-start';
    else if (/[+-]/.test(character) && numberState === 'exponent-start') numberState = 'exponent-sign';
    else invalid = true;
    decoded += character;
    if (decoded.length >= 4096) flushString();
  }

  function write(source) {
    const special = /["\\\u0000-\u001f]/g;
    let nextSpecial = -1;
    for (let cursor = 0; cursor < source.length && !invalid; cursor++) {
      const character = source[cursor];
      if (mode === 'string') {
        if (!escaped && unicode === null && character !== '"' && character !== '\\' && character.charCodeAt(0) >= 32) {
          if (nextSpecial < cursor) {
            special.lastIndex = cursor;
            nextSpecial = special.exec(source)?.index ?? source.length;
          }
          const next = nextSpecial;
          let end = Math.min(next, cursor + 4096);
          if (end < next && /[\uD800-\uDBFF]/.test(source[end - 1])) end++;
          decoded += source.slice(cursor, end);
          cursor = end - 1;
          if (!/[\uD800-\uDBFF]$/.test(decoded)) flushString();
          continue;
        }
        if (unicode !== null) {
          if (!/[0-9a-fA-F]/.test(character)) { invalid = true; break; }
          unicode += character;
          if (unicode.length === 4) {
            decoded += String.fromCharCode(Number.parseInt(unicode, 16));
            unicode = null;
          }
        } else if (escaped) {
          escaped = false;
          if (character === 'u') unicode = '';
          else if ('"\\/bfnrt'.includes(character)) {
            decoded += ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[character] || character;
          } else invalid = true;
        } else if (character === '\\') escaped = true;
        else if (character === '"') {
          flushString();
          mode = '';
          if (keyString) {
            const parent = stack.at(-1);
            parent.key = keyOverflow ? null : keyValue;
            parent.state = 'colon';
          } else {
            if (context.role && keyValue === 'assistant') facets.add('assistant');
            if (context.type && !keyOverflow) {
              const kind = ({ tool_use: 'tool', tool_result: 'tool-result', image: 'attachment' })[keyValue] || keyValue;
              if (kind === 'thinking') facets.add('thinking');
              if (kind === 'tool' || kind === 'tool-result') facets.add('tools');
              if (kind === 'api-error') facets.add('errors');
              carry = '';
              matchText(kind);
            }
            finishValue();
          }
        } else if (character.charCodeAt(0) < 32) invalid = true;
        else decoded += character;
        if (decoded.length >= 4096 && !/[\uD800-\uDBFF]$/.test(decoded)) flushString();
        continue;
      }
      if (mode === 'number' || mode === 'literal') {
        if (!/[ \t\r\n,\]}]/.test(character)) {
          if (mode === 'number') numberCharacter(character);
          else if (literal.length < 5) literal += character;
          else invalid = true;
          continue;
        }
        flushString();
        finishScalar();
      }
      if (/[ \t\r\n]/.test(character)) continue;
      const parent = stack.at(-1);
      if (rootDone && !parent) { invalid = true; break; }
      if (parent?.state === 'colon') {
        if (character !== ':') invalid = true;
        else parent.state = 'value';
        continue;
      }
      if (character === '}' || character === ']') {
        const close = parent?.kind === 'object' ? '}' : ']';
        if (!parent || character !== close || !['first', 'separator'].includes(parent.state)) invalid = true;
        else { stack.pop(); finishValue(); }
        continue;
      }
      if (parent?.state === 'separator') {
        if (character !== ',') invalid = true;
        else parent.state = parent.kind === 'object' ? 'key' : 'value';
        continue;
      }
      keyString = parent?.kind === 'object' && ['first', 'key'].includes(parent.state);
      if (keyString) {
        if (character !== '"') { invalid = true; continue; }
        beginScalar('string', { search: !!parent.context.keys });
        continue;
      }
      const nextContext = valueContext();
      if (character === '{' || character === '[') {
        stack.push({ kind: character === '{' ? 'object' : 'array', state: 'first', context: nextContext, key: null });
      } else if (character === '"') beginScalar('string', nextContext);
      else if (character === '-' || /\d/.test(character)) {
        beginScalar('number', nextContext);
        numberState = character === '-' ? 'sign' : character === '0' ? 'zero' : 'integer';
        decoded = character;
      } else if (/[tfn]/.test(character)) {
        beginScalar('literal', nextContext);
        literal = character;
      } else invalid = true;
    }
  }

  function finish() {
    if (mode === 'number' || mode === 'literal') { flushString(); finishScalar(); }
    return { matched: !invalid && !mode && rootDone && !stack.length && matched && (filter === 'all' || facets.has(filter)),
      valid: !invalid && !mode && rootDone && !stack.length };
  }

  return { write, finish };
}

module.exports = { createJsonlSearch };
