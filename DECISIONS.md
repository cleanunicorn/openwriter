# Decisions

Every non-obvious choice, with a one-line reason. Newest sections are appended per milestone.
The build spec's working name `zen-editor` became **openwrite**; the workspace metadata
directory keeps the name `.zen/`.

## Toolchain and runtime

- **No server build step.** Node ≥ 24 runs TypeScript natively (type stripping), so
  `node src/server/main.ts` is both dev (`--watch`) and production. Cost: `.ts` import
  extensions and `erasableSyntaxOnly` (no enums, no parameter properties). Checked on Node
  v24.14.1 with `tsc` 7.0.2.
- **TypeScript 7 + Biome instead of ESLint + Prettier.** `typescript-eslint` declares
  `typescript >=4.8.4 <6.1.0`, which excludes the current TypeScript (7.0.2). Biome lints and
  formats with one dev dependency. Fallback if a tool lags TypeScript 7: pin 6.0.x.
- **`npm run format` writes; `npm run format:check` verifies.** CI runs `format:check`, so
  unformatted code cannot pass by being rewritten in the runner.
- **Biome's `style/noDescendingSpecificity` is off.** theme.css orders rules by component, not by
  specificity; the rule flags two pairs that are correct as written and never match the same
  element (`.block + .ghost` before `.ghost`, `.mermaid-block[…] > pre` before `.tray-output pre`), and with `--error-on-warnings` that would
  fail the gate. No other rule is disabled.
- **`sample-workspace/` is excluded from Biome.** It is test data and the writer's content: the
  sample `config.json` and the markdown must stay byte-for-byte what the tests expect, not what a
  formatter prefers.
- **`npm run lint` uses `--error-on-warnings`.** Biome reports several recommended rules as
  warnings, which exit 0; the gate must fail on them.
- **`scripts/ensure-build.ts` builds the client only when `dist/client` is missing or older than
  the sources.** It runs before `npm start` (a clean `npm install && npm start` works) and before
  `npm run test:e2e` (the documented gate order runs e2e before `build`).
- **Hono over Fastify.** Smaller, and `app.request()` tests routes in-process.
- **SSE over WebSocket.** Server→client traffic is one-directional; `EventSource` reconnects by
  itself and the client refetches job state on every reconnect, so no replay log is needed.
- **`concurrently` (dev only)** runs the server and Vite for `npm run dev`.

## Local-only hardening

- **Bind `127.0.0.1` and open `http://127.0.0.1:<port>`**, never `localhost`, which may resolve
  to `::1` where nothing listens.
- **Host allow-list, same-origin check on non-GET, JSON (or `image/*`) content type on mutating
  routes, no CORS headers.** Without it any web page open in the writer's browser could POST a
  job to the loopback API and start an agent with file access.
- **The Vite origin is allowed only with `--dev`.** The dev proxy forwards the browser's Host and
  Origin (`127.0.0.1:5173`); production rejects them.
- **One path guard, `resolveWithin(root, …)`**, checks NUL, absolute segments, `..` (raw and
  percent-decoded), sibling-prefix, and symlinks via `realpath` of the nearest existing ancestor,
  so it also covers files that are about to be created.

## Block model

- **`Doc = { blocks, gaps }` with `gaps.length === blocks.length + 1`; gaps belong to positions.**
  Whitespace stored on a block would travel with it: moving the last block (gap `"\n"`) into the
  middle would fuse two paragraphs.
- **Blocks end at their last non-whitespace character.** Trailing spaces and blank lines live in
  the gap, so an editor never shows stray blank lines and byte identity still holds.
- **Text markdown-it emits no token for (link reference definitions) becomes its own block.**
  Trusting token maps alone would let that text vanish into a "whitespace" gap.
- **Front matter is detected before markdown-it, after an optional BOM.** The BOM stays in
  `gaps[0]`. A `---` that is not at the top, or has no closing fence, is ordinary content.
- **Lone `\r` counts as a line break** (markdown-it normalises it), so line maps stay aligned
  with offsets in the original text.
- **Files that are not valid UTF-8 are refused** (fatal decoder) and never written, instead of
  being silently repaired with U+FFFD.
- **Paired shortcodes are merged in a post-pass** (nearest unmatched opener of the same name).
  Fences, inline code spans, self-closing tags, the commented-out form, and delimiter text inside
  quoted parameters are skipped. An opener with no closer swallows nothing.
