'use strict';

const assert = require('assert');
const view = require('../vendor/subagent-view');
const marked = require('../vendor/marked.min');
const { create } = require('../vendor/rich-document');
const hljs = require('../vendor/highlight.min');
const katex = require('../vendor/katex.min');
const { splitHtml, splitMath, decode } = require('../vendor/rich-fragments');
const { findLiteral } = require('../vendor/runtime-core');

async function allLines(documents, id, version, count) {
  const lines = [];
  for (let start = 0; start < count; start += 80) {
    lines.push(...(await documents.rows({ id, version, index: 0, start })).lines);
  }
  return lines;
}

async function testIncrementalHighlighting() {
  const highlight = (source, language, ceCheckpoints) => hljs.highlight(source, { language, ceCheckpoints, ignoreIllegals: true });
  const fixtures = [
    ['javascript', ['/* multi\n', 'line ;\n', 'comment */\nconst tail = 2;\n']],
    ['javascript', ['const value = `one ;\n', '${`nested ${true ? "yes" : "no"}`}\n', 'two`;\nconst tail = 3;\n']],
    ['javascript', ['const matcher = /[a-z/]+/g;\n', 'const text = "escaped\\\" string";\n', 'const more = 3;\n']],
    ['javascript', ['const html = html`<style>\n', 'body { color: red; }\n', '</style>`;\n']],
    ['typescript', ['interface Result { value: string; }\n', 'const result: Result = { value: `one\n', 'two` };\n']],
    ['python', ['value = """first\n', 'second\n', 'third"""\nprint(value)\n']],
    ['json', ['{"first": 1,\n', '"second": "value",\n', '"third": [true, false]}']],
  ];
  for (const [language, additions] of fixtures) {
    const incremental = create(view, marked, { highlight });
    const full = create(view, marked, { highlight });
    let source = language === 'javascript' || language === 'typescript' ? 'const stable = 1;\n'.repeat(2000) : '';
    let version = 0;
    await incremental.update({ id: 'code', source, code: true, language, version });
    await allLines(incremental, 'code', version, source.split('\n').length);
    for (const addition of additions) {
      const baseLength = source.length;
      source += addition;
      version++;
      const before = incremental.stats.highlightedCharacters;
      await incremental.update({ id: 'code', append: addition, baseLength, code: true, language, version });
      await full.update({ id: 'code', source, code: true, language, version: version + 100 });
      const actual = await allLines(incremental, 'code', version, source.split('\n').length);
      const expected = await allLines(full, 'code', version + 100, source.split('\n').length);
      assert.deepStrictEqual(actual, expected, `${language} streaming lexical scopes must match a complete highlight`);
      if (language === 'javascript' || language === 'typescript') {
        assert(incremental.stats.highlightedCharacters - before < 1600,
          'stable statements must be reused while the complete active lexical tail is highlighted');
        assert(incremental.stats.reusedCodeLines > 1900);
      }
    }
  }
}

async function testAtomicFragments() {
  const source = '**' + 'bold 😀 e\u0301 & '.repeat(4000).trimEnd() + '** [safe link](https://example.com)';
  const engine = view.createMarkdownEngine(marked);
  const html = view.parseMarkdown(engine, source);
  const split = splitHtml(html);
  assert(split.length > 4 && split.every((part) => part.text.length < 8200));
  assert.strictEqual(split.map((part) => part.text).join(''), decode(html.replace(/<[^>]+>/g, '')));
  assert(split.slice(0, -1).every((part) => part.html.includes('<strong>') && part.html.includes('</strong>')),
    'fragments must close and reopen nested formatting without reparsing truncated Markdown');
  assert(split.every((part) => !/[\uD800-\uDBFF]$/.test(part.text) && !/^\p{Mark}/u.test(part.text)));
  const formula = katex.renderToString('x+'.repeat(2000) + 'y', { displayMode: true });
  const formulaParts = splitMath(formula);
  assert(formulaParts.length > 1 && formulaParts.every((part) => part.html.length < 35000));
  const fraction = katex.renderToString('\\frac{' + 'x'.repeat(10000) + '}{y}', { displayMode: true });
  assert.strictEqual(splitMath(fraction)[0].html, fraction, 'indivisible fraction layout must remain intact');
  const documents = create(view, marked);
  const manifest = await documents.update({ id: 'prose', version: 1, source });
  const rendered = await documents.render({ id: 'prose', version: 1, start: 0, end: manifest.count });
  assert(rendered.items[0].parts.count > 4);
  const location = await documents.locate({ id: 'prose', version: 1, offset: source.indexOf('safe link'), query: 'safe link' });
  assert(location.part > 1);
  const part = await documents.rows({ id: 'prose', version: 1, index: 0, partKey: 'block', part: location.part });
  assert(part.html.includes('href="https://example.com"'));
  const full = await documents.rows({ id: 'prose', version: 1, index: 0, partKey: 'block', expanded: true });
  assert.strictEqual(full.html, html, 'explicit complete view must preserve original formatting');
  const code = 'const value = "' + 'entry '.repeat(12000) + 'ATOMIC_NEEDLE";';
  await documents.update({ id: 'code', version: 1, source: code, code: true, language: 'javascript' });
  const codeLocation = await documents.locate({ id: 'code', version: 1, offset: code.indexOf('ATOMIC_NEEDLE'), query: 'ATOMIC_NEEDLE' });
  assert(codeLocation.row === 0 && codeLocation.part >= 8 && codeLocation.partKey === 'line-0');
  const table = '| Cell |\n|---|\n| ' + 'word '.repeat(14000) + 'TABLE_NEEDLE |';
  await documents.update({ id: 'table', version: 1, source: table });
  const tableLocation = await documents.locate({ id: 'table', version: 1, offset: table.indexOf('TABLE_NEEDLE'), query: 'TABLE_NEEDLE' });
  assert(tableLocation.row === 0 && tableLocation.cell === 0 && tableLocation.part > 1);
  assert.deepStrictEqual(findLiteral('İ😀PREFIX ΟΣ τέλος', 'ΟΣ'), { start: 10, end: 12 });
}

