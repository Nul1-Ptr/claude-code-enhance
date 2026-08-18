(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__CLAUDE_ENHANCE_RUNTIME_CORE__ = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  const ALL_FEATURES = Object.freeze(['apiErrors', 'code', 'math', 'copy', 'zoom']);

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

  return Object.freeze({ ALL_FEATURES, normalizeFeatures, createIncrementalScheduler });
});
