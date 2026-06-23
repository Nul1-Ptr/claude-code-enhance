# Changelog

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
