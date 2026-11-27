'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const Module = require('module');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const originalLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      extensions: { getExtension: () => null, onDidChange: () => ({ dispose() {} }) },
      commands: { executeCommand() {}, registerCommand: () => ({ dispose() {} }) },
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
      window: {
        showInformationMessage: () => Promise.resolve(),
        showWarningMessage: () => Promise.resolve(),
        showErrorMessage() {},
      },
      env: { openExternal() {} },
      Uri: { parse: (value) => value },
      StatusBarAlignment: { Right: 1 },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const projectRoot = path.join(__dirname, '..');
const extension = require('../extension.js')._test;
const {
  transformClaudeBundle,
  findMessageRetentionTargets,
  findVirtualTurnTargets,
  parseBundle,
} = require('../lib/bundle-transform');
const virtualTurns = require('../vendor/virtual-turns');
const {
  acquireFileLockSync,
  transactionalWriteFilesSync,
  withFileLockSync,
} = require('../lib/file-transaction');
const { ALL_FEATURES, createIncrementalScheduler } = require('../vendor/runtime-core');
const uninstall = require('../uninstall-hook');

const retentionDeclaration = 'var cap=600,keep=500;function trim(items){if(items.length>cap){let offset=items.length-keep;return items.slice(offset)}return items}';
const messageRetentionDeclaration = `
  var retentionCap=600,retentionFloor=300,retentionReserve=100;
  function trimMessages(items,options){
    if(items.length<=retentionCap)return{messages:items,removedIndices:[]};
    let keep=Math.max(retentionFloor,retentionCap-retentionReserve);
    if(keep===items.length)return{messages:items,removedIndices:[]};
    let removed=new Set;
    for(let index=0;index<items.length-keep;index++)removed.add(index);
    return{messages:items.filter((item,index)=>!removed.has(index)),removedIndices:[...removed]};
  }
  function replayMessages(items,teleported){
    return trimMessages(items,{protectRecent:false,teleportedCount:teleported}).messages;
  }
  function appendMessages(items,teleported,options){
    let{messages,removedIndices}=trimMessages(items,{...options,teleportedCount:teleported});
    return{messages,removed:removedIndices.length};
  }
`;
const markdownCall = 'const plugins=base;React.createElement(Markdown,{components:{p:P},remarkPlugins:plugins},value);';
const virtualTurnMarkup = `
  const hookState=function(initial){return React.useState(initial)};
  const h=React.createElement;
  const m=React.createElement;
  const Fragment=React.Fragment;
  const primaryTurns=[];
  const secondaryTurns=[];
  const usePrimary=false;
  const listRef={current:null};
  function Chat({session:e}){
    let [opened,setOpened]=hookState(false);
    return h("div",{ref:listRef,className:"messagesContainer_test",children:[
      usePrimary?primaryTurns.map((turn,index)=>{return h(Fragment,{children:[turn.banner,m("div",{className:"turn_test",children:[]})]},turn.key)}):secondaryTurns.map((turn,index)=>{return h(Fragment,{children:[turn.banner,m("div",{className:"turn_test",children:[]})]},turn.key)})
    ]});
  }
`;

