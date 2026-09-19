// A stand-in agent process for spawn tests: no test needs a real agent CLI.
// Usage: node echo-agent.ts <mode> [pid-file]
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [mode = 'ok', pidFile] = process.argv.slice(2)

let prompt = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) prompt += chunk

const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`)

if (mode === 'ok') {
  emit({ type: 'started', prompt })
  // One JSON line split across two writes: the reader must reassemble it.
  process.stdout.write('{"type":"mes')
  await new Promise((resolve) => setTimeout(resolve, 20))
  process.stdout.write('sage","text":"split line"}\n')
  emit({ type: 'done' })
  process.exit(0)
}
if (mode === 'exit') {
  process.stderr.write('fatal: something went wrong\n')
  process.exit(3)
}
if (mode === 'silent-exit') {
  process.exit(2)
}
if (mode === 'flood') {
  const line = `${'x'.repeat(1023)}\n`
  for (let i = 0; i < 4096; i++) process.stdout.write(line)
  // No process.exit here: it would drop output that is still buffered in the pipe.
}
if (mode === 'grandchild') {
  // Like a real agent CLI: a child process of its own that ignores SIGTERM politely.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  if (pidFile !== undefined) writeFileSync(pidFile, `${process.pid}\n${child.pid}\n`)
  emit({ type: 'started' })
  setInterval(() => {}, 1000)
}
if (mode === 'hang') {
  emit({ type: 'started' })
  setInterval(() => {}, 1000)
}
if (mode === 'stubborn') {
  // Ignores SIGTERM, like an agent busy in a tool call: only SIGKILL stops it.
  process.on('SIGTERM', () => {})
  if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid))
  emit({ type: 'started' })
  setInterval(() => {}, 1000)
}
