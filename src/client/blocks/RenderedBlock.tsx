import { memo, useEffect, useMemo, useRef } from 'react'
import { type RenderEnv, renderMarkdown, renderMermaidIn } from '../render/markdown.ts'
import { useApp } from '../state/app.ts'

function currentMermaidTheme(): 'default' | 'dark' {
  const forced = document.documentElement.dataset.theme
  const dark =
    forced === 'dark' ||
    (forced !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  return dark ? 'dark' : 'default'
}

type Props = { raw: string; assetBase: string | null; className?: string; testId?: string }

/** Rendered markdown for one block. Memoised on `raw`, so typing elsewhere re-renders nothing. */
export const RenderedBlock = memo(function RenderedBlock({
  raw,
  assetBase,
  className,
  testId,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => {
    const env: RenderEnv =
      assetBase === null
        ? {}
        : { resolveImage: (src) => assetBase + src.split('/').map(encodeURIComponent).join('/') }
    return renderMarkdown(raw, env)
  }, [raw, assetBase])

  // A diagram is baked with the theme it was rendered in: when the theme changes, start again
  // from the sanitised HTML (which resets the "already rendered" marks) and render it anew.
  const themeEpoch = useApp((state) => state.themeEpoch)
  const renderedEpoch = useRef(themeEpoch)
  useEffect(() => {
    if (ref.current === null) return
    if (renderedEpoch.current !== themeEpoch) {
      renderedEpoch.current = themeEpoch
      ref.current.innerHTML = html
    }
    void renderMermaidIn(ref.current, currentMermaidTheme())
  }, [html, themeEpoch])

  return (
    <div
      ref={ref}
      className={`rendered ${className ?? ''}`}
      data-testid={testId ?? 'rendered'}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised by DOMPurify in renderMarkdown
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})
