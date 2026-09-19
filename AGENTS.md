# openwrite — Agent guide

Guidance for AI agents (and humans) contributing to **openwrite**.

openwrite is a local-first, block-based markdown editor for technical blog
posts, with agent-powered editing. One user for now: they write markdown,
publish with Hugo, and already use CLI coding agents (Claude Code, Codex). The
editor is calm and minimal; AI help appears only when reached for, and several
agent jobs run in the background while the writer keeps writing. The project
follows GitHub flow: `main` is always runnable, work happens on short-lived
branches, and every change lands through a pull request.

**Status (2026-09-19): no code exists yet.** Everything below marked *planned*
is the contract the first scaffold must create. When the scaffold lands, replace
*planned* with what was built, in the same PR.

Use [README.md](README.md) for setup, the workspace layout, the job file
contract, and how to add an adapter or a skill. Record every non-obvious
decision, with a one-line reason, in [DECISIONS.md](DECISIONS.md) — including
any place the build spec turned out to be a bad idea and what replaced it.

## Prerequisites

Versions are what is installed on the dev machine as of 2026-09-19.

- **Node.js ≥ 24 + npm** (v24.14.1 / 11.11.0). TypeScript everywhere.
- **Playwright browser binaries** — `npx playwright install --with-deps`, once
  per machine or container.
- **`gh` CLI** for PRs (2.92.0).
- **Agent CLIs, only for the real adapters:** `claude` (2.1.278), `codex`
  (codex-cli 0.155.1). They use the user's own logins; the app stores no keys.
- **Hugo** (v0.154.5 extended) — the user's true preview. No test depends on it.
- **`asciinema` and `agg`** — not installed. Only the terminal-recording skill
  needs them; it must detect that they are missing and say so clearly.
- **`herdr`** (0.9.1) — optional adapter backend, evaluated in milestone 5.

## Commands

npm scripts are the single source of the dev flow. `npm run dev` and
`npm start` are fixed by the spec; the other names are *planned* and the
scaffold must create them exactly.

- **Install / bootstrap:** `npm install`
- **Run locally (dev):** `npm run dev`
- **Run locally (production):** `npm start` — opens the editor on the sample
  workspace