- **One `reconcile(oldDoc, newText)`** (LCS over raws) serves re-split on blur, the external
  reload, and the post-condition of structural ops. A split keeps the first ID; a merge keeps the
  earlier one.
- **An op that touches a gap adds a blank-line separator only when the gap has none;** after
  every structural op the result is re-split and, if the raws differ, the re-split wins.
- **The property test builds documents from known fragments** and asserts that split recovers
  exactly those fragments (LF, CRLF, lone CR). Round-trip equality alone holds by construction
  and would pass a splitter that never splits.

## Editor

- **The client owns the live document and the block IDs; the server is stateless about blocks.**
  Nothing sits between a keystroke and the screen, and accepting an agent's result is one
  synchronous reducer step, so there is no accept race to guard.
- **Pure reducers plus a ~30-line store (`useSyncExternalStore`), no state library.**
- **Two-tier undo.** CodeMirror history inside the focused block; a document-level snapshot stack
  for commits, reorders, merges, splits, accepted ops, and external reloads. `Mod-z` falls through
  to the document when the editor has nothing left to undo.
- **The focused editor's text (the draft) is part of every save and every job snapshot,** so
  autosave and jobs never miss what is being typed.
- **Edit mode is entered on mouseup, with the cursor computed at mousedown.** A blur elsewhere can
  re-render and shift the layout between the two; a drag that selects text never enters edit mode,
  so text in a rendered block can be selected for a prompt.
- **Cursor near the click:** block-level tokens carry `data-line`; the text just before the caret
  is searched inside those source lines. markdown-it has no inline source maps; the fallback is
  the start of the line.
- **Saving:** 750 ms debounce, only when the text differs from disk, full text plus the base
  hash. A stale base is a 409 and triggers the same reconcile as a watcher event. Disk wins except
  in the focused block. A file deleted from outside pauses autosave and is never recreated.
- **`fs.watch` on the document's directory** (sees save-by-rename), debounced, compared by
  content hash; hashes the server itself wrote are ignored. No `chokidar` needed so far.
- **Mermaid labels are SVG text (`htmlLabels: false`).** HTML labels live in `foreignObject`,
  which sanitising removes; SVG text also survives the standalone HTML export.
- **The mermaid source travels as the text of a `<pre>`,** not in a `data-` attribute: DOMPurify
  drops attribute values that contain `-->`.
- **Front matter summary and skill headers share one dependency-free key/value reader.** Display
  only; on anything unexpected the line just says "front matter".
- **Always-visible controls in the editor itself: none.** The notice line appears only when there
  is something to say. The one exception in the app is the job tray (under "Jobs" below).

## Jobs

- **Block-level queueing runs in the client** (`src/shared/jobs/scheduler.ts`, pure and
  unit-tested). Only the client knows the live document and whether a job was *settled*, so a
  conflicting request is held there and posted with a fresh snapshot once its blockers are
  accepted or rejected. The server enforces only the global concurrency limit (FIFO); waiting for
  review holds no process slot.
- **The article barrier is per document and FIFO.** Later block jobs cannot pass a waiting
  `article` job (no starvation); other documents keep running. `research` takes a process slot
  but no lock, and the writer's own edits never consult the scheduler.
- **While a decision is being applied the queue does not start jobs.** The `settled` event can
  arrive before the accepted ops are in the document; a job started in that window would
  snapshot the old text.
- **Jobs carry a monotonic `revision`.** Two state changes can share a millisecond timestamp, and
  the POST response can arrive after newer SSE events; the client keeps the highest revision.
- **A virtual anchor `b0`** appears in the snapshot of a document without content, so an ordinary
  `insert_after b0` creates first content ("draft brief", "draft article"). `result.json` keeps
  exactly the spec's shape.
- **Validation is two-stage:** zod (strict — unknown ops or keys reject) and then semantic rules
  (scope, targets, front matter, one replace/delete per block, asset paths inside `assets/`,
  assets exist as regular files). Both run on the server before anything reaches the UI; the
  client re-checks targets against the live document.
- **One repair attempt.** The rejected file is kept as `result.invalid.json`, the errors go into
  `repair.md`, and auth, exit, and timeout failures are never "repaired".
- **Marker spoofing is harmless.** Markers exist only in the job's `article.md`; every
  `block_id` in a result is validated against the snapshot and the targets.
- **Accept copies, never moves, and never overwrites.** Only assets referenced by accepted ops
  go into the bundle; identical content reuses the name, different content gets `name-2.ext`.
  References are rewritten at exact destination spans only, never by global substring replace.
  No acceptance journal: the worst crash outcome is an unreferenced file in the bundle.
