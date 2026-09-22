import type { HtmlExportRequest, MarkdownExportRequest } from '../shared/api-types.ts'
import { workspaceHeaders } from './api.ts'
import { registerCommands } from './palette/commands.ts'
import { inGroup } from './palette/group.ts'
import { renderForExport } from './render/export-html.ts'
import { currentDoc, dispatch, flush, store } from './state/app.ts'

async function download(
  url: string,
  body: MarkdownExportRequest | HtmlExportRequest,
  fallbackName: string,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...workspaceHeaders() },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`export failed (${response.status})`)
  const name =
    response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName
  const link = document.createElement('a')
  link.href = URL.createObjectURL(await response.blob())
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}

async function exportArticle(kind: 'markdown' | 'html'): Promise<void> {
  const state = currentDoc(store.get())
  if (state === null || state.ref.kind !== 'article' || state.status !== 'ready') return
  const { slug } = state.ref
  try {
    // What is exported is what is on disk: commit the open editor and save first.
    dispatch({ type: 'blur' })
    await flush(state.ref)
    if (kind === 'markdown') {
      await download('/api/export/markdown', { slug }, `${slug}-markdown.zip`)
      return
    }
    const fresh = currentDoc(store.get())
    if (fresh === null) return
    const { title, html } = await renderForExport(fresh)
    await download('/api/export/html', { slug, title, html }, `${slug}-html.zip`)
  } catch (error) {
    dispatch({
      type: 'notice',
      notice: error instanceof Error ? error.message : 'The export failed.',
    })
  }
}

registerCommands((state) => {
  const doc = currentDoc(state)
  if (doc === null || doc.ref.kind !== 'article' || doc.status !== 'ready') return []
  return inGroup('export', [
    {
      id: 'export-markdown',
      title: 'Export: markdown + assets (zip)',
      hint: 'the bundle as is',
      run: () => exportArticle('markdown'),
    },
    {
      id: 'export-html',
      title: 'Export: standalone HTML + assets (zip)',
      hint: 'diagrams rendered',
      run: () => exportArticle('html'),
    },
  ])
})
