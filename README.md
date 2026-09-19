# openwrite

A local-first, block-based markdown editor for technical blog posts, with agent-powered
editing. The file on disk is plain markdown; agents propose, the writer approves.

> Status: under construction in the initial build PR. Sections below grow with each milestone.

## Setup

Requires Node.js ≥ 24.

```bash
npm install
npm start          # builds the client if needed, opens the editor on a copy of the sample workspace
```

`npm start` copies `sample-workspace/` to `.openwrite/sample-workspace/` on first run and opens
that copy. To open your own workspace:

```bash
npm start -- --workspace /path/to/workspace     # or OPENWRITE_WORKSPACE=/path/to/workspace
```

The server binds `127.0.0.1` only.

## Using the editor

- Click a block to edit its markdown; `Esc` or a click elsewhere renders it again.
- Arrow keys cross block edges. `Enter` on an empty last line starts a new block. `Backspace` at
  the start of a block merges it into the one above. Pasting several paragraphs re-splits on blur.
- Hover a block to get the drag handle in the left margin (keyboard: focus the handle, `Space`,
  arrows, `Space`).
- `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` undo and redo across the whole document, reorders included.
- Paste or drop an image: it is saved next to the article and referenced with a relative path.
- `Ctrl/Cmd+K` opens the command palette: switch article, new article, theme, and more.
- Changes are saved automatically. If the file changes on disk, the editor reloads it and keeps
  the block you are typing in.

## Working with agents

- Select text in a block, or select whole blocks (click the left margin, shift-click or drag to
  extend), and a small prompt pill appears. Start typing (or press `Ctrl/Cmd+I` from inside an
  editor), press `Enter`, and carry on writing. `/skill-name` at the start runs a skill.
- A job's scope is `selection` (the target blocks), `whole article`, or `research` (no edits; the
  answer opens in a side panel where any note can be inserted as a block).
- Results arrive as ghost diffs in place: replacements as inline diffs, insertions as ghost
  blocks, deletions struck through. Accept or reject per change or for the whole job — by mouse,
  or focus a change and press `Enter` / `Backspace` (`Ctrl/Cmd+Enter` / `Ctrl/Cmd+Backspace` for
  the whole job). Nothing enters the article until you accept it.
- Many jobs run at once. A second job on a busy block waits until the first is accepted or
  rejected, then runs against the outcome. A whole-article job runs alone. Editing is never
  blocked; if you edit a block while its job runs, the result is compared with your current
  text and marked "changed since request".
- The tray in the bottom-right corner appears while there are jobs: status, streamed progress,
  cancel, and the raw output of failed or stale jobs.

## Workspace layout

```
<workspace>/
  strategy.md                 global voice, audience, structure rules
  sources/                    reference files agents may read
  content/posts/<slug>/       Hugo leaf bundle: index.md + assets
  .zen/
    config.json               settings (validated; every key has a default)
    articles/<slug>/brief.md  per-article outline, angle, target reader
    jobs/<job-id>/            one directory per agent job
```

`contentDir` in `.zen/config.json` is relative to the workspace by default. It may be an absolute
path to point straight into a Hugo site's `content/` directory; articles then live where Hugo
wants them and `hugo server` is the true preview.

## Agents and settings

Settings are reachable from the palette (`Settings…`) and stored in `<workspace>/.zen/config.json`
(validated; an invalid file is reported and never overwritten):

| Key | Meaning |
| --- | --- |
| `mainAgent` | `claude`, `codex`, or `fake`. Switching is a settings change, nothing else. |
| `taskAgents` | per-task overrides, for example `{ "image": "codex" }`; resolved before `mainAgent` |
| `contentDir` | `content` by default; relative to the workspace, or an absolute path into a Hugo site |
| `theme` | `system`, `light`, `dark` |
| `concurrency` | how many agent processes run at once (jobs waiting for review do not count) |
| `jobTimeoutSec` | a job that produces no result in this time is stopped |
| `adapters.<name>` | `command`, `model`, `extraArgs`, and `baseArgs` (replaces the verified default command line; `{jobDir}`, `{jobRel}`, `{workspace}` are substituted) |

