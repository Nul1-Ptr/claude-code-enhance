'use strict';

const fs = require('fs');
const path = require('path');

function richWorkerSource(vendorDirectory) {
  const files = ['marked.min.js', 'katex.min.js', 'highlight.min.js', 'runtime-core.js', 'math-core.js',
    'subagent-view.js', 'rich-fragments.js', 'rich-document.js', 'rich-content.js'];
  return 'const window=self;\n' + files.map((file) => fs.readFileSync(path.join(vendorDirectory, file), 'utf8')).join('\n;\n') +
    '\nself.hljs=hljs;\n';
}

function richWorkerConfiguration(vendorDirectory) {
  return `window.__CLAUDE_ENHANCE_WORKER_SOURCE__=${JSON.stringify(richWorkerSource(vendorDirectory)).replace(/</g, '\\u003c')};`;
}

module.exports = { richWorkerSource, richWorkerConfiguration };
