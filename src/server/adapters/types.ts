import type { AdapterConfig } from '../../shared/config-schema.ts'
import type { FailureReason } from '../../shared/jobs/job-types.ts'

export type ProgressEvent = { text: string }

export type Completion =
  | { ok: true }
  | { ok: false; reason: FailureReason; message: string; output?: string }

export type AdapterOptions = {
  /**
   * The workspace root, which the agent may read (`sources/`). claude and the herdr pane run with
   * it as their working directory; codex re-roots itself to the job directory.
   */
  workspace: string
  jobId: string
  /**
   * What the agent is told to do: the process adapters send it on stdin, herdr passes it to
   * `agent prompt`. The real instructions are files in the job directory.
   */
  prompt: string
  /** The writer's overrides for this adapter from `.zen/config.json`. */
  config: AdapterConfig
  /** Extra allowances a skill declared (`allow:` header), mapped by each adapter as it can. */
  allow: string[]
  network: boolean
}

export type AdapterHandle = {
  progress: AsyncIterable<ProgressEvent>
  done: Promise<Completion>
  /**
   * Idempotent. Stops the whole process tree; never erases output already written. `force` skips
   * any grace period: the server is shutting down and must not leave a paid agent running.
   */
  cancel: (options?: { force?: boolean }) => Promise<void>
}

/**
 * An adapter only launches a process and relays progress; the file contract does the rest.
 * Result parsing, validation, repair, timeouts, and scheduling belong to the job manager.
 */
export type AgentAdapter = {
  readonly name: string
  start: (jobDir: string, options: AdapterOptions) => AdapterHandle
}
