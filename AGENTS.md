# openwrite — Agent guide

Guidance for AI agents (and humans) contributing to **openwrite**.

openwrite is a local-first, block-based markdown editor for technical blog
posts, with agent-powered editing. One user for now: they write markdown,
publish with Hugo, and already use CLI coding agents (Claude Code, Codex). The
editor is calm and minimal; AI help appears only when reached for, and several
agent jobs run in the background while the writer keeps writing. Work happens
directly on `main`: no branches, no worktrees, no pull requests.

**Status:** the first version is built: the editor, the job system, the
`claude`, `codex`, `herdr` and `fake` adapters, skills, and export. This file
describes what exists; update it in the same change as the code it describes.

Use [README.md](README.md) for setup, the workspace layout, the job file
contract, and how to add an adapter or a skill. Record every non-obvious
decision, with a one-line reason, in [DECISIONS.md](DECISIONS.md) — including
any place the build spec turned out to be a bad idea and what replaced it.

## Prerequisites

Versions are what is installed on the dev machine as of 2026-09-19.

- **Node.js ≥ 24 + npm** (v24.14.1 / 11.11.0). TypeScript everywhere.
- **Playwright browser binaries** — `npx playwright install --with-deps chromium`,
  once per machine or container; add `firefox webkit` for `npm run test:e2e:all`.
- **Linux or macOS.** Windows is not supported yet (only the unit suite runs there, in CI); README, "Windows",
  lists what was made portable and what is known not to work.
- **Agent CLIs, only for the real adapters:** `claude` (2.1.278), `codex`
  (codex-cli 0.155.1). They use the user's own logins; the app stores no keys.
- **Hugo** (v0.154.5 extended) — the user's true preview. No test depends on it.
- **`asciinema` and `agg`** — not installed. Only the terminal-recording skill
  needs them; the server checks the skill's `requires:` header on `PATH` and
  fails the job at once, naming what is missing.
- **`herdr`** (0.9.1) — optional adapter backend; see
  [docs/herdr-evaluation.md](docs/herdr-evaluation.md).

## Commands

npm scripts are the single source of the dev flow (`package.json`).

- **Install / bootstrap:** `npm install`
- **Run locally (dev):** `npm run dev` — Node server with `--watch` on
  `127.0.0.1:4317` plus Vite on every interface at port `5173`
- **Run locally (production):** `npm start` — builds the client when it is
  missing or stale (`scripts/ensure-build.ts`), then opens the editor on a
  gitignored copy of the sample workspace (`.openwrite/sample-workspace/`);
  `npm start -- --workspace <dir>` opens another one
- **Lint:** `npm run lint` — Biome, warnings fail
- **Format:** `npm run format` writes; `npm run format:check` verifies (CI)
- **Type-check:** `npm run typecheck`
- **Unused code:** `npm run knip` — unused exports, files and dependencies; the
  entry points and every ignore are listed, with reasons, in `knip.jsonc`