function testStructuralTransforms() {
  const source = `${retentionDeclaration}\n${markdownCall}`;
  const transformed = transformClaudeBundle(source, { fullTranscript: true });
  assert(transformed.ok, 'formatted Markdown renderer should transform');
  assert(transformed.body.includes('__remarkMath'), 'remark math should be injected');
  assert(transformed.body.includes('__rehypeKatex'), 'rehype KaTeX should be injected');
  assert(transformed.diagnostics.retentionApplied, 'retention function should be transformed');
  assert(transformed.diagnostics.fullTranscriptRequested,
    'the transform default should report the enabled full-transcript request');

  const withRehype = 'h(M,{remarkPlugins:r,rehypePlugins:k,components:c},v)';
  const rehypeResult = transformClaudeBundle(withRehype, { fullTranscript: false });
  assert(rehypeResult.ok, 'existing rehypePlugins should transform');
  assert(/\(k\)\.concat\([^)]*__rehypeKatex/.test(rehypeResult.body), 'existing rehypePlugins should be extended');

  const noTarget = 'const unrelated={remarkPlugins:[],components:{}};';
  const missing = transformClaudeBundle(noTarget);
  assert(!missing.ok && missing.reason === 'markdown-renderer-not-found', 'missing renderer should fail closed');
  assert(missing.body === noTarget, 'missing renderer should leave source untouched');

  const ambiguousSource = `${markdownCall}\nh(M,{remarkPlugins:r,components:c},v);`;
  const ambiguous = transformClaudeBundle(ambiguousSource);
  assert(!ambiguous.ok && ambiguous.reason === 'ambiguous-markdown-renderer', 'ambiguous renderers should fail closed');
  assert(ambiguous.body === ambiguousSource, 'ambiguous renderer should leave source untouched');

  const spreadSource = 'function getOpts(p){return{remarkPlugins:[gfm]}}h(M,{...getOpts(p),components:{c}},v);';
  const spreadResult = transformClaudeBundle(spreadSource, { fullTranscript: false });
  assert(spreadResult.ok, 'spread Markdown renderer should transform');
  assert(spreadResult.body.includes('__remarkMath'), 'remark math should be injected for spread target');
  assert(spreadResult.body.includes('__rehypeKatex'), 'rehype KaTeX should be injected for spread target');

  const spreadWithRehype = 'function getOpts(p){return{remarkPlugins:[gfm]}}h(M,{...getOpts(p),rehypePlugins:k,components:{c}},v);';
  const spreadRehypeResult = transformClaudeBundle(spreadWithRehype, { fullTranscript: false });
  assert(spreadRehypeResult.ok, 'spread Markdown renderer with explicit rehypePlugins should transform');
  assert(spreadRehypeResult.body.includes('rehypePlugins:(_s?.rehypePlugins||[]).concat'),
    'spread props should extend the final rehypePlugins value');

  const uniqueMultiSpread = `
    const base={remarkPlugins:[gfm]};
    h(M,{...base,...dynamic(),components:{code:C,pre:P}},v);
  `;
  const uniqueMultiSpreadResult = transformClaudeBundle(uniqueMultiSpread, { fullTranscript: false });
  assert(uniqueMultiSpreadResult.ok,
    'multiple spreads should transform when exactly one source is statically linked to remarkPlugins');
  assert(uniqueMultiSpreadResult.body.includes('((_s)=>({..._s,remarkPlugins:'),
    'multiple spreads should enhance the final merged props object');

  const unknownMultiSpread = 'h(M,{...base,...dynamic(),components:{code:C,pre:P}},v);';
  const unknownMultiSpreadResult = transformClaudeBundle(unknownMultiSpread, { fullTranscript: false });
  assert(!unknownMultiSpreadResult.ok && unknownMultiSpreadResult.reason === 'markdown-renderer-not-found',
    'multiple spreads without a unique remarkPlugins source should fail closed');

  const ambiguousMultiSpread = `
    const base={remarkPlugins:[gfm]};
    const extra={remarkPlugins:[other]};
    h(M,{...base,...extra,components:{code:C,pre:P}},v);
  `;
  const ambiguousMultiSpreadResult = transformClaudeBundle(ambiguousMultiSpread, { fullTranscript: false });
  assert(!ambiguousMultiSpreadResult.ok && ambiguousMultiSpreadResult.reason === 'markdown-renderer-not-found',
    'multiple statically linked remarkPlugin spreads should fail closed');

  const textualRemarkSpread = `
    const base={description:"remarkPlugins are configured elsewhere"};
    h(M,{...base,...dynamic(),components:{code:C,pre:P}},v);
  `;
  const textualRemarkSpreadResult = transformClaudeBundle(textualRemarkSpread, { fullTranscript: false });
  assert(!textualRemarkSpreadResult.ok && textualRemarkSpreadResult.reason === 'markdown-renderer-not-found',
    'remarkPlugins text should not be mistaken for a structured spread property');

  const explicitRemarkAfterSpread = `
    const base={rehypePlugins:[existing]};
    h(M,{...base,remarkPlugins:[gfm],components:{code:C,pre:P}},v);
  `;
  const explicitRemarkAfterSpreadResult = transformClaudeBundle(explicitRemarkAfterSpread, {
    fullTranscript: false,
  });
  assert(explicitRemarkAfterSpreadResult.ok &&
      explicitRemarkAfterSpreadResult.body.includes('((_s)=>({..._s,remarkPlugins:'),
    'explicit plugins combined with spreads should enhance the final merged props object');

  const ambiguousSpread = `${spreadSource}\nh(M,{...getOpts(p),components:{c}},v);`;
  const ambiguousSpreadRes = transformClaudeBundle(ambiguousSpread);
  assert(!ambiguousSpreadRes.ok && ambiguousSpreadRes.reason === 'ambiguous-markdown-renderer', 'ambiguous spread renderers should fail closed');

  const multiTargetWithAuxiliary = `
    function getOpts(p){return{remarkPlugins:[gfm]}}
    const aux = h(M, { remarkPlugins: [gfm], components: { a: A } }, v);
    const main = h(M, { ...getOpts(p), components: { a: A, code: C, pre: P } }, v);
  `;
  const disambiguated = transformClaudeBundle(multiTargetWithAuxiliary);
  assert(disambiguated.ok, 'multi-target with conversation renderer should disambiguate');
  assert(disambiguated.diagnostics.markdownTargets === 1, 'disambiguated target should report 1 Markdown target');

  const identifierComponents = `
    const aux = h(M, { remarkPlugins: [gfm], components: { a: A } }, v);
    const B = useMemo(() => ({ a: A, code: C, pre: P }), []);
    const main = h(M, { remarkPlugins: [gfm], rehypePlugins: k, components: B }, v);
  `;
  const disambiguatedId = transformClaudeBundle(identifierComponents);
  assert(disambiguatedId.ok, 'multi-target with memoized identifier components should disambiguate');
  assert(disambiguatedId.diagnostics.markdownTargets === 1, 'identifier components should report 1 Markdown target');

  const shadowedIdentifierComponents = `
    const B = useMemo(() => ({ a: A, code: C, pre: P }), []);
    function Auxiliary(){
      const B = { a: A };
      return h(M, { remarkPlugins: [gfm], components: B }, v);
    }
    const main = h(M, { remarkPlugins: [gfm], rehypePlugins: k, components: B }, v);
  `;
  const shadowedComponents = transformClaudeBundle(shadowedIdentifierComponents);
  assert(shadowedComponents.ok,
    'Markdown component discovery should resolve the identifier in the renderer lexical scope');
  assert(shadowedComponents.diagnostics.markdownTargets === 1,
    'shadowed component identifiers should not promote the auxiliary renderer');

  const unrelatedNestedComponentObject = `
    const aux = h(M, { remarkPlugins: [gfm], components: { a: A } }, v);
    const B = useMemo(() => ({
      a: A,
      metadata: { code: C, pre: P },
    }), []);
    const other = h(M, { remarkPlugins: [gfm], components: B }, v);
  `;
  const unrelatedNestedComponents = transformClaudeBundle(unrelatedNestedComponentObject);
  assert(!unrelatedNestedComponents.ok &&
      unrelatedNestedComponents.reason === 'ambiguous-markdown-renderer',
    'unrelated nested code/pre properties should not identify a Markdown component mapping');

  const disabled = transformClaudeBundle(source, { fullTranscript: false });
  assert(disabled.ok && !disabled.body.includes('claude-code-enhance-full-transcript'), 'disabled full transcript should preserve retention');
  assert(!disabled.diagnostics.retentionApplied, 'disabled full transcript should report no retention transform');

  const functionForms = [
    'const trim=function(items){if(items["length"]>cap){let offset=items.length-keep;return items["slice"](offset)}return items};',
    'const trim=(items)=>{if(items.length>cap){let offset=items.length-keep;return items.slice(offset)}return items};',
  ];
  for (const form of functionForms) {
    const ast = parseBundle(`var cap=600,keep=500;${form}`);
    assert(findMessageRetentionTargets(ast).length === 1, `retention form should be discovered: ${form}`);
  }

  const shadowedRetentionNumbers = `
    var cap=600,keep=500;
    function trim(items){
      if(items.length>cap){let offset=items.length-keep;return items.slice(offset)}
      return items;
    }
    function unrelated(){var cap=50,keep=40;return cap+keep}
  `;
  const shadowedRetentionTargets = findMessageRetentionTargets(parseBundle(shadowedRetentionNumbers));
  assert(shadowedRetentionTargets.length === 1 &&
      shadowedRetentionTargets[0].limit === 600 && shadowedRetentionTargets[0].keep === 500,
    'retention thresholds should resolve in the candidate function lexical scope');

  const localRetentionNumbers = `
    function retentionModule(){
      const cap=600,keep=500;
      function trim(items){
        if(items.length>cap){let offset=items.length-keep;return items.slice(offset)}
        return items;
      }
      return trim;
    }
    const cap=50,keep=40;
  `;
  const localRetentionTargets = findMessageRetentionTargets(parseBundle(localRetentionNumbers));
  assert(localRetentionTargets.length === 1 &&
      localRetentionTargets[0].limit === 600 && localRetentionTargets[0].keep === 500,
    'function-local retention constants should override same-named outer bindings');

  const messageRetentionSource = `${messageRetentionDeclaration}\n${markdownCall}`;
  const messageRetentionAst = parseBundle(messageRetentionSource);
  const messageRetentionTargets = findMessageRetentionTargets(messageRetentionAst);
  assert(messageRetentionTargets.length === 1, 'new message-retention function should be discovered');
  assert(messageRetentionTargets[0].kind === 'message-retention',
    'new message-retention function should be classified separately from slice retention');
  assert(messageRetentionTargets[0].limit === 600,
    'new message-retention function should expose its numeric limit');

  const messageRetentionTransformed = transformClaudeBundle(messageRetentionSource, {
    fullTranscript: true,
    virtualTurns: false,
  });
  assert(messageRetentionTransformed.ok, 'new message-retention bundle should transform');
  assert(messageRetentionTransformed.diagnostics.retentionApplied,
    'new message-retention function should be transformed');
  assert(messageRetentionTransformed.diagnostics.retentionReason === 'applied',
    'new message-retention transform should report applied');
  assert(messageRetentionTransformed.body.includes('claude-code-enhance-full-transcript'),
    'new message-retention transform should add the marker');
  assert(messageRetentionTransformed.body.includes('return {messages:items,removedIndices:[]}'),
    'new message-retention function should return the complete message list');
  const wrapperPatch = extension.patchMessageRetentionCap(messageRetentionDeclaration);
  assert(wrapperPatch.applied, 'retention-only patch should update the structured entry point');
  const wrapperContext = {};
  vm.createContext(wrapperContext);
  vm.runInContext(
    wrapperPatch.body,
    wrapperContext,
    { filename: 'message-retention-wrappers.js' }
  );
  const wrapperMessages = Array.from({ length: 700 }, (_, index) => ({ index }));
  assert(wrapperContext.replayMessages(wrapperMessages, 0).length === 700,
    'replay wrappers should inherit full history from the patched retention entry point');
  assert(wrapperContext.appendMessages(wrapperMessages, 0, {}).removed === 0,
    'append wrappers should inherit empty removal metadata from the patched entry point');

  const messageRetentionDisabled = transformClaudeBundle(messageRetentionSource, {
    fullTranscript: false,
    virtualTurns: false,
  });
  assert(messageRetentionDisabled.ok && !messageRetentionDisabled.diagnostics.retentionApplied,
    'fullTranscript=false should preserve the new message-retention function');
  assert(!messageRetentionDisabled.body.includes('claude-code-enhance-full-transcript'),
    'fullTranscript=false should not add the marker to the new function');

  const semanticEviction = `
    function evictMessages(messages,event,boundary){
      let ids=getEvictedIds(event);
      if(ids.length===0)return{evictedCount:0,evictedBeforeBoundary:0};
      let next=messages.filter((message)=>!ids.has(message.uuid));
      if(next.length===messages.length)return{evictedCount:0,evictedBeforeBoundary:0};
      messages.length=0;
      for(let message of next)messages.push(message);
      return{evictedCount:messages.length-next.length,evictedBeforeBoundary:boundary};
    }
  `;
  assert(findMessageRetentionTargets(parseBundle(semanticEviction)).length === 0,
    'semantic eviction should not be treated as a capacity-retention target');

  const guardedSemanticFilter = `
    var semanticLimit=600;
    function filterSemanticMessages(messages, options){
      if(messages.length<=semanticLimit){
        return{messages:messages.filter((message)=>message.visible),removedIndices:[]};
      }
      return{messages:messages.filter((message)=>message.visible),removedIndices:[]};
    }
  `;
  assert(findMessageRetentionTargets(parseBundle(guardedSemanticFilter)).length === 0,
    'a length guard must return the unchanged array before it qualifies as capacity retention');

  const emptyRemovalFilter = `
    var displayLimit=600;
    function filterDisplayRows(messages, options){
      if(messages.length<=displayLimit)return{messages,removedIndices:[]};
      return{messages:messages.filter((message)=>message.visible),removedIndices:[]};
    }
  `;
  assert(findMessageRetentionTargets(parseBundle(emptyRemovalFilter)).length === 0,
    'structured filters without real removed indices should not qualify as capacity retention');

  const semanticIndexFilter = `
    var semanticIndexLimit=600;
    function filterSemanticIndices(messages, options){
      if(messages.length<=semanticIndexLimit)return{messages,removedIndices:[]};
      return{messages:messages.filter((message,index)=>index%2===0),removedIndices:[1]};
    }
  `;
  assert(findMessageRetentionTargets(parseBundle(semanticIndexFilter)).length === 0,
    'index-based semantic filtering without matching removal bookkeeping must not qualify as capacity retention');

  const duplicateRetention = `${messageRetentionDeclaration}
    function trimMessagesAgain(items,options){
      if(items.length<=retentionCap)return{messages:items,removedIndices:[]};
      let keep=Math.max(retentionFloor,retentionCap-retentionReserve);
      if(keep===items.length)return{messages:items,removedIndices:[]};
      let removed=new Set;
      for(let index=0;index<items.length-keep;index++)removed.add(index);
      return{messages:items.filter((item,index)=>!removed.has(index)),removedIndices:[...removed]};
    }
  `;
  const ambiguousRetention = transformClaudeBundle(`${duplicateRetention}\n${markdownCall}`, {
    fullTranscript: true,
    virtualTurns: false,
  });
  assert(!ambiguousRetention.ok, 'ambiguous retention should fail closed when full transcript is requested');
  assert(ambiguousRetention.reason === 'ambiguous-retention-target',
    'ambiguous retention should return a dedicated failure reason');
  assert(!ambiguousRetention.diagnostics.retentionApplied,
    'ambiguous retention targets should not be partially transformed');
  assert(ambiguousRetention.diagnostics.retentionReason === 'ambiguous-retention-target',
    'ambiguous retention targets should be diagnosed');
  assert(!ambiguousRetention.body.includes('claude-code-enhance-full-transcript'),
    'ambiguous retention transform should leave all retention functions untouched');
}

