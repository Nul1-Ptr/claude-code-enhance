'use strict';

const fs = require('fs');
const path = require('path');
const {
  findMarkdownRenderTargets,
  findMessageRetentionTargets,
  findVirtualTurnTargets,
  parseBundle,
  transformClaudeBundle,
  validateBundleSyntax,
} = require('../lib/bundle-transform');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const fixturesRoot = path.join(__dirname, 'fixtures', 'claude-bundles');
const expectations = {
  '2.1.314.js': { retention: 'BKe', replay: 'zfe', append: 'Hfe' },
  '2.1.317.js': { retention: 'tGe', replay: '$fe', append: 'jfe' },
  '2.1.318.js': { retention: 'oGe', replay: 'qfe', append: 'Kfe' },
};

for (const [fileName, expected] of Object.entries(expectations)) {
  const source = fs.readFileSync(path.join(fixturesRoot, fileName), 'utf8');
  const ast = parseBundle(source);
  const retention = findMessageRetentionTargets(ast);
  const virtualTurns = findVirtualTurnTargets(source, ast);
  const markdown = findMarkdownRenderTargets(source, ast);
  assert(retention.length === 1 && retention[0].name === expected.retention,
    `${fileName} should expose the structured ${expected.retention} retention entry point`);
  assert(virtualTurns.length === 1, `${fileName} should expose one virtual turn renderer`);
  assert(markdown.length === 1 && markdown[0].kind === 'property',
    `${fileName} should expose one explicit Markdown renderer`);
  assert(source.includes(`function ${expected.replay}`) && source.includes(`function ${expected.append}`),
    `${fileName} should retain the observed replay and append wrappers`);

  const transformed = transformClaudeBundle(source, {
    fullTranscript: true,
    virtualTurns: true,
    requireVirtualTurnsForFullTranscript: true,
  });
  assert(transformed.ok, `${fileName} should transform successfully`);
  assert(transformed.diagnostics.retentionApplied, `${fileName} should patch structured retention`);
  assert(transformed.diagnostics.virtualTurnsApplied, `${fileName} should patch the turn renderer`);
  assert(transformed.body.includes('claude-code-enhance-full-transcript'),
    `${fileName} should carry the full-transcript marker`);
  assert(transformed.body.includes('__CLAUDE_ENHANCE_VIRTUAL_TURNS__'),
    `${fileName} should call the virtual-turn runtime`);
  validateBundleSyntax(transformed.body, fileName);
}

console.log('Claude bundle fixture regression passed (2.1.314, 2.1.317, 2.1.318)');
