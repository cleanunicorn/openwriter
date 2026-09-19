import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Article, DocRef } from '../shared/api-types.ts'
import { summariseFrontMatter } from '../shared/blocks/front-matter.ts'
import { splitText } from '../shared/blocks/split.ts'
import { isSlug } from '../shared/names.ts'
import { loadConfig } from './config.ts'
import { assertSlug, resolveWithin } from './paths.ts'

export class UndecodableError extends Error {}
export class ConflictError extends Error {
  readonly current: { text: string; hash: string | null; exists: boolean }
  constructor(current: { text: string; hash: string | null; exists: boolean }) {
    super('document changed on disk')
    this.current = current
  }
}

export const hashText = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Decode strictly: a file that is not UTF-8 is refused, never silently repaired and rewritten. */
function readUtf8(file: string): string {
  try {
    return decoder.decode(readFileSync(file))
  } catch (error) {
    if (error instanceof TypeError)
      throw new UndecodableError(`${path.basename(file)} is not valid UTF-8`)
    throw error
  }
}

export type DocOnDisk = { text: string; hash: string | null; exists: boolean }

/** Owns every filesystem path of the workspace. Routes never build paths themselves. */
export class Workspace {
  readonly root: string
  constructor(root: string) {
    this.root = root
  }

  config() {
    return loadConfig(this.root)
  }

  /**
   * The content root: relative → inside the workspace; absolute → its own guarded root, so
   * `contentDir` can point straight into a Hugo site. Every article path resolves against it.
   */
  contentRoot(): string {
    const { contentDir } = this.config().config
    return path.isAbsolute(contentDir) ? contentDir : resolveWithin(this.root, contentDir)
  }

  /**
   * Why a `contentDir` cannot be used, or null. A relative value must stay inside the workspace
   * (`../site/content` is refused; an absolute path is the supported way to point outside).
   */
  static contentDirProblem(root: string, contentDir: string): string | null {
    if (path.isAbsolute(contentDir)) return null
    try {
      resolveWithin(root, contentDir)
      return null
    } catch (error) {
      return `contentDir "${contentDir}" leaves the workspace; use an absolute path to point outside it (${(error as Error).message})`
    }
  }

  contentDirProblem(): string | null {
    return Workspace.contentDirProblem(this.root, this.config().config.contentDir)
  }

  contentOutsideWorkspace(): boolean {
    const relative = path.relative(this.root, this.contentRoot())
    return relative.startsWith('..') || path.isAbsolute(relative)
  }

  bundleDir(slug: string): string {
    return resolveWithin(this.contentRoot(), 'posts', assertSlug(slug))
  }

  briefPath(slug: string): string {
    return resolveWithin(this.root, '.zen', 'articles', assertSlug(slug), 'brief.md')
  }

  strategyPath(): string {
    return resolveWithin(this.root, 'strategy.md')
  }

  jobsDir(): string {
    return resolveWithin(this.root, '.zen', 'jobs')
  }

  docPath(ref: DocRef): string {
    if (ref.kind === 'strategy') return this.strategyPath()
    if (ref.kind === 'brief') return this.briefPath(ref.slug)
    return path.join(this.bundleDir(ref.slug), 'index.md')
  }

  readDoc(ref: DocRef): DocOnDisk {
    const file = this.docPath(ref)
    if (!existsSync(file)) return { text: '', hash: null, exists: false }
    const text = readUtf8(file)
    return { text, hash: hashText(text), exists: true }
  }

  /**
   * The one write path for documents: compare with the disk base, write a temp file in the same
   * directory, rename. A stale base (or a file deleted from outside) is a conflict, never a
   * silent overwrite or re-creation.
   */
  writeDoc(ref: DocRef, text: string, baseHash: string | null): string {
    const file = this.docPath(ref)
    const current = this.readDoc(ref)
    if (current.hash !== baseHash) throw new ConflictError(current)
    mkdirSync(path.dirname(file), { recursive: true })
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
    writeFileSync(temp, text)
    renameSync(temp, file)
    return hashText(text)
  }

  listArticles(): Article[] {
    // A content directory that cannot be used lists nothing; /api/config says why.
    if (this.contentDirProblem() !== null) return []
    const posts = path.join(this.contentRoot(), 'posts')
    if (!existsSync(posts)) return []
    const articles: Article[] = []
    for (const entry of readdirSync(posts, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isSlug(entry.name)) continue
      const index = path.join(posts, entry.name, 'index.md')
      if (!existsSync(index) || !statSync(index).isFile()) continue
      let title = entry.name
      try {
        const first = splitText(readUtf8(index)).slices[0]
        if (first?.kind === 'frontmatter') title = summariseFrontMatter(first.raw).title ?? title
      } catch {
        // An unreadable article is still listed by its slug.
      }
      articles.push({ slug: entry.name, title })
    }
    return articles.sort((a, b) => a.slug.localeCompare(b.slug))
  }

  createArticle(title: string, today = new Date()): Article {
    const base =
      title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'untitled'
    let slug = base
    for (let n = 2; existsSync(this.bundleDir(slug)); n++) slug = `${base}-${n}`
    const dir = this.bundleDir(slug)
    mkdirSync(dir, { recursive: true })
    const date = today.toISOString().slice(0, 10)
    const safeTitle = title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    writeFileSync(
      path.join(dir, 'index.md'),
      `---\ntitle: "${safeTitle}"\ndate: ${date}\ndraft: true\n---\n\n# ${title}\n`,
    )
    const brief = this.briefPath(slug)
    mkdirSync(path.dirname(brief), { recursive: true })
    if (!existsSync(brief)) writeFileSync(brief, '')
    return { slug, title }
  }
}
