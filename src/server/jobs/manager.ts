import path from 'node:path'
import { DEFAULT_CONFIG } from '../../shared/config-schema.ts'
import { referencedAssets } from '../../shared/jobs/asset-refs.ts'
import {
  type FailureReason,
  isUnsettled,
  type Job,
  type JobRequest,
  type JobState,
} from '../../shared/jobs/job-types.ts'
import { type Result, ResultSchema } from '../../shared/jobs/result-schema.ts'
import { START_ANCHOR, validateOps } from '../../shared/jobs/validate-ops.ts'
import type { AdapterRegistry } from '../adapters/registry.ts'
import type { AdapterHandle } from '../adapters/types.ts'
import { sanitiseFileName, storeWithoutOverwrite } from '../assets.ts'
import { HttpError } from '../http.ts'
import { resolveWithin } from '../paths.ts'
import { findSkill, missingTools, type Skill, type ToolLookup } from '../skills.ts'
import type { EventHub } from '../sse.ts'
import type { Workspace } from '../workspace.ts'
import { renderRepair, writeJobFiles } from './job-files.ts'
import {
  appendJobText,
  readJobAsset,
  readJobText,
  readJobTextOrNull,
  UnsafeJobFileError,
  writeJobText,
} from './job-io.ts'
import { type JobFile, recoverJobs, saveJobFile } from './store.ts'

const PROGRESS_TAIL = 40
const PROGRESS_LOG_LIMIT = 512 * 1024

export type ManagerOptions = {
  workspace: Workspace
  events: EventHub
  registry: AdapterRegistry
  adapterOverride?: string
  toolLookup?: ToolLookup
  skillsDir?: string
}

type Entry = {
  file: JobFile
  request?: JobRequest
  skill?: Skill
  handle?: AdapterHandle
  logBytes: number
}

function newJobId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const random = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `${stamp.slice(0, 8)}-${stamp.slice(8)}-${random}`
}

/**
 * Owns the job lifecycle on the server: contract files, the global concurrency limit (a FIFO
 * queue for process slots), result validation with one repair attempt, cancel, timeouts, review
 * decisions with asset promotion, and restart recovery. Block-level queueing lives in the client,
 * which is the only place that knows the live document and whether a job was settled.
 */
export class JobManager {
  private readonly entries = new Map<string, Entry>()
  private readonly waiting: string[] = []
  private running = 0
  private readonly options: ManagerOptions

  constructor(options: ManagerOptions) {
    this.options = options
    for (const file of recoverJobs(options.workspace.jobsDir())) {
      this.entries.set(file.job.id, { file, logBytes: 0 })
    }
  }

