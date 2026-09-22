import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDoc, createIdMinter } from '../shared/blocks/index.ts'
import type { JobRequest } from '../shared/jobs/job-types.ts'
import { buildClaudeArgs } from './adapters/claude.ts'
import {
  ALLOW_ENTRY,
  findSkill,
  listSkills,
  missingTools,
  parseSkill,
  SKILLS_DIR,
  SkillHeaderSchema,
} from './skills.ts'
import { createTestApp, json, type TestApp } from './test-helpers.ts'

describe('the shipped skills', () => {
  it('every file in skills/ parses and is named after its file', () => {
    const files = readdirSync(SKILLS_DIR).filter((file) => file.endsWith('.md'))
    expect(files.sort()).toEqual([
      'diagram.md',
      'draft-article.md',
      'draft-brief.md',
      'image.md',
      'terminal-recording.md',
      'video.md',
    ])
    for (const file of files) {
      const skill = parseSkill(readFileSync(path.join(SKILLS_DIR, file), 'utf8'))
      expect(`${skill.name}.md`).toBe(file)
      expect(skill.body.length).toBeGreaterThan(40)
    }
    expect(listSkills().map((skill) => skill.name)).toHaveLength(files.length)
  })

  it('pins every skill’s extra allowances: a new Bash rule is a reviewed change', () => {
    // A `Bash(...)` rule gives claude a shell that --restricted does not confine (it confines the
    // file tools only). Such a skill trades confinement for its purpose; see DECISIONS.md. This
    // list must change in the same commit as a skill's `allow:` header, and a widened command
    // line is sentinel-checked with `node scripts/verify-adapter.ts claude --skill=<name>`.
    const allowances = Object.fromEntries(listSkills().map((skill) => [skill.name, skill.allow]))
    expect(allowances).toEqual({
      diagram: [],
      'draft-article': [],
      'draft-brief': [],
      image: [],
      'terminal-recording': [
        'Bash(asciinema *)',
        'Bash(agg *)',
        'Bash(command -v *)',
        'Bash(bash *)',
      ],
      video: [],
    })
  })

  it('builds the real command line of the one skill that widens it', () => {
    const skill = findSkill('terminal-recording')
    const args = buildClaudeArgs('/ws/.zen/jobs/j', {
      workspace: '/ws',
      jobId: 'j',
      prompt: '',
      config: { extraArgs: [] },
      allow: skill?.allow ?? [],
      network: false,
    })
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Edit,Write,Bash')
    expect(args).toContain('--restricted')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
  })

  it('diagram asks for a fenced mermaid block', () => {
    expect(findSkill('diagram')?.body).toContain('fenced `mermaid` code block')
  })

  it('terminal recording declares its tools, its allowances, and the missing-tool rule', () => {
    const skill = findSkill('terminal-recording')
    expect(skill?.requires).toEqual(['asciinema', 'agg'])
    expect(skill?.allow).toContain('Bash(asciinema *)')
    expect(skill?.body).toContain('command -v asciinema agg')
    expect(skill?.body).toContain('names the missing tool')
  })

  it('image is routed by task, and video is a stub', () => {
    expect(findSkill('image')).toMatchObject({ task: 'image', network: true, stub: false })
    expect(findSkill('video')).toMatchObject({ stub: true })
  })

  it('reports which required tools are missing, with an injected lookup', () => {
    const skill = parseSkill(
      '---\nname: rec\ndescription: d\nrequires: [asciinema, agg, node]\n---\nbody that is long enough',
    )
    expect(missingTools(skill, (tool) => tool === 'node')).toEqual(['asciinema', 'agg'])
    expect(missingTools(skill, () => true)).toEqual([])
  })

  it('the README documents every header key', () => {
    const readme = readFileSync(path.join(SKILLS_DIR, '..', 'README.md'), 'utf8')
    const section = readme.slice(readme.indexOf('## Adding a skill'), readme.indexOf('## Export'))
    for (const key of Object.keys(SkillHeaderSchema.shape)) {
      expect(section, `README "Adding a skill" does not mention "${key}:"`).toMatch(
        new RegExp(`^${key}:`, 'm'),
      )
    }
  })

  it.each(['--add-dir /', '-p', '--dangerously-skip-permissions', 'Bash(rm *) --add-dir /'])(
    'rejects the flag-shaped allow entry %j',
    (entry) => {
      const text = `---\nname: bad\ndescription: d\nallow: ["${entry}"]\n---\nbody that is long enough to count`
      expect(() => parseSkill(text)).toThrow()
    },
  )

  it('accepts the entries the shipped skills use', () => {
    for (const entry of [
      'Bash(asciinema *)',
      'Bash(command -v *)',
      'Read',
      'WebFetch(domain:example.com)',
    ]) {
      expect(ALLOW_ENTRY.test(entry), entry).toBe(true)
    }
  })

  it('rejects a header without a name or description', () => {
    expect(() => parseSkill('---\ndescription: d\n---\nbody')).toThrow()
    expect(() => parseSkill('no header at all')).toThrow()
  })
})

