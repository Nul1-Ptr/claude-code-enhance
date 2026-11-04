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

function isFunctionNode(node) {
  return node?.type === 'FunctionDeclaration'
    || node?.type === 'FunctionExpression'
    || node?.type === 'ArrowFunctionExpression';
}

function addScopeBinding(scope, name, binding) {
  if (!scope || !name) return;
  const bindings = scope.bindings.get(name) || [];
  if (!bindings.some((candidate) => candidate.node === binding.node && candidate.kind === binding.kind)) {
    bindings.push(binding);
    scope.bindings.set(name, bindings);
  }
}

function nearestVarScope(scope) {
  let current = scope;
  while (current && current.type !== 'function' && current.type !== 'program') {
    current = current.parent;
  }
  return current || scope;
}

function buildScopeIndex(ast) {
  const rootScope = {
    type: 'program',
    node: ast,
    parent: null,
    children: [],
    bindings: new Map(),
  };

  function createScope(type, node, parent) {
    const scope = { type, node, parent, children: [], bindings: new Map() };
    parent?.children.push(scope);
    return scope;
  }

  function visitPattern(pattern, scope, binding) {
    if (!pattern || typeof pattern !== 'object') return;
    if (pattern.type === 'Identifier') {
      addScopeBinding(scope, pattern.name, binding);
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      visitPattern(pattern.left, scope, binding);
      visit(pattern.right, scope);
      return;
    }
    if (pattern.type === 'RestElement') {
      visitPattern(pattern.argument, scope, binding);
      return;
    }
    if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements || []) visitPattern(element, scope, binding);
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties || []) {
        if (property.type === 'RestElement') {
          visitPattern(property.argument, scope, binding);
          continue;
        }
        if (property.computed) visit(property.key, scope);
        visitPattern(property.value, scope, binding);
      }
    }
  }

  function visitFunction(node, parentScope, declarationBinding = false) {
    if (declarationBinding && node.id?.type === 'Identifier') {
      addScopeBinding(parentScope, node.id.name, { kind: 'function', node });
    }

    const functionScope = createScope('function', node, parentScope);
    if (!declarationBinding && node.id?.type === 'Identifier') {
      addScopeBinding(functionScope, node.id.name, { kind: 'function', node });
    }
    for (const parameter of node.params || []) {
      visitPattern(parameter, functionScope, { kind: 'parameter', node: parameter });
    }
    visit(node.body, functionScope);
  }

  function visit(node, scope) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;

    if (node.type === 'Program') {
      for (const statement of node.body || []) visit(statement, scope);
      return;
    }
    if (node.type === 'BlockStatement') {
      const blockScope = createScope('block', node, scope);
      for (const statement of node.body || []) visit(statement, blockScope);
      return;
    }
    if (node.type === 'FunctionDeclaration') {
      visitFunction(node, scope, true);
      return;
    }
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      visitFunction(node, scope, false);
      return;
    }
    if (node.type === 'VariableDeclaration') {
      const bindingScope = node.kind === 'var' ? nearestVarScope(scope) : scope;
      for (const declarator of node.declarations || []) {
        visitPattern(declarator.id, bindingScope, { kind: 'variable', node: declarator });
        visit(declarator.init, scope);
      }
      return;
    }
    if (node.type === 'CatchClause') {
      const catchScope = createScope('catch', node, scope);
      visitPattern(node.param, catchScope, { kind: 'parameter', node: node.param });
      visit(node.body, catchScope);
      return;
    }
    if (node.type === 'ClassDeclaration' && node.id?.type === 'Identifier') {
      addScopeBinding(scope, node.id.name, { kind: 'class', node });
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'id') continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child, scope);
      } else {
        visit(value, scope);
      }
    }
  }

  visit(ast, rootScope);
  return { rootScope };
}

function scopeForPosition(scopeIndex, position) {
  let scope = scopeIndex?.rootScope || null;
  while (scope) {
    const children = scope.children || [];
    let low = 0;
    let high = children.length - 1;
    let candidate = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const child = children[middle];
      if (child.node.start <= position) {
        candidate = child;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (!candidate || position >= candidate.node.end) break;
    scope = candidate;
  }
  return scope;
}

function resolveBinding(identifier, scopeIndex) {
  if (identifier?.type !== 'Identifier' || !scopeIndex) return null;
  let scope = scopeForPosition(scopeIndex, identifier.start);
  while (scope) {
    const bindings = scope.bindings.get(identifier.name);
    if (bindings?.length) return bindings.length === 1 ? bindings[0] : null;
    scope = scope.parent;
  }
  return null;
}

function walkAstWithAncestors(root, visitor) {
  const ancestors = [];
  const stack = [{ node: root, exit: false }];
  while (stack.length) {
    const entry = stack.pop();
    const node = entry.node;
    if (entry.exit) {
      ancestors.pop();
      continue;
    }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') continue;

    visitor(node, ancestors);
    ancestors.push(node);
    stack.push({ node, exit: true });
    const children = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && typeof child.type === 'string') {
            children.push(child);
          }
        }
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        children.push(value);
      }
    }
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], exit: false });
    }
  }
}

