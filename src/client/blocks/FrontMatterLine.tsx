import { summariseFrontMatter } from '../../shared/blocks/front-matter.ts'

/** Front matter collapsed to a quiet title · date · tags line. Clicking it edits the raw text. */
export function FrontMatterLine({ raw }: { raw: string }) {
  const { title, date, tags } = summariseFrontMatter(raw)
  const parts = [
    title,
    date,
    tags.length > 0 ? tags.map((tag) => `#${tag}`).join(' ') : undefined,
  ].filter((part): part is string => part !== undefined && part !== '')
  return (
    <div className="front-matter" data-testid="front-matter">
      {parts.length > 0 ? parts.join(' · ') : 'front matter'}
    </div>
  )
}
