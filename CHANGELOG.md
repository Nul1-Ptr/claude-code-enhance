# Changelog

## [1.0.5] - 2026-08-18

### Sub-agent Transcripts
- Added a native activity-bar tree that groups Claude Code child-agent histories by project and parent session, with prompt labels, agent type, status, size, and raw JSONL access.
- Added a separate complete transcript webview for user, assistant, thinking, tool-call, tool-result, and error records. Open transcripts refresh append-only while their JSONL files grow.
- Added search and message-type filters without coupling the feature to Claude Code's private extension-host/webview protocol.

### Rich Rendering And Safety
- Added bundled Marked GFM parsing for transcript tables and code fences, KaTeX rendering with math-aware table-pipe protection, Highlight.js code rendering, and source-preserving formula failures.
- Added DOM allowlisting, literal raw-HTML handling, restricted links, local-only assets, and a nonce-based Content Security Policy.
- Added softer tool/API error styling, readable table math, adaptive display-math padding, and left-aligned formulas.

### Validation
- Added synthetic JSONL streaming, malformed-line, tool/error, Markdown, math, table, code, and CSP regressions.
- Validated every local sub-agent history: 113 JSONL files, 16,184 renderable messages, and 50 MB in the current test corpus.

## [1.0.4] - 2026-08-18

### Architecture
- Replaced version-specific minified-bundle regex patching with Acorn AST discovery. Markdown and transcript-retention targets are matched semantically, transformed by source ranges, syntax-validated, and rejected when discovery is missing or ambiguous.
- Added verified multi-file transactions for webview patches, restores, backup rotation, and uninstall cleanup, including SHA-256/version metadata, `fsync`, atomic renames, and rollback after partial commits.
- Replaced immediate and delayed global rescans with a shared feature registry and animation-frame scheduler. Mutation batches now coalesce feature flags and process only dirty message roots; conversation replacement remains a full-pass fallback.

### Configuration And Diagnostics
- Added settings for full-transcript retention, content and math scale, tool-output math, syntax highlighting, copy controls, and API error cards.
- Added the `Claude Code Enhance: Show Diagnostics` command and runtime diagnostics in the `Ctrl+Shift+D` DOM export.
- Added explicit detection and recovery for incomplete JS/CSS patch states and safe backup rotation after in-place Claude Code updates.

### Rich Content
- Unified deterministic math candidate scanning across source, remark/rehype, and DOM fallback paths while preserving exact raw text for literal fallback.
- Added context-aware recovery for line-numbered and blockquoted tool output, orphan display delimiters, HTML-adjacent equations, template substitutions, protected code spans, malformed dimensions, and unsupported KaTeX operators.
- Prevented long valid display formulas with TeX subscripts from being mistaken for Markdown emphasis, recovered validated math-only inline-code spans, and excluded Claude's Edit/Monaco diff surfaces from tool-output math fallback.
- Expanded API error cards, table math sizing/alignment, content readability, code highlighting, and copy behavior.

### Validation
- Added structural, transaction, configuration, scheduler, uninstall, and installed-version architecture regressions.
- Added real-history validation for Claude and Codex assistant messages and tool results, including formula rendering, code-region exclusion, normalization idempotence, API errors, highlighting, and table pipes.

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
