import type { AdapterConfig } from '../../shared/config-schema.ts'
import type { FailureReason } from '../../shared/jobs/job-types.ts'

export type ProgressEvent = { text: string }

export type Completion =
  | { ok: true }
  | { ok: false; reason: FailureReason; message: string; output?: string }

export type AdapterOptions = {
  /** The agent's working directory, so it can read `sources/` freely. */
  workspace: string
  jobId: string
  /** What the agent is told on stdin. The real instructions are files in the job directory. */
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