function testVirtualTurnTransform() {
  const source = `${markdownCall}\n${virtualTurnMarkup}`;
  const ast = parseBundle(source);
  const targets = findVirtualTurnTargets(source, ast);
  assert(targets.length === 1, 'virtual turn target should be discovered uniquely');
  assert(targets[0].hook.alias === 'hookState', 'virtual turn target should find the state hook');
  assert(targets[0].createElement === 'h', 'virtual turn target should preserve the element factory');
  assert(targets[0].turnCreateElement === 'm', 'synthetic turn target should preserve its DOM factory');
  assert(targets[0].focusIdentifier === '', 'turn renderers without highlight state should not invent one');

  const transformed = transformClaudeBundle(source, { fullTranscript: false, virtualTurns: true });
  assert(transformed.ok, 'virtual turn bundle should transform');
  assert(transformed.diagnostics.virtualTurnsApplied, 'virtual turns should report applied');
  assert(transformed.diagnostics.virtualTurnsReason === 'applied', 'virtual turns should report the applied reason');
  assert(transformed.body.includes('__CLAUDE_ENHANCE_VIRTUAL_TURNS__'), 'virtual runtime call should be injected');
  assert(transformed.body.includes('useState:hookState'),
    'the virtual child component should receive the verified state hook');
  assert(transformed.body.includes('return m(__claudeEnhanceVirtualRuntime.Component'),
    'the virtual child should be created by Claude\'s intrinsic-element JSX factory');
  assert(!transformed.body.includes('__claudeEnhanceVirtualTick') &&
      !transformed.body.includes('__claudeEnhanceVirtualForce'),
    'virtualization state must not be injected into Claude\'s parent chat component');
  assert((transformed.body.match(/hookState\(/g) || []).length === 1,
    'the transform must preserve only Claude\'s original parent hook call');
  assert(transformed.body.includes('firstTurns:primaryTurns'), 'first turn array should be preserved');
  assert(transformed.body.includes('secondTurns:secondaryTurns'), 'second turn array should be preserved');

  const combined = transformClaudeBundle(
    `${retentionDeclaration}\n${source}`,
    { fullTranscript: true, virtualTurns: true }
  );
  assert(combined.ok && combined.diagnostics.virtualTurnsApplied,
    'retention and virtualization transforms should compose');
  assert(combined.body.includes('claude-code-enhance-full-transcript'),
    'full-transcript retention should remain applied alongside virtualization');

  const disabled = transformClaudeBundle(source, { fullTranscript: false, virtualTurns: false });
  assert(disabled.ok, 'disabled virtualization should still transform Markdown');
  assert(!disabled.diagnostics.virtualTurnsApplied, 'disabled virtualization should not transform turns');
  assert(!disabled.body.includes('__claudeEnhanceVirtualRuntime'), 'disabled virtualization should preserve native maps');

  const withoutHook = source.replace(
    'const hookState=function(initial){return React.useState(initial)};',
    'const hookState=function(initial){return initial};'
  );
  const unverifiedHook = transformClaudeBundle(withoutHook, { fullTranscript: false });
  assert(unverifiedHook.ok, 'unverified hooks should not disable the Markdown patch');
  assert(!unverifiedHook.diagnostics.virtualTurnsApplied, 'unverified hooks should fail virtualization closed');

  const nestedHookOnly = source.replace(
    'const hookState=function(initial){return React.useState(initial)};',
    'const hookState=function(initial){function nested(){return React.useState(initial)}return [initial,()=>{}]};'
  );
  const nestedHookResult = transformClaudeBundle(nestedHookOnly, {
    fullTranscript: false,
    virtualTurns: true,
  });
  assert(nestedHookResult.ok && !nestedHookResult.diagnostics.virtualTurnsApplied,
    'a nested useState call must not misidentify a non-hook wrapper as the component hook');

  const sideEffectHookOnly = source.replace(
    'const hookState=function(initial){return React.useState(initial)};',
    'const hookState=function(initial){React.useState(initial);return [initial,()=>{}]};'
  );
  const sideEffectHookResult = transformClaudeBundle(sideEffectHookOnly, {
    fullTranscript: false,
    virtualTurns: true,
  });
  assert(sideEffectHookResult.ok && !sideEffectHookResult.diagnostics.virtualTurnsApplied,
    'a function that only calls useState as a side effect must not qualify as the hook wrapper');

  const unverifiedFullTranscript = transformClaudeBundle(
    `${retentionDeclaration}\n${withoutHook}`,
    {
      fullTranscript: true,
      virtualTurns: true,
      requireVirtualTurnsForFullTranscript: true,
    }
  );
  assert(unverifiedFullTranscript.ok,
    'independent Markdown enhancements should survive a full-transcript safety fallback');
  assert(!unverifiedFullTranscript.diagnostics.retentionApplied,
    'full transcript should leave native retention active when virtualization is unavailable');
  assert(unverifiedFullTranscript.diagnostics.fullTranscriptFallbackReason === 'no-compatible-target',
    'full transcript should diagnose the missing virtual turn target');
  assert(!unverifiedFullTranscript.body.includes('claude-code-enhance-full-transcript'),
    'failed full-transcript virtualization should leave retention untouched');

  const secondTurnComponent = `
    function Chat2({session:e}){
      let [opened,setOpened]=hookState(false);
      return h("div",{ref:listRef,className:"messagesContainer_test",children:[
        usePrimary?primaryTurns.map((turn,index)=>{return h(Fragment,{children:[turn.banner,h("div",{className:"turn_test",children:[]})]},turn.key)}):secondaryTurns.map((turn,index)=>{return h(Fragment,{children:[turn.banner,h("div",{className:"turn_test",children:[]})]},turn.key)})
      ]});
    }
  `;
  const ambiguous = transformClaudeBundle(`${source}\n${secondTurnComponent}`, { fullTranscript: false });
  assert(ambiguous.ok, 'ambiguous virtual targets should not disable the Markdown patch');
  assert(!ambiguous.diagnostics.virtualTurnsApplied, 'ambiguous virtual targets should fail closed');
  assert(ambiguous.diagnostics.virtualTurnsReason === 'ambiguous-turn-renderer', 'ambiguity should be diagnosed');
}

function testVirtualTurnRuntime() {
  const {
    createStore,
    reconcile,
    sumHeights,
    syncHeightIndex,
    canExtendHeightIndex,
    auditHeightIndex,
    sessionKey,
    annotateTurn,
    measuredTurnHeight,
    applyPendingScroll,
    handleScroll,
    indexForHeight,
    getStore,
    clearMeasurements,
    invalidateMeasurements,
    ensureContainer,
    revealFocus,
    reset,
  } = virtualTurns._test;
  reset();

  const anonymousSessionA = {};
  const anonymousSessionB = {};
  assert(sessionKey(anonymousSessionA) === sessionKey(anonymousSessionA),
    'anonymous session objects should retain a stable virtualization key');
  assert(sessionKey(anonymousSessionA) !== sessionKey(anonymousSessionB),
    'different anonymous sessions should not share virtualization state');

  const store = createStore('session');
  reconcile(store, 120, false);
  assert(store.start === 96 && store.end === 120, 'initial window should be tail-first');
  reconcile(store, 121, false);
  assert(store.start === 97 && store.end === 121, 'append at the tail should follow the live turn');
  store.atBottom = false;
  reconcile(store, 130, false);
  assert(store.start === 97 && store.end === 121, 'append while reading history should preserve the window');

  const focusTurns = Array.from({ length: 130 }, (_, index) => ({
    key: `focus-${index}`,
    items: [{ messages: [{ idx: index }] }],
  }));
  revealFocus(store, focusTurns, 12);
  assert(store.start <= 12 && store.end > 12,
    'focused historical messages should move the virtual window to their turn');
  assert(store.pendingScroll?.mode === 'focus' && store.pendingScroll.key === 'focus-12',
    'focused historical messages should schedule a centered reveal');

  const turns = Array.from({ length: 130 }, (_, index) => ({ key: `turn-${index}` }));
  store.heights.set('turn-0', 100);
  assert(sumHeights(store, turns, 0, 1) === 100, 'measured height should be used');
  assert(
    sumHeights(store, turns, 1, 3) === virtualTurns._test.DEFAULTS.estimateHeight * 2,
    'unmeasured turns should use the estimate'
  );
  syncHeightIndex(store, turns);
  store.heights.set('turn-1', 200);
  store.heightValues[1] = 200;
  store.heightDirtyFrom = 1;
  assert(sumHeights(store, turns, 0, 3) === 100 + 200 + virtualTurns._test.DEFAULTS.estimateHeight,
    'height prefix sums should refresh incrementally after measurement changes');
  const replacementTurns = turns.slice();
  replacementTurns[0] = { key: 'turn-replacement' };
  syncHeightIndex(store, replacementTurns);
  assert(store.heightKeys[0] === 'turn-replacement' && !store.heights.has('turn-0'),
    'same-length turn-key replacement should invalidate stale height entries');
  assert(store.heightPrefix[1] === virtualTurns._test.DEFAULTS.estimateHeight,
    'same-length turn-key replacement should rebuild spacer prefix sums');
  const activeReplacementTurns = replacementTurns.slice();
  const activeReplacementIndex = Math.max(0, store.start);
  activeReplacementTurns[activeReplacementIndex] = { key: 'active-turn-replacement' };
  assert(syncHeightIndex(store, activeReplacementTurns),
    'bounded key validation should detect replacements inside the active window');
  const historicalReplacementTurns = activeReplacementTurns.slice();
  historicalReplacementTurns[40] = { key: 'historical-turn-replacement' };
  assert(!syncHeightIndex(store, historicalReplacementTurns),
    'same-length source-array changes should stay bounded on the synchronous render path');
  assert(auditHeightIndex(store, historicalReplacementTurns),
    'the idle consistency audit should detect replacements outside the active window');
  assert(store.heightKeys[40] === 'historical-turn-replacement',
    'historical replacements should rebuild the corresponding height-index entry');

  const retentionStore = createStore('retention-cycle');
  for (let revision = 0; revision < 100; revision++) {
    const retained = Array.from({ length: 24 }, (_, index) => ({ key: `retained-${revision + index}` }));
    syncHeightIndex(retentionStore, retained, null, { skipAudit: true });
    assert(retentionStore.heightIndex.size === retained.length,
      'native retention must remove evicted keys from the height index');
    assert(JSON.stringify(Array.from(retentionStore.heightIndex.keys())) === JSON.stringify(retained.map((turn) => turn.key)),
      'height indices must describe only currently retained turns');
  }

  const largeAppendStore = createStore('large-append');
  reconcile(largeAppendStore, 10000, false);
  let appendKeyReads = 0;
  const largeTurns = Array.from({ length: 10000 }, (_, index) => ({
    get key() {
      appendKeyReads++;
      return `large-${index}`;
    },
  }));
  syncHeightIndex(largeAppendStore, largeTurns);
  appendKeyReads = 0;
  const appendedTurns = largeTurns.concat([{
    get key() {
      appendKeyReads++;
      return 'large-10000';
    },
  }]);
  assert(canExtendHeightIndex(largeAppendStore, appendedTurns),
    'an append-only turn array should use the bounded extension path');
  syncHeightIndex(largeAppendStore, appendedTurns);
  assert(appendKeyReads < 200,
    'appending one turn must not rescan every historical turn key');
  assert(!Object.prototype.hasOwnProperty.call(largeAppendStore, 'heightSource'),
    'virtual stores should not retain the complete turn array');

  let sameLengthKeyReads = 0;
  const sameLengthTurns = appendedTurns.map((turn, index) => ({
    get key() {
      sameLengthKeyReads++;
      return index === 4000 ? 'large-historical-replacement' : turn.key;
    },
  }));
  assert(!syncHeightIndex(largeAppendStore, sameLengthTurns),
    'same-length long arrays should defer historical consistency checks');
  assert(sameLengthKeyReads < 200,
    'same-length streaming updates must not synchronously rescan every historical turn key');
  assert(auditHeightIndex(largeAppendStore, sameLengthTurns),
    'the deferred audit should still repair a historical same-length replacement');
  assert(largeAppendStore.heightKeys[4000] === 'large-historical-replacement',
    'the deferred audit should update the historical key and spacer height entry');

  clearMeasurements(store);
  assert(store.heights.size === 0 && store.heightKeys.length === 0 && store.heightWindow.total === -1,
    'viewport or zoom changes should invalidate all cached turn measurements');
  syncHeightIndex(store, turns);
  assert(indexForHeight(store, virtualTurns._test.DEFAULTS.estimateHeight * 12.5) === 12,
    'height lookup should resolve a scrollbar position to its virtual turn index');

  const createElement = (type, config = {}, key) => ({
    type,
    key: key ?? config.key,
    props: config,
  });
  const annotation = { matched: false };
  const node = {
    type: 'fragment',
    key: 'turn-1',
    props: {
      children: [
        { type: 'span', props: { children: 'banner' } },
        { type: 'div', props: { className: 'turn_test', children: [] } },
      ],
    },
  };
  const annotated = annotateTurn(node, 'turn-1', createElement, createElement, annotation);
  assert(annotation.matched, 'turn wrapper should be annotated');
  assert(annotated.key === 'turn-1', 'turn fragment key should be preserved');
  assert(
    annotated.props.children[2].props['data-ce-turn-key'] === 'turn-1',
    'turn wrapper should carry the stable virtualization key'
  );
  const dashedAnnotation = { matched: false };
  const dashedNode = annotateTurn(
    { type: 'div', props: { className: 'turn-test', children: [] } },
    'turn-dashed',
    createElement,
    createElement,
    dashedAnnotation
  );
  assert(dashedAnnotation.matched && dashedNode.props['data-ce-turn-key'] === 'turn-dashed',
    'dashed turn class names should remain compatible with runtime annotation');

  assert(
    annotated.props.children[0].props['data-ce-turn-start'] === 'turn-1',
    'turn fragments should carry a hidden measurement boundary before leading separators'
  );

  const turnBoundary = {
    getAttribute(name) { return name === 'data-ce-turn-start' ? 'turn-measured' : null; },
    hasAttribute() { return false; },
    previousElementSibling: null,
    getBoundingClientRect() { return { top: 80, bottom: 80, height: 0 }; },
  };
  const daySeparator = {
    hasAttribute() { return false; },
    getAttribute() { return null; },
    previousElementSibling: turnBoundary,
    getBoundingClientRect() { return { top: 80, bottom: 100, height: 20 }; },
  };
  const measuredTurn = {
    getAttribute(name) { return name === 'data-ce-turn-key' ? 'turn-measured' : null; },
    previousElementSibling: daySeparator,
    getBoundingClientRect() { return { top: 100, bottom: 260, height: 160 }; },
  };
  assert(measuredTurnHeight(measuredTurn) === 180,
    'turn height measurement should include its leading date separator');

  const engineSurface = {
    hasAttribute() { return false; },
    getAttribute() { return null; },
    previousElementSibling: null,
    getBoundingClientRect() { return { top: 0, bottom: 80, height: 80 }; },
  };
  turnBoundary.previousElementSibling = engineSurface;
  assert(measuredTurnHeight(measuredTurn) === 180,
    'turn height measurement should stop at its marker and exclude container-level surfaces');

  reset();
  const container = {
    isConnected: true,
    parentElement: null,
    scrollTop: 0,
    scrollHeight: 10000,
    clientHeight: 600,
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0 }; },
  };
  const runtimeCreate = (type, config = {}, key) => ({
    type,
    key: key ?? config.key,
    props: config,
  });
  const renderTurn = (turn) => runtimeCreate('fragment', {
    key: turn.key,
    children: [runtimeCreate('div', { className: 'turn_test' })],
  });
  const renderOptions = {
    branch: true,
    firstTurns: turns,
    secondTurns: [],
    firstRender: renderTurn,
    secondRender: renderTurn,
    createElement: runtimeCreate,
    containerRef: { current: container },
    force() {},
    tick: 0,
    session: { sessionId: { value: 'runtime' } },
  };
  virtualTurns.render(renderOptions);
  const liveStore = getStore('runtime');
  assert(liveStore.renderedTurns === virtualTurns._test.DEFAULTS.initialTurns,
    'the initial tail window should render only the configured number of turns');
  const shortNodes = virtualTurns.render({
    ...renderOptions,
    firstTurns: turns.slice(0, 3),
    session: { sessionId: { value: 'short-runtime' } },
  });
  assert(!shortNodes.some((node) => node.props?.['data-ce-virtual-spacer']),
    'short transcripts should not mount zero-height virtual spacers');
  assert(liveStore.disposed,
    'switching sessions on the same mounted container should dispose the previous store');
  virtualTurns.render(renderOptions);
  const activeStore = getStore('runtime');
  activeStore.start = 80;
  activeStore.end = 104;
  activeStore.windowSize = 24;
  activeStore.atBottom = false;
  const nodes = virtualTurns.render({ ...renderOptions, firstTurns: turns.concat([{ key: 'turn-130' }]) });
  const spacerCount = nodes.filter((node) => node.props?.['data-ce-virtual-spacer']).length;
  assert(spacerCount === 2, 'scrolled window should mount both spacers');
  assert(activeStore.renderedTurns === virtualTurns._test.DEFAULTS.initialTurns + 1,
    'scrolled window should keep the latest turn mounted outside the virtual window');

  const prependSession = { sessionId: { value: 'prepend-runtime' } };
  const prependTurns = Array.from({ length: 40 }, (_, index) => ({ key: `prepend-${index}` }));
  virtualTurns.render({ ...renderOptions, firstTurns: prependTurns, session: prependSession });
  const prependStore = getStore('prepend-runtime');
  prependStore.start = 16;
  prependStore.end = 40;
  prependStore.windowSize = 24;
  prependStore.atBottom = false;
  prependStore.pendingScroll = null;
  prependStore.container = {
    ...container,
    getBoundingClientRect() { return { top: 0, bottom: 600 }; },
    querySelectorAll() {
      return [{
        getAttribute() { return 'prepend-20'; },
        getBoundingClientRect() { return { top: 100, bottom: 200 }; },
      }];
    },
  };
  const prependedTurns = Array.from({ length: 10 }, (_, index) => ({ key: `new-${index}` }))
    .concat(prependTurns);
  const prependedNodes = virtualTurns.render({
    ...renderOptions,
    firstTurns: prependedTurns,
    session: prependSession,
  });
  const renderedKeys = prependedNodes
    .map((node) => node.props?.children?.find?.((child) => child?.props?.['data-ce-turn-key']))
    .filter(Boolean)
    .map((node) => node.props['data-ce-turn-key']);
  assert(prependStore.start === 26 && prependStore.end === 50 && prependStore.tailStart === 50,
    'front insertion should shift the anchored window and recompute the live-tail boundary');
  assert(new Set(renderedKeys).size === renderedKeys.length,
    'front insertion must not render the live tail twice when the shifted window reaches it');

  const trimmedSession = { sessionId: { value: 'trimmed-runtime' } };
  const trimTurns = Array.from({ length: 100 }, (_, index) => ({ key: `trim-${index}` }));
  virtualTurns.render({ ...renderOptions, firstTurns: trimTurns, session: trimmedSession });
  const trimStore = getStore('trimmed-runtime');
  trimStore.start = 76;
  trimStore.end = 100;
  trimStore.windowSize = 24;
  trimStore.atBottom = false;
  trimStore.pendingScroll = null;
  trimStore.container = {
    ...container,
    getBoundingClientRect() { return { top: 0, bottom: 600 }; },
    querySelectorAll() {
      return [{
        getAttribute() { return 'trim-80'; },
        getBoundingClientRect() { return { top: 120, bottom: 220 }; },
      }];
    },
  };
  virtualTurns.render({
    ...renderOptions,
    firstTurns: trimTurns.slice(30),
    session: trimmedSession,
  });
  assert(trimStore.start === 46 && trimStore.end === 70,
    'front trimming should preserve the anchor offset even when the old window exceeded the new tail');

  let arrayArgument = null;
  virtualTurns.render({
    ...renderOptions,
    firstRender(turn, index, array) {
      arrayArgument = array;
      return renderTurn(turn, index, array);
    },
    session: { sessionId: { value: 'array-argument' } },
  });
  assert(arrayArgument === turns,
    'runtime virtualization should preserve Array.map callback third-argument semantics');

  const anchorElement = {
    getAttribute() { return 'turn-5'; },
    getBoundingClientRect() { return { top: 110, bottom: 210 }; },
  };
  const anchorContainer = {
    scrollTop: 1000,
    scrollHeight: 5000,
    clientHeight: 600,
    getBoundingClientRect() { return { top: 50 }; },
    querySelectorAll() { return [anchorElement]; },
  };
  const anchorStore = createStore('anchor');
  anchorStore.container = anchorContainer;
  anchorStore.total = 100;
  anchorStore.end = 90;
  anchorStore.pendingScroll = { mode: 'anchor', key: 'turn-5', offset: 20 };
  applyPendingScroll(anchorStore);
  assert(anchorContainer.scrollTop === 1040, 'window changes should preserve the keyed scroll anchor');
  assert(anchorStore.pendingScroll === null, 'anchor correction should be consumed once');

  reset();
  const invalidationStore = getStore('invalidation');
  let invalidationForces = 0;
  invalidationStore.initialized = true;
  invalidationStore.atBottom = false;
  invalidationStore.topHeight = 1800;
  invalidationStore.heights.set('turn-5', 200);
  invalidationStore.container = {
    isConnected: true,
    scrollTop: 900,
    scrollHeight: 6000,
    clientHeight: 600,
    getBoundingClientRect() { return { top: 50, bottom: 650 }; },
    querySelectorAll() { return [anchorElement]; },
  };
  invalidationStore.force = () => { invalidationForces++; };
  invalidateMeasurements();
  assert(invalidationStore.pendingScroll?.mode === 'anchor' &&
      invalidationStore.pendingScroll.key === 'turn-5',
    'measurement invalidation should capture a visible anchor before clearing heights');
  assert(invalidationStore.heights.size === 0 && invalidationForces === 1,
    'measurement invalidation should clear caches and request one rerender');

  const detachedContainer = {
    isConnected: false,
    scrollTop: 730,
    style: {},
    removeEventListener() {},
  };
  const replacementContainer = {
    isConnected: true,
    parentElement: null,
    scrollTop: 0,
    style: {},
    addEventListener() {},
    removeEventListener() {},
  };
  const remountStore = createStore('remount');
  remountStore.initialized = true;
  remountStore.atBottom = false;
  remountStore.topHeight = 2400;
  remountStore.container = detachedContainer;
  remountStore.scrollHandler = () => {};
  remountStore.containerRef = { current: replacementContainer };
  ensureContainer(remountStore);
  assert(remountStore.container === replacementContainer &&
      remountStore.pendingScroll?.mode === 'position' &&
      remountStore.pendingScroll.scrollTop === 730,
    'container remounts should preserve a historical scroll position instead of forcing the tail');

  const scrollStore = createStore('scroll');
  reconcile(scrollStore, 200, false);
  scrollStore.pendingScroll = null;
  let forceCalls = 0;
  scrollStore.container = {
    isConnected: true,
    scrollTop: 100060,
    scrollHeight: 120000,
    clientHeight: 600,
    getBoundingClientRect() { return { top: 0, bottom: 600 }; },
    querySelector(selector) {
      if (selector.includes('="top"')) {
        return { getBoundingClientRect() { return { top: -99940, bottom: 60 }; } };
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
  scrollStore.force = () => { forceCalls++; };
  scrollStore.topHeight = 100000;
  scrollStore.bottomHeight = 0;
  handleScroll(scrollStore);
  assert(scrollStore.start === 164 && scrollStore.end === 188,
    'approaching the top spacer should page in earlier turns');
  assert(scrollStore.pendingScroll?.mode === 'position',
    'pagination without a DOM anchor should preserve the prior scroll position');
  assert(forceCalls === 1, 'pagination should request one React refresh');

  const cancelStore = createStore('cancel');
  cancelStore.total = 10;
  cancelStore.end = 10;
  cancelStore.container = {
    isConnected: true,
    scrollTop: 100,
    scrollHeight: 5000,
    clientHeight: 600,
    querySelectorAll() { return []; },
  };
  cancelStore.pendingScroll = { mode: 'bottom' };
  handleScroll(cancelStore);
  assert(cancelStore.pendingScroll === null && cancelStore.atBottom === false,
    'user scrolling up should cancel a pending auto-follow');

  const pagedStore = createStore('paged-top');
  pagedStore.total = 200;
  pagedStore.start = 96;
  pagedStore.end = 120;
  pagedStore.windowSize = 24;
  pagedStore.topHeight = 57600;
  pagedStore.bottomHeight = 0;
  pagedStore.atBottom = false;
  pagedStore.pendingScroll = null;
  let pagedForceCalls = 0;
  pagedStore.container = {
    isConnected: true,
    scrollTop: 57000,
    scrollHeight: 100000,
    clientHeight: 600,
    getBoundingClientRect() { return { top: 100, bottom: 700 }; },
    querySelector(selector) {
      if (selector.includes('="top"')) {
        return { getBoundingClientRect() { return { top: -57000, bottom: 340 }; } };
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
  pagedStore.force = () => { pagedForceCalls++; };
  handleScroll(pagedStore);
  assert(pagedStore.start === 84 && pagedStore.end === 108,
    'approaching a large top spacer should page earlier turns instead of jumping to the head');
  assert(pagedStore.pendingScroll?.mode === 'position',
    'top pagination should preserve position when no DOM anchor is available');
  assert(pagedForceCalls === 1, 'top pagination should request one React refresh');

  const headStore = createStore('jump-head');
  headStore.total = 200;
  headStore.start = 12;
  headStore.end = 36;
  headStore.windowSize = 24;
  headStore.topHeight = 7200;
  headStore.atBottom = false;
  let headForceCalls = 0;
  headStore.container = {
    isConnected: true,
    scrollTop: 0,
    scrollHeight: 40000,
    clientHeight: 600,
    getBoundingClientRect() { return { top: 100, bottom: 700 }; },
    querySelector(selector) {
      if (selector.includes('="top"')) {
        return { getBoundingClientRect() { return { top: 100, bottom: 7300 }; } };
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
  headStore.force = () => { headForceCalls++; };
  handleScroll(headStore);
  assert(headStore.start === 0 && headStore.end === 24,
    'dragging to the top of the spacer should jump directly to the first page');
  assert(headStore.pendingScroll?.mode === 'top' && headForceCalls === 1,
    'jumping to the first page should request one anchored refresh');

  const offsetStore = createStore('offset-top');
  offsetStore.total = 200;
  offsetStore.start = 96;
  offsetStore.end = 120;
  offsetStore.windowSize = 24;
  offsetStore.topHeight = 57600;
  offsetStore.atBottom = false;
  let offsetForceCalls = 0;
  offsetStore.container = {
    isConnected: true,
    scrollTop: 500,
    scrollHeight: 100000,
    clientHeight: 600,
    getBoundingClientRect() { return { top: 200, bottom: 800 }; },
    querySelector(selector) {
      if (selector.includes('="top"')) {
        return { getBoundingClientRect() { return { top: -57400, bottom: 400 }; } };
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
  offsetStore.force = () => { offsetForceCalls++; };
  handleScroll(offsetStore);
  assert(offsetStore.start === 84 && offsetForceCalls === 1,
    'DOM spacer bounds should trigger pagination when the list has non-scroll content above it');

  const middleStore = createStore('middle-spacer');
  reconcile(middleStore, 200, false);
  middleStore.pendingScroll = null;
  syncHeightIndex(middleStore, Array.from({ length: 200 }, (_, index) => ({ key: `middle-${index}` })));
  middleStore.topHeight = virtualTurns._test.DEFAULTS.estimateHeight * middleStore.start;
  let middleForceCalls = 0;
  middleStore.container = {
    isConnected: true,
    scrollTop: 50000,
    scrollHeight: 120000,
    clientHeight: 600,
    getBoundingClientRect() { return { top: 100, bottom: 700 }; },
    querySelector(selector) {
      if (selector.includes('="top"')) {
        return { getBoundingClientRect() { return { top: -50000, bottom: 50000 }; } };
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
  middleStore.force = () => { middleForceCalls++; };
  handleScroll(middleStore);
  assert(middleStore.start > 60 && middleStore.end < 120,
    'dragging into the middle of a large spacer should jump near that virtual position');
  assert(middleStore.pendingScroll?.mode === 'focus' && middleForceCalls === 1,
    'middle-spacer jumps should center the resolved turn with one refresh');

  const fallbackStore = createStore('position-fallback');
  fallbackStore.total = 100;
  fallbackStore.end = 80;
  fallbackStore.topHeight = 4200;
  fallbackStore.container = {
    scrollTop: 3000,
    scrollHeight: 12000,
    clientHeight: 600,
    querySelectorAll() { return []; },
  };
  fallbackStore.pendingScroll = { mode: 'position', scrollTop: 3000, topHeight: 5000 };
  applyPendingScroll(fallbackStore);
  assert(fallbackStore.container.scrollTop === 2200,
    'position fallback should compensate for the changed top spacer instead of jumping to zero');

  reset();
  const lruStores = Array.from({ length: virtualTurns._test.DEFAULTS.maxStores + 1 }, (_, index) => (
    getStore(`lru-${index}`)
  ));
  assert(lruStores[0].disposed && lruStores[0].container === null && lruStores[0].force === null,
    'LRU eviction should dispose listeners and queued work for the oldest session');
  reset();
}

function testVirtualTurnExecution() {
  const executableMarkup = `
    const hookState=function(initial){return React.useState(initial)};
    const h=function(type,config,key){
      if(typeof type==="string")throw new Error("component factory received an intrinsic element");
      return React.createElement(type,config,key);
    };
    const m=React.createElement;
    const Fragment=React.Fragment;
    const primaryTurns=[];
    const secondaryTurns=Array.from({length:1000},(_,index)=>({key:"turn-"+index,banner:null}));
    const usePrimary=false;
    const listRef={current:globalThis.testContainer};
    function Chat({session:e}){
      globalThis.parentRenderCount++;
      let [opened,setOpened]=hookState(false);
      return m("div",{ref:listRef,className:"messagesContainer_test",children:[
        m("div",{className:"header"}),
        usePrimary?primaryTurns.map((turn,index,array)=>{return h(Fragment,{children:[turn.banner,m("div",{className:"turn_test","data-map-index":index,"data-map-size":array.length,children:[]})]},turn.key)}):secondaryTurns.map((turn,index,array)=>{return h(Fragment,{children:[turn.banner,m("div",{className:"turn_test","data-map-index":index,"data-map-size":array.length,children:[]})]},turn.key)})
      ]});
    }
  `;
  const source =
    "const base=[];const Markdown=function(){};const P=function(){};const value='x';" +
    `React.createElement(Markdown,{components:{p:P},remarkPlugins:base},value);\n${executableMarkup}`;
  const transformed = transformClaudeBundle(source, { fullTranscript: false, virtualTurns: true });
  assert(transformed.ok && transformed.diagnostics.virtualTurnsApplied,
    'executable virtual-turn bundle should transform');

  function jsx(type, config = {}, key) {
    const props = { ...config };
    const explicitKey = key !== undefined ? key : props.key;
    delete props.key;
    return {
      type,
      key: explicitKey ?? null,
      props,
    };
  }
  function createBundleContext() {
    const container = {
      isConnected: true,
      parentElement: null,
      scrollTop: 0,
      scrollHeight: 10000,
      clientHeight: 600,
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { top: 0 }; },
    };
    const context = {
      console,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      Promise,
      hookCalls: 0,
      parentRenderCount: 0,
      setters: [],
      testContainer: container,
      React: {
        createElement: jsx,
        Fragment: Symbol.for('react.fragment'),
        useState(value) {
          context.hookCalls++;
          const setter = () => {};
          context.setters.push(setter);
          return [value, setter];
        },
      },
    };
    context.window = context;
    context.globalThis = context;
    context.requestAnimationFrame = (callback) => {
      callback();
      return 0;
    };
    vm.createContext(context);
    return context;
  }

  const context = createBundleContext();
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'vendor', 'virtual-turns.js'), 'utf8'), context);
  vm.runInContext(transformed.body, context, { filename: 'virtual-turn-bundle.js' });

  const tree = context.Chat({ session: { sessionId: { value: 'exec' } } });
  const virtualElement = tree.props.children[1];
  assert(virtualElement?.key === 'ce-virtual-turns', 'virtual turns should use a keyed child component');
  assert(virtualElement.type === context.__CLAUDE_ENHANCE_VIRTUAL_TURNS__.Component,
    'the parent chat should mount the stable virtual child component');
  assert(context.parentRenderCount === 1 && context.hookCalls === 1,
    'rendering Claude\'s parent should execute only its original hook');
  const wrapper = virtualElement.type(virtualElement.props);
  assert(context.parentRenderCount === 1 && context.hookCalls === 2,
    'the virtualization hook should execute only inside the child component');
  assert(Array.isArray(wrapper.props.children), 'Fragment children must be passed through props for jsx runtime');
  assert(wrapper.props.children.length === virtualTurns._test.DEFAULTS.initialTurns + 1,
    'execution should mount only the tail window plus its top spacer');
  assert(wrapper.props.children[0].type === 'div' &&
      wrapper.props.children[0].props['data-ce-virtual-spacer'] === 'top',
    'virtual spacers should be created by Claude\'s intrinsic-element JSX factory');
  virtualElement.type(virtualElement.props);
  assert(context.parentRenderCount === 1 && context.hookCalls === 3,
    'rerendering the virtual window must not rerun Claude\'s parent data preparation');

  function count(node, predicate) {
    if (Array.isArray(node)) {
      return node.reduce((total, child) => total + count(child, predicate), 0);
    }
    if (!node || typeof node !== 'object') return 0;
    let total = predicate(node) ? 1 : 0;
    const children = node.props?.children;
    if (Array.isArray(children)) {
      for (const child of children) total += count(child, predicate);
    } else {
      total += count(children, predicate);
    }
    return total;
  }

  function find(node, predicate) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const match = find(child, predicate);
        if (match) return match;
      }
      return null;
    }
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    return find(node.props?.children, predicate);
  }

  assert(count(wrapper, (node) => node.props?.['data-ce-turn-key']) === 24,
    'execution should produce only 24 turn wrappers for a 1000-turn transcript');
  assert(count(wrapper, (node) => node.props?.['data-ce-virtual-spacer']) === 1,
    'tail-first execution should include the top spacer');
  const runtimeFirstTurn = find(wrapper, (node) => node.props?.className === 'turn_test');
  assert(runtimeFirstTurn?.props?.['data-map-index'] === 976 &&
      runtimeFirstTurn.props['data-map-size'] === 1000,
    'runtime execution should preserve absolute index and original array callback arguments');

  const fallbackContext = createBundleContext();
  vm.runInContext(transformed.body, fallbackContext, { filename: 'virtual-turn-fallback-bundle.js' });
  const fallbackTree = fallbackContext.Chat({ session: { sessionId: { value: 'fallback' } } });
  assert(count(fallbackTree, (node) => node.props?.className === 'turn_test') === 24,
    'missing runtime should fall back to a bounded tail window');
  assert(fallbackTree.props.children[1]?.key === 'ce-virtual-turns-fallback',
    'bounded fallback should remain isolated in a keyed Fragment');
  const fallbackFirstTurn = find(fallbackTree, (node) => node.props?.className === 'turn_test');
  assert(fallbackFirstTurn?.props?.['data-map-index'] === 976 &&
      fallbackFirstTurn.props['data-map-size'] === 1000,
    'bounded fallback should preserve absolute index and original array callback arguments');

  const throwingContext = createBundleContext();
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'vendor', 'virtual-turns.js'), 'utf8'), throwingContext);
  vm.runInContext(transformed.body, throwingContext, { filename: 'virtual-turn-throwing-bundle.js' });
  const throwingTree = throwingContext.Chat({ session: { sessionId: { value: 'throwing' } } });
  const throwingElement = throwingTree.props.children[1];
  let renderAttempts = 0;
  throwingElement.props.secondRender = (turn, index, array) => {
    renderAttempts++;
    if (renderAttempts === 1) throw new Error('injected virtualizer failure');
    return jsx('Fragment', {
      children: [jsx('div', {
        className: 'turn_test',
        'data-map-index': index,
        'data-map-size': array.length,
        children: [],
      })],
    }, turn.key);
  };
  const throwingWrapper = throwingElement.type(throwingElement.props);
  assert(count(throwingWrapper, (node) => node.props?.className === 'turn_test') === 24,
    'runtime virtualizer failures should retain the bounded tail fallback');
  assert(renderAttempts === 25,
    'the component should stop virtual rendering after the failure and render one bounded fallback window');
  throwingElement.type(throwingElement.props);
  assert(renderAttempts === 49,
    'a failed session branch should stay on the bounded fallback without retrying virtual rendering');
}

function testScheduler() {
  const scheduled = [];
  const batches = [];
  const rootA = { id: 'a', usable: true };
  const rootB = { id: 'b', usable: true };
  const scheduler = createIncrementalScheduler({
    schedule(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    flush(batch) {
      batches.push(batch);
    },
    isUsableRoot: (root) => root.usable,
  });

  scheduler.enqueue(rootA, ['math'], { reason: 'characterData' });
  scheduler.enqueue(rootB, ['code'], { reason: 'childList' });
  scheduler.enqueue(rootA, ['apiErrors', 'math'], { reason: 'stream' });
  assert(scheduled.length === 1, 'multiple mutations should schedule one flush');
  assert(scheduler.getState().dirtyRootCount === 2, 'dirty roots should be deduplicated');
  scheduled.shift()();
  assert(batches.length === 1 && batches[0].roots.length === 2, 'incremental batch should retain both roots');
  assert(['apiErrors', 'code', 'math'].every((feature) => batches[0].features.includes(feature)), 'feature flags should accumulate');

  scheduler.enqueue(rootA, ['math'], { reason: 'before-swap' });
  scheduler.enqueue(null, undefined, { fullPass: true, reason: 'container-attached' });
  scheduled.shift()();
  assert(batches[1].fullPass && batches[1].roots.length === 0, 'full pass should supersede dirty roots');
  assert(ALL_FEATURES.every((feature) => batches[1].features.includes(feature)), 'full pass should include every feature');
}

function testTransactions() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-enhance-transaction-'));
  const first = path.join(temp, 'first.txt');
  const second = path.join(temp, 'second.txt');
  fs.writeFileSync(first, 'first-original');
  fs.writeFileSync(second, 'second-original');

  let verifierFailed = false;
  try {
    transactionalWriteFilesSync([
      { path: first, content: 'first-new' },
      { path: second, content: 'second-new' },
    ], () => { throw new Error('verification failed'); });
  } catch {
    verifierFailed = true;
  }
  assert(verifierFailed, 'verifier failure should propagate');
  assert(fs.readFileSync(first, 'utf8') === 'first-original', 'verifier failure should preserve first file');
  assert(fs.readFileSync(second, 'utf8') === 'second-original', 'verifier failure should preserve second file');

  const originalRename = fs.renameSync;
  let injectedFailure = false;
  fs.renameSync = function failSecondCommit(source, target) {
    if (!injectedFailure && target === second && source.includes('.claude-enhance-')) {
      injectedFailure = true;
      throw new Error('injected second commit failure');
    }
    return originalRename.call(fs, source, target);
  };
  try {
    transactionalWriteFilesSync([
      { path: first, content: 'first-new' },
      { path: second, content: 'second-new' },
    ]);
    throw new Error('partial commit failure did not propagate');
  } catch (error) {
    assert(error.message.includes('injected second commit failure'), 'expected injected commit failure');
  } finally {
    fs.renameSync = originalRename;
  }
  assert(fs.readFileSync(first, 'utf8') === 'first-original', 'partial commit should roll back first file');
  assert(fs.readFileSync(second, 'utf8') === 'second-original', 'partial commit should preserve second file');
  assert(!fs.readdirSync(temp).some((name) => name.endsWith('.tmp')), 'transaction should remove temporary files');

  const lockPath = path.join(temp, 'patch.lock');
  let reentrant = false;
  withFileLockSync(lockPath, () => {
    withFileLockSync(lockPath, () => { reentrant = true; });
    const contention = childProcess.spawnSync(process.execPath, ['-e', `
      const { withFileLockSync } = require(${JSON.stringify(path.join(projectRoot, 'lib', 'file-transaction.js'))});
      try {
        withFileLockSync(${JSON.stringify(lockPath)}, () => {}, { timeoutMs: 50 });
        process.exit(0);
      } catch (error) {
        process.exit(error.code === 'CLAUDE_ENHANCE_LOCK_TIMEOUT' ? 23 : 24);
      }
    `]);
    assert(contention.status === 23, 'a second process should not enter a live patch lock');
  });
  assert(reentrant && !fs.existsSync(lockPath), 'same-process patch locks should be reentrant and cleanly released');

  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 99999999,
    hostname: os.hostname(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  }));
  const releaseRecovered = acquireFileLockSync(lockPath, { timeoutMs: 100, staleMs: 1000 });
  releaseRecovered();
  assert(!fs.existsSync(lockPath), 'stale patch locks should be recovered atomically');

  for (const legacy of [false, true]) {
    const racingPath = path.join(temp, `racing-${legacy}.lock`);
    const deadOwner = { pid: 99999999, hostname: os.hostname(), createdAt: new Date(0).toISOString() };
    const deadPath = legacy ? racingPath : path.join(racingPath, 'owner-dead.json');
    if (!legacy) fs.mkdirSync(racingPath);
    fs.writeFileSync(deadPath, JSON.stringify(deadOwner));
    let releaseWinner;
    const racingFs = Object.create(fs);
    racingFs.unlinkSync = (filename) => {
      if (filename === deadPath && !releaseWinner) {
        fs.unlinkSync(deadPath);
        if (!legacy) fs.rmdirSync(racingPath);
        releaseWinner = acquireFileLockSync(racingPath);
      }
      return fs.unlinkSync(filename);
    };
    const isolated = { module: { exports: {} }, process, Buffer, SharedArrayBuffer, Atomics, Int32Array,
      require: (name) => name === 'fs' ? racingFs : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'lib/file-transaction.js'), 'utf8'), isolated);
    try {
      isolated.module.exports.acquireFileLockSync(racingPath, { timeoutMs: 0 });
      throw new Error('stale recovery replaced a live owner');
    } catch (error) {
      assert(error.code === 'CLAUDE_ENHANCE_LOCK_TIMEOUT',
        'a stale recovery snapshot must never remove a newly acquired owner');
      assert(fs.readdirSync(racingPath).length === 1, 'the winning lock must keep its ownership record');
    } finally {
      releaseWinner?.();
    }
  }

  const failedLockPath = path.join(temp, 'failed.lock');
  const originalFsync = fs.fsyncSync;
  let failLockSync = true;
  fs.fsyncSync = function failInitialLockSync(descriptor) {
    if (failLockSync) {
      failLockSync = false;
      throw new Error('injected lock initialization failure');
    }
    return originalFsync.call(fs, descriptor);
  };
  try {
    acquireFileLockSync(failedLockPath);
    throw new Error('lock initialization failure did not propagate');
  } catch (error) {
    assert(error.message.includes('injected lock initialization failure'),
      'expected injected lock initialization failure');
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert(!fs.existsSync(failedLockPath), 'failed lock initialization should remove the orphan lock file');
}

function createClaudeFixture(version = '9.9.9') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-enhance-architecture-'));
  const webview = path.join(root, 'webview');
  fs.mkdirSync(webview);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(
    path.join(webview, 'index.js'),
    `${retentionDeclaration}\n${markdownCall}\n${virtualTurnMarkup}`
  );
  fs.writeFileSync(path.join(webview, 'index.css'), '/* pristine */');
  return root;
}