function mapCallInfo(node, source) {
  if (node?.type !== 'CallExpression' || node.arguments.length !== 1) return null;
  const callee = node.callee;
  if (callee?.type !== 'MemberExpression') return null;
  if (callee.object?.type !== 'Identifier') return null;
  const property = callee.computed ? callee.property?.value : callee.property?.name;
  if (property !== 'map') return null;
  const callback = node.arguments[0];
  if (!isFunctionNode(callback) || callback.body?.type !== 'BlockStatement') return null;
  return {
    call: node,
    arraySource: callee.object ? nodeSource(source, callee.object) : '',
    callback,
    callbackSource: nodeSource(source, callback),
  };
}

function classNameMentions(valueNode, name) {
  if (!valueNode) return false;
  const sourceMentions = (value) => {
    const text = String(value || '');
    return name === 'turn'
      ? /(^|\s)turn(?:[_-]|\b)/.test(text)
      : text.includes(name);
  };
  if (valueNode.type === 'Literal' && typeof valueNode.value === 'string') {
    return sourceMentions(valueNode.value);
  }
  if (valueNode.type === 'TemplateLiteral') {
    if ((valueNode.quasis || []).some((quasi) => sourceMentions(quasi.value?.raw))) return true;
  }
  let found = false;
  walkAst(valueNode, (node) => {
    if (found || node.type !== 'MemberExpression') return;
    const property = node.computed ? node.property?.value : node.property?.name;
    if (property === name) found = true;
  });
  return found;
}

function isUndefinedNode(node) {
  return (node?.type === 'Identifier' && node.name === 'undefined') ||
    (node?.type === 'UnaryExpression' && node.operator === 'void');
}

function focusIdentifierForTurn(callback, className) {
  let stateIdentifier = '';
  walkAst(className, (node) => {
    if (stateIdentifier || node.type !== 'ConditionalExpression') return;
    if (node.test?.type === 'Identifier') stateIdentifier = node.test.name;
  });
  if (!stateIdentifier) return '';

  let focusIdentifier = '';
  walkAst(callback.body, (node) => {
    if (focusIdentifier || node.type !== 'VariableDeclarator' ||
        identifierName(node.id) !== stateIdentifier || !node.init) return;
    walkAst(node.init, (inner) => {
      if (focusIdentifier || inner.type !== 'BinaryExpression' ||
          (inner.operator !== '!==' && inner.operator !== '!=')) return;
      if (inner.left?.type === 'Identifier' && isUndefinedNode(inner.right)) {
        focusIdentifier = inner.left.name;
      } else if (inner.right?.type === 'Identifier' && isUndefinedNode(inner.left)) {
        focusIdentifier = inner.right.name;
      }
    });
  });
  return focusIdentifier;
}

function returnCallInfo(callback, source) {
  const statements = callback.body?.body || [];
  const returns = statements.filter((statement) => statement.type === 'ReturnStatement');
  if (returns.length !== 1) return null;
  const expression = returns[0].argument;
  if (expression?.type !== 'CallExpression' || expression.arguments.length < 2) return null;

  const [fragment, props, keyArgument] = expression.arguments;
  if (props?.type !== 'ObjectExpression' || fragment?.type !== 'Identifier') return null;
  if (expression.callee?.type !== 'Identifier') return null;

  const firstParameter = identifierName(callback.params[0]);
  if (!firstParameter || !isMember(keyArgument, firstParameter, 'key')) return null;

  const childrenProperty = objectProperty(props, 'children');
  const children = childrenProperty?.value;
  if (children?.type !== 'ArrayExpression') return null;

  const turnWrapper = children.elements.find((element) => {
    if (element?.type !== 'CallExpression' || element.arguments.length < 2) return false;
    if (element.callee?.type !== 'Identifier') return false;
    const wrapperProps = element.arguments[1];
    if (wrapperProps?.type !== 'ObjectExpression') return false;
    const className = objectProperty(wrapperProps, 'className');
    return !!className && classNameMentions(className.value, 'turn');
  });
  if (!turnWrapper) return null;

  const turnProps = turnWrapper.arguments[1];
  const className = objectProperty(turnProps, 'className')?.value;

  return {
    createElement: identifierName(expression.callee),
    turnCreateElement: identifierName(turnWrapper.callee),
    fragment: identifierName(fragment),
    turnWrapperSource: nodeSource(source, turnWrapper),
    focusIdentifier: focusIdentifierForTurn(callback, className),
  };
}

function directContainerForConditional(conditional, ancestors) {
  let child = conditional;
  for (let parentIndex = ancestors.length - 1; parentIndex >= 0; parentIndex--) {
    const parent = ancestors[parentIndex];
    if (parent.type === 'ArrayExpression' && parent.elements.includes(child)) {
      for (let ancestorIndex = parentIndex - 1; ancestorIndex >= 0; ancestorIndex--) {
        const ancestor = ancestors[ancestorIndex];
        if (ancestor.type === 'CallExpression' && ancestor.arguments[0] &&
            ancestor.arguments[1]?.type === 'ObjectExpression') {
          const props = ancestor.arguments[1];
          const children = objectProperty(props, 'children');
          if (children?.value === parent) {
            const className = objectProperty(props, 'className');
            const ref = objectProperty(props, 'ref');
            if (className && ref?.value?.type === 'Identifier' &&
                classNameMentions(className.value, 'messagesContainer')) {
              return {
                call: ancestor,
                ref: identifierName(ref.value),
                ancestorIndex,
              };
            }
            break;
          }
        }
      }
    }
    child = parent;
  }
  return null;
}