  list(): Job[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.file.dismissed)
      .map((entry) => entry.file.job)
  }

  get(id: string): Job {
    return this.entry(id).file.job
  }

  jobDir(id: string): string {
    if (!/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/.test(id)) throw new HttpError(400, 'invalid job id')
    return resolveWithin(this.options.workspace.jobsDir(), id)
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new HttpError(404, 'job not found')
    return entry
  }

  private update(entry: Entry, patch: Partial<Job>): void {
    entry.file.job = {
      ...entry.file.job,
      ...patch,
      revision: entry.file.job.revision + 1,
      updatedAt: new Date().toISOString(),
    }
    saveJobFile(this.jobDir(entry.file.job.id), entry.file)
    this.options.events.emit({ type: 'job.state', job: entry.file.job })
  }

  private fail(
    entry: Entry,
    reason: FailureReason,
    error: string,
    rawOutput: string | null = null,
  ): void {
    this.update(entry, {
      state: 'failed',
      reason,
      error,
      rawOutput: rawOutput ?? entry.file.job.rawOutput,
    })
  }

  private progress(entry: Entry, text: string): void {
    const job = entry.file.job
    job.progress = [...job.progress, text].slice(-PROGRESS_TAIL)
    if (entry.logBytes < PROGRESS_LOG_LIMIT) {
      const line = `${new Date().toISOString()} ${text}\n`
      entry.logBytes += line.length
      appendJobText(this.jobDir(job.id), 'progress.log', line)
    }
    this.options.events.emit({ type: 'job.progress', id: job.id, text })
  }

  create(request: JobRequest): Job {
    const { workspace } = this.options
    const { config } = workspace.config()
    const ids = new Set(request.snapshot.blocks.map((block) => block.id))
    for (const target of request.targets) {
      if (target !== START_ANCHOR && !ids.has(target))
        throw new HttpError(400, `unknown target block ${target}`)
    }
    if (request.snapshot.gaps.length !== request.snapshot.blocks.length + 1) {
      throw new HttpError(400, 'snapshot gaps do not match its blocks')
    }
    const skill =
      request.skill === undefined ? undefined : findSkill(request.skill, this.options.skillsDir)
    if (request.skill !== undefined && skill === undefined)
      throw new HttpError(400, `unknown skill ${request.skill}`)

    // Task override first, then the main agent; `--adapter` on the command line beats both.
    const adapter =
      this.options.adapterOverride ??
      (skill?.task ? config.taskAgents[skill.task] : undefined) ??
      config.mainAgent
    const id = newJobId()
    const now = new Date().toISOString()
    const job: Job = {
      id,
      doc: request.doc,
      scope: request.scope,
      instruction: request.instruction,
      skill: skill?.name ?? null,
      adapter,
      state: 'queued',
      reason: null,
      error: null,
      targets: request.targets,
      snapshotRaws: Object.fromEntries(
        request.snapshot.blocks.map((block) => [block.id, block.raw]),
      ),
      result: null,
      rawOutput: null,
      decisions: {},
      progress: [],
      revision: 0,
      createdAt: now,
      updatedAt: now,
    }
    const file: JobFile = {
      version: 1,
      job,
      effectiveConfig: {
        adapter: config.adapters[adapter] ?? DEFAULT_CONFIG.adapters[adapter] ?? { extraArgs: [] },
        timeoutSec: config.jobTimeoutSec,
      },
      promoted: {},
      dismissed: false,
    }
    const entry: Entry = { file, request, skill, logBytes: 0 }
    this.entries.set(id, entry)
    writeJobFiles(this.jobDir(id), id, request, workspace, skill)
    saveJobFile(this.jobDir(id), file)
    this.options.events.emit({ type: 'job.state', job })

    if (skill?.stub) {
      this.fail(
        entry,
        'missing-tool',
        `The "${skill.name}" skill is a stub and is not built yet. See the README.`,
      )
      return entry.file.job
    }
    const missing = skill === undefined ? [] : missingTools(skill, this.options.toolLookup)
    if (missing.length > 0) {
      // Fail before any agent starts: nothing is spent on a job that cannot succeed.
      this.fail(
        entry,
        'missing-tool',
        `Missing on PATH: ${missing.join(', ')}. Install ${missing.length > 1 ? 'them' : 'it'} to use the "${skill?.name}" skill.`,
      )
      return entry.file.job
    }
    if (this.options.registry.get(adapter) === undefined) {
      this.fail(
        entry,
        'missing-cli',
        `Unknown agent "${adapter}". Known agents: ${this.options.registry.names().join(', ')}.`,
      )
      return entry.file.job
    }
    this.waiting.push(id)
    this.pump()
    return entry.file.job
  }

  /**
   * Last line of defence for the job lifecycle: whatever throws inside run() — a filesystem error,
   * an adapter that throws or rejects — becomes a failed job. It must never become an unhandled
   * rejection, which would take the server (and the writer's autosave) down.
   */
  private crashed(entry: Entry, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    void entry.handle?.cancel().catch(() => {})
    entry.handle = undefined
    try {
      if (isUnsettled(entry.file.job.state) && entry.file.job.state !== 'ready') {
        this.fail(entry, 'exit', `The job stopped on an internal error: ${message}`)
      }
    } catch (persistError) {
      // Even recording the failure failed (disk full, directory gone): keep it in memory.
      entry.file.job = { ...entry.file.job, state: 'failed', reason: 'exit', error: message }
      console.error('could not record a failed job', persistError)
    }
  }

  /** Start queued jobs while process slots are free. Waiting for review holds no slot. */
  private pump(): void {
    const limit = this.options.workspace.config().config.concurrency
    while (this.running < limit && this.waiting.length > 0) {
      const id = this.waiting.shift() as string
      const entry = this.entries.get(id)
      if (entry === undefined || entry.file.job.state !== 'queued') continue
      this.running++
      void this.run(entry)
        .catch((error: unknown) => this.crashed(entry, error))
        .finally(() => {
          this.running--
          this.pump()
        })
    }
  }

  private async attempt(
    entry: Entry,
    prompt: string,
  ): Promise<
    { ok: true } | { ok: false; reason: FailureReason; message: string; output?: string }
  > {
    const job = entry.file.job
    const adapter = this.options.registry.get(job.adapter)
    if (adapter === undefined)
      return { ok: false, reason: 'missing-cli', message: `unknown agent ${job.adapter}` }
    const handle = adapter.start(this.jobDir(job.id), {
      workspace: this.options.workspace.root,
      jobId: job.id,
      prompt,
      config: entry.file.effectiveConfig.adapter,
      allow: entry.skill?.allow ?? [],
      network: entry.skill?.network ?? false,
    })
    entry.handle = handle
    const relay = (async () => {
      for await (const event of handle.progress) this.progress(entry, event.text)
    })()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), entry.file.effectiveConfig.timeoutSec * 1000)
    })
    // A progress stream that throws must fail the run now, not surface later as an unhandled
    // rejection; a stream that simply ends keeps waiting for completion.
    const relayFailure = relay.then(() => new Promise<never>(() => {}))
    let outcome: Awaited<typeof handle.done> | 'timeout'
    try {
      outcome = await Promise.race([handle.done, timeout, relayFailure])
    } catch (error) {
      clearTimeout(timer)
      throw error
    }
    clearTimeout(timer)
    if (outcome === 'timeout') {
      await handle.cancel()
      await relay
      return {
        ok: false,
        reason: 'timeout',
        message: `No result after ${entry.file.effectiveConfig.timeoutSec} s; the agent was stopped.`,
      }
    }
    await relay
    entry.handle = undefined
    return outcome
  }

  /** Parse and validate `result.json`. Returns the result or the list of errors plus the raw text. */
  private readResult(entry: Entry): { result: Result } | { errors: string[]; raw: string } {
    const job = entry.file.job
    const jobDir = this.jobDir(job.id)
    let raw: string | null
    try {
      raw = readJobText(jobDir, 'result.json')
    } catch (error) {
      if (!(error instanceof UnsafeJobFileError)) throw error
      return { errors: [error.message], raw: '' }
    }
    if (raw === null) return { errors: ['result.json was not written'], raw: '' }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (error) {
      return { errors: [`result.json is not valid JSON: ${(error as Error).message}`], raw }
    }
    const parsed = ResultSchema.safeParse(json)
    if (!parsed.success) {
      return {
        errors: parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || 'result'}: ${issue.message}`,
        ),
        raw,
      }
    }
    const errors = validateOps(parsed.data, {
      scope: job.scope,
      targets: job.targets,
      snapshot: entry.request?.snapshot ?? { blocks: [], gaps: [''] },
    })
    for (const asset of parsed.data.assets) {
      try {
        if (readJobAsset(jobDir, asset.file) === null) {
          errors.push(`asset "${asset.file}" does not exist in the job directory as a plain file`)
        }
      } catch {
        errors.push(`asset "${asset.file}" is not inside assets/`)
      }
    }
    return errors.length > 0 ? { errors, raw } : { result: parsed.data }
  }

  private async run(entry: Entry): Promise<void> {
    const id = entry.file.job.id
    const still = (state: JobState) => entry.file.job.state === state
    this.update(entry, { state: 'running' })
    const dir = `.zen/jobs/${id}`
    const first = await this.attempt(entry, `Read ${dir}/instruction.md and follow it exactly.`)
    if (!still('running')) return
    if (!first.ok) return this.fail(entry, first.reason, first.message, first.output ?? null)

    this.update(entry, { state: 'validating' })
    let checked = this.readResult(entry)
    if ('errors' in checked) {
      // One automatic repair attempt; the rejected output is kept next to the new one.
      const jobDir = this.jobDir(id)
      writeJobText(jobDir, 'result.invalid.json', checked.raw)
      writeJobText(jobDir, 'repair.md', renderRepair(id, checked.errors, checked.raw))
      this.update(entry, { state: 'repairing' })
      this.progress(
        entry,
        `result.json rejected (${checked.errors[0]}); asking the agent to repair it once`,
      )
      const repair = await this.attempt(entry, `Read ${dir}/repair.md and follow it exactly.`)
      if (!still('repairing')) return
      if (!repair.ok)
        return this.fail(entry, repair.reason, repair.message, repair.output ?? checked.raw)
      checked = this.readResult(entry)
      if ('errors' in checked) {
        return this.fail(
          entry,
          'invalid-result',
          `result.json is still invalid after one repair: ${checked.errors.join('; ')}`,
          checked.raw,
        )
      }
    }
    this.update(entry, { state: 'ready', result: checked.result })
  }

  async cancel(id: string): Promise<Job> {
    const entry = this.entry(id)
    const { state } = entry.file.job
    // A proposal that is already complete stays reviewable if cancel races with completion.
    if (state === 'ready' || state === 'settled') return entry.file.job
    if (state === 'failed' || state === 'cancelled' || state === 'stale') return entry.file.job
    this.update(entry, { state: 'cancelled', error: 'Cancelled by the writer.' })
    await entry.handle?.cancel()
    const written = readJobTextOrNull(this.jobDir(id), 'result.json')
    if (written !== null) this.update(entry, { rawOutput: written })
    return entry.file.job
  }

  markStale(id: string, reason: string): Job {
    const entry = this.entry(id)
    if (entry.file.job.state === 'settled') return entry.file.job
    const rawOutput = entry.file.job.rawOutput ?? readJobTextOrNull(this.jobDir(id), 'result.json')
    void entry.handle?.cancel().catch(() => {})
    this.update(entry, { state: 'stale', error: reason, rawOutput })
    return entry.file.job
  }

  dismiss(id: string): void {
    const entry = this.entry(id)
    entry.file.dismissed = true
    saveJobFile(this.jobDir(id), entry.file)
  }

  /**
   * Record review decisions. For accepted ops the assets they reference are copied (never moved,
   * never overwriting) into the article's bundle; the returned map lets the client rewrite the
   * references. Assets of rejected or undecided ops stay in the job directory.
   */
  decide(
    id: string,
    accepted: number[],
    rejected: number[],
  ): { job: Job; assetMap: Record<string, string> } {
    const entry = this.entry(id)
    const job = entry.file.job
    if (job.state !== 'ready' || job.result === null)
      throw new HttpError(409, `job is ${job.state}, not ready for review`)
    const ops = job.result.ops
    for (const index of [...accepted, ...rejected]) {
      if (index >= ops.length) throw new HttpError(400, `no op ${index}`)
    }
    const assetMap: Record<string, string> = {}
    if (job.doc.kind === 'article') {
      const files = job.result.assets.map((asset) => asset.file)
      const bundle = this.options.workspace.bundleDir(job.doc.slug)
      for (const index of accepted) {
        const op = ops[index]
        if (op === undefined || op.op === 'delete') continue
        for (const file of referencedAssets(op.markdown, files)) {
          const known = entry.file.promoted[file]
          if (known !== undefined) {
            assetMap[file] = known
            continue
          }
          // An escaping path throws (PathEscapeError → 400); anything else that is not a plain file is a 409.
          const data = readJobAsset(this.jobDir(id), file)
          if (data === null) throw new HttpError(409, `asset ${file} is missing`)
          const name = storeWithoutOverwrite(bundle, sanitiseFileName(path.basename(file)), data)
          entry.file.promoted[file] = name
          assetMap[file] = name
        }
      }
    }
    const decisions = { ...job.decisions }
    for (const index of accepted) decisions[String(index)] = 'accepted'
    for (const index of rejected) decisions[String(index)] = 'rejected'
    const settled = ops.every((_, index) => decisions[String(index)] !== undefined)
    this.update(entry, { decisions, state: settled ? 'settled' : 'ready' })
    return { job: entry.file.job, assetMap }
  }

  /** Stop every running agent; used when the server shuts down. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) =>
        entry.handle?.cancel({ force: true }).catch(() => {}),
      ),
    )
  }
}
