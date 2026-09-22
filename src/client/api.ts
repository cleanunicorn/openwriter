import type { z } from 'zod'
import {
  ArticleSchema,
  ArticlesResponseSchema,
  AssetResponseSchema,
  ConfigResponseSchema,
  type DocRef,
  DocResponseSchema,
  docUrl,
  OkResponseSchema,
  SaveResponseSchema,
  SkillsResponseSchema,
  encodeWorkspaceHeader,
  WORKSPACE_HEADER,
  WorkspaceMovedSchema,
} from '../shared/api-types.ts'
import type { Config } from '../shared/config-schema.ts'
import { WorkspacesResponseSchema } from '../shared/workspaces-schema.ts'
import {
  ClearJobsResponseSchema,
  DecisionsResponseSchema,
  type JobRequest,
  JobSchema,
  JobsResponseSchema,
} from '../shared/jobs/job-types.ts'

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** Was this refused because another workspace is open now than the one the request named? */
export const workspaceMoved = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status === 409 &&
  WorkspaceMovedSchema.safeParse(error.body).success

let shownWorkspace: () => string | undefined = () => undefined

/**
 * Tell every request which workspace this tab is showing. The server refuses a document read or
 * write meant for another one (409, `WorkspaceMovedSchema`), so a tab that has not heard of a switch
 * yet can neither load the new workspace's same-slug article into its state nor save its own text
 * there. Nothing is named until the tab knows its workspace.
 */
export const nameWorkspaceWith = (get: () => string | undefined): void => {
  shownWorkspace = get
}

/** The one way this page builds the header: naming `root`, or nothing when it is unknown. */
const workspaceHeader = (root: string | undefined): Record<string, string> =>
  root === undefined ? {} : { [WORKSPACE_HEADER]: encodeWorkspaceHeader(root) }

/** The header naming this tab's workspace, for a request made without `request` (the export). */
export const workspaceHeaders = (): Record<string, string> => workspaceHeader(shownWorkspace())

/** Every response is zod-parsed: typed data between client and server, checked at the boundary. */
async function request<T extends z.ZodType>(
  schema: T,
  url: string,
  init: { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {},
): Promise<z.infer<T>> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers:
      init.raw === undefined
        ? { 'content-type': 'application/json', ...workspaceHeaders(), ...init.headers }
        : { ...workspaceHeaders(), ...init.headers },
    body: init.raw ?? (init.method === undefined ? undefined : JSON.stringify(init.body ?? {})),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String(body.error)
        : response.statusText
    throw new ApiError(response.status, message, body)
  }
  return schema.parse(body)
}

export const api = {
  articles: () => request(ArticlesResponseSchema, '/api/articles'),
  createArticle: (title: string) =>
    request(ArticleSchema, '/api/articles', { method: 'POST', body: { title } }),
  doc: (ref: DocRef) => request(DocResponseSchema, docUrl(ref)),
  /** `tab` names the tab that saves, so the others hear of it and it does not (#29). */
  save: (ref: DocRef, text: string, baseHash: string | null, tab: string) =>
    request(SaveResponseSchema, docUrl(ref), { method: 'PUT', body: { text, baseHash, tab } }),
  uploadImage: (slug: string, file: File) =>
    request(AssetResponseSchema, `/api/docs/article/${slug}/assets`, {
      method: 'POST',
      raw: file,
      headers: {
        'content-type': file.type,
        'x-filename': encodeURIComponent(file.name || 'image'),
      },
    }),
  config: () => request(ConfigResponseSchema, '/api/config'),
  jobs: () => request(JobsResponseSchema, '/api/jobs'),
  createJob: (body: JobRequest) => request(JobSchema, '/api/jobs', { method: 'POST', body }),
  cancelJob: (id: string) => request(JobSchema, `/api/jobs/${id}/cancel`, { method: 'POST' }),
  decide: (id: string, accepted: number[], rejected: number[]) =>
    request(DecisionsResponseSchema, `/api/jobs/${id}/decisions`, {
      method: 'POST',
      body: { accepted, rejected },
    }),
  withdrawDecisions: (id: string, indices: number[]) =>
    request(JobSchema, `/api/jobs/${id}/decisions/withdraw`, { method: 'POST', body: { indices } }),
  staleJob: (id: string, reason: string) =>
    request(JobSchema, `/api/jobs/${id}/stale`, { method: 'POST', body: { reason } }),
  dismissJob: (id: string) =>
    request(OkResponseSchema, `/api/jobs/${id}/dismiss`, { method: 'POST' }),
  /** `root`: the workspace whose jobs the writer saw; the server refuses if another is open now. */
  clearFinishedJobs: (root: string) =>
    request(ClearJobsResponseSchema, '/api/jobs/clear-finished', {
      method: 'POST',
      headers: workspaceHeader(root),
    }),
  skills: () => request(SkillsResponseSchema, '/api/skills'),
  /** `root`: the workspace this was written for; the server refuses it if another is open now. */
  saveConfig: (config: Config, root?: string) =>
    request(ConfigResponseSchema, '/api/config', {
      method: 'PUT',
      body: config,
      headers: workspaceHeader(root),
    }),
  workspaces: () => request(WorkspacesResponseSchema, '/api/workspaces'),
  openWorkspace: (name: string) =>
    request(WorkspacesResponseSchema, '/api/workspaces/open', { method: 'POST', body: { name } }),
  switchWorkspace: (id: string) =>
    request(WorkspacesResponseSchema, `/api/workspaces/${id}/open`, { method: 'POST' }),
  createWorkspace: (name: string) =>
    request(WorkspacesResponseSchema, '/api/workspaces', { method: 'POST', body: { name } }),
  renameWorkspace: (id: string, label: string) =>
    request(WorkspacesResponseSchema, `/api/workspaces/${id}`, {
      method: 'PATCH',
      body: { label },
    }),
  forgetWorkspace: (id: string) =>
    request(WorkspacesResponseSchema, `/api/workspaces/${id}`, { method: 'DELETE' }),
  eraseWorkspace: (id: string, confirm: string) =>
    request(WorkspacesResponseSchema, `/api/workspaces/${id}/erase`, {
      method: 'POST',
      body: { confirm },
    }),
}