function testConfigurationAndBackups() {
  const fixture = createClaudeFixture();
  const nativeFonts = path.join(fixture, 'webview', 'fonts');
  fs.mkdirSync(nativeFonts);
  fs.writeFileSync(path.join(nativeFonts, 'native.woff2'), 'native-font');
  const firstOptions = { runtimeConfig: { fullTranscript: false, contentScale: 1 } };
  assert(extension.applyPatch(fixture, path.join(projectRoot, 'vendor'), firstOptions), 'fixture should patch');
  assert(fs.existsSync(path.join(fixture, 'webview', 'claude-enhance-fonts', 'KaTeX_Main-Regular.woff2')),
    'patch fonts should be copied into the extension-owned directory');
  assert(fs.existsSync(path.join(fixture, 'webview', 'claude-enhance-worker.js')),
    'the self-contained rendering worker should be installed with the patch');
  const patchedCss = fs.readFileSync(path.join(fixture, 'webview', 'index.css'), 'utf8');
  assert(patchedCss.includes('claude-enhance-fonts/KaTeX_Main-Regular.woff2'),
    'patched CSS should reference the extension-owned WOFF2 font directory');
  assert(!patchedCss.includes('format("woff")') && !patchedCss.includes('format("truetype")'),
    'patched CSS should not reference legacy font formats');
  assert(fs.readFileSync(path.join(nativeFonts, 'native.woff2'), 'utf8') === 'native-font',
    'patching should leave Claude Code native fonts untouched');
  let patched = fs.readFileSync(path.join(fixture, 'webview', 'index.js'), 'utf8');
  assert(!patched.includes(extension.FULL_TRANSCRIPT_MARKER), 'fullTranscript=false should preserve retention in patched fixture');
  assert(patched.includes(extension.VIRTUAL_TURNS_RUNTIME_MARKER),
    'default patch should include the virtual-turn runtime');
  const firstHash = extension.getPatchedConfigHash(fixture);

  assert(extension.normalizePatchOptions({ virtualTurns: false }).runtimeConfig.virtualTurns === false,
    'top-level virtualTurns should be normalized consistently with fullTranscript');
  assert(extension.normalizePatchOptions().fullTranscript === false,
    'the extension should default to Claude Code native history retention');
  assert(extension.normalizePatchOptions({ fullTranscript: true }).fullTranscript === true,
    'users should still be able to explicitly request full main-chat history');

  const noTurnFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-enhance-no-turn-'));
  const noTurnWebview = path.join(noTurnFixture, 'webview');
  fs.mkdirSync(noTurnWebview);
  fs.writeFileSync(path.join(noTurnFixture, 'package.json'), JSON.stringify({ version: '8.8.6' }));
  fs.writeFileSync(path.join(noTurnWebview, 'index.js'), `${retentionDeclaration}\n${markdownCall}`);
  fs.writeFileSync(path.join(noTurnWebview, 'index.css'), '/* pristine */');
  assert(extension.applyPatch(
    noTurnFixture,
    path.join(projectRoot, 'vendor'),
    { runtimeConfig: { fullTranscript: false, virtualTurns: true } }
  ), 'Markdown-only patching should remain available without a virtual-turn target');
  const noTurnPatched = fs.readFileSync(path.join(noTurnWebview, 'index.js'), 'utf8');
  assert(!noTurnPatched.includes(extension.VIRTUAL_TURNS_RUNTIME_MARKER),
    'unused virtual-turn runtime should not be injected when its AST transform was not applied');

  const fallbackFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-enhance-fallback-'));
  const fallbackWebview = path.join(fallbackFixture, 'webview');
  fs.mkdirSync(fallbackWebview);
  fs.writeFileSync(path.join(fallbackFixture, 'package.json'), JSON.stringify({ version: '8.8.5' }));
  fs.writeFileSync(path.join(fallbackWebview, 'index.js'), `${retentionDeclaration}\n${markdownCall}`);
  fs.writeFileSync(path.join(fallbackWebview, 'index.css'), '/* pristine */');
  assert(extension.applyPatch(
    fallbackFixture,
    path.join(projectRoot, 'vendor'),
    { runtimeConfig: { fullTranscript: true, virtualTurns: true } }
  ), 'full-transcript safety fallback should still apply independent enhancements');
  const fallbackPatched = fs.readFileSync(path.join(fallbackWebview, 'index.js'), 'utf8');
  const fallbackState = extension.getPatchedRuntimeState(fallbackFixture);
  assert(fallbackState?.fullTranscriptRequested && !fallbackState.fullTranscript,
    'patched runtime state should distinguish requested and effective full history');
  assert(fallbackState.fullTranscriptFallbackReason === 'no-compatible-target',
    'patched runtime state should persist the full-history fallback reason');
  assert(fallbackPatched.includes('"fullTranscript":false'),
    'the injected runtime config should expose effective full-history state');
  assert(fallbackPatched.includes('"fullTranscriptRequested":true'),
    'the injected runtime config should retain the user request for diagnostics');
  assert(!fallbackPatched.includes(extension.FULL_TRANSCRIPT_MARKER),
    'safe fallback should leave Claude Code native retention active');
  assert(extension.historyStatusLabel(fallbackState).startsWith('History Native'),
    'status text should report native history after a safety fallback');

  const secondOptions = { runtimeConfig: { fullTranscript: true, contentScale: 1.25 } };
  assert(extension.ensurePatched(fixture, path.join(projectRoot, 'vendor'), secondOptions) === 'refreshed', 'config change should refresh patch');
  const secondHash = extension.getPatchedConfigHash(fixture);
  assert(firstHash !== secondHash, 'config refresh should change config hash');
  assert(extension.ensurePatched(fixture, path.join(projectRoot, 'vendor'), secondOptions) === 'current', 'same config should be current');
  patched = fs.readFileSync(path.join(fixture, 'webview', 'index.js'), 'utf8');
  assert(patched.includes(extension.FULL_TRANSCRIPT_MARKER), 'fullTranscript=true should transform retention after refresh');
  const fullState = extension.getPatchedRuntimeState(fixture);
  assert(fullState?.fullTranscript && fullState.virtualTurns,
    'verified full history should persist both effective capabilities');
  assert(extension.historyStatusLabel(fullState).startsWith('History Full'),
    'status text should report verified full history and its long-session cost');

  const disabledVirtualOptions = {
    runtimeConfig: { fullTranscript: false, contentScale: 1.25, virtualTurns: false },
  };
  assert(
    extension.ensurePatched(fixture, path.join(projectRoot, 'vendor'), disabledVirtualOptions) === 'refreshed',
    'disabling virtual turns should refresh the patch'
  );
  patched = fs.readFileSync(path.join(fixture, 'webview', 'index.js'), 'utf8');
  assert(!patched.includes(extension.VIRTUAL_TURNS_RUNTIME_MARKER),
    'disabling virtual turns should remove the runtime after refresh');

  const unsafeFullTranscript = extension.transformClaudeBundle(
    `${retentionDeclaration}\n${markdownCall}\n${virtualTurnMarkup}`,
    {
      fullTranscript: true,
      virtualTurns: false,
      requireVirtualTurnsForFullTranscript: true,
    }
  );
  assert(unsafeFullTranscript.ok && !unsafeFullTranscript.diagnostics.retentionApplied,
    'full transcript should preserve native retention when turn virtualization is disabled');
  assert(unsafeFullTranscript.diagnostics.fullTranscriptFallbackReason === 'virtual-turns-disabled',
    'full transcript should diagnose explicitly disabled turn virtualization');

  const noVirtualFixture = createClaudeFixture('8.8.7');
  assert(extension.applyPatch(
    noVirtualFixture,
    path.join(projectRoot, 'vendor'),
    { runtimeConfig: { fullTranscript: false, virtualTurns: false, contentScale: 1 } }
  ), 'virtualTurns=false fixture should patch');
  const noVirtualPatched = fs.readFileSync(path.join(noVirtualFixture, 'webview', 'index.js'), 'utf8');
  assert(!noVirtualPatched.includes(extension.VIRTUAL_TURNS_RUNTIME_MARKER),
    'virtualTurns=false should omit the virtual-turn runtime');

  const mismatchFixture = createClaudeFixture('8.8.8');
  assert(extension.applyPatch(mismatchFixture, path.join(projectRoot, 'vendor')), 'mismatch fixture should patch');
  fs.appendFileSync(path.join(mismatchFixture, 'webview', 'index.js.katex-bak'), '\n/* changed */');
  assert(!extension.canRestoreOriginals(mismatchFixture), 'backup hash mismatch should block restore');
  assert(extension.removePatch(mismatchFixture) === false, 'invalid backup should not be restored');

  const legacyFixture = createClaudeFixture('8.8.9');
  const legacyPaths = extension.patchPaths(legacyFixture);
  fs.copyFileSync(legacyPaths.jsPath, legacyPaths.jsBackup);
  fs.copyFileSync(legacyPaths.cssPath, legacyPaths.cssBackup);
  assert(!extension.canRestoreOriginals(legacyFixture), 'legacy backups without metadata should fail closed');
  extension.ensureBackupFiles(
    legacyFixture,
    fs.readFileSync(legacyPaths.jsPath),
    fs.readFileSync(legacyPaths.cssPath)
  );
  assert(extension.canRestoreOriginals(legacyFixture),
    'matching legacy backups should be migrated only from a verified pristine webview');

  const partialFixture = createClaudeFixture('7.7.7');
  assert(extension.applyPatch(partialFixture, path.join(projectRoot, 'vendor')), 'partial fixture should patch');
  fs.copyFileSync(
    path.join(partialFixture, 'webview', 'index.css.katex-bak'),
    path.join(partialFixture, 'webview', 'index.css')
  );
  assert(extension.getPatchState(partialFixture) === 'partial', 'one-sided patch should be detected');
  assert(extension.ensurePatched(partialFixture, path.join(projectRoot, 'vendor')) === 'refreshed', 'verified partial patch should recover');
  assert(extension.getPatchState(partialFixture) === 'patched', 'partial recovery should restore both patch files');

  const partialUpdateFixture = createClaudeFixture('7.7.8');
  assert(extension.applyPatch(partialUpdateFixture, path.join(projectRoot, 'vendor')),
    'partial update fixture should patch');
  fs.writeFileSync(
    path.join(partialUpdateFixture, 'webview', 'index.css'),
    '/* same-version replacement css */'
  );
  assert(extension.getPatchState(partialUpdateFixture) === 'partial',
    'one-sided Claude replacement should appear as a partial patch');
  assert(!extension.partialPatchMatchesBackups(partialUpdateFixture),
    'partial recovery should reject an unpatched side that no longer matches the verified backup');
  assert(extension.ensurePatched(partialUpdateFixture, path.join(projectRoot, 'vendor')) === 'skipped',
    'one-sided Claude updates should fail closed instead of restoring an older bundle');
  assert(extension.removePatch(partialUpdateFixture) === false,
    'direct disable should also reject a one-sided Claude update');
  assert(
    fs.readFileSync(path.join(partialUpdateFixture, 'webview', 'index.css'), 'utf8') ===
      '/* same-version replacement css */',
    'failed partial recovery should preserve the newly installed file'
  );

  const updateFixture = createClaudeFixture('6.6.6');
  assert(extension.applyPatch(updateFixture, path.join(projectRoot, 'vendor')), 'update fixture should patch');
  assert(extension.removePatch(updateFixture), 'update fixture should restore before simulated update');
  fs.writeFileSync(path.join(updateFixture, 'package.json'), JSON.stringify({ version: '6.6.7' }));
  fs.appendFileSync(path.join(updateFixture, 'webview', 'index.js'), '\n/* updated Claude bundle */');
  fs.writeFileSync(path.join(updateFixture, 'webview', 'index.css'), '/* updated pristine css */');
  assert(extension.applyPatch(updateFixture, path.join(projectRoot, 'vendor')), 'in-place Claude update should rotate backups');
  const updatedMetadata = extension.backupMetadata(updateFixture);
  assert(updatedMetadata.claudeVersion === '6.6.7', 'rotated backup should record new Claude version');
  assert(
    fs.readFileSync(path.join(updateFixture, 'webview', 'index.js.katex-bak'), 'utf8').includes('updated Claude bundle'),
    'rotated JavaScript backup should match updated Claude bundle'
  );

  const sameVersionFixture = createClaudeFixture('6.6.8');
  assert(extension.applyPatch(sameVersionFixture, path.join(projectRoot, 'vendor')),
    'same-version update fixture should patch');
  assert(extension.removePatch(sameVersionFixture), 'same-version update fixture should restore');
  fs.appendFileSync(path.join(sameVersionFixture, 'webview', 'index.js'), '\n/* same-version repack */');
  fs.writeFileSync(path.join(sameVersionFixture, 'webview', 'index.css'), '/* same-version pristine css */');
  assert(extension.applyPatch(sameVersionFixture, path.join(projectRoot, 'vendor')),
    'same Claude version with changed bundle content should patch');
  assert(
    fs.readFileSync(path.join(sameVersionFixture, 'webview', 'index.js.katex-bak'), 'utf8').includes('same-version repack'),
    'same-version bundle changes should rotate the pristine backup by content hash'
  );

  assert(extension.removePatch(fixture), 'fixture should restore after configuration checks');
  assert(fs.existsSync(path.join(nativeFonts, 'native.woff2')),
    'removing the patch should preserve Claude Code native fonts');
  assert(!fs.existsSync(path.join(fixture, 'webview', 'claude-enhance-fonts')),
    'removing the patch should delete only extension-owned fonts');
  assert(!fs.existsSync(path.join(fixture, 'webview', 'claude-enhance-worker.js')),
    'removing the patch should delete the rendering worker');
  const disabledUninstall = uninstall.restoreClaudeCode(fixture);
  assert(disabledUninstall.restored,
    'uninstall should consume verified backups after the patch was already disabled');
  assert(!fs.existsSync(path.join(fixture, 'webview', 'index.js.katex-bak')),
    'disabled uninstall should remove the verified backup after confirming current files');

  const fontFailureFixture = createClaudeFixture('6.6.9');
  const originalCopyFile = fs.copyFileSync;
  let injectedFontFailure = false;
  fs.copyFileSync = function failFontCopy(source, target) {
    if (!injectedFontFailure && String(target).includes('claude-enhance-fonts')) {
      injectedFontFailure = true;
      throw new Error('injected font copy failure');
    }
    return originalCopyFile.call(fs, source, target);
  };
  try {
    extension.applyPatch(fontFailureFixture, path.join(projectRoot, 'vendor'));
    throw new Error('font copy failure did not propagate');
  } catch (error) {
    assert(error.message.includes('injected font copy failure'), 'expected injected font copy failure');
  } finally {
    fs.copyFileSync = originalCopyFile;
  }
  assert(extension.getPatchState(fontFailureFixture) === 'unpatched',
    'font copy failure should leave Claude Code webview files pristine');
  assert(!fs.existsSync(path.join(fontFailureFixture, 'webview', 'claude-enhance-fonts')),
    'font copy failure should remove partial extension-owned assets');
  assert(!fs.existsSync(path.join(fontFailureFixture, 'webview', 'claude-enhance-worker.js')),
    'a failed patch should not leave its worker behind');
}

