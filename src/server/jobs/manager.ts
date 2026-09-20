import { rmSync } from 'node:fs'
import path from 'node:path'
import { referencedAssets } from '../../shared/jobs/asset-refs.ts'
import {
  type FailureReason,
  isActive,
  isUnsettled,
  PROGRESS_TAIL,
  type Job,
  type JobRequest,
  type JobState,
} from '../../shared/jobs/job-types.ts'
import { type Result, ResultSchema } from '../../shared/jobs/result-schema.ts'
import { START_ANCHOR, validateOps } from '../../shared/jobs/validate-ops.ts'
import type { AdapterRegistry } from '../adapters/registry.ts'
import type { AdapterHandle, Completion } from '../adapters/types.ts'
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

const PROGRESS_LOG_LIMIT = 512 * 1024
/** How long a workspace switch waits for the runs it cancelled; the epoch fences the rest. */
const QUIESCE_BUDGET_MS = 2000

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
  /** The workspace generation this entry belongs to; see `rebind`. */
  epoch: number
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
  /**
   * Bumped by `rebind` when the workspace changes. Every write a job makes is stamped with the
   * epoch it started in and dropped if that is no longer the current one, so a run still
   * settling cannot create `<new workspace>/.zen/jobs/<old id>/`.
   */
  private epoch = 0
  /** The runs currently in flight, so `quiesce` can wait for them instead of hoping. */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(options: ManagerOptions) {
    this.options = options
    this.recover()
  }

  /** Adopt whatever job directories the current workspace already has. */
  private recover(): void {
    for (const file of recoverJobs(this.options.workspace.jobsDir())) {
      this.entries.set(file.job.id, { file, logBytes: 0, epoch: this.epoch })
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
    // A job of a workspace that is no longer open writes nothing and says nothing: its directory
    // is in the other root, and `jobDir()` would now resolve into this one.
    if (entry.epoch !== this.epoch) return
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
    if (entry.epoch !== this.epoch) return
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
        adapter: config.adapters[adapter] ?? { extraArgs: [] },
        timeoutSec: config.jobTimeoutSec,
      },
      promoted: {},
      dismissed: false,
    }
    const entry: Entry = { file, request, skill, logBytes: 0, epoch: this.epoch }
    // Publish the job only once its files exist. Reading the context can fail (strategy.md that is
    // not UTF-8, a full disk); a half-created job must not stay listed as "queued" forever.
    try {
      writeJobFiles(this.jobDir(id), id, request, workspace, skill)
      saveJobFile(this.jobDir(id), file)
    } catch (error) {
      rmSync(this.jobDir(id), { recursive: true, force: true })
      throw error
    }
    this.entries.set(id, entry)
    this.options.events.emit({ type: 'job.state', job })

    // Fail before any agent starts: nothing is spent on a job that cannot succeed.
    const problem = this.preflight(skill, adapter)
    if (problem !== undefined) {
      this.fail(entry, problem.reason, problem.error)
      return entry.file.job
    }
    this.waiting.push(id)
    this.pump()
    return entry.file.job
  }

  /** Why a job cannot run at all: a stub skill, a tool missing on PATH, or an unknown agent. */
  private preflight(
    skill: Skill | undefined,
    adapter: string,
  ): { reason: FailureReason; error: string } | undefined {
    if (skill?.stub) {
      return {
        reason: 'missing-tool',
        error: `The "${skill.name}" skill is a stub and is not built yet. See the README.`,
      }
    }
    const missing = skill === undefined ? [] : missingTools(skill, this.options.toolLookup)
    if (missing.length > 0) {
      return {
        reason: 'missing-tool',
        error: `Missing on PATH: ${missing.join(', ')}. Install ${missing.length > 1 ? 'them' : 'it'} to use the "${skill?.name}" skill.`,
      }
    }
    if (this.options.registry.get(adapter) === undefined) {
      return {
        reason: 'missing-cli',
        error: `Unknown agent "${adapter}". Known agents: ${this.options.registry.names().join(', ')}.`,
      }
    }
    return undefined
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
      if (isActive(entry.file.job.state)) {
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
      const done = this.settle(entry)
      this.inFlight.add(done)
      const forget = () => this.inFlight.delete(done)
      void done.then(forget, forget)
    }
  }

  /**
   * One run, from start to finish, including its slot. The epoch is read before the run so a
   * switch that happens while it is in flight cannot give a slot back to the workspace that is
   * open now — `rebind` has already reset the count.
   */
  private async settle(entry: Entry): Promise<void> {
    const epoch = this.epoch
    try {
      await this.run(entry)
    } catch (error) {
      this.crashed(entry, error)
    } finally {
      if (epoch === this.epoch) {
        this.running--
        this.pump()
      }
    }
  }

  private async attempt(entry: Entry, prompt: string): Promise<Completion> {
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
    let outcome: Completion | 'timeout'
    try {
      outcome = await Promise.race([handle.done, timeout, relayFailure])
    } finally {
      clearTimeout(timer)
    }
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
    // Every checkpoint asks two questions: is this job still in the state I left it in, and is
    // its workspace still the one that is open? A job whose root has moved stops here — its
    // directory is in the other workspace, and every path below would resolve into this one.
    const still = (state: JobState) => entry.epoch === this.epoch && entry.file.job.state === state
    this.update(entry, { state: 'running' })
    const jobRel = `.zen/jobs/${id}`
    const first = await this.attempt(entry, `Read ${jobRel}/instruction.md and follow it exactly.`)
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
      const repair = await this.attempt(entry, `Read ${jobRel}/repair.md and follow it exactly.`)
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
    // A proposal that is already complete stays reviewable if cancel races with completion, and a
    // job that has already ended has nothing to cancel.
    if (!isActive(state)) return entry.file.job
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
    wantAccepted: number[],
    wantRejected: number[],
  ): { job: Job; assetMap: Record<string, string> } {
    const entry = this.entry(id)
    const job = entry.file.job
    if (job.state !== 'ready' || job.result === null)
      throw new HttpError(409, `job is ${job.state}, not ready for review`)
    const ops = job.result.ops
    if (wantAccepted.some((index) => wantRejected.includes(index))) {
      throw new HttpError(400, 'an op cannot be accepted and rejected at once')
    }
    // Idempotent: an index that already has a decision is ignored, not decided again.
    const undecidedOnly = (indices: number[]) =>
      [...new Set(indices)].filter((index) => job.decisions[String(index)] === undefined)
    for (const index of [...wantAccepted, ...wantRejected]) {
      if (index >= ops.length) throw new HttpError(400, `no op ${index}`)
    }
    const accepted = undecidedOnly(wantAccepted)
    const rejected = undecidedOnly(wantRejected)
    const assetMap = this.promoteAssets(entry, job.result, accepted)
    const decisions = { ...job.decisions }
    for (const index of accepted) decisions[String(index)] = 'accepted'
    for (const index of rejected) decisions[String(index)] = 'rejected'
    const settled = ops.every((_, index) => decisions[String(index)] !== undefined)
    this.update(entry, { decisions, state: settled ? 'settled' : 'ready' })
    return { job: entry.file.job, assetMap }
  }

  /**
   * Take back acceptances the client could not apply. Only the client knows the live document:
   * a block can vanish between the server recording "accepted" and the client applying the op.
   * Such an op was never applied, so it must not stay accepted — it becomes undecided again and a
   * settled job is reviewable again (the client then reports it stale if its targets are gone).
   * Rejections and applied acceptances are never touched. Promoted assets stay in the bundle:
   * they are copies, and a later acceptance reuses them.
   */
  withdraw(id: string, indices: number[]): Job {
    const entry = this.entry(id)
    const job = entry.file.job
    if (job.state !== 'ready' && job.state !== 'settled')
      throw new HttpError(409, `job is ${job.state}, its decisions are final`)
    const decisions = { ...job.decisions }
    for (const index of indices) {
      if (decisions[String(index)] === 'accepted') delete decisions[String(index)]
    }
    if (Object.keys(decisions).length === Object.keys(job.decisions).length) return job
    this.update(entry, { decisions, state: 'ready' })
    return entry.file.job
  }

  /**
   * Copy the assets that the accepted ops reference into the article's bundle, and return
   * `assets/<file>` → name in the bundle. Only an article has a bundle.
   */
  private promoteAssets(entry: Entry, result: Result, accepted: number[]): Record<string, string> {
    const { id, doc } = entry.file.job
    const assetMap: Record<string, string> = {}
    if (doc.kind !== 'article') return assetMap
    const files = result.assets.map((asset) => asset.file)
    const bundle = this.options.workspace.bundleDir(doc.slug)
    for (const index of accepted) {
      const op = result.ops[index]
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
    return assetMap
  }

  /**
   * Let go of this workspace's jobs so its root can move.
   *
   * Every unsettled job is marked stale with the reason, which writes into the workspace that is
   * still open and keeps whatever the agent produced; every agent is force-cancelled; and the
   * runs still in flight are awaited so their last bookkeeping lands in the old root too. The
   * wait is bounded, exactly as the shutdown path bounds `dispose`, because golden rule 8 says a
   * wedged agent may not block the writer — and `rebind`'s epoch fences whatever outlives the
   * budget.
   */
  async quiesce(reason: string, budgetMs = QUIESCE_BUDGET_MS): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (isUnsettled(entry.file.job.state)) this.markStale(entry.file.job.id, reason)
    }
    await Promise.race([
      Promise.allSettled([...this.inFlight, ...this.cancelAll()]),
      new Promise((resolve) => setTimeout(resolve, budgetMs)),
    ])
  }

  /**
   * Adopt another workspace's jobs. The epoch moves first, so anything still running for the
   * previous root is fenced out of `update` and `progress` before a single path is re-resolved;
   * then the in-memory list is dropped and rebuilt from the new root's own job directories. The
   * files of the old workspace are untouched, so switching back finds them again.
   *
   * Call it only after `quiesce`, and only inside the synchronous block that retargets the
   * workspace.
   */
  rebind(): void {
    this.epoch++
    this.entries.clear()
    this.waiting.length = 0
    this.running = 0
    this.recover()
  }

  private cancelAll(): Promise<unknown>[] {
    return [...this.entries.values()].map((entry) =>
      entry.handle === undefined
        ? Promise.resolve()
        : entry.handle.cancel({ force: true }).catch(() => {}),
    )
  }

  /** Stop every running agent; used when the server shuts down. */
  async shutdown(): Promise<void> {
    await Promise.all(this.cancelAll())
  }
}
