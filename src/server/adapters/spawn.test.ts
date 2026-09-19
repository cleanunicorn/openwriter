import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { spawnAgent } from './spawn.ts'

const fixture = path.join(import.meta.dirname, 'fixtures', 'echo-agent.ts')
const temp = mkdtempSync(path.join(os.tmpdir(), 'openwrite-spawn-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const run = (mode: string, extra: string[] = []) => {
  const lines: string[] = []
  const agent = spawnAgent({
    command: process.execPath,
    args: [fixture, mode, ...extra],
    cwd: temp,
    stdin: 'Read instruction.md and follow it.',
    onLine: (line) => lines.push(line),
  })
  return { agent, lines }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('spawnAgent', () => {
  it('passes the prompt on stdin and reassembles lines split across chunks', async () => {
    const { agent, lines } = run('ok')
    const outcome = await agent.done
    expect(outcome).toMatchObject({ status: 'exited', code: 0 })
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { type: 'started', prompt: 'Read instruction.md and follow it.' },
      { type: 'message', text: 'split line' },
      { type: 'done' },
    ])
  })

  it('reports a non-zero exit with the stderr tail', async () => {
    const outcome = await run('exit').agent.done
    expect(outcome).toMatchObject({ status: 'exited', code: 3 })
    expect(outcome.stderrTail).toContain('something went wrong')
  })

  it('reports a missing executable instead of throwing', async () => {
    const agent = spawnAgent({
      command: 'openwrite-no-such-agent-cli',
      args: [],
      cwd: temp,
      stdin: '',
      onLine: () => {},
    })
    expect((await agent.done).status).toBe('missing')
  })

  it('never runs through a shell: metacharacters stay literal arguments', async () => {
    const marker = path.join(temp, 'pwned')
    const { agent } = run('ok', [`; touch ${marker}`, '$(touch x)'])
    await agent.done
    expect(() => readFileSync(marker)).toThrow()
  })

  it('keeps only a bounded tail of a flood of output', async () => {
    const { agent, lines } = run('flood')
    const outcome = await agent.done
    expect(lines).toHaveLength(4096)
    expect(outcome.stdoutTail.length).toBeLessThanOrEqual(64 * 1024)
  })

  it('cancel stops the whole process tree and is idempotent', async () => {
    const pidFile = path.join(temp, 'pids')
    const { agent } = run('grandchild', [pidFile])
    await expect
      .poll(
        () => {
          try {
            return readFileSync(pidFile, 'utf8').trim().split('\n').length
          } catch {
            return 0
          }
        },
        { timeout: 5000 },
      )
      .toBe(2)
    const [parent, grandchild] = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number) as [
      number,
      number,
    ]
    expect(alive(parent) && alive(grandchild)).toBe(true)

    await Promise.all([agent.cancel(), agent.cancel()])
    expect((await agent.done).status).toBe('cancelled')
    await expect.poll(() => alive(parent) || alive(grandchild), { timeout: 5000 }).toBe(false)
  })
})