function testUninstallRestore() {
  const fixture = createClaudeFixture('5.5.5');
  const pristineJs = fs.readFileSync(path.join(fixture, 'webview', 'index.js'), 'utf8');
  const pristineCss = fs.readFileSync(path.join(fixture, 'webview', 'index.css'), 'utf8');
  assert(extension.applyPatch(fixture, path.join(projectRoot, 'vendor')), 'uninstall fixture should patch');
  const restored = uninstall.restoreClaudeCode(fixture);
  assert(restored.restored, 'uninstall should restore verified backups');
  assert(fs.readFileSync(path.join(fixture, 'webview', 'index.js'), 'utf8') === pristineJs, 'uninstall should restore JavaScript');
  assert(fs.readFileSync(path.join(fixture, 'webview', 'index.css'), 'utf8') === pristineCss, 'uninstall should restore CSS');
  assert(!fs.existsSync(path.join(fixture, 'webview', 'index.js.katex-bak')), 'uninstall should remove consumed backups');
  assert(!fs.existsSync(path.join(fixture, 'webview', 'claude-enhance-worker.js')), 'uninstall should remove its worker');

  const legacy = createClaudeFixture('5.5.7');
  const legacyWebview = path.join(legacy, 'webview');
  fs.copyFileSync(path.join(legacyWebview, 'index.js'), path.join(legacyWebview, 'index.js.katex-bak'));
  fs.copyFileSync(path.join(legacyWebview, 'index.css'), path.join(legacyWebview, 'index.css.katex-bak'));
  const legacySkipped = uninstall.restoreClaudeCode(legacy);
  assert(!legacySkipped.restored && legacySkipped.reason === 'backup-verification-failed',
    'uninstall should fail closed for legacy backups without metadata');

  const tampered = createClaudeFixture('5.5.6');
  assert(extension.applyPatch(tampered, path.join(projectRoot, 'vendor')), 'tampered uninstall fixture should patch');
  fs.appendFileSync(path.join(tampered, 'webview', 'index.css.katex-bak'), '\n/* tampered */');
  const skipped = uninstall.restoreClaudeCode(tampered);
  assert(!skipped.restored && skipped.reason === 'backup-verification-failed', 'uninstall should reject tampered backups');
  assert(extension.getPatchState(tampered) === 'patched', 'rejected uninstall should leave the working patch intact');

  const partialUpdate = createClaudeFixture('5.5.9');
  assert(extension.applyPatch(partialUpdate, path.join(projectRoot, 'vendor')),
    'uninstall partial-update fixture should patch');
  fs.writeFileSync(path.join(partialUpdate, 'webview', 'index.css'), '/* newer Claude CSS */');
  const partialSkipped = uninstall.restoreClaudeCode(partialUpdate);
  assert(!partialSkipped.restored && partialSkipped.reason === 'current-files-changed',
    'uninstall should reject a partial state whose unpatched side changed');
  assert(fs.readFileSync(path.join(partialUpdate, 'webview', 'index.css'), 'utf8') ===
      '/* newer Claude CSS */',
    'rejected uninstall should preserve the newer Claude file');

  const unpatched = createClaudeFixture('5.5.8');
  fs.mkdirSync(path.join(unpatched, 'webview', 'claude-enhance-fonts'));
  fs.writeFileSync(path.join(unpatched, 'webview', 'claude-enhance-fonts', 'stale.woff2'), 'stale');
  const allResults = uninstall.restoreAllClaudeCode([
    path.join(unpatched, 'missing-install'),
    unpatched,
  ]);
  assert(allResults.length === 2 && allResults[0].reason === 'backup-verification-failed' &&
      allResults[1].reason === 'not-patched',
    'multi-install uninstall should isolate failures and continue through unpatched installations');
  assert(!fs.existsSync(path.join(unpatched, 'webview', 'claude-enhance-fonts')),
    'uninstall should clean stale extension-owned fonts from an unpatched installation');

  const versions = [
    { parts: uninstall.versionParts('2.1.99'), mtimeMs: 3 },
    { parts: uninstall.versionParts('2.1.234'), mtimeMs: 1 },
    { parts: uninstall.versionParts('2.1.153'), mtimeMs: 2 },
  ].sort(uninstall.compareVersionDescending);
  assert(versions[0].parts[2] === 234, 'uninstall discovery should compare Claude versions numerically');
}