function sessionParameter(component) {
  const parameter = component.params?.[0];
  if (parameter?.type !== 'ObjectPattern') return '';
  for (const property of parameter.properties || []) {
    if (property.type !== 'Property' || propertyName(property) !== 'session') continue;
    if (property.value?.type === 'Identifier') return property.value.name;
  }
  return '';
}

function functionAncestor(ancestors, beforeIndex) {
  for (let index = beforeIndex - 1; index >= 0; index--) {
    const current = ancestors[index];
    if (isFunctionNode(current) && current.body?.type === 'BlockStatement') return current;
  }
  return null;
}

function directArrayPatternHookCalls(component) {
  const calls = new Map();
  const stack = [[component.body, null]];
  while (stack.length) {
    const [node, parent] = stack.pop();
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') continue;
    if (node !== component.body && isFunctionNode(node)) continue;
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' &&
        parent?.type === 'VariableDeclarator' && parent.id?.type === 'ArrayPattern') {
      const name = node.callee.name;
      const entry = calls.get(name) || [];
      entry.push(node.callee);
      calls.set(name, entry);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object') stack.push([child, node]);
        }
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        stack.push([value, node]);
      }
    }
  }
  return calls;
}

function bindingFunctionNode(binding) {
  if (binding?.kind === 'function' && isFunctionNode(binding.node)) return binding.node;
  if (binding?.kind === 'variable' && isFunctionNode(binding.node?.init)) return binding.node.init;
  return null;
}

function isStateHookWrapper(functionNode) {
  const parameter = identifierName(functionNode?.params?.[0]);
  if (!parameter || (functionNode.params || []).length !== 1) return false;
  const returns = ownFunctionReturnExpressions(functionNode);
  if (returns.length !== 1) return false;
  const expression = returns[0];
  if (expression?.type !== 'CallExpression' || expression.arguments.length !== 1 ||
      !isIdentifier(expression.arguments[0], parameter) ||
      expression.callee?.type !== 'MemberExpression') {
    return false;
  }
  const property = expression.callee.computed
    ? expression.callee.property?.value
    : expression.callee.property?.name;
  return property === 'useState';
}

function hookForComponent(component, scopeIndex) {
  const calls = directArrayPatternHookCalls(component);
  const candidates = Array.from(calls.entries()).filter(([, identifiers]) => {
    const bindings = identifiers.map((identifier) => resolveBinding(identifier, scopeIndex));
    if (bindings.some((binding) => !binding)) return false;
    if (bindings.some((binding) => binding !== bindings[0])) return false;
    const functionNode = bindingFunctionNode(bindings[0]);
    return !!functionNode && isStateHookWrapper(functionNode);
  });
  if (candidates.length !== 1) return null;
  return {
    alias: candidates[0][0],
    calls: candidates[0][1].length,
  };
}

function inspectVirtualTurnTargets(source, ast, scopeIndex = buildScopeIndex(ast)) {
  const candidates = [];
  const phases = {
    conditionals: 0,
    mapPairs: 0,
    returnPairs: 0,
    containers: 0,
    sessions: 0,
    hooks: 0,
  };
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (node.type !== 'ConditionalExpression' || node.test?.type !== 'Identifier') return;
    phases.conditionals++;
    const first = mapCallInfo(node.consequent, source);
    const second = mapCallInfo(node.alternate, source);
    if (!first || !second) return;
    phases.mapPairs++;

    const firstReturn = returnCallInfo(first.callback, source);
    const secondReturn = returnCallInfo(second.callback, source);
    if (!firstReturn || !secondReturn) return;
    if (firstReturn.createElement !== secondReturn.createElement ||
        firstReturn.turnCreateElement !== secondReturn.turnCreateElement ||
        firstReturn.fragment !== secondReturn.fragment) return;
    if (firstReturn.focusIdentifier !== secondReturn.focusIdentifier) return;
    phases.returnPairs++;

    const container = directContainerForConditional(node, ancestors);
    if (!container) return;
    phases.containers++;
    const component = functionAncestor(ancestors, container.ancestorIndex);
    if (!component) return;
    const session = sessionParameter(component);
    if (!session) return;
    phases.sessions++;
    const hook = hookForComponent(component, scopeIndex);
    if (!hook) return;
    phases.hooks++;

    candidates.push({
      start: node.start,
      end: node.end,
      testSource: nodeSource(source, node.test),
      first,
      second,
      createElement: firstReturn.createElement,
      turnCreateElement: firstReturn.turnCreateElement,
      fragment: firstReturn.fragment,
      focusIdentifier: firstReturn.focusIdentifier,
      containerRef: container.ref,
      session,
      hook,
      componentStart: component.start,
    });
  });
  return { candidates, phases };
}

function findVirtualTurnTargets(source, ast = parseBundle(source)) {
  return inspectVirtualTurnTargets(String(source || ''), ast, buildScopeIndex(ast)).candidates;
}

function spreadReferencesRemarkPlugins(spreadNode, scopeIndex, source) {
  const arg = spreadNode?.argument;
  if (!arg) return false;
  const argSource = nodeSource(source, arg);
  if (argSource.includes('remarkPlugins')) return true;

  const identifier = arg.type === 'CallExpression' ? arg.callee : arg;
  const binding = resolveBinding(identifier, scopeIndex);
  return !!binding?.node && nodeSource(source, binding.node).includes('remarkPlugins');
}

