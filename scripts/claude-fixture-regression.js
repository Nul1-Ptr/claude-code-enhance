'use strict';

const fs = require('fs');
const os = require('os');
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
  '2.1.332.js': { retention: 'kj', replay: 'UA', append: 'WA', module: true },
};

function findInstalledBundle() {
  const roots = [
    process.env.VSCODE_AGENT_FOLDER && path.join(process.env.VSCODE_AGENT_FOLDER, 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.vscode-server-insiders', 'extensions'),
  ].filter(Boolean);
  const override = process.env.CLAUDE_CODE_BUNDLE || process.env.CLAUDE_CODE_2_1_319_BUNDLE;
  const candidates = override
    ? [override]
    : roots.flatMap((root) => {
        let entries = [];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch {}
        return entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('anthropic.claude-code-'))
          .sort((first, second) => second.name.localeCompare(first.name, undefined, { numeric: true }))
          .flatMap((entry) => [
            path.join(root, entry.name, 'webview', 'index.js.katex-bak'),
            path.join(root, entry.name, 'webview', 'index.js'),
          ]);
      });
  return candidates.find((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    if (candidate.endsWith('.katex-bak')) return true;
    return !fs.readFileSync(candidate, 'utf8').includes('/* === KaTeX LaTeX Rendering Patch === */');
  }) || null;
}

for (const [fileName, expected] of Object.entries(expectations)) {
  const source = fs.readFileSync(path.join(fixturesRoot, fileName), 'utf8');
  const ast = parseBundle(source);
  assert(ast.sourceType === (expected.module ? 'module' : 'script'),
    `${fileName} should preserve the bundle source type`);
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
  assert(transformed.diagnostics.nativeMathGuarded === !!expected.module,
    `${fileName} should guard only the verified native math provider`);
  assert(transformed.diagnostics.nativeCodeGuarded === !!expected.module,
    `${fileName} should guard only the verified native code renderer`);
  if (expected.module) {
    assert(transformed.body.includes("new URL('math.js', import.meta.url)"),
      'module transforms must preserve relative lazy asset loading');
    const mismatched = transformClaudeBundle(source.replace('mathCosts,index,drawsMath);', 'mathCosts,index,otherValue);'), {
      fullTranscript: false,
    });
    assert(mismatched.ok && !mismatched.diagnostics.nativeMathGuarded,
      'an unverified native provider signature must remain unchanged');
    const shadowed = transformClaudeBundle(source.replace('()=>({code:codeRenderer(isCodeColored),pre:Pre})',
      '(isCodeColored)=>({code:codeRenderer(isCodeColored),pre:Pre})'), { fullTranscript: false });
    assert(shadowed.ok && shadowed.diagnostics.nativeMathGuarded && !shadowed.diagnostics.nativeCodeGuarded,
      'a shadowed coloring argument must not be rewritten');
  }

  const defaultTransform = transformClaudeBundle(source, {
    fullTranscript: false,
    virtualTurns: true,
  });
  assert(defaultTransform.ok && defaultTransform.diagnostics.virtualTurnsApplied,
    `${fileName} should keep safe turn virtualization with native history retention`);
  assert(!defaultTransform.diagnostics.retentionApplied &&
    !defaultTransform.body.includes('claude-code-enhance-full-transcript'),
  `${fileName} default mode should not disable native retention`);
}

const installedBundle = findInstalledBundle();
if (installedBundle) {
  const source = fs.readFileSync(installedBundle, 'utf8');
  const ast = parseBundle(source);
  const retention = findMessageRetentionTargets(ast);
  const virtualTurns = findVirtualTurnTargets(source, ast);
  const markdown = findMarkdownRenderTargets(source, ast);
  assert(retention.length === 1 && retention[0].kind === 'message-retention',
    'installed Claude Code should expose one structured history-retention target');
  assert(virtualTurns.length === 1 && markdown.length === 1,
    'installed Claude Code should preserve verified turn and Markdown targets');
  const native = transformClaudeBundle(source, { fullTranscript: false, virtualTurns: true });
  assert(native.ok && native.diagnostics.virtualTurnsApplied && !native.diagnostics.retentionApplied,
    'installed Claude Code default mode should virtualize turns while preserving native retention');
  const full = transformClaudeBundle(source, {
    fullTranscript: true,
    virtualTurns: true,
    requireVirtualTurnsForFullTranscript: true,
  });
  assert(full.ok && full.diagnostics.retentionApplied && full.diagnostics.virtualTurnsApplied,
    'installed Claude Code should still support explicitly requested full transcript mode');
  validateBundleSyntax(native.body, 'claude-code-native-retention.js');
  validateBundleSyntax(full.body, 'claude-code-full-transcript.js');
  if (installedBundle.includes('2.1.332')) {
    assert(native.diagnostics.nativeMathGuarded && native.diagnostics.nativeCodeGuarded,
      '2.1.332 should use a single math and code enhancement pipeline');
  }
  console.log(`Installed bundle verified: ${installedBundle} (native math/code guarded: ${native.diagnostics.nativeMathGuarded}/${native.diagnostics.nativeCodeGuarded})`);
}

console.log(`Claude bundle fixture regression passed (${Object.keys(expectations).join(', ')}; installed check ${installedBundle ? 'passed' : 'skipped'})`);
