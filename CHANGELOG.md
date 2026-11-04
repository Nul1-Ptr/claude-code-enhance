# Changelog

## [1.0.8] - 2026-11-04

### Compatibility
- Validated the structural retention, virtual-turn, and Markdown discovery paths against Claude Code 2.1.318. Its minified identifiers changed again, but the recognized message-retention and turn-renderer structures remain compatible.
- Added structural discovery for Claude Code 2.1.312+ message-list retention functions that return `{ messages, removedIndices }` instead of slicing an array. The new retention entry point is neutralized once, so its replay and append wrappers inherit the complete message list without version-specific patching.
- Added structural retention-target selection with explicit `retentionReason` diagnostics and fail-closed handling when multiple candidates are ambiguous.
- Made full-transcript patching fail closed when Claude's capacity-retention entry point is missing or ambiguous, and added a regression check against the installed Claude bundle.
- Kept semantic eviction of explicitly superseded or retracted messages separate from capacity retention, avoiding duplicate or withdrawn rows in the main chat.
- Added requested-versus-effective runtime state, status reporting, and a warning when full history safely falls back to Claude Code's native retention.
- Added support for Claude Code 2.1.308+ bundles where conversation Markdown components are memoized (`useMemo`) into an identifier (`components: B`) rather than passed as an inline object literal.
- Enhanced `componentsHasCodeOrPre` to trace identifier declarations and inspect memoized component mappings for `code` and `pre` overrides.
- Added regression tests for identifier-backed and memoized Markdown component overrides.
- Resolved minified identifiers and retention constants through lexical scope, preventing unrelated same-named bindings from selecting the wrong Markdown, hook, or retention target.

### Performance
- Added tail-first turn virtualization for long conversations: complete message data stays available while the main chat mounts only the active window plus the latest turn.
- Added keyed scroll anchoring and spacer-based pagination so moving the render window does not jump the reader's position or pull them back to the tail.
- Coupled default full-transcript retention to verified turn virtualization: if the turn renderer cannot be identified safely, only full-transcript retention is skipped while independent rich-rendering patches remain available.
- Kept streaming updates attached to the live tail even while older history is being browsed, and limited Markdown, KaTeX, highlighting, layout, and enhancement work to mounted turns.
- Virtual-turn discovery fails closed: ambiguous or changed Claude bundles keep the native message list while the Markdown enhancement still applies.
- Added a bounded recent-turn runtime fallback so an unexpected virtualizer failure cannot mount an unbounded retained transcript.
- Scoped copy-button maintenance to the dirty turn instead of rescanning the entire message container on every mutation.
- Added `content-visibility` containment for off-screen historical turns.
- Rate-limited syntax highlighting while a code block is still streaming.
- Cached scroll-container discovery to avoid repeated computed-style walks during enhancement cycles.
- Reduced enhancement-cycle scroll layout reads and invalidated virtual height estimates after viewport or zoom changes.
- Added per-turn measurement boundaries so date separators contribute to spacer heights without accidentally counting container headers or engine surfaces.
- Bounded append-only virtual-height indexing so adding a turn does not reread every historical turn key or retain the source turn array.
- Recomputed copy controls at the affected turn when the last message is removed, keeping turn-level copy state correct without a full transcript scan.
- Preserved the sub-agent empty state when an append contains metadata or non-renderable JSONL records but no new messages.
- Reused the sub-agent panel's owned message array during incremental reads and skipped off-screen message layout, avoiding cumulative host-side array copies while the panel is open.

## [1.0.7] - 2026-10-15

### Compatibility
- Added disambiguation for Claude Code 2.1.300+ bundles containing multiple Markdown renderers (such as auxiliary `data-engine-markdown` widgets alongside the primary conversation renderer).
- Targeted the primary conversation renderer by inspecting Markdown component signatures (`code` and `pre` overrides) while keeping ambiguous synthetic targets protected against false positives.
- Added multi-target regression tests covering bundles with both auxiliary and conversation Markdown renderers.

## [1.0.6] - 2026-10-11

### Compatibility
- Added support for Claude Code 2.1.296+ bundles where ReactMarkdown props pass plugin configurations via spread options (`...fn(links, platform)`) rather than direct `remarkPlugins` object properties.
- Wrapped spread options safely to inject KaTeX and remark-math plugins while preserving all runtime options (such as Windows link transforms).
- Added AST discovery and architecture regression tests for spread Markdown renderer targets.

## [1.0.5] - 2026-08-19

### Sub-agent Project Scope
- Filtered the sub-agent sidebar and transcript picker to the active VS Code workspace by default, including multi-root and nested working-directory histories.
- Added panel commands to switch explicitly between the active workspace and all Claude projects, with automatic refresh when workspace folders change.

### Sidebar Icon
- Replaced the unsupported raster-embedded activity icon with a native 24px SVG and assigned an explicit visible stroke color.
- Bumped the extension version so VS Code loads the corrected icon from a fresh extension resource path instead of a cached `1.0.5` asset.

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