- **Lint:** `npm run lint`
- **Format:** `npm run format`
- **Type-check:** `npm run typecheck`
- **Test (unit, all):** `npm test`
- **Test (single file):** `npm test -- <path>`
- **Test (end-to-end):** `npm run test:e2e` — see
  [End-to-end tests](#end-to-end-tests-playwright)
- **Build:** `npm run build`

Lint, format, type-check, unit tests, e2e tests, and build use the sample
workspace, temp directories, and the `fake` adapter. They touch nothing shared
and spend nothing. Run them as often as needed, fix what your change broke, and
rerun without asking. The exceptions are in
[Decision boundaries](#decision-boundaries).

## Golden rules

1. **Never commit directly to `main`.** Always branch, always PR. The one
   exception is the first commit of the empty repository, which has nothing to
   branch from.
2. **Never force-push a shared branch.**
3. **Keep `main` green and runnable.** Every milestone ends with passing tests
   and an app that starts.
4. **Never disable, skip, or delete a test to make a build pass.** If a test is
   wrong, say so and propose the fix.
5. **Lossless round-trip.** Loading and saving an untouched file produces
   byte-identical output. Blocks are slices of the original text, cut at
   markdown-it's top-level token line maps; the exact whitespace between blocks
   is kept. Never serialise from tokens or re-render markdown — that normalises
   it. Hugo front matter and shortcodes (`{{< … >}}`, `{{% … %}}`) pass through
   unmodified, and a paired shortcode spanning several blocks stays one block.
6. **Nothing proprietary in the article.** The file on disk is plain markdown.
   Block IDs live in memory only. The ID marker comments exist only in a job's
   `article.md` snapshot, never in the article.
7. **Agents propose; the writer approves.** Nothing an agent produces enters
   the article until it is accepted. An agent writes only inside its own
   `.zen/jobs/<id>/` directory. `result.json` is validated with zod, and
   anything that does not conform is rejected.
8. **Never block the writer.** Agent work is asynchronous. No job, queue, or
   review state may freeze editing elsewhere in the document.
9. **Local and contained.** The server binds to `127.0.0.1` only. Every file
   path is guarded against traversal outside the workspace.
10. **No blanket permission bypass for agents.** Never default to flags such as
    `--dangerously-skip-permissions`. Use the narrowest settings that let the
    agent read the workspace and write inside its job directory.
11. **Verify agent CLI flags before relying on them.** The flags in the build
    spec are from memory. Check each against the installed tool's `--help` and
    note differences in `DECISIONS.md`.
12. **Small dependencies, boring code.** The product should feel light because
    it is light. A new runtime dependency gets a one-line reason in
    `DECISIONS.md`.

## What done looks like

A change is done when its code, tests, docs, and wiring are in one PR, the
checks pass locally, the app still starts, and the PR is open against `main`.
The first working implementation is not a stopping point: running the result,
inspecting it, and fixing what fails is part of the task. A read-only request
(explain, review, diagnose) is done when the report is delivered.

Make reasonable decisions yourself instead of stopping to ask, and record them
in `DECISIONS.md`. Build the job system against the `fake` adapter before
touching real agents.

The project's definition of done:

- `npm install && npm start` opens the editor on a sample workspace with a
  sample article, `strategy.md`, and `brief.md`.
- An untouched article saves byte-identically. A Hugo shortcode survives
  editing of neighbouring blocks.
- Two separate sections can each receive a different instruction while the
  writer types in a third, and both results arrive as ghost diffs.
- Switching the main agent between `claude` and `codex` in settings works
  without code changes.
- All unit and Playwright tests pass, using the fake adapter in CI.

## Decision boundaries

- **Safe without asking:** the full check suite; `--help` and `--version` on
  any agent CLI; creating and deleting sample or temp workspaces; removing a
  merged task worktree that has no uncommitted work.
- **Needs confirmation unless already authorized, and why:**
  - *Running a real `claude` or `codex` job* — it spends the user's
    subscription or API credits and starts an agent with file access. A task
    that is about a real adapter covers it; keep the prompt and workspace as
    small as the check allows.
  - *Pointing the content directory at a real Hugo site* — the app then writes
    into the user's real posts. Tests and demos use the sample workspace.
  - *Installing system tools* (`asciinema`, `agg`) — changes the user's
    machine. The skill's missing-tool path is testable without them.
  A request that already covers it is the confirmation. In an unattended run
  there is nobody to ask: leave that part unchanged and list it in the PR with
  the reason.
- **Never:** see [Golden rules](#golden-rules).

## Communication

- Explain the reasoning behind decisions and approaches.
- When claiming something works or is fixed, prove it — a passing test, a
  script that validates the behavior, or a clear explanation of why. Don't just
  assert.
- When uncertain, say so rather than presenting a guess as fact.
- End each response with a confidence indicator: 🟢 High | 🟡 Medium | 🔴 Low

## The GitHub flow, step by step

### 1. Start from an up-to-date `main`

```bash
git checkout main
git pull origin main
```

### 2. Create a branch — in a worktree

**Never edit a checkout of `main` directly.** Create the worktree before the
first edit, do the whole change there, and open the PR from it:

```bash
git worktree add .claude/worktrees/<short-topic> -b <type>/<short-topic>
```

`.claude/worktrees/` must be gitignored.

Branch names are short, lowercase, hyphenated, and prefixed by intent:

```
feat/<short-description>      # new feature
fix/<short-description>       # bug fix
refactor/<short-description>  # internal change, no behavior change
perf/<short-description>      # performance work
docs/<short-description>      # documentation only
chore/<short-description>     # tooling, deps, housekeeping
```

Examples: `feat/block-editor`, `fix/shortcode-split`.

### 3. Make focused changes

- One logical change per PR — and a whole feature *is* one logical change.
  Ship its code, tests, and docs together; don't split it across a chain of
  dependent PRs. Don't bundle an unrelated refactor into a fix either.
- **While the project is being set up, the initial build is one PR.** The build
  spec's milestones are checkboxes in that PR's Progress checklist, not
  separate PRs. Tick one only when its tests pass and the app starts, and
  commit at least once per milestone so each is a green point on the branch.
  Revisit this once the first version has landed.
- Match the surrounding style: strict TypeScript, typed data between client and
  server, zod at every boundary that reads a file or a message, early returns.
- Keep diffs focused: everything in the diff should serve that one change.
  Focused is about relevance, not size.
- **Fix it everywhere.** When you fix a problem, search the repo for the same
  problem — the *shape*, not the literal text — and fix every instance in the
  same PR. Put the count up front so the reviewer sees the scale. Stop and list
  the rest at generated code, where the fix would differ, or anything this file
  says needs confirmation.

### 4. Commit

Commits follow [Conventional Commits](https://www.conventionalcommits.org):

```
type(optional-scope): short imperative description
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`. Add `!` before the colon for a breaking change.

```
fix(blocks): keep paired shortcodes in one block
feat(jobs): queue a second job behind a running one
```

Write in the imperative mood ("add", not "added"). Keep the subject under ~72
characters and explain the *why* in the body when it isn't obvious. Commit at
least once per milestone; never commit a red tree.

### 5. Run the checks locally

These mirror what CI runs:

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

### 6. Push and open a PR

```bash
git push -u origin feat/<short-description>
gh pr create --base main --fill
```

Target **`main`**.

## PR titles

The PR title follows the same Conventional Commits format as commits:

```
type(optional scope)!: description
```

## PR description

Keep it short and useful:

- **What** changed and **why**.
- **A Progress checklist** — `- [x]` done, `- [ ]` open — covering the
  milestones inside this PR and any deferred follow-ups.
- **Numbers, not adjectives.** Anything you claim improved carries the value
  you measured and how to reproduce it — `npm test: 269 pass`, `-412 lines`.
  "Not measured" beats a vague adjective.
- **The gap**, for a bug fix: what was supposed to catch this, why it didn't,
  and what now would.
- **The sweep**, for any fix: the search you ran for other instances, and its
  count — found, fixed, and left (with why).
- **How to test** / what you ran.
- Screenshots for UI changes, in both light and dark themes.

## After opening the PR

- Make sure **CI is green**. CI runs the unit and Playwright suites with the
  `fake` adapter only; it never calls a real agent.
- Address review feedback by pushing more commits to the same branch.

## Project map (where things live)

*Planned* — the scaffold settles the repo layout; update this in the same PR.

```
src/shared/         block model (split, serialise), result.json zod schema, job types
src/server/         Node server (Hono or Fastify): filesystem, jobs, agent adapters, event stream
  adapters/           fake, claude, codex (, herdr)
src/client/         Vite + React: blocks, CodeMirror 6 editing, palette, job tray, ghost diffs
skills/             prompt templates any adapter can run: diagram, terminal recording, image, video (stub)
sample-workspace/   sample article, strategy.md, brief.md — what `npm start` opens
e2e/                Playwright specs
docs/               herdr-evaluation.md and other notes
```

Layering: the client never touches the filesystem; it talks to the server over
HTTP plus WebSocket or SSE. The server owns the filesystem and spawns agents.
`src/shared/` has no I/O, so client, server, and tests all import it. An
adapter only launches a process and relays progress; the file contract does
the rest.

The user's **workspace** (separate from this repo; `content/` is configurable
so it can point into a Hugo site):

```
<workspace>/
  strategy.md                 global voice, audience, structure rules
  sources/                    reference files agents may read
  content/posts/<slug>/       Hugo leaf bundle: index.md + assets
  .zen/
    config.json               settings
    articles/<slug>/brief.md  per-article outline, angle, target reader
    jobs/<job-id>/            one directory per agent job
```

## Conventions

- **Naming:** files kebab-case, types and React components PascalCase, unit
  tests `*.test.ts` next to the code, e2e specs `e2e/*.spec.ts`.
- **Configuration:** user settings live in `<workspace>/.zen/config.json`,
  validated with zod on read. Each adapter's command line, model, and extra
  args are overridable there. No secrets are stored.
- **The job file contract:** the server writes `instruction.md`, `article.md`
  (snapshot with ID marker comments), `targets.json`, and `strategy.md` /
  `brief.md` copies or paths into `.zen/jobs/<id>/`. The agent runs with the
  workspace as its working directory, writes `result.json` and `assets/` into
  the job directory, and modifies nothing else. For `blocks` scope, ops may only
  touch the target blocks or insert next to them.
- **Job scopes:** `blocks`, `article` (exclusive: waits for running jobs, new
  block jobs queue behind it), `research` (no edits; answer goes to notes).
- **Media are agent skills, not editor features.** The editor only knows that a
  job returns assets plus blocks that reference them. A new media type is a
  prompt template in `skills/`, never new editor code.
- **Error handling:** adapter failures — missing CLI, auth error, timeout,
  malformed `result.json` (one automatic repair attempt, then surface the raw
  output) — become job states shown in the tray. A stale job keeps its output
  visible so nothing is lost.
- **Registering new components:** a new adapter implements `AgentAdapter`
  (`start(jobDir, options) -> handle` with a progress stream, `cancel()`,
  completion) and is added to the adapter registry; a new skill is a file in
  `skills/`. README documents both.
- **UI:** zen by default — a centered text column of about 680px, light and
  dark themes, no toolbar, no sidebar. Controls appear on hover, on selection,
  or through the command palette (`Cmd/Ctrl+K`). A new always-visible control
  needs a reason in `DECISIONS.md`.

## Testing

- **Framework / runner:** Vitest for unit tests (*planned*), Playwright for e2e.
- **Location & naming:** `*.test.ts` next to the code; `e2e/*.spec.ts`.
- **What to cover:** a property-style round-trip test (parse then serialise
  equals the input) over a corpus with front matter, shortcodes, nested lists,
  tables, code fences, HTML blocks, and odd whitespace. Unit tests for op
  validation, op application, queueing, and every conflict rule. New code
  covers its happy path, error paths, and edge cases.
- **Fixtures / stubs:** the deterministic `fake` adapter stands in for every
  agent. No test needs network, keys, or an installed agent CLI.

## End-to-end tests (Playwright)

- **Specs live in:** `e2e/`, named `*.spec.ts`
- **Config:** `playwright.config.ts` (*planned*) — the `webServer` block starts
  the app against a temp copy of the sample workspace with the `fake` adapter,
  so the run starts the app itself.
- **Browser binaries:** `npx playwright install --with-deps`. A "browser not
  found" / "executable doesn't exist" error means this hasn't been run.

Prefer `npm run test:e2e`; the raw forms:

```bash
npx playwright test                          # everything, headless
npx playwright test e2e/click-to-edit.spec.ts  # one spec
npx playwright test -g "<test title>"        # one test by title
npx playwright test --reporter=list          # plain streaming output
```

> ⚠️ `npx playwright show-report` and `npx playwright show-trace` both start a
> **blocking** web server — they never return. Never run either in an automated
> session. Read the artifacts on disk instead.

**`--headed`, `--debug`, and `--ui`** are for a human at a terminal. `--headed`
needs a display; `--debug` and `--ui` additionally wait for input, so they hang
an automated run.

**Flows that must stay covered:** click-to-edit, blur-to-render, keyboard
navigation between blocks, paste splitting, drag reorder, undo across the
document, and the full select → prompt → review → accept flow with the fake
adapter, including two overlapping jobs.

**Writing tests here:**

- **Selectors:** `getByRole` / `getByLabel` first; `data-testid` only when
  there is no accessible handle (rendered blocks, drag handles); never CSS or
  XPath tied to styling.
- **Waiting:** use web-first assertions — `await expect(locator).toBeVisible()`
  auto-retries until the timeout. Never `waitForTimeout`. The fake adapter's
  timing is controlled by the test, not by sleeps.
- **Test data:** each test gets its own temp copy of the sample workspace.
- **Isolation:** tests run in parallel, so no test may depend on another's
  leftovers or on file order.

**When one fails:** the trace, screenshot, and video land under
`test-results/<test>/`. Read the screenshot and the error text first.

A flaky e2e test is a real finding, not noise — fix it or report it. Never
`test.skip` or `--grep-invert` one to get a green run.

## Security

- Never commit secrets, API keys, credentials, or sensitive data.
- The server listens on `127.0.0.1` only and has no auth model: local access is
  the boundary, so it must never bind wider.
- Resolve every path from the client or from a `result.json` against the
  workspace root and reject anything that escapes it — asset paths included.
- Agent output is untrusted input: validate `result.json` with zod, and treat
  rendered markdown and mermaid from a job like any other external content.

## Hazards

None recorded yet. When an incident produces a rule, add it here in the same PR
that fixes the incident, as its own subsection: the rule, the mechanism, the
evidence it is real, the safe recipe, and the near-misses.

## Where to look

- `README.md` — setup, workspace layout, job file contract, adding an adapter
  or a skill
- `DECISIONS.md` — why a non-obvious choice was made, and verified CLI flags
- `src/shared/` — the block splitter and the `result.json` schema (*planned*)
- `docs/herdr-evaluation.md` — what was tried with herdr, if it was not adopted