- **Several inserts at one anchor keep the result's order** whatever order they were accepted
  in; the client remembers which blocks each op inserted.
- **Undoing an accepted result is an ordinary edit.** It never resurrects or re-runs the job.
- **Timeouts live in the job manager,** not in adapters, so the fake and the real adapters behave
  the same. Cancel is idempotent and keeps whatever output exists; a proposal that is already
  complete stays reviewable if cancel races with completion.
- **Restart and reload.** On server start every unsettled job on disk becomes `stale` with its
  output kept; a dismissed job does not come back. A page reload does the same for that page's
  jobs (OD3).
- **The fake adapter reads and writes the real file contract** and picks its scenario from a
  `fake:<name>` token in the instruction, so the demo and the tests share it. With
  `--fake-control` it stops at a checkpoint until `POST /api/__fake/release`; the route is mounted
  only with that flag (404 otherwise, unit-tested). Tests never sleep.
- **The prompt pill never takes focus by appearing.** A selection stays a selection (copy,
  extend, type over). Outside an editor, typing goes into the pill; `Ctrl/Cmd+I` enters it from
  anywhere. It is anchored to its block and repositions when the layout changes.
- **Review buttons keep the keyboard focus where it is** (`mousedown` is prevented). Otherwise
  pressing "Accept" blurs an open editor, the block re-renders, the layout shifts, and the click
  misses the button.
- **Always-visible control: the job tray,** and only while at least one job exists. It is the
  one place that shows running, failed, and stale work, so nothing is lost silently.

## Real agents (verified 2026-09-19)

Flags were read from the installed tools' `--help` and then exercised with
`node scripts/verify-adapter.ts <adapter>`: one small job in a throwaway copy of the sample
workspace, with sentinel files instead of trust in the prompt. The four checks: (1) a valid
`result.json` arrives (write inside the job directory works), (2) nothing else in the workspace
changed and a probe file the agent was told to create does not exist, (3) the result reflects
`article.md` (the workspace is readable), (4) a secret file outside the workspace was not read.

### claude (Claude Code 2.1.278)

Shipped command line (cwd = workspace, prompt on stdin):

```
claude -p --output-format stream-json --verbose
  --permission-mode dontAsk --permission-prompts none --restricted
  --tools Read,Glob,Grep,Edit,Write
  --allowedTools "Edit(.zen/jobs/<id>/**)"
  --safe-mode --no-session-persistence [--model <m>] [...extraArgs]
```

| Run | Flags | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- | --- |
| 1 | allow list + `--permission-prompts none` only (the first plan) | pass | **fail** | pass | **fail** |
| 2 | run 1 + `--permission-mode dontAsk --restricted` | pass | pass | pass | pass |
| 3 | the shipped default above | pass | pass | pass | pass |

Runs 2 and 3 also passed a `"Write(.zen/jobs/<id>/**)"` rule. claude reports that rule as never
matched ("only Edit(path) rules are") and `Edit(path)` rules cover every file-editing tool, so it
was removed afterwards without changing what is allowed; the warning showed up during the herdr
evaluation (`docs/herdr-evaluation.md`). The block above is the command line the code builds
(`claudeConfinement` in `src/server/adapters/claude.ts`, pinned by `adapters.test.ts`).