The agent CLIs use your own logins; openwrite stores no keys. Agents run with the narrowest
permissions that work: `claude` may read the workspace and write only inside its job directory;
`codex` may write only inside its job directory (its sandbox cannot restrict reads). The exact
command lines and how they were verified are in [DECISIONS.md](DECISIONS.md), "Real agents".
`npm start -- --adapter fake` forces the built-in fake agent for a session.

Every job gets copies of `strategy.md` and the article's `brief.md` and is told to follow them.
The palette has `Edit strategy`, `Edit brief`, `Draft brief from my notes`, and
`Draft article from brief`; the two drafts are ordinary jobs whose proposal you review.

To check a real adapter on your machine (spends credits, never part of the test suite):

```bash
node scripts/verify-adapter.ts claude --extra="--max-budget-usd 0.50"
node scripts/verify-adapter.ts codex
```

### herdr (optional)

[herdr](https://herdr.dev) is a terminal multiplexer for coding agents. With `mainAgent: "herdr"`
a job runs as an interactive `claude` in a pane of the named herdr session `openwrite-jobs`
(`adapters.herdr.session` changes the name), confined exactly like the direct adapter. You can
attach while it runs — the tray shows `herdr session attach openwrite-jobs` — watch sub-agents,
and step in when the agent blocks; the job still completes through the file contract. It needs
`herdr` on `PATH`, has no spend cap, and supports claude only. What was tried and why it was
adopted: [docs/herdr-evaluation.md](docs/herdr-evaluation.md).

## Adding an adapter

An adapter only launches a process and relays progress; the file contract does the rest.

1. Implement `AgentAdapter` from `src/server/adapters/types.ts`:
   `start(jobDir, options) → { progress: AsyncIterable<{ text }>, done: Promise<Completion>, cancel() }`.
   For a CLI, describe it as a `CliSpec` (`buildArgs`, `readLine`, `authPattern`, `loginHint`) and
   wrap it with `createProcessAdapter` from `process-adapter.ts` — see `claude.ts` and `codex.ts`.
   Launching, line splitting, bounded output, process-tree cancel, and failure mapping come with it.
2. Register it in `createApp` (`src/server/app.ts`): `registry.register(createMyAdapter())`. It
   then appears in settings; `adapters.<name>` overrides work without further code.
3. Verify every flag against the tool's `--help`, prove the write confinement with
   `scripts/verify-adapter.ts`, and record both in `DECISIONS.md`. Never default to a permission
   bypass.
4. Test the command line and the stream mapping like `src/server/adapters/adapters.test.ts`.
   No test may need the real CLI.

## Skills and media

Media types are agent skills, not editor features: the editor only knows that a job can return
assets plus blocks that reference them. A skill is a prompt template in `skills/` that any
adapter can run. Run one from the palette (`Run skill: <name>`) or start an instruction with
`/name`.

| Skill | What it does |
| --- | --- |
| `diagram` | returns a fenced `mermaid` block (the editor renders mermaid fences anyway) |
| `terminal-recording` | writes a script, records it with `asciinema`, converts it to a gif with `agg`, returns the cast and the gif. Needs both tools on `PATH`; when one is missing the job fails at once with "Missing on PATH: …" and no agent is started. openwrite never installs them. |
| `image` | runs on the agent configured for image tasks in settings (`taskAgents.image`), otherwise on the main agent |
| `video` | **a stub.** It is listed and refuses to run. A real one would be a prompt like `image`, an agent or tool that can produce video, and an `.mp4`/`.webm` asset referenced from a Hugo `video` shortcode or a `<video>` tag. |
| `draft-brief`, `draft-article` | behind the palette's "Draft brief from my notes" and "Draft article from brief" |

## Adding a skill

Add `skills/<name>.md`. Nothing else changes: the server lists the directory, the palette gets a
"Run skill" entry, and `/name` works in the prompt pill.

```markdown
---
name: haiku                      # must match the file name
description: Rewrite as a haiku  # shown in the palette
scope: blocks                    # blocks | article | research (default: blocks)
task: text                       # optional; picks taskAgents.<task> from settings
requires: [sometool]             # optional; checked on PATH before an agent starts
allow: [Bash(sometool *)]        # optional; extra tool allowances (claude adds them to its allow list)
network: false                   # optional; codex opens the network only when true
stub: false                      # optional; true lists the skill but refuses to run it
---
The prompt: what to produce, as ops on the target blocks, and which files to put into `assets/`.
```

The body is inserted into the job's `instruction.md` under "Skill: <name>", between the writer's
instruction and the contract rules, so it should describe the *what* and leave the `result.json`
format to the contract.

## Export

From the palette, for the article on screen; each produces a zip download:

- **Export: markdown + assets** — the leaf bundle as is: exact markdown bytes and every file next
  to it.
- **Export: standalone HTML + assets** — `index.html`, one `style.css`, and the assets. The
  article is rendered with the editor's own pipeline; mermaid diagrams become inline SVG, so the
  page needs no script and opens offline. Hugo `figure` shortcodes become `<figure>`; other
  shortcode tags are dropped and their inner content kept. A diagram that cannot render fails
  the export with a message.

No DOCX or PDF.

## The job file contract

The contract between the editor and an agent is files, so it works with any agent. For each job
the server creates `<workspace>/.zen/jobs/<id>/`:

| File | Written by | Content |
| --- | --- | --- |
| `instruction.md` | server | the writer's prompt, the scope and its rules, the skill body if any, the output schema |
| `article.md` | server | a snapshot of the document, each block wrapped in `<!-- zen:block id=bN -->` … `<!-- /zen:block -->`; targets carry `target`. Markers exist only here, never in the article. An empty document has the virtual block `b0`. |
| `targets.json` | server | `{ "scope", "blockIds", "selection" }` — `selection` has the selected text and, for a selection made in edit mode, `from`/`to` offsets into the block |
| `strategy.md`, `brief.md` | server | copies of the workspace strategy and the article's brief |
| `job.json`, `progress.log` | server | lifecycle state (`version: 1`), the settings the job was launched with, bounded progress log |
| `result.json` | agent | the proposal (below) |
| `assets/` | agent | generated files, referenced from markdown as `assets/<file>` |
| `result.invalid.json`, `repair.md` | server | only after a rejected result: the rejected output and the repair instructions |

The agent runs with the workspace as its working directory (so it can read `sources/`), writes
`result.json` and `assets/`, and modifies nothing else.

```json
{
  "summary": "one line describing what was done",
  "ops": [
    { "op": "replace", "block_id": "b12", "markdown": "..." },
    { "op": "insert_after", "block_id": "b12", "markdown": "..." },
    { "op": "insert_before", "block_id": "b12", "markdown": "..." },
    { "op": "delete", "block_id": "b13" }
  ],
  "assets": [{ "file": "assets/diagram.png", "alt": "..." }],
  "notes": "free-form markdown, used for research answers and caveats"
}
```

The file is validated with zod (unknown ops or keys reject it) and then against the job: for
`blocks` scope, ops may only touch the target blocks or insert next to them; `research` must have
no ops; asset paths must stay inside `assets/` and exist. A rejected result gets one automatic
repair attempt; after that the job fails and the raw output is shown in the tray.

Job states: `queued → running → validating → (repairing →) ready → settled`, or `failed`
(`missing-cli`, `missing-tool`, `auth`, `timeout`, `invalid-result`, `exit`), `cancelled`,
`stale`. A stale job (deleted target, app restart, page reload) keeps its output visible.

## Development

```bash
npm run dev          # Node server (watch) + Vite, http://127.0.0.1:5173
npm run format       # biome format --write
npm run lint
npm run typecheck
npm test             # Vitest; one file: npm test -- src/server/paths.test.ts
npm run test:e2e     # Playwright; first run: npx playwright install --with-deps chromium
npm run build
```

Every check uses the sample workspace, temp directories, and the `fake` adapter. No test needs
network, keys, or an agent CLI.