function installedClaudeBundles() {
  const roots = [
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
  ];
  const bundles = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('anthropic.claude-code-')) continue;
      const webview = path.join(root, name, 'webview');
      const backup = path.join(webview, 'index.js.katex-bak');
      const source = fs.existsSync(backup) ? backup : path.join(webview, 'index.js');
      if (fs.existsSync(source)) bundles.push({ name, source });
    }
  }
  return bundles;
}

function testInstalledCompatibility() {
  for (const bundle of installedClaudeBundles()) {
    const transformed = transformClaudeBundle(fs.readFileSync(bundle.source, 'utf8'));
    assert(transformed.ok, `installed Claude bundle should be compatible: ${bundle.name} (${transformed.reason})`);
    assert(transformed.diagnostics.markdownTargets === 1, `installed Claude bundle should have one Markdown target: ${bundle.name}`);
    assert(transformed.diagnostics.retentionTargets >= 1,
      `installed Claude bundle should expose a message-retention target: ${bundle.name}`);
    assert(transformed.diagnostics.retentionApplied,
      `installed Claude bundle should apply full-transcript retention: ${bundle.name}`);
    assert(transformed.diagnostics.virtualTurnsApplied,
      `installed Claude bundle should apply turn virtualization: ${bundle.name}`);
    const source = fs.readFileSync(bundle.source, 'utf8');
    const targets = findVirtualTurnTargets(source, parseBundle(source));
    assert(targets.length === 1 && targets[0].focusIdentifier,
      `installed Claude bundle should expose the turn highlight index: ${bundle.name}`);
    assert(targets[0].createElement !== targets[0].turnCreateElement,
      `installed Claude bundle should preserve distinct Fragment and turn JSX factories: ${bundle.name}`);
    assert(transformed.body.includes(`focusIndex:${targets[0].focusIdentifier}`),
      `installed Claude bundle should pass the turn highlight index to virtualization: ${bundle.name}`);
    assert(transformed.body.includes(`useState:${targets[0].hook.alias}`),
      `installed Claude bundle should pass the verified hook to the virtual child: ${bundle.name}`);
    assert(!transformed.body.includes('__claudeEnhanceVirtualTick') &&
        !transformed.body.includes('__claudeEnhanceVirtualForce'),
      `installed Claude bundle should not inject virtual state into the chat parent: ${bundle.name}`);
    assert(transformed.body.includes(`turnCreateElement:${targets[0].turnCreateElement}`),
      `installed Claude bundle should pass the turn JSX factory to virtualization: ${bundle.name}`);
  }
}