function objectHasCodeOrPre(node) {
  if (!node || node.type !== 'ObjectExpression') return false;
  return node.properties.some((p) => {
    const name = propertyName(p);
    return name === 'code' || name === 'pre';
  });
}

function ownFunctionReturnExpressions(functionNode) {
  if (!functionNode) return [];
  if (functionNode.body?.type !== 'BlockStatement') return [functionNode.body];
  const expressions = [];
  const stack = [functionNode.body];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node !== functionNode.body && isFunctionNode(node)) continue;
    if (node.type === 'ReturnStatement' && node.argument) expressions.push(node.argument);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object') stack.push(child);
        }
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        stack.push(value);
      }
    }
  }
  return expressions;
}

function valueHasCodeOrPre(node, scopeIndex, seenBindings = new Set()) {
  if (!node) return false;
  if (node.type === 'ObjectExpression') return objectHasCodeOrPre(node);
  if (node.type === 'Identifier') {
    const binding = resolveBinding(node, scopeIndex);
    if (!binding || seenBindings.has(binding)) return false;
    seenBindings.add(binding);
    const result = binding.kind === 'variable'
      ? valueHasCodeOrPre(binding.node.init, scopeIndex, seenBindings)
      : ownFunctionReturnExpressions(bindingFunctionNode(binding))
        .some((expression) => valueHasCodeOrPre(expression, scopeIndex, seenBindings));
    seenBindings.delete(binding);
    return result;
  }
  if (isFunctionNode(node)) {
    return ownFunctionReturnExpressions(node)
      .some((expression) => valueHasCodeOrPre(expression, scopeIndex, seenBindings));
  }
  if (node.type === 'CallExpression' || node.type === 'NewExpression') {
    if ((node.arguments || []).some((argument) => (
      isFunctionNode(argument) && valueHasCodeOrPre(argument, scopeIndex, seenBindings)
    ))) return true;
    if (node.callee?.type === 'Identifier') {
      const binding = resolveBinding(node.callee, scopeIndex);
      const functionNode = bindingFunctionNode(binding);
      if (binding && functionNode && !seenBindings.has(binding)) {
        seenBindings.add(binding);
        const result = ownFunctionReturnExpressions(functionNode)
          .some((expression) => valueHasCodeOrPre(expression, scopeIndex, seenBindings));
        seenBindings.delete(binding);
        if (result) return true;
      }
    }
    return false;
  }
  if (node.type === 'ConditionalExpression') {
    return valueHasCodeOrPre(node.consequent, scopeIndex, seenBindings) ||
      valueHasCodeOrPre(node.alternate, scopeIndex, seenBindings);
  }
  if (node.type === 'LogicalExpression') {
    return valueHasCodeOrPre(node.left, scopeIndex, seenBindings) ||
      valueHasCodeOrPre(node.right, scopeIndex, seenBindings);
  }
  if (node.type === 'SequenceExpression') {
    return valueHasCodeOrPre(node.expressions.at(-1), scopeIndex, seenBindings);
  }
  if (node.type === 'AssignmentExpression') {
    return valueHasCodeOrPre(node.right, scopeIndex, seenBindings);
  }
  if (node.type === 'ChainExpression' || node.type === 'AwaitExpression') {
    return valueHasCodeOrPre(node.expression || node.argument, scopeIndex, seenBindings);
  }
  return false;
}

function componentsHasCodeOrPre(componentsNode, scopeIndex) {
  return valueHasCodeOrPre(componentsNode, scopeIndex);
}

function findMarkdownRenderTargets(source, ast = parseBundle(source), scopeIndex = buildScopeIndex(ast)) {
  const targets = [];
  walkAst(ast, (node) => {
    if (node.type !== 'CallExpression' || node.arguments.length < 2) return;
    const props = node.arguments[1];
    if (props?.type !== 'ObjectExpression') return;

    const components = objectProperty(props, 'components');
    if (!components) return;

    const remark = objectProperty(props, 'remarkPlugins');
    const rehype = objectProperty(props, 'rehypePlugins');
    const hasCodeOrPre = componentsHasCodeOrPre(components.value, scopeIndex);

    if (remark && remark.value) {
      targets.push({
        kind: 'property',
        callStart: node.start,
        callEnd: node.end,
        callee: nodeSource(source, node.callee),
        component: node.arguments[0] ? nodeSource(source, node.arguments[0]) : '',
        objectStart: props.start,
        objectEnd: props.end,
        spreadStart: null,
        spreadEnd: null,
        spreadArgumentStart: null,
        spreadArgumentEnd: null,
        spreadArgument: '',
        remarkPropertyStart: remark.start,
        remarkValueStart: remark.value.start,
        remarkValueEnd: remark.value.end,
        remarkValue: nodeSource(source, remark.value),
        rehypeValueStart: rehype?.value?.start ?? null,
        rehypeValueEnd: rehype?.value?.end ?? null,
        rehypeValue: rehype?.value ? nodeSource(source, rehype.value) : '',
        propertyNames: props.properties.map(propertyName).filter(Boolean),
        hasCodeOrPre,
      });
      return;
    }

    const spreads = props.properties.filter((p) => p.type === 'SpreadElement');
    if (!spreads.length) return;

    let spread = spreads[0];
    if (spreads.length > 1) {
      const matching = spreads.find((s) => spreadReferencesRemarkPlugins(s, scopeIndex, source));
      if (matching) {
        spread = matching;
      }
    }

    targets.push({
      kind: 'spread',
      callStart: node.start,
      callEnd: node.end,
      callee: nodeSource(source, node.callee),
      component: node.arguments[0] ? nodeSource(source, node.arguments[0]) : '',
      objectStart: props.start,
      objectEnd: props.end,
      spreadStart: spread.start,
      spreadEnd: spread.end,
      spreadArgumentStart: spread.argument.start,
      spreadArgumentEnd: spread.argument.end,
      spreadArgument: nodeSource(source, spread.argument),
      remarkPropertyStart: null,
      remarkValueStart: null,
      remarkValueEnd: null,
      remarkValue: '',
      rehypeValueStart: rehype?.value?.start ?? null,
      rehypeValueEnd: rehype?.value?.end ?? null,
      rehypeValue: rehype?.value ? nodeSource(source, rehype.value) : '',
      propertyNames: props.properties.map(propertyName).filter(Boolean),
      hasCodeOrPre,
    });
  });

  const sorted = targets.sort((a, b) => a.callStart - b.callStart);
  if (sorted.length > 1) {
    const conversationTargets = sorted.filter((t) => t.hasCodeOrPre);
    if (conversationTargets.length === 1) {
      return conversationTargets;
    }
  }
  return sorted;
}