async function formatted(documents, id, version, count) {
  let output = '';
  let cursor = 0;
  while (cursor < count) {
    const result = await documents.render({ id, version, start: cursor, end: count });
    assert(!result.missing && result.items.length > 0);
    output += result.items.map((item) => item.html).join('');
    cursor += result.items.length;
  }
  return output;
}

async function main() {
  const documents = create(view, marked);
  const engine = view.createMarkdownEngine(marked);
  const fixtures = [
    ['# Heading\n\nParagraph', ' continues\n\n## Tail'],
    ['Title', '\n=====\n\nNext'],
    ['- first\n- second', '\n  nested\n\n- third'],
    ['| a | b |\n|---|---|\n| 1 | 2 |', '\n| 3 | 4 |'],
    ['```js\nconst value = 1;', '\nconst next = 2;\n```\n\nTail'],
    ['See [later][ref]\n\nFirst', '\n\n[ref]: https://example.com\n\nNext [ref]'],
    ['[ref]: https://example.com\n\nFirst\n\nLast', '\n\nMore [ref]'],
    ['# CRLF\r\n\r\nFirst\r', '\n\r\nNext'],
    ['$$x', '^2$$\n\nMore $y$'],
    ['> first\n> second', '\n> third\n\nOutside'],
  ];
  for (const [id, parts] of fixtures.entries()) {
    let source = '';
    for (const [revision, part] of parts.entries()) {
      const baseLength = source.length;
      source += part;
      const result = await documents.update({ id, version: revision,
        ...(revision ? { append: part, baseLength } : { source }) });
      assert.strictEqual(await formatted(documents, id, revision, result.count), view.parseMarkdown(engine, source),
        'incremental Markdown must preserve block structure and document reference semantics');
    }
  }
  const source = Array.from({ length: 1000 }, (_, index) => `Paragraph ${index}`).join('\n\n');
  const first = await documents.update({ id: 'append', source, version: 1 });
  await formatted(documents, 'append', 1, first.count);
  const before = { ...documents.stats };
  const next = await documents.update({ id: 'append', append: '\n\nNew tail', baseLength: source.length, version: 2 });
  const changed = next.blocks.filter((block, index) => block.key !== first.blocks[index]?.key);
  assert.strictEqual(changed.length, 1, 'one appended paragraph must leave completed block identities stable');
  await documents.render({ id: 'append', version: 2, start: next.count - 1, end: next.count });
  assert.strictEqual(documents.stats.parsedBlocks - before.parsedBlocks, 1);
  assert(documents.stats.lexedCharacters - before.lexedCharacters < 100,
    'appending one paragraph must lex only the active Markdown tail');
  documents.drop('append');
  assert((await documents.update({ id: 'append', append: 'tail', baseLength: source.length, version: 3 })).missing,
    'a recycled worker document must request source recovery');
  const unmatched = '\\[x '.repeat(8000);
  assert.strictEqual(view.guardMathPipes(unmatched), unmatched);
  assert(view.parseMarkdown(engine, unmatched).length > 16000,
    'unclosed delimiters must remain visible without repeated suffix searches');
  const code = Array.from({ length: 10000 }, (_, index) => `const line${index} = ${index};`).join('\n');
  await documents.update({ id: 'rows', source: code, code: true, language: 'javascript', version: 1 });
  const window = await documents.render({ id: 'rows', version: 1, start: 0, end: 1 });
  assert.strictEqual(window.items[0].virtual.rows, 10000);
  const last = await documents.rows({ id: 'rows', version: 1, index: 0, start: 9990 });
  assert(last.lines.length === 10 && last.lines.at(-1).includes('line9999'));
  assert.strictEqual((await documents.rows({ id: 'rows', version: 1, index: 0, copy: true })).source, code);
  const crlf = code.replaceAll('\n', '\r\n');
  await documents.update({ id: 'rows', source: crlf, code: true, language: 'json', version: 2 });
  assert.strictEqual((await documents.rows({ id: 'rows', version: 2, index: 0, copy: true })).source, crlf,
    'raw code updates must preserve exact newline style when normalized token text is unchanged');
  const budget = create(view, marked, { maximumBytes: 4096 });
  await budget.update({ id: 'first', source: 'first '.repeat(600), version: 1 });
  await budget.update({ id: 'second', source: 'second '.repeat(600), version: 1 });
  assert((await budget.render({ id: 'first', version: 1, start: 0, end: 1 })).missing);
  assert(!(await budget.render({ id: 'second', version: 1, start: 0, end: 1 })).missing,
    'the active document remains renderable even when one message exceeds the cache budget');
  await testIncrementalHighlighting();
  await testAtomicFragments();
  console.log('rich document regression passed (incremental blocks/highlighting, atomic fragments, exact location, Unicode, references)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
