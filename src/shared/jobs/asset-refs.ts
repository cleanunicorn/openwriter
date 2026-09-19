const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Patterns that hold a path as a whole value: link/image destinations and quoted values. */
function patternsFor(path: string): RegExp[] {
  const p = escapeRegExp(path)
  return [
    new RegExp(`(\\]\\(\\s*<?)${p}(>?(?:\\s+(?:"[^"]*"|'[^']*'|\\([^)]*\\)))?\\s*\\))`, 'g'),
    new RegExp(`(=\\s*["'])${p}(["'])`, 'g'),
    new RegExp(`(\\{\\{[<%][^}]*?\\s["'])${p}(["'])`, 'g'),
  ]
}

/** Job asset files (`assets/x.png`) that `markdown` really references. */
export function referencedAssets(markdown: string, files: string[]): string[] {
  return files.filter((file) => patternsFor(file).some((pattern) => pattern.test(markdown)))
}

/**
 * Rewrite references to accepted assets to their final bundle-relative paths. Only exact
 * destination spans are touched — never a global substring replace, which could corrupt prose
 * or a longer path that merely contains the same characters.
 */
export function rewriteAssetRefs(markdown: string, map: Record<string, string>): string {
  let result = markdown
  for (const [from, to] of Object.entries(map)) {
    for (const pattern of patternsFor(from)) result = result.replace(pattern, `$1${to}$2`)
  }
  return result
}
