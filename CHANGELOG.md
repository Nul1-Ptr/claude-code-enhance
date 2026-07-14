# Changelog

## [1.0.3] - 2026-07-14

### Fixed
- Fixed window freeze from an infinite render loop. The `MutationObserver` mistook the `$` characters inside KaTeX `<annotation>` output for new user content and re-triggered the enhancement cycle endlessly. Added an `_enhancing` guard flag and `isSelfMutation()` / `isInsideKatex()` checks so the Observer ignores DOM changes produced by the enhancement script itself.
- Fixed window freeze when a tool confirmation dialog or context button appears. The Observer now watches only the `messagesContainer_` element instead of `document.body`, so dialogs and other UI outside the container no longer trigger the enhancement cycle. Attachment uses a triple fallback (immediate attempt, body-bridge Observer, and `setInterval` polling) to cover both new and existing sessions.
- Fixed enhancements disappearing after switching conversations. The observer now detects when Claude Code replaces `messagesContainer_`, reattaches to the new container, and immediately renders its existing content.
- Fixed auto-scroll not following streaming output. Added `scrollToBottomIfNeeded()`, called before and after each cycle, which restores scroll position via `requestAnimationFrame` when the user is within 150px of the bottom.

### Performance
- Fixed O(n²) slowdown in formula-heavy conversations. Per-element `dataset` markers (`ce-adapted`, `ce-promoted`, `ce-repaired`) skip already-processed `.katex` elements, eliminating repeated `getBoundingClientRect()` reflows.
- Removed a duplicate LaTeX pre-processing pass in `renderLaTeX()`.
- Added `classifyMutations()` so text-only changes trigger only LaTeX rendering and new code elements trigger only syntax highlighting, instead of the full cycle every time.

### Changed
- Renamed `injectHighlightJS()` to `markHighlightJSReady()` to reflect that it does not inject JS.
- Replaced the `_turnMessages` DOM property with a `WeakMap` to avoid memory leaks.

### Notes
- Based on a community fix from the `enhance.js` attachment in issue #2, with the two root-level dedup guards (`ce-bold-processed`, `ce-dimension-processed`) removed. Those latched on the persistent `messagesContainer_` root and would have permanently disabled relaxed-bold and bare-dimension rendering for every message after the first cycle; the underlying passes are already idempotent per text node, so no guard is needed.

## [1.0.2] - 2026-06-23

### Fixed
- Fixed compatibility with Claude Code 2.1.186
- Updated injection pattern to match new JSX factory function syntax
  - Old pattern: `createElement(Component, {remarkPlugins:[...]})`
  - New pattern: `b(QZ, {remarkPlugins:[GR]})`
- The extension now correctly patches the react-markdown component in Claude Code 2.1.186

### Technical Details
The Claude Code webview bundle changed its internal structure:
- Switched from `createElement()` to JSX factory functions (`b()`, `E()`, etc.)
- Component identifiers are now minified (e.g., `QZ` instead of descriptive names)
- Plugin arrays use minified variable names (e.g., `GR` for the GFM remark plugin)

The regex pattern was updated to:
```javascript
/\b([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{remarkPlugins:\[([A-Za-z_$][\w$,]*)\]/
```

This pattern captures:
1. The JSX factory function name (e.g., `b`)
2. The component identifier (e.g., `QZ`)
3. The existing plugin list (e.g., `GR`)

## [1.0.1] - Previous version
- Initial release with LaTeX rendering
- Code syntax highlighting
- Enhanced markdown preview
