import { diffWordsWithSpace } from 'diff'
import { useMemo } from 'react'

/**
 * Inline word diff of markdown source: what `proposed` changes in `current`. A ghost diff shows a
 * job's proposal against the block's current text; a conflict shows the writer's version against
 * the file's.
 */
export function SourceDiff({ current, proposed }: { current: string; proposed: string }) {
  const parts = useMemo(() => diffWordsWithSpace(current, proposed), [current, proposed])
  return (
    <div className="ghost-diff">
      {parts.map((part, index) => {
        const Tag = part.added ? 'ins' : part.removed ? 'del' : 'span'
        // biome-ignore lint/suspicious/noArrayIndexKey: diff parts are positional
        return <Tag key={index}>{part.value}</Tag>
      })}
    </div>
  )
}
