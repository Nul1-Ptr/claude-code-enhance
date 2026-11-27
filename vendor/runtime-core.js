(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__CLAUDE_ENHANCE_RUNTIME_CORE__ = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  const ALL_FEATURES = Object.freeze(['apiErrors', 'code', 'math', 'copy', 'zoom']);
  const CONTENT_LIMITS = Object.freeze({
    sourceCharacters: 64 * 1024,
    sourceLines: 1500,
    mathMarkers: 128,
    codeFences: 48,
    formulaCharacters: 4096,
    codeCharacters: 50 * 1024,
  });

  function foldSearch(value) {
    return String(value).toLowerCase().replace(/ς/g, 'σ');
  }

  function findLiteral(source, query, from = 0) {
    const text = String(source);
    const needle = foldSearch(query);
    if (!needle) return null;
    const suffix = text.slice(from);
    const folded = foldSearch(suffix);
    const index = folded.indexOf(needle);
    if (index < 0) return null;
    if (folded.length === suffix.length) return { start: from + index, end: from + index + needle.length };
    let originalOffset = from;
    let foldedOffset = 0;
    let start = from;
    for (const character of suffix) {
      const next = foldedOffset + foldSearch(character).length;
      if (foldedOffset <= index && index < next) start = originalOffset;
      originalOffset += character.length;
      if (next >= index + needle.length) return { start, end: originalOffset };
      foldedOffset = next;
    }
    return null;
  }

  function richSourceReason(source) {
    if (source.length > CONTENT_LIMITS.sourceCharacters) return 'length';
    if (source.length > CONTENT_LIMITS.formulaCharacters && /\$|\\[([]/.test(source)) return 'math-complexity';
    let lines = 1;
    let mathMarkers = 0;
    let codeFences = 0;
    const markers = /\$|\\[()[\]]|`{3,}|~{3,}|\n/g;
    let match;
    while ((match = markers.exec(source))) {
      if (match[0] === '\n') {
        if (++lines > CONTENT_LIMITS.sourceLines) return 'lines';
      } else if (match[0][0] === '`' || match[0][0] === '~') {
        if (++codeFences > CONTENT_LIMITS.codeFences) return 'code-blocks';
      } else if (++mathMarkers > CONTENT_LIMITS.mathMarkers) {
        return 'math-density';
      }
    }
    return null;
  }

  function createRenderQueue(options) {
    const tasks = new Map();
    let scheduled = false;
    const schedule = () => {
      if (scheduled || !tasks.size) return;
      scheduled = true;
      options.schedule(flush);
    };
    const flush = () => {
      scheduled = false;
      const startedAt = options.now();
      let processed = 0;
      for (const [element, callback] of tasks) {
        if (processed >= 4 || (processed > 0 && options.now() - startedAt >= 6)) break;
        tasks.delete(element);
        processed++;
        if (element.isConnected === false || (options.isUsable && !options.isUsable(element))) continue;
        try { callback(); } catch (error) { options.onError?.(error); }
      }
      schedule();
    };
    return Object.freeze({
      enqueue(element, callback) { tasks.set(element, callback); schedule(); },
      clear() { tasks.clear(); },
    });
  }

  function normalizeFeatures(features, fallback = ALL_FEATURES) {
    const requested = features == null
      ? fallback
      : (typeof features === 'string' ? [features] : Array.from(features));
    return requested.filter((feature, index) => (
      ALL_FEATURES.includes(feature) && requested.indexOf(feature) === index
    ));
  }

  function createIncrementalScheduler(options) {
    if (!options || typeof options.schedule !== 'function' || typeof options.flush !== 'function') {
      throw new TypeError('createIncrementalScheduler requires schedule and flush functions');
    }

    const dirtyRoots = new Set();
    const featureFlags = new Set();
    const reasons = new Set();
    let fullPass = false;
    let scheduled = false;
    let scheduleHandle = null;

    function state() {
      return {
        scheduled,
        fullPass,
        dirtyRootCount: dirtyRoots.size,
        features: Array.from(featureFlags),
        reasons: Array.from(reasons),
      };
    }

    function drain() {
      scheduled = false;
      scheduleHandle = null;
      if (!fullPass && dirtyRoots.size === 0) return null;

      const batch = {
        fullPass,
        roots: fullPass ? [] : Array.from(dirtyRoots),
        features: normalizeFeatures(featureFlags),
        reasons: Array.from(reasons),
      };
      fullPass = false;
      dirtyRoots.clear();
      featureFlags.clear();
      reasons.clear();
      options.flush(batch);
      return batch;
    }

    function requestFlush() {
      if (scheduled) return;
      scheduled = true;
      scheduleHandle = options.schedule(drain);
    }

    function enqueue(root, features, metadata = {}) {
      const requested = normalizeFeatures(features);
      requested.forEach((feature) => featureFlags.add(feature));
      if (metadata.reason) reasons.add(String(metadata.reason));

      if (metadata.fullPass) {
        fullPass = true;
        dirtyRoots.clear();
      } else if (!fullPass && root && (!options.isUsableRoot || options.isUsableRoot(root))) {
        dirtyRoots.add(root);
      }

      if (fullPass || dirtyRoots.size) requestFlush();
      return state();
    }

    function cancel() {
      if (scheduled && typeof options.cancel === 'function') options.cancel(scheduleHandle);
      scheduled = false;
      scheduleHandle = null;
      fullPass = false;
      dirtyRoots.clear();
      featureFlags.clear();
      reasons.clear();
    }

    return Object.freeze({ enqueue, flushNow: drain, cancel, getState: state });
  }

  return Object.freeze({ ALL_FEATURES, CONTENT_LIMITS, foldSearch, findLiteral, richSourceReason, createRenderQueue, normalizeFeatures, createIncrementalScheduler });
});