function numericIdentifierValue(identifier, scopeIndex) {
  const binding = resolveBinding(identifier, scopeIndex);
  const init = binding?.kind === 'variable' ? binding.node?.init : null;
  return init?.type === 'Literal' && typeof init.value === 'number'
    ? init.value
    : undefined;
}

function retentionFunctionMatch(node, scopeIndex) {
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

  const limit = numericIdentifierValue(test.right, scopeIndex);
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

  const keep = numericIdentifierValue(trimExpression.right, scopeIndex);
  const sliced = consequent[1].argument;
  if (sliced?.type !== 'CallExpression' || !isMember(sliced.callee, parameter, 'slice') ||
      sliced.arguments.length !== 1 || !isIdentifier(sliced.arguments[0], trimName) ||
      finalReturn?.type !== 'ReturnStatement' || !isIdentifier(finalReturn.argument, parameter)) {
    return null;
  }

  if (!Number.isFinite(limit) || !Number.isFinite(keep) ||
      limit < 100 || keep < 50 || limit <= keep) return null;
  return {
    start: node.start,
    end: node.end,
    bodyStart: node.body.start,
    functionType: node.type,
    name,
    parameter,
    limit,
    keep,
    kind: 'slice-retention',
  };
}

function numericNodeValue(node, scopeIndex) {
  if (node?.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node?.type === 'Identifier') return numericIdentifierValue(node, scopeIndex);
  return undefined;
}

function expressionReferencesIdentifier(node, name) {
  let found = false;
  walkAst(node, (inner) => {
    if (inner.type === 'Identifier' && inner.name === name) found = true;
  });
  return found;
}

function isMessageRetentionResult(node, parameter, requireUnchanged = false) {
  if (node?.type !== 'ObjectExpression') return false;
  const messages = objectProperty(node, 'messages');
  const removedIndices = objectProperty(node, 'removedIndices');
  if (!messages || !removedIndices) return false;
  if (requireUnchanged) {
    return isIdentifier(messages.value, parameter) &&
      removedIndices.value?.type === 'ArrayExpression' &&
      removedIndices.value.elements.length === 0;
  }
  return expressionReferencesIdentifier(messages.value, parameter);
}

function isChangedMessageRetentionResult(node, parameter) {
  if (!isMessageRetentionResult(node, parameter)) return false;
  const messages = objectProperty(node, 'messages');
  const removedIndices = objectProperty(node, 'removedIndices');
  const removedIsEmpty = removedIndices?.value?.type === 'ArrayExpression' &&
    removedIndices.value.elements.length === 0;
  return !isIdentifier(messages?.value, parameter) && !removedIsEmpty;
}

function walkOwnFunctionBody(root, visitor) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node !== root && isFunctionNode(node)) continue;
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

function hasUnchangedMessageResultReturn(node, parameter) {
  let found = false;
  walkOwnFunctionBody(node, (inner) => {
    if (inner.type === 'ReturnStatement' &&
        isMessageRetentionResult(inner.argument, parameter, true)) found = true;
  });
  return found;
}

function capacityRemovalShape(result, parameter) {
  const messages = objectProperty(result, 'messages')?.value;
  const removedIndices = objectProperty(result, 'removedIndices')?.value;
  if (messages?.type !== 'CallExpression' ||
      !isMember(messages.callee, parameter, 'filter') ||
      messages.arguments.length !== 1 ||
      !isFunctionNode(messages.arguments[0])) {
    return false;
  }

  const callback = messages.arguments[0];
  const indexParameter = identifierName(callback.params?.[1]);
  if (!indexParameter || !expressionReferencesIdentifier(callback.body, indexParameter)) return false;

  const removalSets = new Set();
  walkAstWithAncestors(callback.body, (inner, ancestors) => {
    if (inner.type !== 'CallExpression' || inner.callee?.type !== 'MemberExpression') return;
    const property = inner.callee.computed ? inner.callee.property?.value : inner.callee.property?.name;
    if (property !== 'has' || inner.callee.object?.type !== 'Identifier' ||
        !inner.arguments.some((argument) => isIdentifier(argument, indexParameter))) return;
    const parent = ancestors.at(-1);
    if (parent?.type === 'UnaryExpression' && parent.operator === '!' && parent.argument === inner) {
      removalSets.add(inner.callee.object.name);
    }
  });
  if (removalSets.size === 1) {
    const removalSet = Array.from(removalSets)[0];
    let removedReferencesSet = false;
    walkAst(removedIndices, (inner) => {
      if (inner.type === 'SpreadElement' && isIdentifier(inner.argument, removalSet)) {
        removedReferencesSet = true;
      }
    });
    if (removedReferencesSet) return true;
  }
  return false;
}