- **Test (unit, all):** `npm test`
- **Test (single file):** `npm test -- <path>`
- **Test (end-to-end):** `npm run test:e2e` (Chromium) — see
  [End-to-end tests](#end-to-end-tests-playwright)
- **Test (end-to-end, all engines):** `npm run test:e2e:all` — Chromium, Firefox
  and WebKit, as CI runs it
- **Build:** `npm run build`

Lint, format, type-check, unit tests, e2e tests, and build use the sample
workspace, temp directories, and the `fake` adapter. They touch nothing shared
and spend nothing. Run them as often as needed, fix what your change broke, and
rerun without asking. The exceptions are in
[Decision boundaries](#decision-boundaries).

## Golden rules

1. **Work directly on `main`.** Commit straight to `main`; no branches, no
   worktrees, no pull requests.
2. **Never force-push `main`.**
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
   Block IDs live in memory only (and, across a reload, in the tab's
   `sessionStorage`). The ID marker comments exist only in a job's `article.md`
   snapshot, never in the article.
7. **Agents propose; the writer approves.** Nothing an agent produces enters
   the article until it is accepted. An agent writes only inside its own
   `.zen/jobs/<id>/` directory. `result.json` is validated with zod, and
   anything that does not conform is rejected.
8. **Never block the writer.** Agent work is asynchronous. No job, queue, or
   review state may freeze editing elsewhere in the document.
9. **Local and contained.** The server binds to `127.0.0.1` only. The one
   exception is `npm run dev`, where Vite listens on every interface and proxies
   to the loopback server (`DECISIONS.md`, "Local-only hardening"). Every file
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

A change is done when its code, tests, docs, and wiring are committed to
`main`, the checks pass locally, and the app still starts.
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
  any agent CLI; creating and deleting sample or temp workspaces.
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
  there is nobody to ask: leave that part unchanged and note the reason in the
  commit message.
- **Never:** see [Golden rules](#golden-rules).

## Communication

- Explain the reasoning behind decisions and approaches.
- When claiming something works or is fixed, prove it — a passing test, a
  script that validates the behavior, or a clear explanation of why. Don't just
  assert.
- When uncertain, say so rather than presenting a guess as fact.
- End each response with a confidence indicator: 🟢 High | 🟡 Medium | 🔴 Low

## The workflow, step by step

### 1. Start from an up-to-date `main`

```bash
git pull origin main
```

Work directly in the repository checkout, on `main`. No branches, no
worktrees.

### 2. Make focused changes

- One logical change per commit — and a whole feature *is* one logical change.
  Ship its code, tests, and docs together; don't split it across a chain of
  dependent commits. Don't bundle an unrelated refactor into a fix either.
- **While the project is being set up, the initial build is a series of
  commits.** The build spec's milestones are checkboxes in the change's
  Progress checklist. Tick one only when its tests pass and the app starts, and
  commit at least once per milestone so each is a green point on `main`.
  Revisit this once the first version has landed.
- Match the surrounding style: strict TypeScript, typed data between client and
  server, zod at every boundary that reads a file or a message, early returns.
- Keep diffs focused: everything in the diff should serve that one change.
  Focused is about relevance, not size.
- **Fix it everywhere.** When you fix a problem, search the repo for the same
  problem — the *shape*, not the literal text — and fix every instance in the
  same commit. Put the count in the commit message. Stop and list the rest at
  generated code, where the fix would differ, or anything this file says needs
  confirmation.

### 3. Commit

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

### 4. Run the checks locally

The same checks CI runs. Two differences: CI runs `npm run format:check` (it
must not rewrite files; run `npm run format` before you commit so it passes),
CI builds before the e2e suite (locally `test:e2e` builds the client itself
when it is missing or stale), and CI runs the e2e suite on Chromium, Firefox and
WebKit (`npm run test:e2e:all` locally; run it for a change to the editor, the
shell, pasting or layout):

```bash
npm run format        # CI: npm run format:check
npm run lint
npm run typecheck
npm run knip
npm test
npm run test:e2e
npm run build
```

### 5. Push to `main`

```bash
git push origin main
```

Target **`main`**.

## Commit messages

Beyond the conventional format, keep a commit body short and useful:

- **What** changed and **why**.
- **A Progress checklist** — `- [x]` done, `- [ ]` open — covering the
  milestones in this change and any deferred follow-ups.
- **Numbers, not adjectives.** Anything you claim improved carries the value
  you measured and how to reproduce it — `npm test: 269 pass`, `-412 lines`.
  "Not measured" beats a vague adjective.
- **The gap**, for a bug fix: what was supposed to catch this, why it didn't,
  and what now would.
- **The sweep**, for any fix: the search you ran for other instances, and its
  count — found, fixed, and left (with why).
- **How to test** / what you ran.

## After pushing

- Make sure **CI is green**. CI runs the unit and Playwright suites with the
  `fake` adapter only; it never calls a real agent.

## Project map (where things live)

```
src/shared/           no I/O; imported by client, server, and tests
  blocks/               types, split, serialise, reconcile, merge (the three-way merge a reload runs), doc-ops, shortcodes,
                        front-matter, index (barrel), test-helpers, corpus/
  jobs/                 result-schema, validate-ops, apply-ops, scheduler, asset-refs, job-types, scope, herdr-hint,
                        conversation (the agent panel's earlier turns → conversation.md)
  config-schema.ts  api-types.ts  workspaces-schema.ts  events.ts  key-values.ts  names.ts
  contrast.ts  ports.ts
src/server/           Hono on Node (TypeScript run natively, no build step)
  main.ts               CLI flags, binds 127.0.0.1, opens the browser
  app.ts                createApp(options): wires workspace, watcher, jobs, adapters, routes
  paths.ts security.ts  the path guard; Host/Origin/content-type hardening
  context.ts            AppOptions and the ServerContext every route module receives
  workspace.ts workspace-list.ts config.ts watcher.ts sse.ts assets.ts export.ts http.ts
  skills.ts skills-watcher.ts  shipped skills/ plus <workspace>/.zen/skills/ (guarded, errors kept); skills.changed
  svg.ts                the allow-list SVG sanitiser every stored or served SVG goes through
  test-helpers.ts       createTestApp(): a temp copy of the sample workspace plus an in-process app
  routes/               events (SSE), docs (documents, articles, assets), config, jobs (+ fake control),
                        workspaces (the known list, switch, create, erase), export
  jobs/                 manager (lifecycle, repair, decisions, clear finished), job-files (the contract), store (job.json, restart recovery),
                        job-io (the only way to touch an agent-writable job directory: no-follow, regular files only, removeJobDir),
                        retention (which finished jobs are pruned when a workspace opens)
  adapters/             types, registry, channel, spawn, process-adapter, claude, codex, herdr, fake, fixtures/echo-agent,
                        test-helpers (the AdapterOptions fixture and the pid probe the adapter and job tests share)
src/client/           Vite + React
  index.html main.tsx App.tsx   entry points and the shell (global keys, notices, overlays)
  api.ts                every request, zod-parsed against src/shared/api-types.ts
  state/                store, doc-reducer (pure, history), app (load/save/events), jobs (held requests, decisions, clear finished), describe-clear,
                        session (pure: what a reload keeps, which jobs a tab may still apply), tab (the tab ID; sessionStorage, pagehide)
  blocks/               BlockList, Block, BlockEditor (CodeMirror 6), RenderedBlock, FrontMatterLine, click-to-offset,
                        ConflictCard (a passage both this tab and the file changed), SourceDiff (the word diff it and ghosts show)
  render/               markdown (markdown-it → DOMPurify, highlight.js, mermaid), export-html
  shell/                Shell (the two edge panels and their handles), LeftPanel, RightPanel,
                        layout (pure: dock/stack/overlay), keys (pure: global key precedence), state
  palette/              Palette, commands (the command registry), group (the command taxonomy)
  jobs/                 PromptPill, selection, GhostDiff, Tray (Transcript, and the corner JobCount), Composer,
                        ResearchPanel, commands, instruction (the pure `/skill` parser)
  settings/             Settings, commands
  workspaces/           switch (the switch: save first, adopt once, the `moved` wait), commands,
                        WorkspaceStatus (the switch under way; another tab moved the workspace)
  export.ts  use-restore-focus.ts  theme.css (tokens: colours, type and spacing scales; theme-contrast.test.ts and theme-scale.test.ts check them)
skills/               prompt templates: diagram, terminal-recording, image, video (stub), draft-brief, draft-article
                      (a workspace adds its own in <workspace>/.zen/skills/; a shipped name wins)
sample-workspace/     sample article, strategy.md, brief.md; `npm start` opens a gitignored copy of it
scripts/              ensure-build, e2e-server, screenshots, verify-adapter (manual, real agents)
.github/workflows/    ci.yml: checks (format:check, lint, typecheck, knip, test, build), e2e per engine
                      (chromium, firefox, webkit), unit (windows) (fake adapter only)
e2e/                  Playwright specs, fixtures.ts (one server per test), helpers.ts,
                      start-server.ts (spawns scripts/e2e-server.ts; also used by scripts/screenshots.ts)
docs/                 herdr-evaluation.md, ui-inventory.md (every option's home), screenshots/
```

Layering: the client never touches the filesystem; it talks to the server over
HTTP plus SSE (`src/server/sse.ts`, `connectEvents` in `src/client/state/app.ts`).
The server owns the filesystem and spawns agents.
`src/shared/` has no I/O, so client, server, and tests all import it. An
adapter only launches a process and relays progress; the file contract does
the rest.

The user's **workspace** is separate from this repo; its layout is in
[README.md](README.md#workspace-layout). `content/` is configurable so it can
point into a Hugo site.

## Conventions

- **Naming:** files kebab-case, types and React components PascalCase, unit
  tests `*.test.ts` next to the code, e2e specs `e2e/*.spec.ts`.
- **Configuration:** user settings live in `<workspace>/.zen/config.json`,
  validated with zod on read. Each adapter's command line, model, and extra
  args are overridable there. No secrets are stored.
- **The job file contract** — the files the server writes into
  `.zen/jobs/<id>/`, what the agent writes back, and `codex`'s different
  working root — is in [README.md](README.md#the-job-file-contract). For
  `blocks` scope, ops may only touch the target blocks or insert next to them.
- **Job scopes:** `blocks`, `article` (exclusive: waits for running jobs, new
  block jobs queue behind it), `research` (no edits; answer goes to notes).
- **Media are agent skills, not editor features.** The editor only knows that a
  job returns assets plus blocks that reference them. A new media type is a
  prompt template in `skills/`, never new editor code.
- **Error handling:** adapter failures — missing CLI, auth error, timeout,
  malformed `result.json` (one automatic repair attempt, then surface the raw
  output) — become job states shown in the agent panel. A stale job keeps its output
  visible so nothing is lost.
- **Registering new components:** a new adapter implements `AgentAdapter`
  (`start(jobDir, options) -> handle` with a progress stream, `cancel()`,
  completion) and is added to the adapter registry; a new skill is a file in
  `skills/`. README documents both.
- **UI:** zen by default — a centred text column of about 680px, light and
  dark themes, no toolbar. Two edge panels — **Files and actions** (left) and
  **Agent** (right) — are closed on first run, open with `Ctrl/Cmd+B` /
  `Ctrl/Cmd+Alt+B` or their edge handles, dock beside the column only when it
  keeps its 680px (otherwise the agent panel stacks after the article and the
  left one becomes a drawer opened by hand), and never take the keyboard by
  opening. Everything else appears on hover, on selection, or through the
  command palette (`Cmd/Ctrl+K`), which reaches every command. Every command,
  control and setting has one home in `docs/ui-inventory.md` (a unit test
  keeps it complete). A new always-visible control needs a reason in
  `DECISIONS.md`.

## Testing

- **Framework / runner:** Vitest for unit tests (`vitest.config.ts`, node
  environment, fails on an empty suite), Playwright for e2e.
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
- **Config:** `playwright.config.ts` — the `webServer` block runs
  `scripts/e2e-server.ts`, which starts the app against a temp copy of the
  sample workspace with the `fake` adapter, so the run starts the app itself.
  Tests that write use the `app` fixture in `e2e/fixtures.ts`: one server
  process on a free port and one workspace copy per test. Three projects:
  `chromium`, `firefox`, `webkit`; `npm run test:e2e` runs `chromium`,
  `npm run test:e2e:all` all three, and both build the client first when it is
  missing or stale. A test only one engine can run is scoped with `browserName`
  and a comment, and gets a line in `DECISIONS.md`; none is so far.
- **Ports:** the `webServer` smoke server takes a free port too, picked once in
  the runner and handed to the workers through `OPENWRITE_E2E_PORT`, so runs in
  several checkouts or worktrees on one machine never collide. Set
  `OPENWRITE_E2E_PORT=<port>` to pin it; an invalid value fails the run at once.
- **Browser binaries:** `npx playwright install --with-deps chromium firefox webkit`
  (`--with-deps` installs system libraries and needs root; without it the
  browsers still download into the user's cache). A
  "browser not found" / "executable doesn't exist" error means this hasn't been
  run.

Prefer `npm run test:e2e`; the raw forms:

```bash
npx playwright test                          # everything, all three engines, headless
npx playwright test --project=firefox        # one engine
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
adapter, including two overlapping jobs, plus the shell: panel toggle and
persistence, reaching an article from the left panel, the agent panel's
composer, and a follow-up turn carrying the earlier one (`panels.spec.ts`,
`agent-panel.spec.ts`), and a reload mid-job keeping block identity, queued
requests and reviews, and a reload before autosave keeping the unsaved edit
or making it a conflict (`reload.spec.ts`). `two-tabs.spec.ts` pins down what the
README says about two tabs on one article: a save reaching the other tab, and a
conflict without a save ping-pong. A reload's three-way merge and its conflicts
(Keep mine / Take theirs / Keep both) are covered there and in
`external-change.spec.ts`.

**Writing tests here:**

- **Selectors:** `getByRole` / `getByLabel` first; `data-testid` only when
  there is no accessible handle (rendered blocks, drag handles); never CSS or
  XPath tied to styling. Test ids in use: `block`, `block-body`, `rendered`,
  `gutter`, `drag-handle`, `front-matter`, `diagram`, `ghost`, `ghost-struck`.
  Two class selectors remain on purpose, each with a comment: highlight.js's
  own `.hljs-keyword`, and `.diagram` in the exported file, which carries no
  test ids by contract.
- **Waiting:** use web-first assertions — `await expect(locator).toBeVisible()`
  auto-retries until the timeout. Never `waitForTimeout`. The fake adapter's
  timing is controlled by the test, not by sleeps.
- **Cross-engine habits** (each one was a Firefox or WebKit failure): compare
  layout edges with `SUBPIXEL` slack, never exactly; after `page.reload()` use
  `reloadArticle` before clicking; fixtures such as images must be well-formed
  (Firefox refuses what Chromium repairs); build synthetic events so every engine
  keeps their payload (`image-paste.spec.ts`).
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
  the boundary, so it must never bind wider. In dev, only Vite is exposed, and
  the Host check accepts this machine's own IPs at the Vite port — never an
  arbitrary hostname.
- Resolve every path from the client or from a `result.json` against the
  workspace root and reject anything that escapes it — asset paths included.
- Agent output is untrusted input: validate `result.json` with zod, and treat
  rendered markdown and mermaid from a job like any other external content.

## Hazards

### An allow list does not confine a real agent; prove confinement with sentinels

- **Rule:** never change an adapter's permission flags without re-running
  `node scripts/verify-adapter.ts <adapter>` and recording the result in
  `DECISIONS.md`. A flag that exists in `--help` is not evidence that it confines.
- **Mechanism:** `claude` with only `--allowedTools` and `--permission-prompts
  none` still honours the user's own settings and permission mode, so writes and
  reads outside the allow list can succeed. `--permission-mode dontAsk` plus
  `--restricted` is what denies them.
- **Evidence:** the first verification run (2026-09-19) created `probe.txt` in the
  workspace root and read a secret file outside the workspace; with the two
  flags added, all four sentinel checks pass (`DECISIONS.md`, "Real agents").
- **Safe recipe:** run the script in its throwaway workspace; ship only a command
  line that passes checks 1–3, and say so plainly if check 4 cannot pass.
- **Near-misses:** `codex -s read-only --add-dir <jobDir>` looks like the
  narrowest setting but cannot write `result.json` at all; and `codex` cannot
  confine reads with any documented flag.

### Inside a herdr pane, an unscoped `herdr` command acts on the live session

- **Rule:** every `herdr` call from this project removes the `HERDR_*`
  environment variables and passes `--session <name>`. Never run
  `herdr server stop`; never close panes, tabs, or workspaces you did not create.
- **Mechanism:** panes inherit `HERDR_SOCKET_PATH` and `HERDR_SESSION`, and the
  CLI uses them when no session is named.
- **Evidence:** inside a live pane, `herdr status` reported the live socket, while
  `herdr --session openwrite-eval status` reported a separate, not-running one
  (`docs/herdr-evaluation.md`).
- **Safe recipe:** prove the scoping with a read-only `status` before any
  mutating command; stop a test session by name with `herdr session stop <name>`
  after `herdr session list` confirms it.
- **Near-misses:** `pkill -f <pattern>` matched the shell that ran it when the
  pattern appeared in the same command line; use pid files.

## Where to look

- `README.md` — setup, workspace layout, job file contract, adding an adapter
  or a skill
- `DECISIONS.md` — why a non-obvious choice was made, and verified CLI flags
- `src/shared/blocks/split.ts` — the block splitter; `merge.ts` — the three-way merge of a reload; `src/shared/jobs/result-schema.ts`
  and `validate-ops.ts` — the `result.json` contract; `scheduler.ts` — the queue rules
- `src/server/jobs/manager.ts` — the job lifecycle; `src/server/adapters/` — one file per agent
- `src/server/workspace-list.ts` — the known-workspace list; `src/server/routes/workspaces.ts` —
  the switch (quiesce, retarget, rebind) and the four guards on the delete;
  `src/server/http.ts` `pinWorkspace` — why a request admitted under one workspace never runs
  against another; `src/client/workspaces/switch.ts` — the client side of a switch
- `src/client/shell/layout.ts` — where the edge panels dock, stack or overlay;
  `shell/keys.ts` — the global key precedence; `src/shared/jobs/conversation.ts` — which earlier
  turns a job carries in `conversation.md`, and their bounds
- `docs/ui-inventory.md` — every command, control and setting, and its one home
- `scripts/verify-adapter.ts` — the sentinel check for a real adapter's confinement
- `docs/herdr-evaluation.md` — what was tried with herdr, and why it was adopted
