// Runs when the extension is uninstalled from VSCode
// Restores Claude Code's original webview files

const fs = require('fs');
const path = require('path');

function findClaudeCodeDir() {
  const searchDirs = [
    path.join(require('os').homedir(), '.vscode-server', 'extensions'),
    path.join(require('os').homedir(), '.vscode', 'extensions'),
    path.join(require('os').homedir(), '.cursor', 'extensions'),
  ];
  for (const base of searchDirs) {
    try {
      const entries = fs.readdirSync(base);
      const match = entries
        .filter(e => e.startsWith('anthropic.claude-code-'))
        .sort()
        .pop();
      if (match) return path.join(base, match);
    } catch {}
  }
  return null;
}

const extDir = findClaudeCodeDir();
if (extDir) {
  for (const f of ['webview/index.js', 'webview/index.css']) {
    const bak = path.join(extDir, f + '.katex-bak');
    const orig = path.join(extDir, f);
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, orig);
      fs.unlinkSync(bak);
    }
  }
  const fontsDir = path.join(extDir, 'webview', 'fonts');
  if (fs.existsSync(fontsDir)) {
    fs.rmSync(fontsDir, { recursive: true });
  }
}