function testWorkerPolicyTransactions() {
  const { transformWorkerPolicy, MARKER, policyPaths } = require('../lib/worker-policy');
  const original = 'function policy(webview){return `worker-src ${webview.cspSource}`;}';
  const patched = transformWorkerPolicy(original);
  assert(patched.includes(MARKER) && patched.includes(' blob:'), 'worker policy should only add local blob workers');
  assert(!transformWorkerPolicy(original + original.replace('policy', 'other')), 'ambiguous worker policies must fail closed');
  const fixture = createClaudeFixture();
  try {
    const host = path.join(fixture, 'extension.js');
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '9.9.9', main: './extension.js' }));
    fs.writeFileSync(host, original);
    assert(extension.applyPatch(fixture, path.join(projectRoot, 'vendor')));
    assert(fs.readFileSync(host, 'utf8') === patched, 'host worker policy must be committed with the webview patch');
    assert(extension.removePatch(fixture));
    assert(fs.readFileSync(host, 'utf8') === original, 'disable must restore the exact host policy entry');
    assert(!fs.existsSync(policyPaths(fixture).metadata));
    assert(extension.applyPatch(fixture, path.join(projectRoot, 'vendor')));
    assert(uninstall.restoreClaudeCode(fixture).restored);
    assert(fs.readFileSync(host, 'utf8') === original, 'uninstall must restore the exact host policy entry');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  const installed = uninstall.findClaudeCodeDir();
  if (installed) {
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    const source = fs.readFileSync(path.join(installed, manifest.main), 'utf8');
    assert(transformWorkerPolicy(source), 'installed Claude host should expose one worker CSP template');
  }
}

testStructuralTransforms();
testVirtualTurnTransform();
testVirtualTurnRuntime();
testVirtualTurnExecution();
testScheduler();
testTransactions();
testConfigurationAndBackups();
testUninstallRestore();
testWorkerPolicyTransactions();
testInstalledCompatibility();
console.log(`architecture regression passed (${installedClaudeBundles().length} installed Claude versions)`);
