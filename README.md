# Claude Code Enhance

Claude Code Enhance is a local VS Code extension that improves the Claude Code chat webview.

Based on work from:
- [claude-code-enhance](https://github.com/Sophomoresty/claude-code-enhance)
- [claude-code-katex](https://github.com/MahammadNuriyev62/claude-code-katex)

It adds:

- LaTeX math rendering with KaTeX
- Syntax highlighting for code blocks
- Theme-aware output styling for light, dark, and high-contrast themes
- More readable prompt/input text
- Copy buttons for assistant output and individual code blocks
- Table and code-block readability improvements
- Ctrl/Cmd + mouse-wheel zoom for the chat output

## Preview

Original Claude Code output:

![Original Claude Code chat output](preview/original.png)

Enhanced output with Claude Code Enhance:

![Claude Code Enhance preview](preview/preview.png)

## Version

Current local version: `1.0.0`

The package version is intentionally kept at `1.0.0` for now. Internal patch revisions are tracked separately inside the patched webview so a rebuilt `1.0.0` VSIX can still refresh stale injected code.

## Requirements

- VS Code or code-server
- The official `anthropic.claude-code` extension installed
- This VSIX installed from the local build output

## Install

From this directory:

```bash
npm run package
code --install-extension claude-code-enhance-1.0.0.vsix --force
```

Reload VS Code after installing. The extension patches Claude Code automatically on startup and reloads the Claude Code webview when it applies or refreshes the patch.

## Commands

Open the command palette with `Ctrl+Shift+P`:

- `Claude Code Enhance: Enable`
- `Claude Code Enhance: Disable`
- `Claude Code Enhance: Status`

## What Gets Patched

Claude Code Enhance does not modify Claude Code's extension host code. It patches only Claude Code's webview files:

- `webview/index.js`
- `webview/index.css`

Before patching, it creates backups:

- `webview/index.js.katex-bak`
- `webview/index.css.katex-bak`

The patch is version-stamped. When this extension updates, it can restore the original files from backup and re-apply the current patch.

## How Rendering Works

The extension injects `remark-math` and `rehype-katex` into Claude Code's Markdown rendering pipeline. Math is parsed before Markdown emphasis and escaping can damage LaTeX, so expressions like these render correctly:

```tex
$\mathbf{n}_{\text{phys}} = \mathbf{S}^T \cdot \mathbf{n}_{\text{ref}}$
$J^{-1} = S/|J|$
$$\tilde{F}_{ij} = \sum_k S^{\xi_i}_k \cdot F_{kj}$$
```

The bundled `enhance.js` also runs inside the webview to improve output styling, copy behavior, zoom, tables, code blocks, and fallback math rendering.

Math inside inline code and fenced code blocks is left as literal text.

The enhancer also repairs relaxed bold markers such as `** content **` in output text. Claude Code's Markdown parser follows CommonMark and leaves those markers visible because of the inner spaces; the enhancer renders them as bold while leaving code, math, and the chat input untouched.

## Syntax Highlighting

Code blocks are highlighted with bundled Highlight.js when Claude Code includes a fence language such as `python`, `ts`, `bash`, or `latex`. Unlabeled fences are highlighted as `markdown`, with colored prose plus stronger colors for headings, links, code spans, and list markers, without random auto-detection as `java`, `css`, `yaml`, `ini`, or another unrelated language. Markdown emphasis keeps the prose color so technical tokens like `A_B` do not split into mismatched colors.

The extension applies a common One Dark / One Light inspired syntax palette on top of Highlight.js so keywords, strings, comments, numbers, types, functions, and metadata stay colorful and readable across light, dark, and high-contrast themes.

Each code block also gets its own **Copy** button, separate from the full-response copy button.

Inline math and display math use theme-aware background colors. Display math uses a full-width block similar to code blocks, with a larger centered equation.

## Theme Behavior

The enhancer uses VS Code theme variables where possible:

- editor foreground/background
- input foreground/background
- widget borders
- text code block background
- inline and display math background
- button colors
- high-contrast borders

Light theme code blocks use the One Light inspired palette so the dark bundled syntax theme does not produce low-contrast text.

## Disable Or Uninstall

Preferred temporary disable:

1. Run `Ctrl+Shift+P`.
2. Select `Claude Code Enhance: Disable`.
3. The extension restores the original webview files and reloads the webview.

To re-enable, run:

```text
Claude Code Enhance: Enable
```

Uninstalling the VS Code extension should run `uninstall-hook.js`, which restores the backups and removes copied KaTeX fonts.

## If You Disabled The Extension From The Extensions Panel

VS Code's extension disable action does not run cleanup hooks. If you disabled the extension from the Extensions panel before running `Claude Code Enhance: Disable`, the already-patched Claude Code webview may keep the enhancement.

Use one of these fixes:

1. Re-enable `Claude Code Enhance`, then run `Claude Code Enhance: Disable`.
2. Or run the restore hook manually from this source directory:

```bash
npm run restore
```

Then reload the Claude Code webview or reload the VS Code window.

## Development

Run the dependency-free smoke test:

```bash
npm test
```

Build a VSIX:

```bash
npm run package
```

The generated `.vsix` file is ignored by `.vscodeignore`, so rebuilding will not accidentally include an old VSIX inside a new VSIX.

## Important Notes

- Disable or uninstall older `claude-code-katex` builds before using this extension to avoid two patchers fighting over the same Claude Code webview files.
- If Claude Code changes its internal webview bundle, the patch may become unsupported. In that case the extension leaves Claude Code untouched and shows a warning.
- This is a local enhancement extension, not an official Anthropic extension.

## License

MIT
