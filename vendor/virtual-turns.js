(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__CLAUDE_ENHANCE_VIRTUAL_TURNS__ = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  const DEFAULTS = Object.freeze({
    initialTurns: 24,
    pageTurns: 12,
    tailTurns: 1,
    estimateHeight: 600,
    edgeThreshold: 240,
    maxStores: 4,
  });
  const MESSAGE_CONTAINER_SELECTOR = '[class*="messagesContainer_"]';
  const VIRTUAL_SPACER_ATTRIBUTE = 'data-ce-virtual-spacer';
  const TURN_KEY_ATTRIBUTE = 'data-ce-turn-key';
  const TURN_START_ATTRIBUTE = 'data-ce-turn-start';
  const TURN_KEY_SELECTOR = `[${TURN_KEY_ATTRIBUTE}]`;
  const stores = new Map();
  const sessionTokens = new WeakMap();
  let nextSessionToken = 1;
  let viewportResizeScheduled = false;

  function nextFrame(callback) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 16);
  }

  function afterCommit(callback) {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(() => nextFrame(callback));
    } else {
      setTimeout(() => nextFrame(callback), 0);
    }
  }

  function scheduleIdle(callback) {
    if (typeof requestIdleCallback === 'function') {
      return { kind: 'idle', handle: requestIdleCallback(callback, { timeout: 250 }) };
    }
    return { kind: 'timeout', handle: setTimeout(callback, 250) };
  }

  function cancelIdle(scheduled) {
    if (!scheduled) return;
    if (scheduled.kind === 'idle' && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(scheduled.handle);
    } else {
      clearTimeout(scheduled.handle);
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function turnKey(turn, index) {
    const value = turn?.key ?? turn?.uuid ?? turn?.id;
    return value === undefined || value === null || value === ''
      ? `ce-turn-${index}`
      : String(value);
  }

  function sessionKey(session) {
    const value = session?.sessionId?.value
      ?? session?.sessionId
      ?? session?.channelId?.value
      ?? session?.channelId
      ?? session?.id;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (session && typeof session === 'object') {
      let token = sessionTokens.get(session);
      if (!token) {
        token = `object-${nextSessionToken++}`;
        sessionTokens.set(session, token);
      }
      return token;
    }
    return 'main';
  }

  function createStore(key) {
    return {
      key,
      containerRef: null,
      container: null,
      scrollHandler: null,
      resizeObserver: null,
      originalOverflowAnchor: '',
      controlsOverflowAnchor: false,
      force: null,
      focusIndex: undefined,
      branch: null,
      total: 0,
      start: 0,
      end: 0,
      tailStart: 0,
      windowSize: DEFAULTS.initialTurns,
      initialized: false,
      atBottom: true,
      heights: new Map(),
      heightIndex: new Map(),
      heightKeys: [],
      heightValues: [],
      heightPrefix: [0],
      heightDirtyFrom: 0,
      heightSourceFirstKey: null,
      heightSourceLastKey: null,
      heightAudit: null,
      heightAuditGeneration: 0,
      topHeight: 0,
      bottomHeight: 0,
      heightWindow: {
        start: -1,
        end: -1,
        tailStart: -1,
        total: -1,
      },
      pendingScroll: null,
      afterScheduled: false,
      scrollScheduled: false,
      containerRetries: 0,
      renderedTurns: 0,
      measurementScheduled: false,
      failedBranch: null,
      disposed: false,
    };
  }

  function disposeStore(store) {
    if (store?.container && store.scrollHandler) {
      store.container.removeEventListener?.('scroll', store.scrollHandler);
    }
    store?.resizeObserver?.disconnect?.();
    if (store?.controlsOverflowAnchor && store.container?.style) {
      store.container.style.overflowAnchor = store.originalOverflowAnchor;
    }
    if (store) {
      store.disposed = true;
      store.controlsOverflowAnchor = false;
      store.containerRef = null;
      store.container = null;
      store.scrollHandler = null;
      store.resizeObserver = null;
      store.force = null;
      store.pendingScroll = null;
      store.afterScheduled = false;
      store.scrollScheduled = false;
      store.measurementScheduled = false;
      cancelIdle(store.heightAudit);
      store.heightAudit = null;
      store.heightAuditGeneration++;
    }
  }

  function getStore(key) {
    let store = stores.get(key);
    if (store) {
      stores.delete(key);
      stores.set(key, store);
      return store;
    }

    if (stores.size >= DEFAULTS.maxStores) {
      const oldestKey = stores.keys().next().value;
      disposeStore(stores.get(oldestKey));
      stores.delete(oldestKey);
    }
    store = createStore(key);
    stores.set(key, store);
    return store;
  }

  function resetStore(store, total, branch) {
    clearMeasurements(store);
    store.branch = branch;
    store.focusIndex = undefined;
    store.total = total;
    store.windowSize = Math.min(total, DEFAULTS.initialTurns);
    store.start = Math.max(0, total - store.windowSize);
    store.end = total;
    store.tailStart = total;
    store.heightWindow = { start: -1, end: -1, tailStart: -1, total: -1 };
    store.initialized = true;
    store.atBottom = true;
    store.pendingScroll = total > 0 ? { mode: 'bottom' } : null;
  }

  function clearMeasurements(store) {
    store.heights.clear();
    store.heightIndex.clear();
    store.heightKeys = [];
    store.heightValues = [];
    store.heightPrefix = [0];
    store.heightDirtyFrom = 0;
    store.heightSourceFirstKey = null;
    store.heightSourceLastKey = null;
    cancelIdle(store.heightAudit);
    store.heightAudit = null;
    store.heightAuditGeneration++;
    store.topHeight = 0;
    store.bottomHeight = 0;
    store.heightWindow = { start: -1, end: -1, tailStart: -1, total: -1 };
  }

  function invalidateMeasurements() {
    for (const store of stores.values()) {
      if (store.atBottom) store.pendingScroll = { mode: 'bottom' };
      else if (store.container) setAnchorPending(store);
      clearMeasurements(store);
      requestForce(store);
    }
  }

  function expandToTail(store, total) {
    const size = Math.max(DEFAULTS.initialTurns, store.windowSize);
    store.end = total;
    store.start = Math.max(0, total - size);
    store.windowSize = store.end - store.start;
    store.pendingScroll = { mode: 'bottom' };
  }

  function reconcile(store, total, branch) {
    const branchChanged = store.branch !== branch;
    if (!store.initialized || branchChanged) {
      resetStore(store, total, branch);
      return;
    }

    const previousTotal = store.total;
    if (total > previousTotal && store.atBottom) {
      expandToTail(store, total);
    }
    store.total = total;
    store.end = clamp(store.end, 0, total);
    store.start = clamp(store.start, 0, Math.max(0, store.end));
    const desiredWindow = Math.min(total, Math.max(DEFAULTS.initialTurns, store.windowSize));
    if (store.end - store.start < desiredWindow) {
      store.start = Math.max(0, store.end - desiredWindow);
    }
    store.windowSize = Math.max(0, store.end - store.start);
    if (store.atBottom && store.end >= total) {
      store.pendingScroll = { mode: 'bottom' };
    }
  }

  function turnContainsFocus(turn, focusIndex) {
    if (!Number.isInteger(focusIndex) || !turn) return false;
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) {
      if (item?.idx === focusIndex) return true;
      if (item?.kind === 'fold' && item.fold?.messages?.some((message) => message?.idx === focusIndex)) {
        return true;
      }
      if (item?.messages?.some((message) => message?.idx === focusIndex)) return true;
    }
    return false;
  }

  function revealFocus(store, turns, focusIndex) {
    if (!Number.isInteger(focusIndex)) {
      store.focusIndex = focusIndex;
      return;
    }
    if (store.focusIndex === focusIndex) return;
    const index = turns.findIndex((turn) => turnContainsFocus(turn, focusIndex));
    if (index < 0) return;
    store.focusIndex = focusIndex;
    if ((index >= store.start && index < store.end) || index >= store.tailStart) return;

    const windowSize = Math.max(DEFAULTS.initialTurns, store.windowSize);
    const before = Math.floor(windowSize / 3);
    store.start = clamp(index - before, 0, Math.max(0, store.total - windowSize));
    store.end = Math.min(store.total, store.start + windowSize);
    store.windowSize = store.end - store.start;
    store.atBottom = false;
    store.pendingScroll = { mode: 'focus', key: turnKey(turns[index], index) };
  }

  function heightFor(store, key) {
    return store.heights.get(key) || DEFAULTS.estimateHeight;
  }

  function activeHeightKeysMatch(store, turns, firstKey, lastKey) {
    const length = turns.length;
    if (store.heightKeys.length !== length) return false;
    if (store.heightSourceFirstKey !== firstKey || store.heightSourceLastKey !== lastKey) return false;
    if (length === 0) return true;

    const indices = new Set([0, length - 1, store.start - 1, store.end, store.tailStart - 1]);
    for (let index = store.start; index < Math.min(store.end, length); index++) indices.add(index);
    for (let index = Math.max(0, store.tailStart); index < length; index++) indices.add(index);
    return heightKeysMatchAtIndices(store, turns, indices, length);
  }

  function heightKeysMatchAtIndices(store, turns, indices, limit = store.heightKeys.length) {
    for (const index of indices) {
      if (index < 0 || index >= limit || index >= turns.length) continue;
      if (store.heightKeys[index] !== turnKey(turns[index], index)) return false;
    }
    return true;
  }

  function allHeightKeysMatch(store, turns, limit = store.heightKeys.length) {
    if (turns.length < limit) return false;
    for (let index = 0; index < limit; index++) {
      if (store.heightKeys[index] !== turnKey(turns[index], index)) return false;
    }
    return true;
  }

  function canExtendHeightIndex(store, turns) {
    const previousLength = store.heightKeys.length;
    if (turns.length <= previousLength) return false;
    if (previousLength === 0) return true;

    const indices = new Set([
      0,
      previousLength - 1,
      store.start - 1,
      store.start,
      store.end - 1,
      store.tailStart - 1,
    ]);
    for (let index = store.start; index < Math.min(store.end, previousLength); index++) {
      indices.add(index);
    }
    for (let index = Math.max(0, store.tailStart); index < previousLength; index++) {
      indices.add(index);
    }
    return heightKeysMatchAtIndices(store, turns, indices, previousLength);
  }

  function auditHeightIndex(store, turns, beforeChange) {
    if (store.disposed || store.heightKeys.length !== turns.length) return false;
    if (allHeightKeysMatch(store, turns)) return false;
    return syncHeightIndex(store, turns, beforeChange, { forceFull: true, skipAudit: true });
  }

  function scheduleHeightAudit(store, turns) {
    if (store.disposed || !turns.length) return;
    cancelIdle(store.heightAudit);
    const generation = ++store.heightAuditGeneration;
    const weakTurns = typeof WeakRef === 'function' ? new WeakRef(turns) : null;
    store.heightAudit = scheduleIdle(() => {
      store.heightAudit = null;
      if (store.disposed || generation !== store.heightAuditGeneration) return;
      const currentTurns = weakTurns ? weakTurns.deref() : turns;
      if (!currentTurns) return;
      const changed = auditHeightIndex(store, currentTurns, () => {
        if (!store.atBottom && !store.pendingScroll && store.container) setAnchorPending(store);
      });
      if (changed) requestForce(store);
    });
  }

  function syncHeightIndex(store, turns, beforeChange, options = {}) {
    const length = turns.length;
    const previousKeys = store.heightKeys;
    const firstKey = length > 0 ? turnKey(turns[0], 0) : null;
    const lastKey = length > 0 ? turnKey(turns[length - 1], length - 1) : null;
    const activeKeysMatch = activeHeightKeysMatch(store, turns, firstKey, lastKey);
    const verifiedKeysMatch = activeKeysMatch &&
      (!options.forceFull || allHeightKeysMatch(store, turns));
    if (verifiedKeysMatch) {
      rebuildHeightPrefix(store);
      if (!options.skipAudit) scheduleHeightAudit(store, turns);
      return false;
    }

    if (canExtendHeightIndex(store, turns)) {
      if (typeof beforeChange === 'function') beforeChange();
      const previousLength = previousKeys.length;
      for (let index = previousLength; index < length; index++) {
        const key = turnKey(turns[index], index);
        store.heightKeys[index] = key;
        store.heightValues[index] = heightFor(store, key);
        store.heightIndex.set(key, index);
      }
      store.heightDirtyFrom = Math.min(store.heightDirtyFrom, previousLength);
      store.heightWindow = { start: -1, end: -1, tailStart: -1, total: -1 };
      rebuildHeightPrefix(store);
      store.heightSourceFirstKey = firstKey;
      store.heightSourceLastKey = lastKey;
      if (!options.skipAudit) scheduleHeightAudit(store, turns);
      return true;
    }

    let common = 0;
    const limit = Math.min(previousKeys.length, length);
    while (common < limit && previousKeys[common] === turnKey(turns[common], common)) common++;

    const keysChanged = common < previousKeys.length || previousKeys.length !== length;
    if (keysChanged) {
      if (typeof beforeChange === 'function') beforeChange();
      const appendedOnly = common === previousKeys.length && previousKeys.length < length;
      store.heightKeys.length = common;
      store.heightValues.length = common;
      store.heightPrefix.length = common + 1;
      if (common < previousKeys.length) {
        for (const key of store.heightIndex.keys()) {
          const index = store.heightIndex.get(key);
          if (index >= common) store.heightIndex.delete(key);
        }
      }
      for (let index = common; index < length; index++) {
        const key = turnKey(turns[index], index);
        store.heightKeys[index] = key;
        store.heightValues[index] = heightFor(store, key);
        store.heightIndex.set(key, index);
      }
      if (!appendedOnly) {
        const activeKeys = new Set(store.heightKeys);
        for (const key of store.heights.keys()) {
          if (!activeKeys.has(key)) store.heights.delete(key);
        }
      }
      store.heightDirtyFrom = Math.min(store.heightDirtyFrom, common);
      store.heightWindow = { start: -1, end: -1, tailStart: -1, total: -1 };
    }

    rebuildHeightPrefix(store);
    store.heightSourceFirstKey = firstKey;
    store.heightSourceLastKey = lastKey;
    if (!options.skipAudit) scheduleHeightAudit(store, turns);
    return keysChanged;
  }

  function rebuildHeightPrefix(store) {
    const start = clamp(store.heightDirtyFrom, 0, store.heightValues.length);
    for (let index = start; index < store.heightValues.length; index++) {
      store.heightPrefix[index + 1] = store.heightPrefix[index] + store.heightValues[index];
    }
    store.heightPrefix.length = store.heightValues.length + 1;
    store.heightDirtyFrom = store.heightValues.length;
  }

  function sumHeights(store, turns, start, end) {
    syncHeightIndex(store, turns);
    const safeStart = clamp(Number(start) || 0, 0, turns.length);
    const safeEnd = clamp(Number(end) || 0, safeStart, turns.length);
    return store.heightPrefix[safeEnd] - store.heightPrefix[safeStart];
  }

  function createNode(factory, type, props, key) {
    const config = { ...(props || {}) };
    delete config.key;
    return key === undefined || key === null
      ? factory(type, config)
      : factory(type, config, key);
  }

  function annotateTurn(node, key, createElement, turnCreateElement, state) {
    if (Array.isArray(node)) {
      return node.map((child) => annotateTurn(child, key, createElement, turnCreateElement, state));
    }
    if (!node || typeof node !== 'object' || !node.props) return node;

    const props = node.props;
    const className = typeof props.className === 'string' ? props.className : '';
    if (typeof node.type === 'string' && /(^|\s)turn(?:_|-)/.test(className)) {
      state.matched = true;
      const config = {
        ...props,
        [TURN_KEY_ATTRIBUTE]: key,
      };
      return createNode(turnCreateElement, node.type, config, node.key);
    }

    if (!Array.isArray(props.children)) return node;
    let changed = false;
    const children = props.children.map((child) => {
      if (!child || typeof child !== 'object' || !child.props) return child;
      const childClassName = typeof child.props.className === 'string' ? child.props.className : '';
      if (typeof child.type !== 'string' || !/(^|\s)turn(?:_|-)/.test(childClassName)) return child;
      changed = true;
      state.matched = true;
      return createNode(turnCreateElement, child.type, {
        ...child.props,
        [TURN_KEY_ATTRIBUTE]: key,
      }, child.key);
    });
    if (changed) {
      const marker = createNode(turnCreateElement, 'span', {
        [TURN_START_ATTRIBUTE]: key,
        'aria-hidden': 'true',
        hidden: true,
      }, `ce-turn-start-${key}`);
      return createNode(createElement, node.type, { ...props, children: [marker, ...children] }, node.key);
    }
    return node;
  }

  function isScrollable(container) {
    if (!container || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
      return false;
    }
    try {
      return /(auto|scroll|overlay)/.test(window.getComputedStyle(container).overflowY || '');
    } catch {
      return false;
    }
  }

  function findScrollContainer(store) {
    const hasContainerRef = !!store.containerRef;
    const refContainer = store.containerRef?.current;
    if (refContainer?.isConnected !== false && refContainer) {
      if (isScrollable(refContainer) || !refContainer.parentElement) return refContainer;
      const body = typeof document !== 'undefined' ? document.body : null;
      const root = typeof document !== 'undefined' ? document.documentElement : null;
      let ancestor = refContainer.parentElement;
      while (ancestor && ancestor !== body && ancestor !== root) {
        if (isScrollable(ancestor)) return ancestor;
        ancestor = ancestor.parentElement;
      }
      return refContainer;
    }
    if (hasContainerRef) return null;
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    const candidates = Array.from(document.querySelectorAll(MESSAGE_CONTAINER_SELECTOR));
    return candidates.find((element) => element?.isConnected !== false) || null;
  }

  function ensureContainer(store) {
    const container = findScrollContainer(store);
    if (!container) return null;

    if (store.container !== container) {
      const previousContainer = store.container;
      if (!store.pendingScroll && previousContainer) {
        if (store.atBottom) {
          store.pendingScroll = { mode: 'bottom' };
        } else if (previousContainer.isConnected !== false) {
          setAnchorPending(store);
        } else {
          store.pendingScroll = {
            mode: 'position',
            scrollTop: Number(previousContainer.scrollTop) || 0,
            topHeight: store.topHeight,
          };
        }
      }
      if (store.container && store.scrollHandler) {
        store.container.removeEventListener?.('scroll', store.scrollHandler);
      }
      store.resizeObserver?.disconnect?.();
      if (store.controlsOverflowAnchor && store.container?.style) {
        store.container.style.overflowAnchor = store.originalOverflowAnchor;
      }
      store.container = container;
      store.scrollHandler = () => onScroll(store);
      container.addEventListener?.('scroll', store.scrollHandler, { passive: true });
      if (container.style) {
        store.originalOverflowAnchor = container.style.overflowAnchor || '';
        container.style.overflowAnchor = 'none';
        store.controlsOverflowAnchor = true;
      } else {
        store.controlsOverflowAnchor = false;
      }
      store.containerRetries = 0;
      if (!store.pendingScroll) {
        store.pendingScroll = store.atBottom
          ? { mode: 'bottom' }
          : { mode: 'position', scrollTop: 0, topHeight: store.topHeight };
      }
    }
    return container;
  }

  function measuredTurnHeight(element) {
    const key = element?.getAttribute?.(TURN_KEY_ATTRIBUTE);
    let first = element;
    let boundaryFound = false;
    const leading = [];
    let previous = element?.previousElementSibling;
    while (previous &&
           !previous.hasAttribute?.(TURN_KEY_ATTRIBUTE) &&
           !previous.hasAttribute?.(VIRTUAL_SPACER_ATTRIBUTE)) {
      if (previous.getAttribute?.(TURN_START_ATTRIBUTE) === key) {
        boundaryFound = true;
        break;
      }
      leading.push(previous);
      previous = previous.previousElementSibling;
    }
    if (boundaryFound && leading.length) first = leading[leading.length - 1];

    try {
      const firstRect = first?.getBoundingClientRect?.();
      const lastRect = element?.getBoundingClientRect?.();
      if (firstRect && lastRect) {
        const span = lastRect.bottom - firstRect.top;
        if (Number.isFinite(span) && span > 0) return span;
      }
      return lastRect?.height || 0;
    } catch {
      return 0;
    }
  }

  function measure(store) {
    if (store.disposed) return false;
    const container = store.container;
    if (!container || typeof container.querySelectorAll !== 'function') return false;
    let changed = false;
    for (const element of container.querySelectorAll(TURN_KEY_SELECTOR)) {
      const key = element.getAttribute?.(TURN_KEY_ATTRIBUTE);
      if (!key) continue;
      const height = measuredTurnHeight(element);
      if (!Number.isFinite(height) || height <= 0) continue;
      const previous = store.heights.get(key);
      if (Number.isFinite(previous) && Math.abs(previous - height) < 0.5) continue;
      changed = true;
      store.heights.set(key, height);
      const index = store.heightIndex.get(key);
      if (index !== undefined) {
        store.heightValues[index] = height;
        store.heightDirtyFrom = Math.min(store.heightDirtyFrom, index);
        store.heightWindow = { start: -1, end: -1, tailStart: -1, total: -1 };
      }
    }
    return changed;
  }

  function scheduleMeasurementRefresh(store) {
    if (store.disposed || store.measurementScheduled) return;
    store.measurementScheduled = true;
    nextFrame(() => {
      store.measurementScheduled = false;
      if (store.disposed) return;
      if (!measure(store)) return;
      if (store.atBottom) store.pendingScroll = { mode: 'bottom' };
      else setAnchorPending(store);
      rebuildHeightPrefix(store);
      const nextTopHeight = store.heightPrefix[store.start] - store.heightPrefix[0];
      const nextBottomHeight = store.heightPrefix[store.tailStart] - store.heightPrefix[store.end];
      if (Math.abs(nextTopHeight - store.topHeight) >= 0.5 ||
          Math.abs(nextBottomHeight - store.bottomHeight) >= 0.5) {
        requestForce(store);
      } else {
        store.pendingScroll = null;
        if (store.atBottom && store.container) {
          store.container.scrollTop = store.container.scrollHeight;
        }
      }
    });
  }

  function observeRenderedTurns(store) {
    if (typeof ResizeObserver !== 'function' || !store.container) return;
    if (!store.resizeObserver) {
      store.resizeObserver = new ResizeObserver(() => scheduleMeasurementRefresh(store));
    } else {
      store.resizeObserver.disconnect();
    }
    for (const element of store.container.querySelectorAll?.(TURN_KEY_SELECTOR) || []) {
      store.resizeObserver.observe(element);
    }
  }

  function findRenderedTurn(container, key) {
    if (!container || typeof container.querySelectorAll !== 'function') return null;
    const elements = container.querySelectorAll(TURN_KEY_SELECTOR);
    for (const element of elements) {
      if (element.getAttribute?.(TURN_KEY_ATTRIBUTE) === key) return element;
    }
    return null;
  }

  function captureAnchor(store) {
    const container = store.container;
    if (!container || typeof container.querySelectorAll !== 'function') return null;
    const containerRect = container.getBoundingClientRect?.();
    if (!containerRect) return null;
    const viewportTop = containerRect.top;
    const viewportBottom = containerRect.bottom ?? (containerRect.top + container.clientHeight);
    const elements = container.querySelectorAll(TURN_KEY_SELECTOR);
    for (const element of elements) {
      const rect = element.getBoundingClientRect?.();
      if (!rect || rect.bottom <= viewportTop || rect.top >= viewportBottom) continue;
      return {
        key: element.getAttribute?.(TURN_KEY_ATTRIBUTE),
        offset: rect.top - viewportTop,
      };
    }
    return null;
  }

  function applyPendingScroll(store) {
    const pending = store.pendingScroll;
    const container = store.container;
    if (!pending || !container) return;

    if (pending.mode === 'bottom') {
      container.scrollTop = container.scrollHeight;
    } else if (pending.mode === 'top') {
      container.scrollTop = 0;
    } else if (pending.mode === 'position') {
      const delta = store.topHeight - pending.topHeight;
      container.scrollTop = Math.max(0, pending.scrollTop + delta);
    } else if (pending.mode === 'anchor') {
      const element = findRenderedTurn(container, pending.key);
      if (element) {
        const containerRect = container.getBoundingClientRect?.();
        const rect = element.getBoundingClientRect?.();
        if (containerRect && rect) {
          container.scrollTop += (rect.top - containerRect.top) - pending.offset;
        }
      } else {
        const delta = store.topHeight - (pending.topHeight || 0);
        container.scrollTop = Math.max(0, (pending.scrollTop || 0) + delta);
      }
    } else if (pending.mode === 'focus') {
      const element = findRenderedTurn(container, pending.key);
      element?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    }

    store.pendingScroll = null;
    const bottomDistance = container.scrollHeight - container.scrollTop - container.clientHeight;
    store.atBottom = store.end >= store.total && bottomDistance <= DEFAULTS.edgeThreshold;
  }

  function runAfterRender(store) {
    if (store.disposed) return;
    const container = ensureContainer(store);
    if (!container) {
      if (store.force && store.containerRetries < 5) {
        store.containerRetries++;
        setTimeout(() => {
          if (store.disposed) return;
          store.afterScheduled = false;
          scheduleAfterRender(store);
        }, 60);
      }
      return;
    }
    const measurementsChanged = measure(store);
    observeRenderedTurns(store);
    applyPendingScroll(store);
    if (measurementsChanged) {
      rebuildHeightPrefix(store);
      const nextTopHeight = store.heightPrefix[store.start] - store.heightPrefix[0];
      const nextBottomHeight = store.heightPrefix[store.tailStart] - store.heightPrefix[store.end];
      if (Math.abs(nextTopHeight - store.topHeight) >= 0.5 ||
          Math.abs(nextBottomHeight - store.bottomHeight) >= 0.5) {
        if (store.atBottom) store.pendingScroll = { mode: 'bottom' };
        else setAnchorPending(store);
        requestForce(store);
      }
    }
  }

  function scheduleAfterRender(store) {
    if (store.disposed || store.afterScheduled) return;
    store.afterScheduled = true;
    afterCommit(() => {
      store.afterScheduled = false;
      runAfterRender(store);
    });
  }

  function requestForce(store) {
    if (store.disposed) return;
    if (!store.container || store.container.isConnected === false) return;
    if (typeof store.force !== 'function') return;
    store.force((value) => value + 1);
  }

  function setAnchorPending(store) {
    const anchor = captureAnchor(store);
    const anchorIndex = anchor ? store.heightIndex.get(anchor.key) : undefined;
    store.pendingScroll = anchor
      ? {
          mode: 'anchor',
          key: anchor.key,
          offset: anchor.offset,
          index: anchorIndex,
          windowOffset: Number.isInteger(anchorIndex) &&
            anchorIndex >= store.start && anchorIndex < store.end
            ? anchorIndex - store.start
            : undefined,
          scrollTop: Number(store.container?.scrollTop) || 0,
          topHeight: store.topHeight,
        }
      : {
          mode: 'position',
          scrollTop: Number(store.container?.scrollTop) || 0,
          topHeight: store.topHeight,
        };
  }

  function shiftEarlier(store) {
    const page = Math.min(store.start, DEFAULTS.pageTurns);
    if (page <= 0) return false;
    const windowSize = Math.max(1, store.end - store.start);
    setAnchorPending(store);
    store.start -= page;
    store.end = Math.min(store.total, store.start + windowSize);
    store.windowSize = store.end - store.start;
    store.atBottom = false;
    requestForce(store);
    return true;
  }

  function jumpToHead(store) {
    if (store.start === 0) return false;
    store.pendingScroll = { mode: 'top' };
    store.start = 0;
    store.end = Math.min(store.total, Math.max(DEFAULTS.initialTurns, store.windowSize));
    store.windowSize = store.end - store.start;
    store.atBottom = false;
    requestForce(store);
    return true;
  }

  function shiftLater(store) {
    const page = Math.min(store.total - store.end, DEFAULTS.pageTurns);
    if (page <= 0) return false;
    setAnchorPending(store);
    store.start += page;
    store.end = Math.min(store.total, store.end + page);
    store.windowSize = store.end - store.start;
    requestForce(store);
    return true;
  }

  function jumpToTail(store) {
    if (store.end >= store.total) return false;
    store.pendingScroll = { mode: 'bottom' };
    store.end = store.total;
    store.start = Math.max(0, store.total - Math.max(DEFAULTS.initialTurns, store.windowSize));
    store.windowSize = store.end - store.start;
    store.atBottom = true;
    requestForce(store);
    return true;
  }

  function indexForHeight(store, height) {
    rebuildHeightPrefix(store);
    if (!store.heightValues.length) return 0;
    const target = clamp(Number(height) || 0, 0, store.heightPrefix.at(-1) || 0);
    let low = 0;
    let high = store.heightValues.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (store.heightPrefix[middle + 1] <= target) low = middle + 1;
      else high = middle - 1;
    }
    return clamp(low, 0, store.heightValues.length - 1);
  }

  function jumpToIndex(store, index) {
    const target = clamp(Number(index) || 0, 0, Math.max(0, store.total - 1));
    const windowSize = Math.min(store.total, Math.max(DEFAULTS.initialTurns, store.windowSize));
    const nextStart = clamp(
      target - Math.floor(windowSize / 2),
      0,
      Math.max(0, store.total - windowSize)
    );
    const nextEnd = Math.min(store.total, nextStart + windowSize);
    if (nextStart === store.start && nextEnd === store.end) return false;
    store.start = nextStart;
    store.end = nextEnd;
    store.windowSize = nextEnd - nextStart;
    store.atBottom = false;
    store.pendingScroll = { mode: 'focus', key: store.heightKeys[target], index: target };
    requestForce(store);
    return true;
  }

  function jumpWithinSpacer(store, spacerRect, containerRect, rangeStart, rangeEnd) {
    if (!spacerRect || !containerRect || rangeEnd <= rangeStart) return false;
    const viewportBottom = containerRect.bottom ?? (containerRect.top + store.container.clientHeight);
    if (spacerRect.top >= containerRect.top - DEFAULTS.edgeThreshold ||
        spacerRect.bottom <= viewportBottom + DEFAULTS.edgeThreshold) {
      return false;
    }
    const viewportMiddle = (containerRect.top + viewportBottom) / 2;
    const spacerHeight = Math.max(1, spacerRect.bottom - spacerRect.top);
    const fraction = clamp((viewportMiddle - spacerRect.top) / spacerHeight, 0, 1);
    const rangeHeight = store.heightPrefix[rangeEnd] - store.heightPrefix[rangeStart];
    const absoluteHeight = store.heightPrefix[rangeStart] + rangeHeight * fraction;
    const index = clamp(indexForHeight(store, absoluteHeight), rangeStart, rangeEnd - 1);
    return jumpToIndex(store, index);
  }

  function handleScroll(store) {
    if (store.disposed) return;
    const container = store.container;
    if (!container || container.isConnected === false) return;
    const total = store.total;
    if (!total) return;

    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const actualBottom = container.scrollHeight - viewportBottom <= DEFAULTS.edgeThreshold;
    if (store.pendingScroll?.mode === 'bottom') {
      if (actualBottom) return;
      store.pendingScroll = null;
      store.atBottom = false;
    } else if (store.pendingScroll) {
      return;
    }
    store.atBottom = actualBottom && store.end >= total;

    if (store.start > 0 && store.topHeight > 0) {
      const topSpacer = container.querySelector?.(`[${VIRTUAL_SPACER_ATTRIBUTE}="top"]`);
      const containerRect = container.getBoundingClientRect?.();
      const topRect = topSpacer?.getBoundingClientRect?.();
      if (jumpWithinSpacer(store, topRect, containerRect, 0, store.start)) return;
      const atSpacerStart = containerRect && topRect
        ? topRect.top >= containerRect.top - DEFAULTS.edgeThreshold
        : viewportTop <= DEFAULTS.edgeThreshold;
      const nearTopSpacer = containerRect && topRect
        ? topRect.bottom >= containerRect.top - DEFAULTS.edgeThreshold
        : viewportTop < store.topHeight + DEFAULTS.edgeThreshold;
      if (atSpacerStart) {
        jumpToHead(store);
        return;
      }
      if (nearTopSpacer) {
        shiftEarlier(store);
        return;
      }
    }

    if (store.end < total && actualBottom) {
      jumpToTail(store);
      return;
    }

    if (store.end < total && store.bottomHeight > 0) {
      const bottomSpacer = container.querySelector?.(`[${VIRTUAL_SPACER_ATTRIBUTE}="bottom"]`);
      const containerRect = container.getBoundingClientRect?.();
      const bottomRect = bottomSpacer?.getBoundingClientRect?.();
      if (jumpWithinSpacer(store, bottomRect, containerRect, store.end, store.tailStart)) return;
      const nearBottomSpacer = containerRect && bottomRect
        ? bottomRect.top <= containerRect.bottom + DEFAULTS.edgeThreshold
        : viewportBottom > container.scrollHeight - store.bottomHeight - DEFAULTS.edgeThreshold;
      const passedBottomSpacer = containerRect && bottomRect
        ? bottomRect.bottom <= containerRect.top
        : viewportTop >= container.scrollHeight - store.bottomHeight;
      if (passedBottomSpacer) {
        jumpToTail(store);
        return;
      }
      if (nearBottomSpacer) {
        shiftLater(store);
      }
    }
  }

  function onScroll(store) {
    if (store.disposed || store.scrollScheduled) return;
    store.scrollScheduled = true;
    nextFrame(() => {
      store.scrollScheduled = false;
      if (store.disposed) return;
      handleScroll(store);
    });
  }

  function createSpacer(turnCreateElement, edge, height) {
    return createNode(turnCreateElement, 'div', {
      [VIRTUAL_SPACER_ATTRIBUTE]: edge,
      'aria-hidden': 'true',
      style: {
        width: '100%',
        height: Math.max(0, Math.round(height)),
        flex: '0 0 auto',
        pointerEvents: 'none',
      },
    }, `ce-${edge}-spacer`);
  }

  function renderRange(
    store,
    turns,
    start,
    end,
    renderTurn,
    createElement,
    turnCreateElement,
    nodes
  ) {
    for (let index = start; index < end; index++) {
      const turn = turns[index];
      if (!turn) continue;
      const node = typeof renderTurn === 'function' ? renderTurn(turn, index, turns) : null;
      const state = { matched: false };
      const rendered = annotateTurn(
        node,
        turnKey(turn, index),
        createElement,
        turnCreateElement,
        state
      );
      if (!state.matched) {
        throw new Error('Claude turn wrapper was not found in the rendered turn.');
      }
      if (Array.isArray(rendered)) {
        rendered.forEach((child) => nodes.push(child));
      } else {
        nodes.push(rendered);
      }
      store.renderedTurns++;
    }
  }

  function render(options = {}) {
    const branch = !!options.branch;
    const turns = (branch ? options.firstTurns : options.secondTurns) || [];
    const renderTurn = branch ? options.firstRender : options.secondRender;
    const safeTurns = Array.isArray(turns) ? turns : [];
    const total = safeTurns.length;
    const key = sessionKey(options.session);
    const store = getStore(key);
    if (options.containerRef) {
      for (const [otherKey, otherStore] of stores) {
        if (otherKey !== key && otherStore.containerRef === options.containerRef) {
          disposeStore(otherStore);
          stores.delete(otherKey);
        }
      }
    }

    store.containerRef = options.containerRef || store.containerRef;
    store.force = options.force;
    const resetRequired = !store.initialized || store.branch !== branch;
    let keysChanged;
    if (resetRequired) {
      reconcile(store, total, branch);
      keysChanged = syncHeightIndex(store, safeTurns);
    } else {
      keysChanged = syncHeightIndex(store, safeTurns, () => {
        if (!store.atBottom && !store.pendingScroll && store.container) {
          setAnchorPending(store);
        }
      });
      reconcile(store, total, branch);
    }

    store.tailStart = store.end < total
      ? Math.max(store.end, total - DEFAULTS.tailTurns)
      : total;
    revealFocus(store, safeTurns, options.focusIndex);
    store.tailStart = store.end < total
      ? Math.max(store.end, total - DEFAULTS.tailTurns)
      : total;
    if (keysChanged && store.pendingScroll?.mode === 'anchor' &&
        Number.isInteger(store.pendingScroll.index)) {
      const nextIndex = store.heightIndex.get(store.pendingScroll.key);
      if (Number.isInteger(nextIndex)) {
        const windowSize = Math.min(total, Math.max(DEFAULTS.initialTurns, store.windowSize));
        const nextStart = Number.isInteger(store.pendingScroll.windowOffset)
          ? nextIndex - store.pendingScroll.windowOffset
          : store.start + nextIndex - store.pendingScroll.index;
        const clampedStart = clamp(nextStart, 0, Math.max(0, total - windowSize));
        if (clampedStart !== store.start) {
          store.start = clampedStart;
          store.end = Math.min(total, store.start + windowSize);
          store.windowSize = store.end - store.start;
        }
      }
    }
    store.tailStart = store.end < total
      ? Math.max(store.end, total - DEFAULTS.tailTurns)
      : total;
    syncHeightIndex(store, safeTurns);
    if (keysChanged && store.pendingScroll?.mode === 'focus' &&
        Number.isInteger(store.pendingScroll.index)) {
      store.pendingScroll.key = store.heightKeys[store.pendingScroll.index];
    }
    const cached = store.heightWindow;
    if (cached.start !== store.start || cached.end !== store.end ||
        cached.tailStart !== store.tailStart || cached.total !== total) {
      store.topHeight = store.heightPrefix[store.start] - store.heightPrefix[0];
      store.bottomHeight = store.heightPrefix[store.tailStart] - store.heightPrefix[store.end];
      store.heightWindow = {
        start: store.start,
        end: store.end,
        tailStart: store.tailStart,
        total,
      };
    }
    store.renderedTurns = 0;

    const nodes = [];
    const turnCreateElement = options.turnCreateElement || options.createElement;
    if (store.start > 0 && store.topHeight > 0) {
      nodes.push(createSpacer(turnCreateElement, 'top', store.topHeight));
    }
    renderRange(
      store,
      safeTurns,
      store.start,
      store.end,
      renderTurn,
      options.createElement,
      turnCreateElement,
      nodes
    );
    if (store.end < total && store.bottomHeight > 0) {
      nodes.push(createSpacer(turnCreateElement, 'bottom', store.bottomHeight));
    }
    if (store.tailStart < total) {
      renderRange(
        store,
        safeTurns,
        store.tailStart,
        total,
        renderTurn,
        options.createElement,
        turnCreateElement,
        nodes
      );
    }

    scheduleAfterRender(store);
    return nodes;
  }

  function renderFallback(options = {}) {
    const branch = !!options.branch;
    const turns = (branch ? options.firstTurns : options.secondTurns) || [];
    const renderTurn = branch ? options.firstRender : options.secondRender;
    const safeTurns = Array.isArray(turns) ? turns : [];
    const start = Math.max(0, safeTurns.length - DEFAULTS.initialTurns);
    const nodes = [];
    if (typeof renderTurn === 'function') {
      for (let index = start; index < safeTurns.length; index++) {
        nodes.push(renderTurn(safeTurns[index], index, safeTurns));
      }
    }
    return createNode(options.createElement, options.fragment, { children: nodes });
  }

  function warnFallback(error) {
    try {
      if (typeof window === 'undefined' || window.__claudeEnhanceVirtualWarned) return;
      window.__claudeEnhanceVirtualWarned = true;
      console.warn(
        '[Claude Enhance] Virtual turns fell back to a bounded tail window',
        error
      );
    } catch {
    }
  }

  function disableStore(store, branch) {
    if (!store) return;
    if (store.container && store.scrollHandler) {
      store.container.removeEventListener?.('scroll', store.scrollHandler);
    }
    store.resizeObserver?.disconnect?.();
    if (store.controlsOverflowAnchor && store.container?.style) {
      store.container.style.overflowAnchor = store.originalOverflowAnchor;
    }
    store.failedBranch = branch;
    store.controlsOverflowAnchor = false;
    store.container = null;
    store.scrollHandler = null;
    store.resizeObserver = null;
    store.force = null;
    store.pendingScroll = null;
    store.afterScheduled = false;
    store.scrollScheduled = false;
    store.measurementScheduled = false;
    cancelIdle(store.heightAudit);
    store.heightAudit = null;
    store.heightAuditGeneration++;
  }

  function Component(options = {}) {
    let hookState;
    try {
      hookState = options.useState(0);
    } catch (error) {
      warnFallback(error);
      return renderFallback(options);
    }

    const force = Array.isArray(hookState) ? hookState[1] : null;
    if (typeof force !== 'function') {
      const error = new Error('Claude state hook did not return a setter.');
      warnFallback(error);
      return renderFallback(options);
    }

    const branch = !!options.branch;
    const store = getStore(sessionKey(options.session));
    if (store.failedBranch === branch) return renderFallback(options);
    if (store.failedBranch !== null) store.failedBranch = null;

    try {
      const nodes = render({ ...options, force });
      return createNode(options.createElement, options.fragment, { children: nodes });
    } catch (error) {
      warnFallback(error);
      disableStore(store, branch);
      return renderFallback(options);
    }
  }

  function diagnostics() {
    return Array.from(stores.values()).map((store) => ({
      key: store.key,
      total: store.total,
      start: store.start,
      end: store.end,
      tailStart: store.tailStart,
      renderedTurns: store.renderedTurns,
      atBottom: store.atBottom,
      topHeight: store.topHeight,
      bottomHeight: store.bottomHeight,
      measuredTurns: store.heights.size,
      fallback: store.failedBranch !== null,
    }));
  }

  function reset() {
    for (const store of stores.values()) disposeStore(store);
    stores.clear();
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      if (viewportResizeScheduled) return;
      viewportResizeScheduled = true;
      nextFrame(() => {
        viewportResizeScheduled = false;
        invalidateMeasurements();
      });
    }, { passive: true });
  }

  return Object.freeze({
    Component,
    render,
    diagnostics,
    invalidateMeasurements,
    reset,
    _test: Object.freeze({
      DEFAULTS,
      MESSAGE_CONTAINER_SELECTOR,
      VIRTUAL_SPACER_ATTRIBUTE,
      TURN_KEY_ATTRIBUTE,
      TURN_START_ATTRIBUTE,
      TURN_KEY_SELECTOR,
      createStore,
      getStore,
      reconcile,
      resetStore,
      clearMeasurements,
      invalidateMeasurements,
      turnContainsFocus,
      revealFocus,
      sumHeights,
      createNode,
      activeHeightKeysMatch,
      heightKeysMatchAtIndices,
      allHeightKeysMatch,
      canExtendHeightIndex,
      auditHeightIndex,
      syncHeightIndex,
      rebuildHeightPrefix,
      measuredTurnHeight,
      ensureContainer,
      turnKey,
      sessionKey,
      annotateTurn,
      captureAnchor,
      applyPendingScroll,
      handleScroll,
      shiftEarlier,
      shiftLater,
      jumpToHead,
      jumpToTail,
      indexForHeight,
      jumpToIndex,
      jumpWithinSpacer,
      renderFallback,
      disableStore,
      reset,
    }),
  });
});
