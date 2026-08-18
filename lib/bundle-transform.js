'use strict';

const acorn = require('../vendor/acorn');
const vm = require('vm');

const DEFAULT_FULL_TRANSCRIPT_MARKER = 'claude-code-enhance-full-transcript';
const REMARK_PLUGINS = 'window.__KATEX_V2_LOADED?[window.__remarkBracketMath,window.__remarkMath]:[]';
const REHYPE_PLUGINS = 'window.__KATEX_V2_LOADED?[window.__rehypeKatex]:[]';

function parseBundle(source) {
  return acorn.parse(String(source || ''), {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
  });
}

function validateBundleSyntax(source, filename = 'claude-code-webview.js') {
  new vm.Script(String(source || ''), { filename });
  return true;
}

function walkAst(root, visitor) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node.type === 'string') visitor(node);

    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
          if (value[i] && typeof value[i] === 'object') stack.push(value[i]);
        }
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        stack.push(value);
      }
    }
  }
}

function propertyName(property) {
  if (!property || property.type !== 'Property') return '';
  if (!property.computed && property.key?.type === 'Identifier') return property.key.name;
  if (property.key?.type === 'Literal') return String(property.key.value);
  return '';
}

function objectProperty(objectNode, name) {
  return objectNode?.properties?.find((property) => propertyName(property) === name) || null;
}

function nodeSource(source, node) {
  return source.slice(node.start, node.end);
}

function findMarkdownRenderTargets(source, ast = parseBundle(source)) {
  const targets = [];
  walkAst(ast, (node) => {
    if (node.type !== 'CallExpression' || node.arguments.length < 2) return;
    const props = node.arguments[1];
    if (props?.type !== 'ObjectExpression') return;

    const remark = objectProperty(props, 'remarkPlugins');
    const components = objectProperty(props, 'components');
    if (!remark || !components || !remark.value) return;

    const rehype = objectProperty(props, 'rehypePlugins');
    targets.push({
      callStart: node.start,
      callEnd: node.end,
      callee: nodeSource(source, node.callee),
      component: node.arguments[0] ? nodeSource(source, node.arguments[0]) : '',
      objectStart: props.start,
      objectEnd: props.end,
      remarkPropertyStart: remark.start,
      remarkValueStart: remark.value.start,
      remarkValueEnd: remark.value.end,
      remarkValue: nodeSource(source, remark.value),
      rehypeValueStart: rehype?.value?.start ?? null,
      rehypeValueEnd: rehype?.value?.end ?? null,
      rehypeValue: rehype?.value ? nodeSource(source, rehype.value) : '',
      propertyNames: props.properties.map(propertyName).filter(Boolean),
    });
  });
  return targets.sort((a, b) => a.callStart - b.callStart);
}

function identifierName(node) {
  return node?.type === 'Identifier' ? node.name : '';
}

function isIdentifier(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

function isMember(node, objectName, propertyNameValue) {
  if (node?.type !== 'MemberExpression' || !isIdentifier(node.object, objectName)) return false;
  if (!node.computed) return isIdentifier(node.property, propertyNameValue);
  return node.property?.type === 'Literal' && node.property.value === propertyNameValue;
}

function numericBindings(ast) {
  const bindings = new Map();
  walkAst(ast, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    const name = identifierName(node.id);
    if (!name || node.init?.type !== 'Literal' || typeof node.init.value !== 'number') return;
    bindings.set(name, node.init.value);
  });
  return bindings;
}

function retentionFunctionMatch(node, bindings) {
  if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) ||
      node.params.length !== 1 || node.body?.type !== 'BlockStatement') return null;
  const parameter = identifierName(node.params[0]);
  const name = identifierName(node.id) || '<anonymous>';
  const statements = node.body?.body || [];
  if (!parameter || !name || statements.length !== 2) return null;

  const [conditional, finalReturn] = statements;
  const test = conditional?.type === 'IfStatement' ? conditional.test : null;
  if (test?.type !== 'BinaryExpression' || test.operator !== '>' ||
      !isMember(test.left, parameter, 'length') || test.right?.type !== 'Identifier') {
    return null;
  }

  const limit = bindings.get(test.right.name);
  const consequent = conditional.consequent?.type === 'BlockStatement'
    ? conditional.consequent.body
    : [conditional.consequent];
  if (consequent.length !== 2 || consequent[0]?.type !== 'VariableDeclaration' ||
      consequent[1]?.type !== 'ReturnStatement') return null;

  const declarators = consequent[0].declarations || [];
  if (declarators.length !== 1) return null;
  const trimName = identifierName(declarators[0].id);
  const trimExpression = declarators[0].init;
  if (!trimName || trimExpression?.type !== 'BinaryExpression' || trimExpression.operator !== '-' ||
      !isMember(trimExpression.left, parameter, 'length') || trimExpression.right?.type !== 'Identifier') {
    return null;
  }

  const keep = bindings.get(trimExpression.right.name);
  const sliced = consequent[1].argument;
  if (sliced?.type !== 'CallExpression' || !isMember(sliced.callee, parameter, 'slice') ||
      sliced.arguments.length !== 1 || !isIdentifier(sliced.arguments[0], trimName) ||
      finalReturn?.type !== 'ReturnStatement' || !isIdentifier(finalReturn.argument, parameter)) {
    return null;
  }

  if (!Number.isFinite(limit) || !Number.isFinite(keep) || limit <= keep || keep <= 0) return null;
  return {
    start: node.start,
    end: node.end,
    bodyStart: node.body.start,
    functionType: node.type,
    name,
    parameter,
    limit,
    keep,
  };
}

