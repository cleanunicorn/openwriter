import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createChannel } from './channel.ts'
import type { AdapterHandle, AgentAdapter, Completion } from './types.ts'

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

type Targets = { scope: string; blockIds: string[] }
type ArticleBlock = { id: string; raw: string }

/** Read the snapshot the way a real agent would: from the marker comments in article.md. */
function readBlocks(jobDir: string): ArticleBlock[] {
  const article = readFileSync(path.join(jobDir, 'article.md'), 'utf8')
  const blocks: ArticleBlock[] = []
  const pattern = /<!-- zen:block id=(b\d+)[^>]*-->\n([\s\S]*?)\n<!-- \/zen:block -->/g
  for (const match of article.matchAll(pattern))
    blocks.push({ id: match[1] ?? '', raw: match[2] ?? '' })
  return blocks
}

/**
 * Test-controlled checkpoints. With `--fake-control` every fake job stops before it writes its
 * result until a test releases it, so e2e timing is driven by the test and never by sleeps.
 */
export class FakeGate {
  private readonly waiting = new Map<string, () => void>()
  readonly enabled: boolean
  constructor(enabled: boolean) {
    this.enabled = enabled
  }

  wait(jobId: string, signal: AbortSignal): Promise<void> {
    if (!this.enabled) return new Promise((resolve) => setTimeout(resolve, 600))
    return new Promise((resolve) => {
      this.waiting.set(jobId, resolve)
      signal.addEventListener('abort', () => {
        this.waiting.delete(jobId)
        resolve()
      })
    })
  }

  waitingIds(): string[] {
    return [...this.waiting.keys()]
  }

  /** Release one job, or every waiting job when no ID is given. */
  release(jobId?: string): string[] {
    const ids = jobId === undefined ? this.waitingIds() : this.waiting.has(jobId) ? [jobId] : []
    for (const id of ids) {
      this.waiting.get(id)?.()
      this.waiting.delete(id)
    }
    return ids
  }
}

/**
 * The deterministic stand-in for every agent. It honours the same file contract as a real one:
 * it reads `instruction.md`, `article.md` and `targets.json` and writes `result.json`. The
 * scenario is a `fake:<name>` token in the writer's instruction (default `upper`).
 */
export function createFakeAdapter(gate: FakeGate): AgentAdapter {
  return {
    name: 'fake',
    start(jobDir, options): AdapterHandle {
      const channel = createChannel<{ text: string }>()
      const abort = new AbortController()
      const isRepair = options.prompt.includes('repair.md')

      const run = async (): Promise<Completion> => {
        const instruction = readFileSync(path.join(jobDir, 'instruction.md'), 'utf8')
        const scenario = instruction.match(/fake:([a-z-]+)/)?.[1] ?? 'upper'
        const targets = JSON.parse(
          readFileSync(path.join(jobDir, 'targets.json'), 'utf8'),
        ) as Targets
        const blocks = readBlocks(jobDir)
        const byId = new Map(blocks.map((block) => [block.id, block.raw]))
        const first = targets.blockIds[0] ?? 'b0'
        channel.push({ text: `fake agent: scenario "${scenario}"${isRepair ? ' (repair)' : ''}` })
        channel.push({ text: `read ${blocks.length} blocks, ${targets.blockIds.length} targets` })

        await gate.wait(options.jobId, abort.signal)
        if (abort.signal.aborted) return { ok: false, reason: 'exit', message: 'cancelled' }
        if (scenario === 'hang')
          await new Promise((resolve) => abort.signal.addEventListener('abort', resolve))
        if (scenario === 'fail')
          return {
            ok: false,
            reason: 'exit',
            message: 'the fake agent exited with code 1',
            output: 'boom',
          }
        if (scenario === 'auth')
          return {
            ok: false,
            reason: 'auth',
            message: 'not logged in — run the agent CLI once to sign in',
          }

        const upper = targets.blockIds.map((id) => ({
          op: 'replace',
          block_id: id,
          markdown: (byId.get(id) ?? '').toUpperCase(),
        }))
        const results: Record<string, unknown> = {
          upper: { summary: 'Upper-cased the target blocks.', ops: upper, assets: [], notes: '' },
          insert: {
            summary: 'Inserted a paragraph.',
            ops: [{ op: 'insert_after', block_id: first, markdown: 'Inserted by the fake agent.' }],
          },
          delete: { summary: 'Deleted the block.', ops: [{ op: 'delete', block_id: first }] },
          multi: {
            summary: 'Rewrote, inserted two paragraphs, and deleted one.',
            ops: [
              { op: 'replace', block_id: first, markdown: `${byId.get(first) ?? ''} (tightened)` },
              { op: 'insert_after', block_id: first, markdown: 'First insert.' },
              {
                op: 'insert_after',
                block_id: first,
                markdown: 'Second insert.\n\nWith a second block.',
              },
              ...(targets.blockIds[1] ? [{ op: 'delete', block_id: targets.blockIds[1] }] : []),
            ],
          },
          asset: {
            summary: 'Added a diagram image.',
            ops: [
              {
                op: 'insert_after',
                block_id: first,
                markdown: '![Fake diagram](assets/fake-diagram.png)',
              },
            ],
            assets: [{ file: 'assets/fake-diagram.png', alt: 'Fake diagram' }],
          },
          diagram: {
            summary: 'Added a mermaid diagram.',
            ops: [
              {
                op: 'insert_after',
                block_id: first,
                markdown: '```mermaid\ngraph TD\n  Idea --> Draft\n  Draft --> Post\n```',
              },
            ],
          },
          research: {
            summary: 'Answered the question.',
            ops: [],
            notes: '## Findings\n\nThe notes say blocks feel calm.\n\n- Source: `sources/notes.md`',
          },
          draft: {
            summary: 'Drafted the document.',
            ops: [
              {
                op: 'insert_after',
                block_id: first,
                markdown: '# Draft\n\nDrafted by the fake agent from the context files.',
              },
            ],
          },
          'out-of-scope': {
            summary: 'Touched a block it was not given.',
            ops: [
              {
                op: 'delete',
                block_id:
                  blocks.find((block) => !targets.blockIds.includes(block.id))?.id ?? 'b999',
              },
            ],
          },
        }

        channel.push({ text: 'writing result.json' })
        const invalid = scenario === 'invalid-twice' || (scenario === 'invalid-once' && !isRepair)
        if (scenario === 'asset') {
          mkdirSync(path.join(jobDir, 'assets'), { recursive: true })
          writeFileSync(path.join(jobDir, 'assets', 'fake-diagram.png'), PIXEL)
        }
        const body = invalid
          ? '{ "summary": "not quite json", "ops": [ { "op": "rewrite" '
          : JSON.stringify(results[scenario] ?? results.upper, null, 2)
        writeFileSync(path.join(jobDir, 'result.json'), body)
        return { ok: true }
      }

      const done = run()
        .catch(
          (error: unknown): Completion => ({ ok: false, reason: 'exit', message: String(error) }),
        )
        .finally(() => channel.close())
      return {
        progress: channel.iterable,
        done,
        cancel: async () => {
          abort.abort()
          await done
        },
      }
    },
  }
}
