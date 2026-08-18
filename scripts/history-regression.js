const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const vm = require('vm');

const projectRoot = path.join(__dirname, '..');
const katex = require(path.join(projectRoot, 'vendor', 'katex.min.js'));
const hljs = require(path.join(projectRoot, 'vendor', 'highlight.min.js'));

class DOMParserStub {
  parseFromString() {
    return { nodeType: 9, childNodes: [] };
  }
}

const context = {
  console: { log() {}, warn() {}, error() {} },
  katex,
  hljs,
  DOMParser: DOMParserStub,
  document: {
    createElement() {
      return { innerHTML: '', content: { nodeType: 11, childNodes: [] } };
    },
  },
  window: {
    katex,
    hljs,
    __CLAUDE_ENHANCE_TEST_MODE__: true,
  },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(projectRoot, 'vendor', 'remark-math-bundle.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(projectRoot, 'vendor', 'enhance.js'), 'utf8'), context);
const api = context.window.__CLAUDE_ENHANCE_TEST_API__;
const pipeGuard = context.window.__remarkPipeGuard;
const MAX_TOOL_RESULT_SCAN = 128 * 1024;

const aliases = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml',
  md: 'markdown', tex: 'latex',
};

const stats = {
  files: 0,
  bytes: 0,
  lines: 0,
  validJsonLines: 0,
  malformedJsonLines: 0,
  assistantRecords: 0,
  assistantTextParts: 0,
  assistantCharacters: 0,
  toolResultRecords: 0,
  toolResultTextParts: 0,
  toolResultCharacters: 0,
  toolResultCharactersScanned: 0,
  truncatedToolResults: 0,
  codeOnlyToolResults: 0,
  candidates: 0,
  renderedCandidates: 0,
  literalCandidates: 0,
  katexErrors: 0,
  candidateRangeErrors: 0,
  codeRegionCandidateErrors: 0,
  normalizationChanges: 0,
  normalizationNonIdempotence: 0,
  codeBlocks: 0,
  unterminatedFences: 0,
  unsupportedLanguages: {},
  highlightErrors: 0,
  apiErrors: 0,
  apiParseErrors: 0,
  guardedPipeLines: 0,
  pipeGuardErrors: 0,
};

const failures = {
  json: [],
  math: [],
  ranges: [],
  protected: [],
  normalization: [],
  fences: [],
  highlight: [],
  api: [],
  pipes: [],
};

function assertFailure(bucket, detail) {
  if (failures[bucket].length < 20) failures[bucket].push(detail);
}

function filesUnder(root) {
  if (fs.statSync(root).isFile()) return [root];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(file));
    else if (entry.name.endsWith('.jsonl')) files.push(file);
  }
  return files.sort();
}

function textParts(value) {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (part?.type === 'text' && typeof part.text === 'string') return [part.text];
    if (typeof part?.content === 'string') return [part.content];
    return [];
  });
}

function renderableTexts(record, kind) {
  if (kind === 'claude') {
    if (record.type === 'assistant' || record.message?.role === 'assistant') {
      return textParts(record.message?.content)
        .map((text) => ({ text, contentType: 'assistant' }));
    }
    if (record.message?.role === 'user' && Array.isArray(record.message.content)) {
      return record.message.content
        .filter((part) => part?.type === 'tool_result')
        .flatMap((part) => textParts(part.content))
        .map((text) => ({ text, contentType: 'tool-result' }));
    }
    return [];
  }

  const payload = record.payload;
  if (record.type !== 'response_item') return [];
  if (payload?.type === 'message' && payload.role === 'assistant') {
    return Array.isArray(payload.content)
      ? payload.content
        .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
        .map((part) => ({ text: part.text, contentType: 'assistant' }))
      : [];
  }
  if (payload?.type === 'function_call_output' && typeof payload.output === 'string') {
    return [{ text: payload.output, contentType: 'tool-result' }];
  }
  return [];
}

function boundedToolResultParts(text) {
  if (text.length <= MAX_TOOL_RESULT_SCAN) return [{ text, segment: 'complete' }];
  const half = MAX_TOOL_RESULT_SCAN / 2;
  stats.truncatedToolResults++;
  return [
    { text: text.slice(0, half), segment: 'head' },
    { text: text.slice(-half), segment: 'tail' },
  ];
}