function findMessageRetentionTargets(ast) {
  const bindings = numericBindings(ast);
  const targets = [];
  walkAst(ast, (node) => {
    const match = retentionFunctionMatch(node, bindings);
    if (match) targets.push(match);
  });
  return targets.sort((a, b) => a.start - b.start);
}

function applyReplacements(source, replacements) {
  let output = source;
  replacements
    .slice()
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .forEach((replacement) => {
      output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
    });
  return output;
}

function markdownReplacements(target, source) {
  const replacements = [{
    start: target.remarkValueStart,
    end: target.remarkValueEnd,
    value: `(${source.slice(target.remarkValueStart, target.remarkValueEnd)}).concat(${REMARK_PLUGINS})`,
  }];

  if (target.rehypeValueStart !== null) {
    replacements.push({
      start: target.rehypeValueStart,
      end: target.rehypeValueEnd,
      value: `(${source.slice(target.rehypeValueStart, target.rehypeValueEnd)}).concat(${REHYPE_PLUGINS})`,
    });
  } else {
    replacements.push({
      start: target.remarkPropertyStart,
      end: target.remarkPropertyStart,
      value: `rehypePlugins:${REHYPE_PLUGINS},`,
    });
  }
  return replacements;
}

function transformClaudeBundle(source, options = {}) {
  const input = String(source || '');
  let ast;
  try {
    ast = parseBundle(input);
  } catch (error) {
    return { ok: false, reason: 'bundle-parse-error', error, body: input, diagnostics: {} };
  }

  const markdownTargets = findMarkdownRenderTargets(input, ast);
  if (markdownTargets.length !== 1) {
    return {
      ok: false,
      reason: markdownTargets.length ? 'ambiguous-markdown-renderer' : 'markdown-renderer-not-found',
      body: input,
      diagnostics: { markdownTargets: markdownTargets.length },
    };
  }

  const replacements = markdownReplacements(markdownTargets[0], input);
  const retentionTargets = options.fullTranscript === false ? [] : findMessageRetentionTargets(ast);
  let retentionApplied = false;
  if (retentionTargets.length === 1) {
    const target = retentionTargets[0];
    const marker = options.fullTranscriptMarker || DEFAULT_FULL_TRANSCRIPT_MARKER;
    replacements.push({
      start: target.start,
      end: target.end,
      value: `${input.slice(target.start, target.bodyStart)}{return ${target.parameter}/* ${marker} */}`,
    });
    retentionApplied = true;
  }

  const body = applyReplacements(input, replacements);
  try {
    validateBundleSyntax(body);
  } catch (error) {
    return {
      ok: false,
      reason: 'transformed-bundle-parse-error',
      error,
      body: input,
      diagnostics: { markdownTargets: 1, retentionTargets: retentionTargets.length },
    };
  }

  return {
    ok: true,
    reason: 'transformed',
    body,
    diagnostics: {
      markdownTargets: 1,
      markdownCallee: markdownTargets[0].callee,
      markdownComponent: markdownTargets[0].component,
      retentionTargets: retentionTargets.length,
      retentionApplied,
      retentionLimit: retentionTargets[0]?.limit || null,
      retentionKeep: retentionTargets[0]?.keep || null,
    },
  };
}

function patchMessageRetentionCap(source, marker = DEFAULT_FULL_TRANSCRIPT_MARKER) {
  const input = String(source || '');
  let ast;
  try {
    ast = parseBundle(input);
  } catch {
    return { body: input, applied: false };
  }
  const targets = findMessageRetentionTargets(ast);
  if (targets.length !== 1) return { body: input, applied: false };
  const target = targets[0];
  return {
    body: applyReplacements(input, [{
      start: target.start,
      end: target.end,
      value: `${input.slice(target.start, target.bodyStart)}{return ${target.parameter}/* ${marker} */}`,
    }]),
    applied: true,
  };
}

module.exports = {
  DEFAULT_FULL_TRANSCRIPT_MARKER,
  parseBundle,
  validateBundleSyntax,
  walkAst,
  findMarkdownRenderTargets,
  findMessageRetentionTargets,
  transformClaudeBundle,
  patchMessageRetentionCap,
};
