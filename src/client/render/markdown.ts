import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import MarkdownIt from 'markdown-it'

// A fixed language list keeps the bundle small; anything else renders as plain code.
const languages = {
  bash,
  css,
  diff,
  go,
  ini,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
}
for (const [name, language] of Object.entries(languages)) hljs.registerLanguage(name, language)
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' })
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['html', 'svg', 'go-html-template'], { languageName: 'xml' })
hljs.registerAliases(['toml'], { languageName: 'ini' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['py'], { languageName: 'python' })

export type RenderEnv = {
  /** Maps a relative image path to a URL the browser can load. Render time only. */
  resolveImage?: (src: string) => string
  /** Export mode: `figure` shortcodes become <figure>, other shortcode tags are dropped. */
  exportMode?: boolean
}

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const md = new MarkdownIt({
  html: true,
  linkify: false,
  highlight: (code, language) => {
    if (language !== '' && hljs.getLanguage(language) !== undefined) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    }
    return ''
  },
})

// Source lines on block-level tokens, so a click can be mapped back to the markdown.
md.core.ruler.push('source_lines', (state) => {
  for (const token of state.tokens) {
    if (token.map === null || token.type === 'inline' || token.nesting === -1) continue
    token.attrSet('data-line', String(token.map[0]))
    token.attrSet('data-line-end', String(token.map[1]))
  }
})

const SHORTCODE = /\{\{[<%][\s\S]*?[>%]\}\}/g
const attribute = (tag: string, name: string) =>
  tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`))?.[1] ?? ''

/** What a shortcode renders as: a quiet chip in the editor; on export a <figure>, or nothing. */
function shortcodeHtml(tag: string, env: RenderEnv): string {
  if (!env.exportMode) return `<span class="shortcode">${escapeHtml(tag)}</span>`
  if (!/^\{\{[<%]\s*figure\b/.test(tag)) return ''
  const src = attribute(tag, 'src')
  const caption = attribute(tag, 'caption') || attribute(tag, 'title')
  return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(attribute(tag, 'alt') || caption)}">${
    caption === '' ? '' : `<figcaption>${escapeHtml(caption)}</figcaption>`
  }</figure>`
}

// Hugo shortcodes are shown as quiet chips in the editor; Hugo itself is the true preview.
md.core.ruler.push('shortcodes', (state) => {
  const env = state.env as RenderEnv
  const token = (type: 'text' | 'html_inline', content: string) => {
    const made = new state.Token(type, '', 0)
    made.content = content
    return made
  }
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline' || blockToken.children === null) continue
    const children: typeof blockToken.children = []
    for (const child of blockToken.children) {
      if (child.type !== 'text' || !child.content.includes('{{')) {
        children.push(child)
        continue
      }
      let last = 0
      for (const match of child.content.matchAll(SHORTCODE)) {
        const before = child.content.slice(last, match.index)
        if (before !== '') children.push(token('text', before))
        const tag = match[0]
        children.push(token('html_inline', shortcodeHtml(tag, env)))
        last = match.index + tag.length
      }
      const rest = child.content.slice(last)
      if (rest !== '') children.push(token('text', rest))
    }
    blockToken.children = children
  }
})

const defaultFence = md.renderer.rules.fence
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index]
  if (token !== undefined && token.info.trim().split(/\s+/)[0] === 'mermaid') {
    const lines = `data-line="${token.map?.[0] ?? 0}" data-line-end="${token.map?.[1] ?? 0}"`
    // The source travels as text: DOMPurify drops attribute values that contain `-->`.
    return `<div class="mermaid-block" data-testid="diagram" ${lines}><pre>${escapeHtml(token.content)}</pre></div>\n`
  }
  return defaultFence?.(tokens, index, options, env, self) ?? ''
}

const isRelative = (src: string) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src)

const defaultImage = md.renderer.rules.image
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]
  const src = String(token?.attrGet('src') ?? '')
  const resolveImage = (env as RenderEnv | undefined)?.resolveImage
  if (token !== undefined && resolveImage !== undefined && isRelative(src)) {
    token.attrSet('src', resolveImage(src))
  }
  return defaultImage?.(tokens, index, options, env, self) ?? ''
}

/**
 * Markdown → sanitised HTML. Article text and agent output are both untrusted input, so the one
 * render path always ends in DOMPurify; ghost previews and the HTML export reuse it.
 */
export function renderMarkdown(source: string, env: RenderEnv = {}): string {
  return DOMPurify.sanitize(md.render(source, env), {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  })
}

let mermaidCounter = 0

/** Render every mermaid placeholder under `root`. mermaid is loaded only when one exists. */
export async function renderMermaidIn(root: HTMLElement, theme: 'default' | 'dark'): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('.mermaid-block:not([data-rendered])')]
  if (nodes.length === 0) return
  const { default: mermaid } = await import('mermaid')
  // SVG text labels, not HTML-in-foreignObject: they survive sanitising and standalone export.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  })
  for (const node of nodes) {
    const source = node.querySelector('pre')?.textContent ?? ''
    node.dataset.rendered = 'true'
    const id = `mermaid-${mermaidCounter++}`
    try {
      // parse() first: render() on bad input leaves an error graphic in the page.
      await mermaid.parse(source)
      const { svg } = await mermaid.render(id, source)
      node.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true, html: true },
        ADD_TAGS: ['foreignObject'],
      })
      node.dataset.rendered = 'ok'
    } catch (error) {
      // A bad diagram never loses content: show the source and the reason.
      node.dataset.rendered = 'error'
      document.getElementById(`d${id}`)?.remove()
      const note = document.createElement('p')
      note.className = 'mermaid-error'
      note.textContent = `Diagram error: ${error instanceof Error ? error.message : String(error)}`
      node.append(note)
    }
  }
}
