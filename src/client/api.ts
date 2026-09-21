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
} from '../shared/api-types.ts'
import type { Config } from '../shared/config-schema.ts'
import { WorkspacesResponseSchema } from '../shared/workspaces-schema.ts'
import {
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
        ? { 'content-type': 'application/json', ...init.headers }
        : init.headers,
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
  save: (ref: DocRef, text: string, baseHash: string | null) =>
    request(SaveResponseSchema, docUrl(ref), { method: 'PUT', body: { text, baseHash } }),
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
  skills: () => request(SkillsResponseSchema, '/api/skills'),
  saveConfig: (config: Config) =>
    request(ConfigResponseSchema, '/api/config', { method: 'PUT', body: config }),
  workspaces: () => request(WorkspacesResponseSchema, '/api/workspaces'),
  openWorkspace: (path: string) =>
    request(WorkspacesResponseSchema, '/api/workspaces/open', { method: 'POST', body: { path } }),
  createWorkspace: (path: string) =>
    request(WorkspacesResponseSchema, '/api/workspaces', { method: 'POST', body: { path } }),
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
