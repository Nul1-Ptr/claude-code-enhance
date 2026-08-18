const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const projectRoot = path.join(__dirname, '..');
const katex = require(path.join(projectRoot, 'vendor', 'katex.min.js'));
const hljs = require(path.join(projectRoot, 'vendor', 'highlight.min.js'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createEnhanceTestApi() {
  const context = {
    console: {
      log() {},
      warn() {},
      error() {},
    },
    katex,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    window: {
      __CLAUDE_ENHANCE_TEST_MODE__: true,
      __remarkMath() {
        return function dummyRemarkMathTransformer(tree) {
          tree.__dummyRemarkMathTransformerRan = true;
        };
      },
      __rehypeKatex() {
        return function dummyRehypeKatexTransformer(tree) {
          tree.__dummyRehypeKatexTransformerRan = true;
        };
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);

  const enhancePath = path.join(projectRoot, 'vendor', 'enhance.js');
  vm.runInContext(fs.readFileSync(enhancePath, 'utf8'), context, {
    filename: enhancePath,
  });

  const api = context.window.__CLAUDE_ENHANCE_TEST_API__;
  assert(api, 'enhance test API was not exposed');
  api.__remarkMath = context.window.__remarkMath;
  api.__rehypeKatex = context.window.__rehypeKatex;
  return api;
}

function createRemarkBundleTestApi() {
  class DOMParserStub {
    parseFromString() {
      return { nodeType: 9, childNodes: [] };
    }
  }

  const context = {
    console: {
      log() {},
      warn() {},
      error() {},
    },
    DOMParser: DOMParserStub,
    document: {
      createElement() {
        return {
          innerHTML: '',
          content: { nodeType: 11, childNodes: [] },
        };
      },
    },
    katex,
    hljs,
    window: { katex, __CLAUDE_ENHANCE_TEST_MODE__: true },
  };
  context.globalThis = context;
  vm.createContext(context);

  const bundlePath = path.join(projectRoot, 'vendor', 'remark-math-bundle.js');
  vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), context, {
    filename: bundlePath,
  });

  const enhancePath = path.join(projectRoot, 'vendor', 'enhance.js');
  vm.runInContext(fs.readFileSync(enhancePath, 'utf8'), context, {
    filename: enhancePath,
  });

  const guard = context.window.__remarkPipeGuard;
  const restore = context.window.__remarkPipeGuardRestore;
  assert(typeof guard === 'function', 'remark pipe guard should be exposed');
  assert(typeof restore === 'function', 'remark pipe guard restore should be exposed');
  return {
    guard,
    restore,
    bracketMath: context.window.__remarkBracketMath,
    remarkMath: context.window.__remarkMath,
  };
}

function renderSpans(api, text, name) {
  const spans = api.scanStructuredMath(text, { markdown: true, context: 'regression' }).candidates
    .filter((candidate) => candidate.decision === 'render');
  for (const span of spans.slice(0, 30)) {
    const html = api.renderLatexHtml(span.renderFormula, span.displayMode);
    assert(typeof html === 'string' && html.includes('katex'), `${name}: rendered math is missing KaTeX markup`);
    assert(!html.includes('katex-error'), `${name}: rendered math contains KaTeX error markup`);
  }
  return spans.length;
}

function fakeCodeBlock(className, parentClassName = '', dataLanguage = '') {
  return {
    className,
    parentElement: {
      className: parentClassName,
      getAttribute(name) {
        return name === 'data-language' ? dataLanguage : '';
      },
    },
    getAttribute(name) {
      return name === 'data-language' ? dataLanguage : '';
    },
  };
}

function fakeClosestElement(ancestorClassNames) {
  return {
    nodeType: 1,
    tagName: 'SPAN',
    className: ancestorClassNames[0] || '',
    parentElement: null,
    getAttribute() { return null; },
    querySelectorAll() { return []; },
    closest(selector) {
      const classFragments = Array.from(String(selector).matchAll(/\[class\*="([^"]+)"\]/g), (match) => match[1]);
      const classSelectors = Array.from(String(selector).matchAll(/(?:^|,)\s*\.([A-Za-z0-9_-]+)/g), (match) => match[1]);
      return ancestorClassNames.some((className) => (
        classFragments.some((fragment) => className.includes(fragment)) ||
        classSelectors.some((selectorClass) => className.split(/\s+/).includes(selectorClass))
      )) ? this : null;
    },
  };
}

function collectTextContent(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];

  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    if (typeof part.text === 'string') return [part.text];
    if (typeof part.content === 'string') return [part.content];
    if (Array.isArray(part.content)) return collectTextContent(part.content);
    return [];
  });
}

