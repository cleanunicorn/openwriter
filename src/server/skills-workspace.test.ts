import { execFileSync } from 'node:child_process'
import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerEvent } from '../shared/events.ts'
import { createDoc, createIdMinter } from '../shared/blocks/index.ts'
import type { JobRequest } from '../shared/jobs/job-types.ts'
import {
  findSkill,
  listLocalSkills,
  loadSkills,
  MAX_LOCAL_SKILLS,
  MAX_SKILL_BYTES,
} from './skills.ts'
import { createTestApp, json, type TestApp } from './test-helpers.ts'

const SAMPLE = path.resolve(import.meta.dirname, '..', '..', 'sample-workspace')

const skillText = (name: string, extra = '', body = `Rewrite the target block as a ${name}.`) =>
  `---\nname: ${name}\ndescription: Rewrite as a ${name}\n${extra}---\n${body}\n`

let root: string
let outside: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'openwrite-local-skills-'))
  outside = mkdtempSync(path.join(os.tmpdir(), 'openwrite-outside-'))
  mkdirSync(path.join(root, '.zen', 'skills'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const skillsDir = () => path.join(root, '.zen', 'skills')
const put = (file: string, text: string) => writeFileSync(path.join(skillsDir(), file), text)
const errorFor = (file: string) =>
  loadSkills(root).errors.find((problem) => problem.file === `.zen/skills/${file}`)?.error

describe('workspace skills on disk', () => {
  it('loads a valid file as a workspace skill', () => {
    put('haiku.md', skillText('haiku', 'scope: article\nrequires: [node]\n'))
    const { skills, errors } = listLocalSkills(root)
    expect(errors).toEqual([])
    expect(skills).toEqual([
      expect.objectContaining({
        name: 'haiku',
        scope: 'article',
        requires: ['node'],
        source: 'workspace',
        body: 'Rewrite the target block as a haiku.',
      }),
    ])
  })

  it('is empty, without errors, when the workspace has no skills folder', () => {
    rmSync(skillsDir(), { recursive: true })
    expect(listLocalSkills(root)).toEqual({ skills: [], errors: [] })
    rmSync(path.join(root, '.zen'), { recursive: true })
    expect(listLocalSkills(root)).toEqual({ skills: [], errors: [] })
  })

  it('keeps the valid skills when another file is broken, and says what is wrong', () => {
    put('haiku.md', skillText('haiku'))
    put('broken.md', '---\nname: broken\nscope: everything\n---\nbody')
    const { skills, errors } = listLocalSkills(root)
    expect(skills.map((skill) => skill.name)).toEqual(['haiku'])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.file).toBe('.zen/skills/broken.md')
    // The same zod schema as the shipped skills, reported field by field.
    expect(errors[0]?.error).toMatch(/description: /)
    expect(errors[0]?.error).toMatch(/scope: /)
  })

  it.each([
    ['no header', 'no-header.md', 'Just a prompt, no header.', /has no header/],
    ['a name that is not the file name', 'limerick.md', skillText('haiku'), /name: haiku/],
    ['a header without a prompt', 'empty.md', skillText('empty', '', ''), /no prompt/],
    [
      'an allow: entry',
      'shell.md',
      skillText('shell', 'allow: [Bash(rm *)]\n'),
      /allow: is only honoured in the shipped/,
    ],
    [
      'network: true',
      'online.md',
      skillText('online', 'network: true\n'),
      /network: true is only honoured/,
    ],
    [
      'a flag-shaped allow entry',
      'flags.md',
      skillText('flags', 'allow: ["--add-dir /"]\n'),
      /allow\.0: must look like Tool/,
    ],
  ])('refuses %s', (_label, file, text, reason) => {
    put(file, text)
    expect(errorFor(file)).toMatch(reason)
  })

  it.each(['Haiku.md', 'my_skill.md', '-flag.md'])('refuses the file name %j', (file) => {
    put(file, skillText('haiku'))
    expect(errorFor(file)).toMatch(/lowercase letters, digits and hyphens/)
  })

  it('refuses a file with the name of a shipped skill: the shipped one stays', () => {
    put('diagram.md', skillText('diagram', '', 'Draw it in ASCII instead.'))
    expect(errorFor('diagram.md')).toMatch(/shipped skill is already called "diagram"/)
    const { skills } = loadSkills(root)
    expect(skills.filter((skill) => skill.name === 'diagram')).toHaveLength(1)
    expect(findSkill('diagram', root)?.body).toContain('fenced `mermaid` code block')
    expect(findSkill('diagram', root)?.source).toBe('shipped')
  })

  it('refuses an oversized file without reading it', () => {
    put('big.md', skillText('big', '', 'x'.repeat(MAX_SKILL_BYTES + 1)))
    expect(errorFor('big.md')).toMatch(/at most 64 KiB/)
  })

  it('refuses a file that is not UTF-8', () => {
    writeFileSync(
      path.join(skillsDir(), 'latin.md'),
      Buffer.concat([Buffer.from(skillText('latin')), Buffer.from([0xff, 0xfe])]),
    )
    expect(errorFor('latin.md')).toMatch(/not UTF-8/)
  })

  it('refuses a link that leaves the workspace, and never reads its target', () => {
    const secret = path.join(outside, 'secret.md')
    writeFileSync(secret, skillText('secret', '', 'THE SECRET'))
    symlinkSync(secret, path.join(skillsDir(), 'secret.md'))
    const catalog = listLocalSkills(root)
    expect(catalog.skills).toEqual([])
    expect(errorFor('secret.md')).toMatch(/outside the workspace/)
    expect(JSON.stringify(catalog)).not.toContain('THE SECRET')
  })

  it('follows a link that stays inside the workspace', () => {
    writeFileSync(path.join(root, 'haiku-source.md'), skillText('haiku'))
    symlinkSync(path.join(root, 'haiku-source.md'), path.join(skillsDir(), 'haiku.md'))
    expect(listLocalSkills(root).skills.map((skill) => skill.name)).toEqual(['haiku'])
  })

  it('refuses a hard link, a folder and a FIFO named like a skill', () => {
    writeFileSync(path.join(outside, 'linked.md'), skillText('linked'))
    try {
      linkSync(path.join(outside, 'linked.md'), path.join(skillsDir(), 'linked.md'))
    } catch {
      // Two temp dirs on different filesystems cannot be hard-linked; link inside the workspace.
      writeFileSync(path.join(root, 'linked.md'), skillText('linked'))
      linkSync(path.join(root, 'linked.md'), path.join(skillsDir(), 'linked.md'))
    }
    mkdirSync(path.join(skillsDir(), 'folder.md'))
    execFileSync('mkfifo', [path.join(skillsDir(), 'pipe.md')])
    expect(errorFor('linked.md')).toMatch(/hard link/)
    expect(errorFor('folder.md')).toMatch(/not a regular file/)
    // O_NONBLOCK: opening the FIFO returns at once instead of waiting for a writer.
    expect(errorFor('pipe.md')).toMatch(/not a regular file/)
  })

  it('refuses a skills folder that is a link out of the workspace', () => {
    rmSync(skillsDir(), { recursive: true })
    writeFileSync(path.join(outside, 'secret.md'), skillText('secret'))
    symlinkSync(outside, skillsDir())
    expect(listLocalSkills(root)).toEqual({
      skills: [],
      errors: [{ file: '.zen/skills', error: expect.stringMatching(/outside the workspace/) }],
    })
  })

  it('reports a skills "folder" that is a file', () => {
    rmSync(skillsDir(), { recursive: true })
    writeFileSync(skillsDir(), 'not a folder')
    expect(listLocalSkills(root).errors).toEqual([
      { file: '.zen/skills', error: 'it is not a folder' },
    ])
  })

  it('ignores files that are not skills', () => {
    put('README.txt', 'notes')
    put('.hidden.md', skillText('hidden'))
    expect(listLocalSkills(root)).toEqual({ skills: [], errors: [] })
  })

  it(`reads at most ${MAX_LOCAL_SKILLS} files and reports the rest`, () => {
    for (let index = 0; index <= MAX_LOCAL_SKILLS; index++) {
      const name = `s${String(index).padStart(3, '0')}`
      put(`${name}.md`, skillText(name))
    }
    const { skills, errors } = listLocalSkills(root)
    expect(skills).toHaveLength(MAX_LOCAL_SKILLS)
    expect(errors).toEqual([
      {
        file: `.zen/skills/s${MAX_LOCAL_SKILLS}.md`,
        error: expect.stringMatching(/only the first/),
      },
    ])
  })
})

describe('workspace skills in the app', () => {
  let t: TestApp
  let lookup: (tool: string) => boolean
  beforeEach(() => {
    lookup = () => true
    t = createTestApp({ fakeControl: true, toolLookup: (tool) => lookup(tool) })
    mkdirSync(path.join(t.workspace, '.zen', 'skills'), { recursive: true })
  })
  afterEach(() => t.cleanup())

  const putIn = (workspace: string, file: string, text: string) => {
    mkdirSync(path.join(workspace, '.zen', 'skills'), { recursive: true })
    writeFileSync(path.join(workspace, '.zen', 'skills', file), text)
  }

  const request = (skill: string): JobRequest => {
    const article = path.join(t.workspace, 'content', 'posts', 'hello-openwrite', 'index.md')
    const doc = createDoc(readFileSync(article, 'utf8'), createIdMinter())
    const target = doc.blocks.find((block) => block.raw.includes('## Why blocks'))
    return {
      doc: { kind: 'article', slug: 'hello-openwrite' },
      scope: 'blocks',
      instruction: 'make it short',
      skill,
      targets: [target?.id ?? 'b0'],
      snapshot: doc,
    }
  }

  it('lists workspace skills after the shipped ones, with their source and the errors', async () => {
    putIn(t.workspace, 'haiku.md', skillText('haiku'))
    putIn(t.workspace, 'broken.md', '---\nname: broken\n---\nbody')
    const { skills, errors } = await json(t.get('/api/skills'))
    const names = skills.map((skill: { name: string }) => skill.name)
    expect(names.at(-1)).toBe('haiku')
    expect(names).toContain('diagram')
    expect(skills.at(-1)).toMatchObject({ name: 'haiku', source: 'workspace' })
    expect(skills.at(-1)).not.toHaveProperty('body')
    expect(errors).toEqual([
      { file: '.zen/skills/broken.md', error: expect.stringMatching(/^description: /) },
    ])
  })

  it('runs a workspace skill as an ordinary job: its body goes into instruction.md', async () => {
    putIn(t.workspace, 'haiku.md', skillText('haiku', '', 'Three lines: five, seven, five.'))
    const job = await json(t.send('POST', '/api/jobs', request('haiku')))
    expect(job.skill).toBe('haiku')
    const instruction = readFileSync(
      path.join(t.workspace, '.zen', 'jobs', job.id, 'instruction.md'),
      'utf8',
    )
    expect(instruction).toContain('## Skill: haiku')
    expect(instruction).toContain('Three lines: five, seven, five.')
    await expect.poll(() => t.gate.waitingIds()).toContain(job.id)
  })

  it('puts a workspace skill’s requires: through the same PATH preflight', async () => {
    lookup = (tool) => tool !== 'figlet'
    putIn(t.workspace, 'banner.md', skillText('banner', 'requires: [figlet]\n'))
    const job = await json(t.send('POST', '/api/jobs', request('banner')))
    expect(job).toMatchObject({ state: 'failed', reason: 'missing-tool' })
    expect(job.error).toContain('Missing on PATH: figlet')
    expect(t.gate.waitingIds()).toEqual([])
  })

  it('refuses to run a broken or shadowing file: the job is a 400 or the shipped skill', async () => {
    putIn(t.workspace, 'broken.md', '---\nname: broken\n---\nbody')
    expect((await t.send('POST', '/api/jobs', request('broken'))).status).toBe(400)
    putIn(t.workspace, 'diagram.md', skillText('diagram', '', 'LOCAL DIAGRAM BODY'))
    const job = await json(t.send('POST', '/api/jobs', request('diagram')))
    const instruction = readFileSync(
      path.join(t.workspace, '.zen', 'jobs', job.id, 'instruction.md'),
      'utf8',
    )
    expect(instruction).toContain('fenced `mermaid` code block')
    expect(instruction).not.toContain('LOCAL DIAGRAM BODY')
  })

  it('follows a workspace switch: the list and the jobs use the new workspace’s skills', async () => {
    putIn(t.workspace, 'haiku.md', skillText('haiku'))
    const other = path.join(t.workspacesDir, 'other')
    mkdirSync(t.workspacesDir, { recursive: true })
    cpSync(SAMPLE, other, { recursive: true })
    putIn(other, 'limerick.md', skillText('limerick'))

    const opened = await t.send('POST', '/api/workspaces/open', { name: 'other' })
    expect(opened.status).toBe(200)
    const { skills } = await json(t.get('/api/skills'))
    const names = skills.map((skill: { name: string }) => skill.name)
    expect(names).toContain('limerick')
    expect(names).not.toContain('haiku')
    expect((await t.send('POST', '/api/jobs', request('haiku'))).status).toBe(400)
  })

  it('emits skills.changed when a skill file is added, broken or removed', async () => {
    const seen: ServerEvent[] = []
    t.context.events.subscribe((event) => seen.push(event))
    const changes = () => seen.filter((event) => event.type === 'skills.changed').length

    putIn(t.workspace, 'haiku.md', skillText('haiku'))
    await expect.poll(changes).toBe(1)
    putIn(t.workspace, 'haiku.md', '---\nname: haiku\n---\nno description')
    await expect.poll(changes).toBe(2)
    rmSync(path.join(t.workspace, '.zen', 'skills', 'haiku.md'))
    await expect.poll(changes).toBe(3)
  })

  it('sees a skills folder that is created after the server started', async () => {
    // A fresh app on the sample workspace, which has no .zen/skills/ folder at all.
    const plain = createTestApp()
    try {
      const seen: ServerEvent[] = []
      plain.context.events.subscribe((event) => seen.push(event))
      putIn(plain.workspace, 'haiku.md', skillText('haiku'))
      await expect.poll(() => seen.some((event) => event.type === 'skills.changed')).toBe(true)
    } finally {
      plain.cleanup()
    }
  })

  it('watches the new workspace after a switch', async () => {
    const other = path.join(t.workspacesDir, 'other')
    mkdirSync(t.workspacesDir, { recursive: true })
    cpSync(SAMPLE, other, { recursive: true })
    mkdirSync(path.join(other, '.zen', 'skills'), { recursive: true })
    expect((await t.send('POST', '/api/workspaces/open', { name: 'other' })).status).toBe(200)

    const seen: ServerEvent[] = []
    t.context.events.subscribe((event) => seen.push(event))
    putIn(other, 'limerick.md', skillText('limerick'))
    await expect.poll(() => seen.some((event) => event.type === 'skills.changed')).toBe(true)
  })
})