function looksLikeRawCodeToolOutput(text) {
  const source = String(text || '');
  const compactCodeSignals = source.match(/(?:=>|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\.createElement\(|\breturn\b)/g) || [];
  if (source.length > 1000 && compactCodeSignals.length >= 8) return true;
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 8) return false;
  const codeSignals = lines.filter((line) => (
    /^(?:[%#]|__\w+|(?:if|else|elif|for|while|return|class|def|function|template)\b)/.test(line) ||
    /(?:\$\{[^}]+\}|=>|::|[{};]\s*$|\b(?:int|float|double|const|static|void)\b)/.test(line)
  )).length;
  const proseSignals = lines.filter((line) => /^[A-Z][^\n]{25,}[.!?:]$/.test(line)).length;
  return codeSignals >= 5 && codeSignals >= Math.max(3, proseSignals * 1.5);
}

function scanCodeBlocks(text, source) {
  let fence = null;
  let code = [];
  let lineNumber = source.line;

  function finishCode() {
    const rawLanguage = fence.language.toLowerCase();
    const language = aliases[rawLanguage] || rawLanguage || 'markdown';
    if (!hljs.getLanguage(language)) {
      stats.unsupportedLanguages[language] = (stats.unsupportedLanguages[language] || 0) + 1;
      return;
    }
    try {
      hljs.highlight(code.join('\n').slice(0, 8000), { language, ignoreIllegals: true });
    } catch (error) {
      stats.highlightErrors++;
      assertFailure('highlight', { ...source, language, error: String(error.message || error) });
    }
  }

  for (const line of text.split('\n')) {
    const structuralLine = line.replace(/^(?:\s{0,3}>\s?)+/, '');
    if (!fence) {
      const opening = structuralLine.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (opening) {
        fence = {
          character: opening[1][0],
          length: opening[1].length,
          language: (opening[2].trim().match(/^([A-Za-z0-9_+#.-]+)/) || [])[1] || '',
        };
        code = [];
        stats.codeBlocks++;
      }
      lineNumber++;
      continue;
    }

    const closing = structuralLine.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
    if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) {
      finishCode();
      fence = null;
      code = [];
    } else {
      code.push(line);
    }
    lineNumber++;
  }

  if (fence) {
    stats.unterminatedFences++;
    assertFailure('fences', { ...source, language: fence.language, marker: fence.character.repeat(fence.length) });
    finishCode();
  }
}

function inspectAssistantText(text, source) {
  if (source.contentType === 'tool-result') {
    stats.toolResultTextParts++;
    stats.toolResultCharactersScanned += text.length;
  } else {
    stats.assistantTextParts++;
    stats.assistantCharacters += text.length;
  }
  scanCodeBlocks(text, source);

  if (source.contentType === 'tool-result' && looksLikeRawCodeToolOutput(text)) {
    stats.codeOnlyToolResults++;
    return;
  }

  if (text.trim().startsWith('API Error:')) {
    stats.apiErrors++;
    if (!api.parseApiErrorText(text.trim())) {
      stats.apiParseErrors++;
      assertFailure('api', source);
    }
  }

  if (text.includes('$') || text.includes('\\')) {
    const normalized = api.normalizeMarkdownMathSource(text);
    if (normalized !== text) stats.normalizationChanges++;
    const normalizedAgain = api.normalizeMarkdownMathSource(normalized);
    if (normalizedAgain !== normalized) {
      stats.normalizationNonIdempotence++;
      let difference = 0;
      while (difference < normalized.length && normalized[difference] === normalizedAgain[difference]) difference++;
      assertFailure('normalization', {
        ...source,
        difference,
        original: text.slice(Math.max(0, difference - 120), difference + 240),
        first: normalized.slice(Math.max(0, difference - 120), difference + 240),
        second: normalizedAgain.slice(Math.max(0, difference - 120), difference + 240),
      });
    }
  }

  const scan = api.scanStructuredMath(text, { markdown: true, context: 'history' });
  const protectedRanges = api.collectMarkdownProtectedRanges(text);
  let previousEnd = -1;
  for (const candidate of scan.candidates) {
    stats.candidates++;
    if (candidate.start < previousEnd || text.slice(candidate.start, candidate.end) !== candidate.raw) {
      stats.candidateRangeErrors++;
      assertFailure('ranges', { ...source, raw: candidate.raw });
    }
    previousEnd = Math.max(previousEnd, candidate.end);
    if (protectedRanges.some((range) => candidate.start < range.end && candidate.end > range.start)) {
      stats.codeRegionCandidateErrors++;
      assertFailure('protected', { ...source, raw: candidate.raw });
    }

    if (candidate.decision === 'literal') {
      stats.literalCandidates++;
      continue;
    }

    stats.renderedCandidates++;
    if (!candidate.preparation.ok) {
      stats.katexErrors++;
      assertFailure('math', { ...source, reason: 'render decision without preparation', raw: candidate.raw });
      continue;
    }
    try {
      const html = api.renderLatexHtml(candidate.renderFormula, candidate.displayMode);
      if (html.includes('katex-error')) {
        stats.katexErrors++;
        assertFailure('math', { ...source, reason: 'katex-error', raw: candidate.raw });
      }
    } catch (error) {
      stats.katexErrors++;
      assertFailure('math', { ...source, reason: String(error.message || error), raw: candidate.raw });
    }
  }

  for (const line of text.split('\n')) {
    if (!line.includes('|')) continue;
    try {
      const guarded = pipeGuard(line);
      if (guarded !== line) stats.guardedPipeLines++;
    } catch (error) {
      stats.pipeGuardErrors++;
      assertFailure('pipes', { ...source, error: String(error.message || error) });
    }
  }
}

async function inspectRoot(root, kind) {
  const files = filesUnder(root);
  const relativeBase = fs.statSync(root).isDirectory() ? root : path.dirname(root);
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    stats.files++;
    stats.bytes += fs.statSync(file).size;
    const relative = path.relative(relativeBase, file);
    const input = fs.createReadStream(file);
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;

    for await (const line of reader) {
      lineNumber++;
      stats.lines++;
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
        stats.validJsonLines++;
      } catch (error) {
        stats.malformedJsonLines++;
        assertFailure('json', { root: kind, file: relative, line: lineNumber, error: String(error.message || error) });
        continue;
      }

      const entries = renderableTexts(record, kind);
      if (!entries.length) continue;
      if (entries.some((entry) => entry.contentType === 'assistant')) stats.assistantRecords++;
      if (entries.some((entry) => entry.contentType === 'tool-result')) stats.toolResultRecords++;
      for (const entry of entries) {
        if (entry.contentType === 'tool-result') {
          stats.toolResultCharacters += entry.text.length;
          for (const part of boundedToolResultParts(entry.text)) {
            inspectAssistantText(part.text, {
              root: kind,
              file: relative,
              line: lineNumber,
              contentType: entry.contentType,
              segment: part.segment,
            });
          }
        } else {
          inspectAssistantText(entry.text, {
            root: kind,
            file: relative,
            line: lineNumber,
            contentType: entry.contentType,
          });
        }
      }
    }

    if ((fileIndex + 1) % 50 === 0 || fileIndex + 1 === files.length) {
      process.stderr.write(`history regression ${kind}: ${fileIndex + 1}/${files.length}\n`);
    }
  }
}

(async () => {
  const requested = process.argv.slice(2).map((target) => path.resolve(target));
  const targets = requested.length
    ? requested.map((root) => ({ root, kind: root.includes(`${path.sep}.codex${path.sep}`) ? 'codex' : 'claude' }))
    : [
      { root: path.join(os.homedir(), '.claude'), kind: 'claude' },
      { root: path.join(os.homedir(), '.codex'), kind: 'codex' },
    ];
  for (const target of targets) await inspectRoot(target.root, target.kind);
  console.log(JSON.stringify({ stats, failures }, null, 2));

  const failed = stats.malformedJsonLines || stats.katexErrors || stats.candidateRangeErrors ||
    stats.codeRegionCandidateErrors || stats.normalizationNonIdempotence || stats.highlightErrors ||
    stats.apiParseErrors || stats.pipeGuardErrors;
  if (failed) process.exitCode = 1;
})();