describe('skills in jobs', () => {
  let t: TestApp
  let lookup: (tool: string) => boolean
  beforeEach(() => {
    lookup = () => true
    t = createTestApp({ fakeControl: true, toolLookup: (tool) => lookup(tool) })
  })
  afterEach(() => t.cleanup())

  const request = (skill: string): JobRequest => {
    const article = path.join(t.workspace, 'content', 'posts', 'hello-openwrite', 'index.md')
    const doc = createDoc(readFileSync(article, 'utf8'), createIdMinter())
    const target = doc.blocks.find((block) => block.raw.includes('## Why blocks'))
    return {
      doc: { kind: 'article', slug: 'hello-openwrite' },
      scope: 'blocks',
      instruction: 'fake:diagram show the flow',
      skill,
      targets: [target?.id ?? 'b0'],
      snapshot: doc,
    }
  }

  it('lists skills without their bodies', async () => {
    const { skills } = await json(t.get('/api/skills'))
    expect(skills.map((skill: { name: string }) => skill.name)).toContain('terminal-recording')
    expect(skills[0]).not.toHaveProperty('body')
    // Permission headers are the server's business; they do not travel to the client.
    const recording = skills.find((skill: { name: string }) => skill.name === 'terminal-recording')
    expect(Object.keys(recording).sort()).toEqual([
      'description',
      'document',
      'name',
      'requires',
      'scope',
      'source',
      'stub',
      'task',
    ])
    expect(recording.source).toBe('shipped')
  })

  it('puts the skill body into instruction.md: any adapter can run it', async () => {
    const job = await json(t.send('POST', '/api/jobs', request('diagram')))
    const instruction = readFileSync(
      path.join(t.workspace, '.zen', 'jobs', job.id, 'instruction.md'),
      'utf8',
    )
    expect(instruction).toContain('## Skill: diagram')
    expect(instruction).toContain('fenced `mermaid` code block')
    expect(instruction).toContain('show the flow')
  })

  it('says clearly which tools are missing, before any agent starts', async () => {
    lookup = (tool) => tool !== 'asciinema' && tool !== 'agg'
    const job = await json(t.send('POST', '/api/jobs', request('terminal-recording')))
    expect(job).toMatchObject({ state: 'failed', reason: 'missing-tool' })
    expect(job.error).toContain('asciinema, agg')
    expect(t.gate.waitingIds()).toEqual([])
  })

  it('starts the recording skill when the tools exist', async () => {
    const job = await json(t.send('POST', '/api/jobs', request('terminal-recording')))
    expect(job.state).not.toBe('failed')
    await expect.poll(() => t.gate.waitingIds()).toContain(job.id)
  })

  it('refuses the video stub with a pointer to the README', async () => {
    const job = await json(t.send('POST', '/api/jobs', request('video')))
    expect(job).toMatchObject({ state: 'failed', reason: 'missing-tool' })
    expect(job.error).toContain('stub')
  })

  it('rejects an unknown skill', async () => {
    expect((await t.send('POST', '/api/jobs', request('nonesuch'))).status).toBe(400)
  })

  it('routes a task to its configured agent before the main agent', async () => {
    const plain = createTestApp({ adapterOverride: undefined, fakeControl: true })
    try {
      writeFileSync(
        path.join(plain.workspace, '.zen', 'config.json'),
        JSON.stringify({
          mainAgent: 'fake',
          taskAgents: { image: 'codex' },
          adapters: { codex: { command: 'openwrite-no-such-cli' } },
        }),
      )
      const body = { ...request('image') }
      const image = await json(plain.send('POST', '/api/jobs', body))
      const diagram = await json(plain.send('POST', '/api/jobs', { ...body, skill: 'diagram' }))
      expect(image.adapter).toBe('codex')
      expect(diagram.adapter).toBe('fake')
    } finally {
      plain.cleanup()
    }
  })

  it('a new skill is a file: no editor or server code changes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'openwrite-skills-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'haiku.md'),
      '---\nname: haiku\ndescription: Rewrite as a haiku\n---\nRewrite the target block as a haiku, three lines.',
    )
    const custom = createTestApp({ fakeControl: true, skillsDir: dir })
    try {
      // The palette lists exactly what the job manager can run.
      const { skills } = await json(custom.get('/api/skills'))
      expect(skills.map((skill: { name: string }) => skill.name)).toEqual(['haiku'])
      const job = await json(custom.send('POST', '/api/jobs', request('haiku')))
      expect(job.skill).toBe('haiku')
      expect(
        readFileSync(path.join(custom.workspace, '.zen', 'jobs', job.id, 'instruction.md'), 'utf8'),
      ).toContain('as a haiku')
    } finally {
      custom.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