function messageRetentionFunctionMatch(node, scopeIndex) {
  if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) ||
      node.params.length !== 2 || node.body?.type !== 'BlockStatement') return null;
  const parameter = identifierName(node.params[0]);
  const name = identifierName(node.id) || '<anonymous>';
  if (!parameter) return null;

  const statements = node.body.body || [];
  const guard = statements[0];
  const guardTest = guard?.type === 'IfStatement' ? guard.test : null;
  if (guardTest?.type !== 'BinaryExpression' ||
      (guardTest.operator !== '<=' && guardTest.operator !== '<') ||
      !isMember(guardTest.left, parameter, 'length') ||
      !hasUnchangedMessageResultReturn(guard.consequent, parameter)) {
    return null;
  }
  const limit = numericNodeValue(guardTest.right, scopeIndex);
  if (!Number.isFinite(limit) || limit < 100) return null;

  const finalReturn = statements.at(-1);
  if (finalReturn?.type !== 'ReturnStatement' ||
      !isChangedMessageRetentionResult(finalReturn.argument, parameter)) {
    return null;
  }
  if (!capacityRemovalShape(finalReturn.argument, parameter)) return null;

  let resultReturns = 0;
  let changedResultReturns = 0;
  walkOwnFunctionBody(node.body, (inner) => {
    if (inner.type === 'ReturnStatement' &&
        isMessageRetentionResult(inner.argument, parameter)) {
      resultReturns++;
      if (isChangedMessageRetentionResult(inner.argument, parameter)) changedResultReturns++;
    }
  });

  if (resultReturns < 2 || changedResultReturns < 1) return null;
  return {
    start: node.start,
    end: node.end,
    bodyStart: node.body.start,
    functionType: node.type,
    name,
    parameter,
    limit,
    keep: null,
    kind: 'message-retention',
  };
}

function findMessageRetentionTargets(ast, scopeIndex = buildScopeIndex(ast)) {
  const targets = [];
  walkAst(ast, (node) => {
    const capacityMatch = messageRetentionFunctionMatch(node, scopeIndex);
    if (capacityMatch) {
      targets.push(capacityMatch);
      return;
    }
    const sliceMatch = retentionFunctionMatch(node, scopeIndex);
    if (sliceMatch) targets.push(sliceMatch);
  });
  return targets.sort((a, b) => a.start - b.start);
}

function selectMessageRetentionTargets(targets) {
  if (targets.length === 0) return { targets: [], reason: 'not-found' };
  const byKind = new Map();
  for (const target of targets) {
    const group = byKind.get(target.kind) || [];
    group.push(target);
    byKind.set(target.kind, group);
  }
  if (byKind.size > 1 || Array.from(byKind.values()).some((group) => group.length !== 1)) {
    return { targets: [], reason: 'ambiguous-retention-target' };
  }
  return { targets: targets.slice(), reason: 'applied' };
}