- **An allow list alone confines nothing.** In run 1 the agent created `probe.txt` in the
  workspace root and read the secret outside the workspace: the writer's own settings decide what
  is allowed beyond the list. `--permission-mode dontAsk` denies everything the list does not
  cover ("Permission to use Write has been denied because Claude Code is running in don't ask
  mode"), and `--restricted` ignores user/project settings and confines the file tools to the
  working directory ("… is outside <workspace>; --restricted confines the file tools to the
  working directory").
- `--restricted` removes Bash unless `--tools` names it; a skill that declares
  `allow: Bash(asciinema *)` gets `Bash` added to `--tools` and its rule to `--allowedTools`.
- `--restricted` also ignores the model in the writer's settings; set `model` for the adapter in
  openwrite's settings to choose one.
- `--safe-mode` keeps the writer's hooks, plugins, MCP servers and `CLAUDE.md` out of job runs.
  `--bare` was rejected: it needs an API key, and the writer uses their login.
- Differences from the spec: it only says "headless print mode with streamed JSON output".
  `--verbose` is kept with `stream-json`; running without it was not tried.
- Cost of the three runs: each capped with `--max-budget-usd 0.50`, 19–24 s each.

### codex (codex-cli 0.155.1)

Shipped command line (prompt on stdin, `-` last):

```
codex exec --json --skip-git-repo-check --ephemeral
  -C <jobDir> -s workspace-write
  -c sandbox_workspace_write.exclude_slash_tmp=true
  -c sandbox_workspace_write.exclude_tmpdir_env_var=true [-m <model>] [...extraArgs] -
```

| Run | Sandbox | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- | --- |
| 1 | `-C <workspace> -s read-only --add-dir <jobDir>` | **fail** | pass | — | — |
| 2 | `-C <jobDir> -s workspace-write`, /tmp excluded (shipped) | pass | pass | pass | **fail** |
| 3 | run 2 + `-c sandbox_permissions=[]` | pass | pass | pass | **fail** |

- **`--add-dir` does not make a directory writable under `read-only`** (run 1: "the read-only
  sandbox blocked writing `result.json`"); it only extends `workspace-write`.
- **The job directory is codex's working root.** That is what makes it the only writable place.
  It deviates from the spec's "workspace as working directory"; the adapter's prompt tells the
  agent where the workspace is and how the paths in `instruction.md` map. Writing to the
  workspace root was denied ("read-only file system").
- **codex cannot confine reads.** Its sandbox restricts writes only: in runs 2 and 3 the agent
  read the secret outside the workspace with `cat`. No flag in `codex exec --help` changes that.
  Writes — the part the file contract depends on — are confined to the job directory.
  Workspace-wide write (`-C <workspace> -s workspace-write`) was not needed and is not shipped
  (OD2).
- `-o <jobDir>/last-message.txt` was part of the verified runs and was removed afterwards: the
  codex CLI writes that file itself, outside its sandbox, at a name inside the agent-writable job
  directory, so a symlink planted there would become an outside write. Nothing read the file.
- codex has no per-command allow list; a skill that declares `network: true` adds
  `-c sandbox_workspace_write.network_access=true`.

### Both

- No default command line contains a bypass flag (`--dangerously-skip-permissions`,
  `bypassPermissions`, `--dangerously-bypass-approvals-and-sandbox`, `danger-full-access`); a unit
  test asserts it. `command`, `model`, `baseArgs` (with `{jobDir}`, `{jobRel}`, `{workspace}`),
  and `extraArgs` are the writer's to override in settings — the spec forbids a bypass
  *default*, not the writer's own choice.
- One `spawnAgent` launches every process: executable plus argv (never a shell), the prompt on
  stdin, stdout split into lines across chunks, bounded output tails, `ENOENT` → `missing-cli`,
  and cancel signals the whole process group (SIGTERM, then SIGKILL after 3 s) because agent
  CLIs spawn children.
- Auth failures are recognised per adapter from the stream's error event or stderr and become
  `failed · not signed in` with the command to run. They are never "repaired".
- Real agents never run in `npm test` or CI: `scripts/verify-adapter.ts` is manual, and its
  report scrubs home and temp paths.

## Skills and export

- **A skill with a `Bash(...)` rule runs with a shell that is not confined.** claude's
  `--restricted` confines the file tools only, so `terminal-recording`
  (`allow: Bash(asciinema *) …`) can run arbitrary commands as the writer — `asciinema rec -c`
  alone is an arbitrary-command path, so trimming the list would narrow nothing. That is the
  price of a skill whose purpose is to run a script. Consequences: a skill file is reviewed like
  code; `skills.test.ts` pins every skill's `allow` list so a new rule cannot land unnoticed;
  and a widened command line can be sentinel-checked with
  `node scripts/verify-adapter.ts claude --skill=<name>`. **Not run for `terminal-recording`:**
  `asciinema` and `agg` are not installed here (the job stops at the preflight), and the
  real-agent run budget of this build was spent. codex ignores `allow` entirely.

- **A skill is a file, `skills/<name>.md`:** a small header read by the same dependency-free
  key/value reader as front matter (validated with zod) plus a prompt body. The server lists the
  directory; the palette and `/name` are generic. No editor code exists per media type.
- **Missing tools are detected by the server, generically, before an agent starts** (`requires`
  in the header, looked up on `PATH`; the lookup is injected in tests). It names the tools, spends
  nothing, and is testable without installing anything. The recording template still carries the
  `command -v asciinema agg` instruction as a second line of defence.
- **`image` is routed by task** (`taskAgents.image`, else the main agent) through the same
  registry. The spec allows the main agent to spawn another agent CLI as a subprocess; routing
  the job instead keeps one confined process per job and needs no nested permissions.
- **`video` is a stub:** listed, marked `stub: true`, and refused with a pointer to the README.
- **Export: the client renders, the server zips.** DOMPurify needs a DOM, and mermaid renders in
  the browser anyway, so the HTML body is rendered by the editor's own pipeline (export mode) and
  posted; the server wraps it in a template with one `style.css`, adds the bundle's files, and
  zips with `fflate`. No headless browser on the server, no CDN in the page.
- **The standalone HTML export is baked light.** Diagrams are rendered to SVG once, with
  mermaid's light theme; a `prefers-color-scheme: dark` block in the export stylesheet would put
  those light diagrams on a dark page, so there is none. Its colours are the app's light tokens
  and `export.test.ts` checks their contrast.
- **Exports commit the open editor and save first,** so the zip equals what is on disk.
- **Symlinks in a bundle are never followed or exported.**

## herdr (milestone 5)

- **Adopted as an optional adapter.** In an isolated test session all five criteria held:
  headless start without a TTY, reliable agent state, completion through the file contract,
  cancel by closing the pane, and the live session untouched. Details and limits:
  `docs/herdr-evaluation.md`.
- **Every herdr call removes the inherited `HERDR_*` variables and names its session.** openwrite
  may run inside a herdr pane; an unscoped command would act on the writer's own session.
- **`adapters.<name>.session` is a herdr-only key in the shared adapter schema.** A generic
  `options` bag would keep the schema adapter-neutral but move the validation of that one key out
  of zod; with a single adapter-specific key and a single reader (`herdr.ts`) the typed key wins.
  Revisit when a second adapter needs an option of its own.
- **The herdr path has not been sentinel-checked itself.** It passes `claudeConfinement()` — the
  flags that passed all four checks in print mode — to an interactive claude, and the evaluation
  saw the job write only its `result.json` and leave the article alone. But the probe-file and
  outside-secret checks were never run through a pane: the real-run budget of the build was spent.
  `node scripts/verify-adapter.ts herdr` now exists for exactly that; until someone runs it,
  herdr's confinement is inherited, not measured.
- **Interactive claude inside herdr reuses the direct adapter's confinement flags.** Print-only
  flags (`--permission-prompts`, `--max-budget-usd`, `--no-session-persistence`) are left out.
- **"Open this job in herdr" shows the attach command** instead of opening a terminal: a local
  web server cannot do that for the writer.

## The job directory is untrusted

- **Every name inside `.zen/jobs/<id>/` is agent-controlled once the agent runs.** An agent with
  a shell (codex, or a skill that allows Bash) can replace `progress.log`, `result.json` or
  `assets/` with a symlink, a hard link to an outside file, a directory, or a FIFO. The server
  therefore touches the job directory only through `src/server/jobs/job-io.ts`: opens use
  `O_NOFOLLOW | O_NONBLOCK` and accept only regular files with one link; writes go through an
  exclusive random-named temp file plus rename (a rename replaces the entry, it never writes
  through it); assets resolve from the trusted job directory, never from its `assets` child.
  Found in review: before this, the server served and appended to files outside the workspace
  through planted symlinks.
- **`job.json` lives in that directory too,** so it is re-validated with zod on every read and
  never trusted for anything the in-memory job does not already know.

## Decisions made while fixing the review findings

- **Only a `blocks` job goes stale when a target disappears.** A whole-article job lists every
  block as a target; an ordinary merge must not cancel a long, paid draft. A vanished block is
  reported when its op is applied.
- **An insert anchored on a block the same result deletes is a validation error,** as is a
  replace with empty markdown: applying them would silently drop the new text. The one repair
  attempt gets a message that says what to write instead.
- **A declared asset that no op references is a validation error,** and `./assets/x` and
  reference-style definitions count as references. Otherwise the file is never copied into the
  bundle and the article keeps a dead `assets/…` link.
- **Each op is decided once.** The client drops indices that are decided or in flight; the server
  ignores an already decided index (the first decision stands) and refuses accept+reject of one op.
- **An accepted replace or delete of the block being edited commits the open draft first.** The
  draft stays one undo step behind; without this it was folded back over the accepted text.
- **Shutdown kills agents at once (`cancel({ force: true })`) and the server waits for it,** up
  to two seconds. Agents run in their own process groups and would otherwise survive Ctrl-C.
- **Every (re)connect of the event stream re-checks open documents, settings, and the article
  list.** The server keeps no event log, so that is the only way to see what happened meanwhile.
- **The research panel reserves layout space** (beside the text from 1160px, below it on narrower
  windows) instead of covering the text the writer is typing in. It still opens by itself.
- **The prompt pill is not keyed on its targets,** so extending a selection keeps what was typed.
- **A relative `contentDir` that leaves the workspace is refused before it is saved;** an
  absolute path is the supported way to point outside. `GET /api/config` never throws on a bad
  value, so settings can always repair it.
- **A failed save retries by itself after three seconds** and its notice is sticky; leaving the
  tab saves at once, and the unload guard also covers a dirty document.
- **A pasted SVG image is stored and exported unchanged.** It is served with `nosniff` and
  `content-security-policy: default-src 'none'` (`fileResponse` in `src/server/http.ts`), and both
  the editor and the exported page reference it only as an `<img>`, which runs no script. Script
  in it could run only if the writer opened the file itself in a browser. Sanitising or refusing
  SVG changes what the writer can paste, so it is a follow-up, not a fix.
- **An acceptance the client could not apply is withdrawn, not kept.** The server records
  "accepted" (and copies assets) before the client applies the op to the live document, which only
  the client knows. If the block vanished during that round trip, the client calls
  `POST /api/jobs/:id/decisions/withdraw`: the op is undecided again, a settled job is reviewable
  again, and a `blocks` job then goes stale as usual. Applying first and recording second was
  rejected: a failed recording would leave an applied edit that the job still offers as a ghost.
  A failed withdraw leaves the old behaviour (a notice), so it is never worse than before.
- **An image upload that finishes after its editor closed is announced,** with the file name and
  the reference to type; the reference is not guessed into a block the writer has left.
- **Test-only server routes** (`/api/__fake/release`, `/waiting`, `/drop-events`) exist only with
  `--fake-control`; a unit test asserts 404 without it.

## Manager decisions (OD1–OD7, all defaults accepted 2026-09-19)

- **OD1 — `contentDir` may be absolute (outside the workspace).** The spec wants it to "point
  directly into a Hugo site's content directory". It becomes a second guarded root and settings
  shows a notice.
- **OD2 — codex write scope.** Ship only a sandbox row that passes the sentinel check; a
  workspace-wide write default is not shipped without the user's say.
- **OD3 — a page reload counts as a restart for jobs.** Block IDs are session-scoped, so open
  reviews become stale (output kept) and queued requests are dropped; a `beforeunload` guard warns
  first. Keeping IDs across a reload is a deferred follow-up.
- **OD4 — PR screenshots are committed under `docs/screenshots/`.**
- **OD5 — `npm start` opens a gitignored copy of the sample** (`.openwrite/sample-workspace/`),
  created on first run, so the tracked sample that every test copies stays pristine. Delete
  `.openwrite/` to reset it.
- **OD6 — a text selection in a rendered block targets the whole block** and passes the selected
  string as a hint; exact ranges exist only in edit mode.
- **OD7 — shortcodes in the HTML export:** `figure` maps to `<figure>`; other shortcode tags are
  dropped and their inner content kept.

## Sample workspace

- **The sample's `.zen/config.json` sets `mainAgent: "fake"`** so a first run can never spend
  credits or fail on a missing login. The schema default for any other workspace is `claude`.

## Runtime dependencies

| Package | Reason |
| --- | --- |
| `react`, `react-dom` | UI, named by the spec |
| `@codemirror/state`, `view`, `commands`, `language`, `lang-markdown` | the editing state of a block, named by the spec; the individual packages avoid `basicSetup` chrome |
| `markdown-it` | block splitting (token line maps) and rendering, named by the spec |
| `@dnd-kit/core`, `sortable`, `utilities` | drag reorder, named by the spec |
| `mermaid` | diagram rendering, named by the spec; loaded lazily |
| `hono`, `@hono/node-server` | the HTTP server, named by the spec |
| `zod` | validation at every boundary that reads a file or a message |
| `dompurify` | agent output and article HTML are untrusted; sanitise before it reaches the DOM |
| `highlight.js` | syntax highlighting for code fences (core + a fixed language list) |
| `diff` | word diffs for ghost replacements; small and well tested |
| `fflate` | zip export without a native dependency |
