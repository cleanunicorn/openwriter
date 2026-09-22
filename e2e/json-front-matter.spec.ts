import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { type App, expect, test } from './fixtures.ts'
import { editor, expectFile, openArticle } from './helpers.ts'

// Hugo's JSON front matter, with a brace and an escaped quote inside strings.
const jsonFrontMatter = `{
  "title": "Hello, JSON",
  "date": "2026-09-22T08:00:00Z",
  "tags": ["json", "hugo"],
  "params": { "note": "a } brace and a \\" quote" }
}`

/** The sample article with its YAML front matter swapped for JSON; returns the new text. */
function useJsonFrontMatter(app: App): string {
  const text = app.readArticle().replace(/^---\n[\s\S]*?\n---/, jsonFrontMatter)
  expect(text.startsWith(`${jsonFrontMatter}\n\n# Hello, openwrite`)).toBe(true)
  writeFileSync(app.articlePath(), text)
  return text
}

test('JSON front matter is a quiet line that edits as raw text', async ({ page, app }) => {
  useJsonFrontMatter(app)
  await openArticle(page)
  const line = page.getByTestId('front-matter')
  await expect(line).toHaveText('Hello, JSON · 2026-09-22 · #json #hugo')
  await line.click()
  await expect(editor(page)).toContainText('"title": "Hello, JSON"')
  await expect(editor(page)).toContainText('"params": { "note": "a } brace and a \\" quote" }')
})

test('JSON front matter has no drag handle', async ({ page, app }) => {
  useJsonFrontMatter(app)
  await openArticle(page)
  const frontMatter = page.locator('[data-testid="block"][data-kind="frontmatter"]')
  await expect(frontMatter).toHaveCount(1)
  await frontMatter.hover()
  await expect(frontMatter.getByTestId('drag-handle')).toHaveCount(0)
})

test('an article with JSON front matter is never written when untouched', async ({ page, app }) => {
  const text = useJsonFrontMatter(app)
  const mtime = statSync(app.articlePath()).mtimeMs
  await openArticle(page)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('Escape')
  await expect(editor(page)).toHaveCount(0)
  await expect(() => expect(statSync(app.articlePath()).mtimeMs).toBe(mtime)).toPass()
  expect(readFileSync(app.articlePath(), 'utf8')).toBe(text)
})

test('editing the block under JSON front matter leaves it byte for byte', async ({ page, app }) => {
  const text = useJsonFrontMatter(app)
  await openArticle(page)
  await page.getByRole('heading', { name: 'Hello, openwrite', level: 1 }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' (edited)')
  await page.keyboard.press('Escape')

  await expectFile(app.articlePath(), (file) =>
    expect(file).toContain(`${jsonFrontMatter}\n\n# Hello, openwrite (edited)\n`),
  )
  expect(app.readArticle().replace(' (edited)', '')).toBe(text)
  await expect(page.getByTestId('front-matter')).toHaveText(
    'Hello, JSON · 2026-09-22 · #json #hugo',
  )
})
