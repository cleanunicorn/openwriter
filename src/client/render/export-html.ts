import { serialise, summariseFrontMatter } from '../../shared/blocks/index.ts'
import type { DocState } from '../state/doc-reducer.ts'
import { liveDoc } from '../state/doc-reducer.ts'
import { renderMarkdown, renderMermaidIn } from './markdown.ts'

export class ExportError extends Error {}

/**
 * Render the article with the editor's own pipeline (sanitised, highlighted) in export mode and
 * turn every mermaid fence into inline SVG, so the exported page needs no script and no network.
 * Relative asset paths stay relative: the assets travel in the same zip.
 */
export async function renderForExport(state: DocState): Promise<{ title: string; html: string }> {
  const doc = liveDoc(state)
  const first = doc.blocks[0]
  const hasFrontMatter = first?.kind === 'frontmatter'
  const body = hasFrontMatter ? { blocks: doc.blocks.slice(1), gaps: doc.gaps.slice(1) } : doc
  const title =
    (hasFrontMatter ? summariseFrontMatter(first.raw).title : undefined) ??
    (state.ref.kind === 'article' ? state.ref.slug : 'Article')

  const stage = document.createElement('div')
  stage.style.cssText = 'position:absolute;left:-10000px;top:0;width:680px'
  stage.innerHTML = renderMarkdown(serialise(body), { exportMode: true })
  document.body.append(stage)
  try {
    await renderMermaidIn(stage, 'default')
    const failed = stage.querySelector('.mermaid-block[data-rendered="error"] .mermaid-error')
    if (failed !== null) {
      // A page that silently lacks a diagram is not a finished export.
      throw new ExportError(
        `A diagram could not be rendered, so nothing was exported. ${failed.textContent ?? ''}`,
      )
    }
    for (const block of stage.querySelectorAll<HTMLElement>('.mermaid-block')) {
      block.querySelector('pre')?.remove()
      block.className = 'diagram'
      block.removeAttribute('data-rendered')
    }
    for (const element of stage.querySelectorAll('[data-line]')) {
      element.removeAttribute('data-line')
      element.removeAttribute('data-line-end')
    }
    return { title, html: stage.innerHTML }
  } finally {
    stage.remove()
  }
}
