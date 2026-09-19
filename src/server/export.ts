import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'

/** Files of a leaf bundle, relative paths → bytes. Symlinks are never followed or included. */
function readBundle(bundleDir: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const stats = lstatSync(full)
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) walk(full)
      else if (stats.isFile())
        files[path.relative(bundleDir, full).split(path.sep).join('/')] = readFileSync(full)
    }
  }
  walk(bundleDir)
  return files
}

const under = (folder: string, files: Record<string, Uint8Array>) =>
  Object.fromEntries(Object.entries(files).map(([name, data]) => [`${folder}/${name}`, data]))

/** Markdown + assets: the bundle as is — every file, nested paths, exact bytes. */
export function markdownZip(bundleDir: string, slug: string): Uint8Array {
  return zipSync(under(slug, readBundle(bundleDir)), { level: 6 })
}

/**
 * The exported page is baked light, on purpose: its diagrams are rendered to SVG once, with
 * mermaid's light theme, so a dark variant of the page would put light diagrams on a dark
 * background. Colours are the app's light tokens (theme.css); export.test.ts checks their contrast.
 */
export const EXPORT_STYLESHEET = `:root { color-scheme: light; }
body { margin: 0; font: 18px/1.7 Charter, 'Iowan Old Style', Georgia, serif; color: #22211f; background: #fbfaf8; }
main { width: min(680px, 100% - 48px); margin: 0 auto; padding: 72px 0 96px; }
h1 { font-size: 2em; line-height: 1.2; margin: 0 0 0.6em; }
h2 { font-size: 1.4em; line-height: 1.3; margin: 1.8em 0 0.4em; }
h3 { font-size: 1.15em; margin: 1.6em 0 0.4em; }
a { color: #3b6ea5; }
img, svg, video { max-width: 100%; height: auto; }
figure { margin: 1.5em 0; text-align: center; }
figcaption { font-size: 0.85em; color: #66635d; }
blockquote { margin: 1.2em 0; padding-left: 16px; border-left: 3px solid #e6e3dd; color: #66635d; }
code { font: 0.85em ui-monospace, 'SF Mono', Menlo, Consolas, monospace; background: #f1efea; padding: 0.1em 0.3em; border-radius: 3px; }
pre { background: #f1efea; padding: 14px 16px; border-radius: 6px; overflow-x: auto; line-height: 1.5; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; font-size: 0.9em; }
th, td { border-bottom: 1px solid #e6e3dd; padding: 6px 12px; text-align: left; }
hr { border: 0; border-top: 1px solid #e6e3dd; margin: 2em 0; }
.diagram { text-align: center; margin: 1.5em 0; }
.hljs-keyword, .hljs-built_in, .hljs-type { color: #8a3f82; }
.hljs-string, .hljs-attr { color: #226138; }
.hljs-comment { color: #66635d; font-style: italic; }
.hljs-number, .hljs-literal { color: #8f4c14; }
.hljs-title, .hljs-function { color: #3b6ea5; }
`

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/**
 * Standalone HTML + assets. The body arrives already rendered and sanitised by the client (the
 * editor's own pipeline, diagrams as inline SVG), so the page needs no script, no CDN and no
 * server: it opens from disk, offline.
 */
export function htmlZip(
  bundleDir: string,
  slug: string,
  title: string,
  bodyHtml: string,
): Uint8Array {
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<main>
${bodyHtml}
</main>
</body>
</html>
`
  const { 'index.md': _markdown, ...assets } = readBundle(bundleDir)
  return zipSync(
    under(slug, {
      'index.html': strToU8(page),
      'style.css': strToU8(EXPORT_STYLESHEET),
      ...assets,
    }),
    { level: 6 },
  )
}