function collectHistorySnippets() {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const projectDirs = fs.existsSync(projectsRoot)
    ? fs.readdirSync(projectsRoot)
      .map((name) => path.join(projectsRoot, name))
      .filter((entry) => {
        try {
          return fs.statSync(entry).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
  const snippets = [];
  const codeBlocks = [];

  for (const dir of projectDirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const lines = fs.readFileSync(file, 'utf8').split(/\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        let record;
        try {
          record = JSON.parse(lines[i]);
        } catch {
          continue;
        }

        for (const text of collectTextContent(record.message?.content)) {
          if (/[\\$]|```|\|/.test(text) && snippets.length < 50) {
            snippets.push({
              name: `history:${path.basename(file)}:${i + 1}`,
              text: text.slice(0, 8000),
            });
          }

          const fenceRe = /```([A-Za-z0-9_+#.-]*)[^\n]*\n([\s\S]*?)```/g;
          let match;
          while ((match = fenceRe.exec(text)) && codeBlocks.length < 50) {
            codeBlocks.push({
              name: `history-code:${path.basename(file)}:${i + 1}`,
              language: match[1] || 'markdown',
              code: match[2].slice(0, 8000),
            });
          }
        }
      }
    }
  }

  return { snippets, codeBlocks };
}

function readJsonlApiErrorTexts(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\n/)
    .flatMap((line) => {
      if (!line.trim()) return [];
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return [];
      }
      if (!record.isApiErrorMessage) return [];
      return collectTextContent(record.message?.content)
        .filter((text) => text.startsWith('API Error:'));
    });
}

const embeddedVllmApiErrors = [
  [
    "API Error: 400 2 request validation errors:",
    "Input should be a valid string, field: 'messages[44].***.str', value: [{'text': '<system-reminder>\\nThe following skills are available for use with the Skill tool:\\n</system-reminder>\\n', 'type': 'text'}, {'text': 'with more details\\n', 'type': 'text'}, {'text': 'explain the pagedattention kernel with more details\\n', 'type': 'text'}, {'text': 'explain the pagedattention kernel with more details\\n', 'type': 'text'}, {'text': 'explain the pagedattention kernel with more details\\n', 'type': 'text'}, {'cache_control': {'type': 'ephemeral'}, 'text': 'explain the pagedattention kernel with more details', 'type': 'text'}];",
    "Extra inputs are not permitted, field: 'messages[44].***.list[ChatMessageContent][5].cache_control'",
  ].join(' '),
  "API Error: 500 unable to detect request format. Expected format: ['openai_chat']. Please verify your request body structure matches the expected format. (request id: 20260522104820321990707cF0CdM5Q). This is a server-side issue, usually temporary - try again in a moment. If it persists, check your inference gateway (elysia.h-e.top).",
];

const api = createEnhanceTestApi();
const remarkApi = createRemarkBundleTestApi();

const remarkData = {};
const integratedRemarkTransformer = remarkApi.remarkMath.call({
  data() { return remarkData; },
});
assert(typeof integratedRemarkTransformer === 'function', 'wrapped bundled remark-math should return a transformer');
assert(
  Array.isArray(remarkData.micromarkExtensions) &&
    Array.isArray(remarkData.fromMarkdownExtensions) &&
    Array.isArray(remarkData.toMarkdownExtensions),
  'wrapped bundled remark-math should preserve parser and serializer registrations'
);
const integratedRemarkTree = {
  type: 'root',
  children: [
    { type: 'inlineMath', value: 'x_1' },
    { type: 'inlineMath', value: 'need{' },
  ],
};
integratedRemarkTransformer(integratedRemarkTree, {});
assert(integratedRemarkTree.children[0].type === 'inlineMath', 'bundled remark-math should retain valid formulas');
assert(integratedRemarkTree.children[1].type === 'text', 'bundled remark-math should demote invalid formulas');

const numericFormulaSource = '**$1.8\\times10^{-15}$** via prose (e.g. $F_x - 0.1F_y = 2\\xi$);';
assert(
  api.normalizeMarkdownMathSource(numericFormulaSource) === numericFormulaSource,
  'a numeric formula with a real closing delimiter should not be escaped as currency'
);
assert(
  api.normalizeMarkdownMathSource('Cost $5 and shell $HOME stay prose.').includes('Cost \\$5'),
  'an unpaired numeric currency dollar should still be protected'
);
assert(
  api.normalizeMarkdownMathSource('Cost $5, then formula $x$.').includes('Cost \\$5, then formula $x$.'),
  'a later formula should not be mistaken for the numeric dollar closing delimiter'
);
assert(
  api.normalizeMarkdownMathSource('$64{\\times}64$→fDNS') === '$64{\\times}64$→fDNS',
  'numeric formulas followed by Unicode punctuation should keep their opening delimiter'
);

let normalizedParserSource = '';
const sourceProcessor = {
  parser(source) {
    normalizedParserSource = source;
    return { type: 'root', children: [] };
  },
};
remarkApi.bracketMath.call(sourceProcessor);
sourceProcessor.parser(numericFormulaSource, {});
assert(
  normalizedParserSource === numericFormulaSource,
  'the installed remark source plugin should preserve closed numeric formulas'
);

const structuredContextCases = [
  { text: '`code $x$` and $y$', expected: ['$y$'] },
  { text: '``code ` $x$ `` and $y$', expected: ['$y$'] },
  { text: '```sh\necho $HOME\n```\n$y$', expected: ['$y$'] },
  { text: '~~~perl\nprint $x\n~~~\n$y$', expected: ['$y$'] },
  { text: '    perl $need{\n\n$y$', expected: ['$y$'] },
  { text: '<code>$x$</code> and $y$', expected: ['$y$'] },
  { text: '> ```sh\n> echo $HOME\n> ```\n> $y$', expected: ['$y$'] },
];
for (const testCase of structuredContextCases) {
  const scan = api.scanStructuredMath(testCase.text, { markdown: true, context: 'property-context' });
  assert(
    JSON.stringify(scan.candidates.map((candidate) => candidate.raw)) === JSON.stringify(testCase.expected),
    `structured scanner should respect Markdown code context: ${testCase.text}`
  );
}

const structuredFormulaBodies = [
  'x',
  'x_1+y^2',
  '1.8\\times10^{-15}',
  '\\frac{a+b}{c}',
];
const structuredDelimiters = [
  { open: '$', close: '$', displayMode: false },
  { open: '\\(', close: '\\)', displayMode: false },
  { open: '$$', close: '$$', displayMode: true },
  { open: '\\[', close: '\\]', displayMode: true },
];
const structuredWrappers = [
  (raw) => `before ${raw} after`,
  (raw) => `**${raw}**`,
  (raw) => `| value | ${raw} |`,
];

for (const body of structuredFormulaBodies) {
  for (const delimiter of structuredDelimiters) {
    const raw = `${delimiter.open}${body}${delimiter.close}`;
    for (const wrap of structuredWrappers) {
      const source = wrap(raw);
      const scan = api.scanStructuredMath(source, { markdown: true, context: 'property-formula' });
      assert(scan.candidates.length === 1, `structured scanner should find exactly one candidate: ${source}`);
      const candidate = scan.candidates[0];
      assert(candidate.type === 'StructuredMathCandidate', 'candidate should expose its structured type');
      assert(candidate.raw === raw && source.slice(candidate.start, candidate.end) === raw, 'candidate range should preserve exact source');
      assert(candidate.body === body && candidate.displayMode === delimiter.displayMode, 'candidate should preserve body and display mode');
      assert(candidate.decision === 'render' && candidate.preparation.ok, 'render decisions should require successful strict preparation');
      assert(!api.renderLatexHtml(candidate.renderFormula, candidate.displayMode).includes('katex-error'), 'render candidates should not produce KaTeX errors');
    }
  }
}

for (const source of [
  'Cost $5, then formula $x$.',
  '`\\(code\\)` and \\(x\\)',
  '\\[x^2\\]',
  '| equation | \\[x^2\\] |',
  '$$x^2$$',
  '$$\nx^2\n$$',
  '\\(need{\\)',
]) {
  const normalized = api.normalizeMarkdownMathSource(source);
  assert(
    api.normalizeMarkdownMathSource(normalized) === normalized,
    `Markdown math source normalization should be idempotent: ${source}`
  );
}
assert(
  api.normalizeMarkdownMathSource('\\(need{\\)') === '\\\\(need{\\\\)',
  'invalid bracket math should escape its delimiters so Markdown preserves the literal source'
);

const quotedEntropyFormula = '$\\rho^{-s/c_v}\\propto p^{-1}\\rho^{\\gamma}$';
const quotedEntropySource = `The note's parenthetical \`${quotedEntropyFormula}\` is nonsensical.`;
const recoveredEntropySource = api.normalizeMarkdownMathSource(quotedEntropySource);
assert(
  recoveredEntropySource === `The note's parenthetical ${quotedEntropyFormula} is nonsensical.`,
  'an inline-code span containing exactly one valid formula should return to the math pipeline'
);
assert(
  api.scanStructuredMath(recoveredEntropySource, { markdown: true, context: 'history' })
    .candidates.some((candidate) => candidate.raw === quotedEntropyFormula && candidate.decision === 'render'),
  'a recovered inline-code formula should render as math'
);
for (const literalCode of ['`echo $HOME`', '`${value}`', '`Cost $5`', '`$need{$`', '```text\n$x$\n```']) {
  assert(
    api.normalizeMarkdownMathSource(literalCode) === literalCode,
    `mixed, template, invalid, and fenced code should remain protected: ${literalCode}`
  );
}

for (const source of ['$HOME and PATH$', '$This is prose$', '$need{$', '$$This is prose$$']) {
  const scan = api.scanStructuredMath(source, { markdown: true, context: 'property-literal' });
  assert(scan.candidates.length === 1, `literal candidate should retain one exact source range: ${source}`);
  const candidate = scan.candidates[0];
  assert(candidate.decision === 'literal' && candidate.raw === source, `literal candidate should preserve source: ${source}`);
}

const positionalRemarkSource = 'before $need{$ after';
const positionalRemarkTree = {
  type: 'root',
  children: [{
    type: 'inlineMath',
    value: 'need{',
    position: { start: { offset: 7 }, end: { offset: 14 } },
  }],
};
api.normalizeRemarkMathNodes(positionalRemarkTree, { value: positionalRemarkSource, data: {} });
assert(
  positionalRemarkTree.children[0].type === 'text' && positionalRemarkTree.children[0].value === '$need{$',
  'remark literal recovery should use the exact positioned source range'
);

const invalidHastTree = {
  type: 'root',
  children: [{
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [{
      type: 'element',
      tagName: 'code',
      properties: { className: ['language-math', 'math-display'] },
      children: [{ type: 'text', value: 'need{' }],
    }],
  }],
};
api.normalizeHastMathNodes(invalidHastTree);
assert(
  invalidHastTree.children[0].tagName === 'span' && invalidHastTree.children[0].children[0].value === '$$need{$$',
  'HAST fallback should demote invalid display math to literal source before rehype-katex'
);

const pyfrM0Formula = '\\mathsf M_0=\\ell(\\mathbf x^{fpts})=\\underbrace{\\mathsf V^{-T}\\phi(\\mathbf x^{fpts})}_{\\texttt{nodal_basis_at(fpts)}}\\quad (\\text{interpolation to flux points}),';
const pyfrM1Formula = '\\mathsf M_1=\\nabla_\\xi\\ell(\\mathbf x^{upts})=\\underbrace{\\mathsf V^{-T}\\nabla_\\xi\\phi}_{\\texttt{jac_nodal_basis_at(upts)}}\\quad (\\text{reference derivative}).';
const hllcUnderbraceFormula = '\\underbrace{\\mathbf F_L\\cdot\\hat{\\mathbf n} + s_L(\\mathbf u_{*L} - \\mathbf u_L)}_{\\mathbf F_{*L}} + s_L(\\mathbf u_{*L} - \\mathbf u_L) = \\mathbf F_L\\cdot\\hat{\\mathbf n} + 2s_L(\\mathbf u_{*L} - \\mathbf u_L)';
assert(
  api.normalizeLatexForRender(pyfrM0Formula, true).includes('\\texttt{nodal\\_basis\\_at(fpts)}'),
  'PyFR texttt identifier underscores should be escaped before KaTeX rendering'
);
assert(
  !api.renderLatexHtml(pyfrM0Formula, true).includes('katex-error'),
  'PyFR M0 display formula should render without a KaTeX error'
);
assert(
  !api.renderLatexHtml(pyfrM1Formula, true).includes('katex-error'),
  'PyFR M1 display formula should render without a KaTeX error'
);
const hllcUnderbraceSource = `The middle branch expands to:\n$$${hllcUnderbraceFormula}$$\nThen prose continues.`;
const hllcUnderbraceCandidate = api.scanStructuredMath(hllcUnderbraceSource, {
  markdown: true,
  context: 'history',
}).candidates[0];
assert(
  hllcUnderbraceCandidate?.decision === 'render' && hllcUnderbraceCandidate.displayMode,
  'a long valid display formula with TeX subscripts should not be mistaken for Markdown emphasis'
);
assert(
  api.normalizeMarkdownMathSource(hllcUnderbraceSource).includes(`$$\n${hllcUnderbraceFormula}\n$$`),
  'a same-line display formula should be normalized to a Markdown math block'
);
assert(
  api.isInsideMathExcludedRegion(fakeClosestElement(['toolBody_ZUQaOA', 'diffEditorWrapper_s6OFow'])),
  'Edit diff surfaces inside tool output should be excluded from DOM math fallback'
);
assert(
  !api.isInsideMathExcludedRegion(fakeClosestElement(['toolBody_ZUQaOA', 'toolBodyRowContent_ZUQaOA'])),
  'ordinary tool-result prose should remain eligible for code-aware math rendering'
);
const lineNumberedToolOutput = [
  '185\t> $$ \\mathcal S_k=\\frac12\\Big(\\partial_\\chi(\\mathbf x\\times\\partial_{\\xi_j}\\mathbf x)',
  '186\t> -\\partial_\\xi(\\mathbf x\\times\\partial_{\\chi}\\mathbf x)\\Big), $$',
  '187\t> with $(k,i,j)$ cycling through the coordinate pairs.',
].join('\n');
const toolOutputCandidates = api.scanStructuredMath(lineNumberedToolOutput, {
  markdown: true,
  context: 'history-tool-output',
}).candidates;
assert(
  toolOutputCandidates.length === 2 && toolOutputCandidates.every((candidate) => candidate.decision === 'render'),
  'line-numbered blockquoted tool-output Markdown should preserve both display and inline math candidates'
);
assert(
  toolOutputCandidates[0].displayMode && toolOutputCandidates[1].formula === '(k,i,j)',
  'tool-output math should retain display mode and exact inline formula boundaries'
);
assert(
  toolOutputCandidates[0].formula.includes('186\t>') &&
    !toolOutputCandidates[0].renderFormula.includes('186\t>') &&
    toolOutputCandidates[0].renderFormula.includes('-\\partial_\\xi'),
  'tool-output rendering should remove line prefixes without changing the source candidate'
);
const inlineAfterQuotedProse = [
  '77\t> $f$ has degree $\\le 2n-1$, so $\\deg r\\le',
  '78\t> n-1$.',
].join('\n');
const quotedInlineCandidates = api.scanStructuredMath(inlineAfterQuotedProse, {
  markdown: true,
  context: 'history-tool-output',
}).candidates;
assert(
  quotedInlineCandidates[2].formula.includes('78\t>') &&
    quotedInlineCandidates[2].renderFormula === '\\deg r\\le\nn-1',
  'tool-output prefix inference should work when inline math starts after quoted prose'
);
const numberedDisplayOutput = [
  '109\t$$ \\int_{-1}^1 f\\,d\\xi',
  '110\t   =\\sum_q w_q f(\\xi_q). $$',
].join('\n');
const numberedDisplayCandidate = api.scanStructuredMath(numberedDisplayOutput, {
  markdown: true,
  context: 'history-tool-output',
}).candidates[0];
assert(
  numberedDisplayCandidate.renderFormula === '\\int_{-1}^1 f\\,d\\xi\n=\\sum_q w_q f(\\xi_q).',
  'tool-output rendering should remove tab-separated Read line numbers'
);
const blockquotedToolOutput = ['> $$', '> a > b', '> $$', '> and $c$.'].join('\n');
const blockquotedCandidates = api.scanStructuredMath(blockquotedToolOutput, {
  markdown: true,
  context: 'history-tool-output',
}).candidates;
assert(
  blockquotedCandidates.length === 2 && blockquotedCandidates[0].renderFormula === 'a > b',
  'tool-output rendering should remove only the structural blockquote prefix'
);
const fencedToolOutput = ['```latex', '$$x+y$$', '```', 'prose $z$'].join('\n');
const fencedToolOutputScan = api.scanStructuredMath(fencedToolOutput, {
  markdown: true,
  context: 'history-tool-output',
});
assert(
  fencedToolOutputScan.candidates.length === 1 && fencedToolOutputScan.candidates[0].raw === '$z$',
  'tool-output scanning should keep language-tagged code protected while rendering prose math'
);
const orphanBeforeFence = [
  '$$ orphan display opener',
  '```javascript',
  'const template = "$code$";',
  '```',
  '$$ \\sum_{i=1}^{n} i $$',
].join('\n');
const orphanBeforeFenceScan = api.scanStructuredMath(orphanBeforeFence, {
  markdown: true,
  context: 'history-tool-output',
});
assert(
  orphanBeforeFenceScan.candidates.length === 1 &&
    orphanBeforeFenceScan.candidates[0].raw === '$$ \\sum_{i=1}^{n} i $$',
  'an orphan display opener should not cross fenced code or consume a later valid formula'
);
const htmlAdjacentMath = [
  '<p>$$\\max \\sum_{r \\in \\text{ready}} x_r$$</p>',
  '<p>Subject to:</p>',
  '<p>$$\\sum_r x_r \\leq N_{\\max}$$</p>',
].join('');
const normalizedHtmlMath = api.normalizeMarkdownMathSource(htmlAdjacentMath);
assert(
  api.normalizeMarkdownMathSource(normalizedHtmlMath) === normalizedHtmlMath,
  'HTML-adjacent display math normalization should be idempotent'
);
assert(
  api.scanStructuredMath(normalizedHtmlMath, { markdown: true, context: 'history' }).candidates
    .filter((candidate) => candidate.decision === 'render').length === 2,
  'HTML-adjacent display math should preserve independent formula boundaries'
);
const makoToolOutput = [
  "9\tvalue='[${str(nvars)}]'",
  "10\tother='[${str(ndims)}]'",
].join('\n');
const makoCandidates = api.scanStructuredMath(makoToolOutput, {
  markdown: true,
  context: 'history-tool-output',
}).candidates;
assert(
  makoCandidates.length === 0,
  'tool-output template substitutions should not become paired dollar math candidates'
);
const obsidianOperatorFormulas = [
  '\\operatorname{encode}(s)=\\mathbf{x}_{1:T}',
  '\\operatorname{Var}(R)',
  '\\operatorname{Re}\\left(\\overline{z_q}z_k e^{i(\\phi_s-\\phi_t)}\\right)',
];
for (const formula of obsidianOperatorFormulas) {
  assert(
    api.normalizeLatexForRender(formula, true) === formula,
    `display normalization should preserve the operator command in ${formula}`
  );
  const preparation = api.prepareLatexForKatex(formula, true);
  assert(
    preparation.ok && preparation.formula === formula && !preparation.repaired,
    `valid operator math should pass strict KaTeX preparation unchanged: ${formula}`
  );
  assert(
    /<mi mathvariant="normal">(?:encode|Var|Re)<\/mi><mo>⁡<\/mo>/.test(api.renderLatexHtml(formula, true)),
    `operatorname should render as a named math operator: ${formula}`
  );
}
assert(
  api.normalizeLatexForRender('\\sum{i=0}', true) === '\\sum_{i=0}',
  'display large-operator repair should retain one TeX command backslash'
);
const pyfrMathTree = {
  type: 'root',
  children: [{
    type: 'element',
    tagName: 'code',
    properties: { className: ['language-math', 'math-display'] },
    children: [{ type: 'text', value: pyfrM0Formula }],
  }],
};
api.__rehypeKatex()(pyfrMathTree, {});
assert(
  pyfrMathTree.__dummyRehypeKatexTransformerRan,
  'wrapped rehype-katex transformer should still call the original transformer'
);
assert(
  pyfrMathTree.children[0].children[0].value.includes('\\texttt{nodal\\_basis\\_at(fpts)}'),
  'wrapped rehype-katex transformer should normalize PyFR texttt identifiers before KaTeX'
);
const textSpecialFormula = '\\texttt{scale=max_qk#1 & 100% ready $done}';
assert(
  api.chooseRenderableLatexForKatex(textSpecialFormula, false).includes('\\texttt{scale=max\\_qk\\#1 \\& 100\\% ready \\$done}'),
  'KaTeX retry preparation should escape text-command specials'
);
assert(
  !api.renderLatexHtml(textSpecialFormula, false).includes('katex-error'),
  'text-command specials should render without a KaTeX error after repair'
);
const nestedTextFormula = '\\text{outer \\texttt{inner_name} total_count_#1}';
const normalizedNestedText = api.normalizeLatexTextCommands(nestedTextFormula);
assert(
  normalizedNestedText.includes('\\texttt{inner\\_name}') && normalizedNestedText.includes('total\\_count\\_\\#1'),
  'nested text commands and adjacent special characters should be normalized with balanced braces'
);
assert(
  api.prepareLatexForKatex(nestedTextFormula, false).ok,
  'balanced nested text commands should produce a valid KaTeX candidate'
);
assert(
  !api.prepareLatexForKatex('need{', false).ok,
  'an unbalanced formula should carry an explicit failed preparation result'
);
assert(
  !api.prepareLatexForKatex('x'.repeat(12001), false).ok,
  'oversized formulas should be rejected before invoking KaTeX'
);
assert(
  api.looksLikeCodeDollarFormula('3 : $2; $need{'),
  'Perl dollar variables should be classified as code-like rather than math'
);
assert(api.isPreparedLatexFormula('abc', false), 'a simple multi-letter variable should remain valid inline math');
assert(api.isPreparedLatexFormula('x+y', false), 'a simple operator expression should remain valid inline math');
assert(
  !api.isPreparedLatexFormula('HOME and PATH', false),
  'a short ordinary phrase between dollar delimiters should remain literal text'
);

const classifiedMathTree = {
  type: 'root',
  children: [
    { type: 'inlineMath', value: 'x_1' },
    { type: 'inlineMath', value: 'HOME and PATH' },
    { type: 'inlineMath', value: 'need{' },
    { type: 'inlineMath', value: '3 : $2; $need{' },
  ],
};
api.__remarkMath()(classifiedMathTree, {});
assert(
  classifiedMathTree.__dummyRemarkMathTransformerRan,
  'wrapped remark-math transformer should still call the original transformer'
);
assert(
  classifiedMathTree.children[0].type === 'inlineMath',
  'valid inline math should remain a math node'
);
assert(
  classifiedMathTree.children[1].type === 'text' && classifiedMathTree.children[1].value === '$HOME and PATH$',
  'ambiguous short prose should be restored as literal delimited text'
);
assert(
  classifiedMathTree.children[2].type === 'text' && classifiedMathTree.children[2].value === '$need{$',
  'unrenderable inline math should be restored as literal delimited text'
);
assert(
  classifiedMathTree.children[3].type === 'text' && classifiedMathTree.children[3].value === '$3 : $2; $need{$',
  'code-like dollar content should be restored before rehype-katex runs'
);
assert(
  api.chooseRenderableLatexForKatex('\\mathds{R}', false).includes('\\mathbb{R}'),
  'unsupported mathds macro should be repaired to mathbb'
);
assert(
  !api.renderLatexHtml('\\mathds{R}', false).includes('katex-error'),
  'mathds alias repair should render without a KaTeX error'
);
assert(
  !api.renderLatexHtml('\\mbox{foo_bar}', false).includes('katex-error'),
  'mbox text identifiers should render through the text-command repair path'
);

const asymVQuantTableRow = '| Asym V quant | `scale=amax(|V|)/448`; `q=clamp(V/scale).to(fp8)` | [asym_k16_v8.py:69](lmcache/v1/kv_codec/asym_k16_v8.py#L69) |';
const guardedAsymVQuantTableRow = remarkApi.guard(asymVQuantTableRow);
assert(
  guardedAsymVQuantTableRow.includes('`scale=amax(\uE000V\uE000)/448`'),
  'inline-code pipes in the Asym V quant table row should be protected before GFM table parsing'
);
assert(
  (guardedAsymVQuantTableRow.match(/\|/g) || []).length === 4,
  'Asym V quant table row should only expose real table separators to the parser'
);
const restoredAsymVQuantNode = { value: guardedAsymVQuantTableRow };
remarkApi.restore(restoredAsymVQuantNode);
assert(
  restoredAsymVQuantNode.value.includes('`scale=amax(|V|)/448`'),
  'inline-code pipes in the Asym V quant table row should be restored after parsing'
);

const apiErrorText = [
  "API Error: 400 2 request validation errors:",
  "Input should be a valid string, field: messages[44].str, value: [{'text': '<system-reminder>Use skills</system-reminder>', 'type': 'text'}, {'text': 'with more details', 'type': 'text'}, {'cache_control': {'type': 'ephemeral'}, 'text': 'explain the pagedattention kernel with more details', 'type': 'text'}]",
  "Extra inputs are not permitted, field: messages[44].list[ChatMessageContent][5].cache_control",
].join(' ');
const parsedApiError = api.parseApiErrorText(apiErrorText);
assert(parsedApiError, 'API error should parse');
assert(parsedApiError.status === '400', 'API error status should parse');
assert(parsedApiError.summary === '2 request validation errors', 'API error summary should use validation count');
assert(parsedApiError.fields.includes('messages[44].str'), 'API error should include string field');
assert(parsedApiError.fields.includes('messages[44].list[ChatMessageContent][5].cache_control'), 'API error should include cache_control field');
assert(parsedApiError.textFields.length === 3, 'API error should extract nested text payloads');
assert(parsedApiError.textFields[2].includes('pagedattention kernel'), 'API error should retain readable nested text');

const vllmApiErrorFile = path.join(
  os.homedir(),
  '.claude',
  'projects',
  '-home-hzl-Disk-Git-repos-vllm',
  '834578ed-2fc6-4919-a2bf-9ecb255f6a98.jsonl'
);
const vllmApiErrors = [
  ...embeddedVllmApiErrors,
  ...readJsonlApiErrorTexts(vllmApiErrorFile),
];
const validationApiError = vllmApiErrors.find((text) => text.includes('messages[44].***.list[ChatMessageContent][5].cache_control'));
assert(validationApiError, 'vLLM validation API error should be found');
const parsedValidationApiError = api.parseApiErrorText(validationApiError);
assert(parsedValidationApiError.summary === '2 request validation errors', 'vLLM API error summary should stay compact');
assert(parsedValidationApiError.fields.includes('messages[44].***.str'), 'vLLM API error should preserve the str field');
assert(
  parsedValidationApiError.fields.includes('messages[44].***.list[ChatMessageContent][5].cache_control'),
  'vLLM API error should preserve the cache_control field'
);
assert(parsedValidationApiError.textFields.some((text) => text.includes('system-reminder')), 'vLLM API error should extract system reminder text');

const gatewayApiError = vllmApiErrors.find((text) => text.includes('Expected format:'));
assert(gatewayApiError, 'vLLM gateway API error should be found');
const parsedGatewayApiError = api.parseApiErrorText(gatewayApiError);
assert(parsedGatewayApiError.status === '500', 'gateway API error status should parse');
assert(parsedGatewayApiError.expectedFormat === "['openai_chat']", 'gateway expected format should parse');
assert(parsedGatewayApiError.gateway === 'elysia.h-e.top', 'gateway host should parse');

const richTextCases = [
  {
    name: 'inline formula with price literal',
    text: 'The gradient $\\nabla f(x)$ renders, but cost $5 and shell $HOME stay prose.',
    expectedSpans: 1,
  },
  {
    name: 'digit-start grid formulas near prose',
    text: "Caveat 9 (TML axis-order discrepancy between code's `4π×8π×8π` and paper's `8π×8π×4π`) is correctly noted; the manuscript's $L_1,L_2,L_3=8\\pi,8\\pi,4\\pi$ with grid $256{\\times}256{\\times}128$→fDNS $64{\\times}64{\\times}32$ confirms the code's stored `[32,64,64]` is a permutation of the physical axes.",
    expectedSpans: 3,
  },
  {
    name: 'digit-start formula attached to prose label',
    text: 'grid $256{\\times}256{\\times}128$→fDNS$64{\\times}64{\\times}32$',
    expectedSpans: 2,
  },
  {
    name: 'PyFR numeric formula inside bold followed by later inline math',
    text: '- the pipeline **`smats`-transform → reference divergence → $1/J$** reproduces the true physical divergence to **$1.8\\times10^{-15}$** via the *adjugate* orientation (e.g. $F_x - 0.1F_y = 2\\xi$);',
    expectedSpans: 3,
  },
  {
    name: 'display formula',
    text: '$$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$',
    expectedSpans: 1,
  },
  {
    name: 'bracket formulas',
    text: 'Inline \\(A^T A\\) and display \\[\\mathbf{n}_{\\text{phys}} = \\mathbf{S}^T\\mathbf{n}\\].',
    expectedSpans: 2,
  },
  {
    name: 'table row with formula pipes',
    text: '| quantity | value |\n|---|---|\n| inverse Jacobian | $J^{-1}=S/|J|$ |',
    expectedSpans: 1,
  },
  {
    name: 'table row with display equation block',
    text: '| equation |\n|---|\n| $$\\sum_{i=1}^{n} x_i = \\frac{n(n+1)}{2}$$ |',
    expectedSpans: 1,
    expectedDisplaySpans: 1,
  },
  {
    name: 'numbered tool excerpt beginning with orphan display closer',
    text: [
      '134\t   \\partial_{x_i}g=\\frac1J\\sum_k\\mathsf S_{ki}\\,\\partial_{\\xi_k}g . $$',
      '135\t',
      '136\tA cheap $d\\times d$ matvec per point, fused into (`gradcoru`),',
      '138\t$\\mathsf S^T/J$ is applied in `negdivconf`.',
      '141\tFrom `pnorm_at` ($\\mathbf N$ = reference-face normal):',
      '143\t$$ \\mathbf p\\mathbf n=\\mathsf S^{T}\\mathbf N. $$',
    ].join('\n'),
    expectedSpans: 4,
    expectedDisplaySpans: 1,
  },
  {
    name: 'PyFR texttt identifiers in display formulas',
    text: `$$ ${pyfrM0Formula}$$\n$$ ${pyfrM1Formula}$$`,
    expectedSpans: 2,
    expectedDisplaySpans: 2,
  },
  {
    name: 'escaped and malformed delimiters',
    text: 'Literal \\$not math\\$, an unclosed $\\frac{x}{, and normal prose.',
    expectedSpans: 0,
  },
  {
    name: 'Perl dollar variables exposed by malformed inline code',
    text: 'Fragments $3 : $2; $need{$ and $need{$ stay literal instead of becoming KaTeX errors.',
    expectedSpans: 0,
  },
  {
    name: 'prose-heavy dollar span',
    text: '$This paragraph has many ordinary words, punctuation, and no math macros, so it should remain plain prose rather than being rendered as mathematics.$',
    expectedSpans: 0,
  },
  {
    name: 'matrix-sized inline formula',
    text: 'Standalone $\\begin{matrix}1&2\\\\3&4\\end{matrix}$ should still be renderable.',
    expectedSpans: 1,
  },
];

let renderedSpanCount = 0;
for (const testCase of richTextCases) {
  const spans = api.scanStructuredMath(testCase.text, { markdown: true, context: 'rich-case' }).candidates
    .filter((candidate) => candidate.decision === 'render');
  assert(spans.length === testCase.expectedSpans, `${testCase.name}: expected ${testCase.expectedSpans} math spans, got ${spans.length}`);
  if (typeof testCase.expectedDisplaySpans === 'number') {
    const displaySpans = spans.filter((span) => span.displayMode).length;
    assert(displaySpans === testCase.expectedDisplaySpans, `${testCase.name}: expected ${testCase.expectedDisplaySpans} display math spans, got ${displaySpans}`);
  }
  renderedSpanCount += renderSpans(api, testCase.text, testCase.name);
}

assert(api.getCodeLanguage(fakeCodeBlock('language-py')) === 'python', 'py alias should resolve to python');
assert(api.getCodeLanguage(fakeCodeBlock('lang-ts')) === 'typescript', 'ts alias should resolve to typescript');
assert(api.getCodeLanguage(fakeCodeBlock('', '', 'sh')) === 'bash', 'raw sh data-language should resolve to bash');
assert(api.isDimensionLatexFormula('256{\\times}256{\\times}128'), 'TeX dimension formula should be recognized');
assert(api.isDimensionLatexFormula('64×64×32'), 'Unicode dimension formula should be recognized');
assert(api.isDimensionLatexFormula('\\64{\\times}64{\\times}32'), 'stray-backslash dimension formula should be recognized');
assert(!api.isDimensionLatexFormula('4π×8π×8π'), 'pi dimension literal should stay non-math unless explicitly delimited');
for (const malformed of [
  '256{\\times}256{\\times}128→fDNS\\64{\\times}64{\\times}32',
  '256{\\times}256{\\times}128→fDNS64{\\times}64{\\times}32',
  '256{\\times}256{\\times}128→fDNS $64{\\times}64{\\times}32',
  '256×256×128→fDNS\\64×64×32',
]) {
  const parts = api.parseMalformedDimensionText(malformed);
  assert(parts, `malformed dimension chain should parse: ${malformed}`);
  assert(parts.label === 'fDNS', `malformed dimension label should parse: ${malformed}`);
  assert(parts.right === '64{\\times}64{\\times}32' || parts.right === '64×64×32', `malformed right dimension should parse: ${malformed}`);
}
assert(hljs.getLanguage('python'), 'Highlight.js should include python');
assert(hljs.highlight('print(1)', { language: 'python', ignoreIllegals: true }).value.includes('print'), 'python highlighting should not fail');
assert(!hljs.getLanguage('made-up-language'), 'unsupported language should be detectable before highlighting');

const markdownTable = [
  '| Feature | Status |',
  '|---|---|',
  '| KaTeX | `$x^2$` |',
  '| Code | `const x = 1` |',
].join('\n');
renderedSpanCount += renderSpans(api, markdownTable, 'markdown table');

const { snippets, codeBlocks } = collectHistorySnippets();
for (const snippet of snippets) {
  renderedSpanCount += renderSpans(api, snippet.text, snippet.name);
}

for (const block of codeBlocks) {
  const language = block.language || 'markdown';
  const normalized = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    md: 'markdown',
    tex: 'latex',
  }[language] || language;
  if (hljs.getLanguage(normalized)) {
    hljs.highlight(block.code, { language: normalized, ignoreIllegals: true });
  }
}

console.log(`rich content regression passed (${renderedSpanCount} rendered math spans, ${snippets.length} history snippets, ${codeBlocks.length} code blocks)`);
