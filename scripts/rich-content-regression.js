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
    window: {
      __CLAUDE_ENHANCE_TEST_MODE__: true,
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
    window: { katex },
  };
  context.globalThis = context;
  vm.createContext(context);

  const bundlePath = path.join(projectRoot, 'vendor', 'remark-math-bundle.js');
  vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), context, {
    filename: bundlePath,
  });

  const guard = context.window.__remarkPipeGuard;
  const restore = context.window.__remarkPipeGuardRestore;
  assert(typeof guard === 'function', 'remark pipe guard should be exposed');
  assert(typeof restore === 'function', 'remark pipe guard restore should be exposed');
  return { guard, restore };
}

function renderSpans(api, text, name) {
  const spans = api.findMathSpans(text);
  for (const span of spans.slice(0, 30)) {
    const html = api.renderLatexHtml(span.formula, span.displayMode);
    assert(typeof html === 'string' && html.includes('katex'), `${name}: rendered math is missing KaTeX markup`);
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
    name: 'escaped and malformed delimiters',
    text: 'Literal \\$not math\\$, an unclosed $\\frac{x}{, and normal prose.',
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
  const spans = api.findMathSpans(testCase.text);
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