function retentionReplacement(target, source, marker) {
  const prefix = `${source.slice(target.start, target.bodyStart)}`;
  if (target.kind === 'message-retention') {
    return {
      start: target.start,
      end: target.end,
      value: `${prefix}{return {messages:${target.parameter},removedIndices:[]}/* ${marker} */}`,
    };
  }
  return {
    start: target.start,
    end: target.end,
    value: `${prefix}{return ${target.parameter}/* ${marker} */}`,
  };
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
  if (target.kind === 'spread') {
    const replacements = [];
    const hasExplicitRehype = target.rehypeValueStart !== null;
    const rehypeSnippet = hasExplicitRehype
      ? ''
      : `,rehypePlugins:(_s?.rehypePlugins?(_s.rehypePlugins).concat(${REHYPE_PLUGINS}):${REHYPE_PLUGINS})`;

    replacements.push({
      start: target.spreadStart,
      end: target.spreadEnd,
      value: `...((_s)=>({..._s,remarkPlugins:(_s?.remarkPlugins||[]).concat(${REMARK_PLUGINS})${rehypeSnippet}}))((${target.spreadArgument}))`,
    });

    if (hasExplicitRehype) {
      replacements.push({
        start: target.rehypeValueStart,
        end: target.rehypeValueEnd,
        value: `(${source.slice(target.rehypeValueStart, target.rehypeValueEnd)}).concat(${REHYPE_PLUGINS})`,
      });
    }

    return replacements;
  }

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

function virtualTurnReplacements(target, source) {
  const names = [
    '__claudeEnhanceVirtualRuntime',
    '__claudeEnhanceVirtualError',
    '__claudeEnhanceVirtualWarned',
    '__claudeEnhanceFallbackBranch',
    '__claudeEnhanceFallbackFirstTurns',
    '__claudeEnhanceFallbackSecondTurns',
    '__claudeEnhanceFallbackFirstRender',
    '__claudeEnhanceFallbackSecondRender',
    '__claudeEnhanceFallbackTurns',
    '__claudeEnhanceFallbackRender',
    '__claudeEnhanceFallbackStart',
    '__claudeEnhanceFallbackTurn',
    '__claudeEnhanceFallbackIndex',
  ];
  if (names.some((name) => new RegExp(`\\b${name}\\b`).test(source))) return null;

  const boundedFallback =
    `((__claudeEnhanceFallbackBranch,__claudeEnhanceFallbackFirstTurns,` +
    `__claudeEnhanceFallbackSecondTurns,__claudeEnhanceFallbackFirstRender,` +
    `__claudeEnhanceFallbackSecondRender)=>{` +
    `const __claudeEnhanceFallbackTurns=__claudeEnhanceFallbackBranch?` +
    `__claudeEnhanceFallbackFirstTurns:__claudeEnhanceFallbackSecondTurns;` +
    `const __claudeEnhanceFallbackRender=__claudeEnhanceFallbackBranch?` +
    `__claudeEnhanceFallbackFirstRender:__claudeEnhanceFallbackSecondRender;` +
    `const __claudeEnhanceFallbackStart=Math.max(0,__claudeEnhanceFallbackTurns.length-24);` +
    `return __claudeEnhanceFallbackTurns.slice(__claudeEnhanceFallbackStart).map(` +
    `(__claudeEnhanceFallbackTurn,__claudeEnhanceFallbackIndex)=>` +
    `__claudeEnhanceFallbackRender(__claudeEnhanceFallbackTurn,` +
    `__claudeEnhanceFallbackStart+__claudeEnhanceFallbackIndex,` +
    `__claudeEnhanceFallbackTurns))` +
    `})(!!(${target.testSource}),${target.first.arraySource},${target.second.arraySource},` +
    `(${target.first.callbackSource}),(${target.second.callbackSource}))`;
  const runtimeCall =
    `((__claudeEnhanceVirtualRuntime)=>{` +
    `try{` +
    `if(!__claudeEnhanceVirtualRuntime||typeof __claudeEnhanceVirtualRuntime.Component!=="function")` +
    `return ${target.createElement}(${target.fragment},{children:${boundedFallback}},"ce-virtual-turns-fallback");` +
    `return ${target.turnCreateElement}(__claudeEnhanceVirtualRuntime.Component,{` +
    `useState:${target.hook.alias},` +
    `branch:!!(${target.testSource}),` +
    `firstTurns:${target.first.arraySource},` +
    `secondTurns:${target.second.arraySource},` +
    `firstRender:${target.first.callbackSource},` +
    `secondRender:${target.second.callbackSource},` +
    `createElement:${target.createElement},` +
    `turnCreateElement:${target.turnCreateElement},` +
    `fragment:${target.fragment},` +
    `containerRef:${target.containerRef},` +
    `focusIndex:${target.focusIdentifier || 'void 0'},` +
    `session:${target.session}` +
    `},"ce-virtual-turns")` +
    `}catch(__claudeEnhanceVirtualError){` +
    `try{if(typeof window!=="undefined"&&!window.__claudeEnhanceVirtualWarned){window.__claudeEnhanceVirtualWarned=true;` +
    `console.warn("[Claude Enhance] Virtual turns fell back to a bounded tail window",__claudeEnhanceVirtualError)}}catch{}` +
    `return ${target.createElement}(${target.fragment},{children:${boundedFallback}},"ce-virtual-turns-fallback")` +
    `}` +
    `})(typeof window==="undefined"?void 0:window.__CLAUDE_ENHANCE_VIRTUAL_TURNS__)`;

  return [{
    start: target.start,
    end: target.end,
    value: runtimeCall,
  }];
}

function replacementsOverlap(first, second) {
  return first.start < second.end && second.start < first.end;
}

function transformClaudeBundle(source, options = {}) {
  const input = String(source || '');
  const fullTranscriptEnabled = options.fullTranscript !== false;
  const fullTranscriptRequested = fullTranscriptEnabled;
  const virtualTurnsRequested = options.virtualTurns !== false;
  let ast;
  try {
    ast = parseBundle(input);
  } catch (error) {
    return { ok: false, reason: 'bundle-parse-error', error, body: input, diagnostics: {} };
  }

  const scopeIndex = buildScopeIndex(ast);
  const markdownTargets = findMarkdownRenderTargets(input, ast, scopeIndex);
  if (markdownTargets.length !== 1) {
    return {
      ok: false,
      reason: markdownTargets.length ? 'ambiguous-markdown-renderer' : 'markdown-renderer-not-found',
      body: input,
      diagnostics: { markdownTargets: markdownTargets.length },
    };
  }

  const markdownOnlyReplacements = markdownReplacements(markdownTargets[0], input);
  const replacements = markdownOnlyReplacements.slice();
  const retentionTargets = fullTranscriptEnabled ? findMessageRetentionTargets(ast, scopeIndex) : [];
  const retentionSelection = !fullTranscriptEnabled
    ? { targets: [], reason: 'disabled' }
    : selectMessageRetentionTargets(retentionTargets);
  if (options.fullTranscript === true && retentionSelection.targets.length === 0 &&
      options.requireVirtualTurnsForFullTranscript !== true) {
    return {
      ok: false,
      reason: retentionSelection.reason === 'ambiguous-retention-target'
        ? 'ambiguous-retention-target'
        : 'message-retention-not-found',
      body: input,
      diagnostics: {
        markdownTargets: 1,
        retentionTargets: retentionTargets.length,
        retentionApplied: false,
        retentionReason: retentionSelection.reason,
        retentionKinds: retentionTargets.map((target) => target.kind),
      },
    };
  }
  let retentionApplied = false;
  const marker = options.fullTranscriptMarker || DEFAULT_FULL_TRANSCRIPT_MARKER;
  if (retentionSelection.targets.length > 0) {
    retentionSelection.targets.forEach((target) => {
      replacements.push(retentionReplacement(target, input, marker));
    });
    retentionApplied = true;
  }

  const baseBody = applyReplacements(input, replacements);
  try {
    validateBundleSyntax(baseBody);
  } catch (error) {
    return {
      ok: false,
      reason: 'transformed-bundle-parse-error',
      error,
      body: input,
      diagnostics: { markdownTargets: 1, retentionTargets: retentionTargets.length },
    };
  }

  let virtualTurnsApplied = false;
  let virtualTurnsReason = virtualTurnsRequested ? 'no-compatible-target' : 'disabled';
  let virtualTurnCandidates = 0;
  let virtualTurnPhases = null;
  let virtualReplacements = null;
  let body = baseBody;

  if (virtualTurnsRequested) {
    const inspection = inspectVirtualTurnTargets(input, ast, scopeIndex);
    virtualTurnCandidates = inspection.candidates.length;
    virtualTurnPhases = inspection.phases;
    if (inspection.candidates.length === 1) {
      virtualReplacements = virtualTurnReplacements(inspection.candidates[0], input);
      if (!virtualReplacements) {
        virtualTurnsReason = 'identifier-collision';
      } else {
        const overlaps = virtualReplacements.some((virtualReplacement) => (
          replacements.some((replacement) => replacementsOverlap(virtualReplacement, replacement))
        ));
        if (overlaps) {
          virtualTurnsReason = 'overlapping-transform';
        } else {
          const combinedBody = applyReplacements(input, replacements.concat(virtualReplacements));
          try {
            validateBundleSyntax(combinedBody);
            body = combinedBody;
            virtualTurnsApplied = true;
            virtualTurnsReason = 'applied';
          } catch {
            virtualTurnsReason = 'transformed-bundle-parse-error';
          }
        }
      }
    } else if (inspection.candidates.length > 1) {
      virtualTurnsReason = 'ambiguous-turn-renderer';
    }
  }

  let fullTranscriptFallbackReason = null;
  if (options.requireVirtualTurnsForFullTranscript === true && fullTranscriptRequested &&
      (retentionSelection.targets.length === 0 || !virtualTurnsRequested || !virtualTurnsApplied)) {
    retentionApplied = false;
    if (retentionSelection.targets.length === 0) {
      fullTranscriptFallbackReason = retentionSelection.reason === 'ambiguous-retention-target'
        ? 'ambiguous-retention-target'
        : 'message-retention-not-found';
    } else if (!virtualTurnsRequested) {
      fullTranscriptFallbackReason = 'virtual-turns-disabled';
    } else {
      fullTranscriptFallbackReason = virtualTurnsReason;
    }

    const safeReplacements = markdownOnlyReplacements.concat(
      virtualTurnsApplied && virtualReplacements ? virtualReplacements : []
    );
    const safeBody = applyReplacements(input, safeReplacements);
    try {
      validateBundleSyntax(safeBody);
      body = safeBody;
    } catch (error) {
      return {
        ok: false,
        reason: 'transformed-bundle-parse-error',
        error,
        body: input,
        diagnostics: {
          markdownTargets: 1,
          retentionTargets: retentionTargets.length,
          retentionApplied: false,
          fullTranscriptFallbackReason,
          virtualTurnsRequested,
          virtualTurnsApplied: false,
          virtualTurnsReason: 'transformed-bundle-parse-error',
        },
      };
    }
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
      retentionReason: retentionSelection.reason,
      retentionKinds: retentionTargets.map((target) => target.kind),
      retentionLimit: retentionTargets[0]?.limit ?? null,
      retentionKeep: retentionTargets[0]?.keep ?? null,
      fullTranscriptRequested,
      fullTranscriptFallbackReason,
      virtualTurnsRequested,
      virtualTurnsApplied,
      virtualTurnsReason,
      virtualTurnCandidates,
      virtualTurnPhases,
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
  const targets = findMessageRetentionTargets(ast, buildScopeIndex(ast));
  const selection = selectMessageRetentionTargets(targets);
  if (selection.targets.length === 0) return { body: input, applied: false };
  const body = applyReplacements(input, selection.targets.map((target) => (
    retentionReplacement(target, input, marker)
  )));
  try {
    validateBundleSyntax(body);
  } catch {
    return { body: input, applied: false };
  }
  return { body, applied: true, targets: selection.targets.length };
}

module.exports = {
  DEFAULT_FULL_TRANSCRIPT_MARKER,
  parseBundle,
  validateBundleSyntax,
  walkAst,
  findMarkdownRenderTargets,
  findMessageRetentionTargets,
  findVirtualTurnTargets,
  inspectVirtualTurnTargets,
  transformClaudeBundle,
  patchMessageRetentionCap,
};
