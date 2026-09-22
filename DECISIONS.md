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
- **The Playwright smoke server picks a free port** (`playwright.config.ts`), unless
  `OPENWRITE_E2E_PORT` names one. The fixed 4399 made a second run on the same machine (another
  checkout or worktree) fail at start with "port already used". The config is loaded again in every
  worker, so the port is picked once in the runner, synchronously (a config exports a plain
  object), and written back to the environment the workers inherit.
- **`src/client/state/app.test.ts` is type-checked with the client config, not the server one.**
  Client unit tests are checked with node types and no DOM; this one imports `app.ts`, which uses
  `window`. It stubs `window` and `fetch` itself and needs nothing from node, so it moves to the
  DOM program (`files` in `tsconfig.client.json`, `exclude` in `tsconfig.server.json`).
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
- **`npm run dev` listens on every interface (2026-09-22, at the writer's request)** so the editor
  can be opened from another device. Only Vite (`host: true`) is exposed; the Node API stays on
  `127.0.0.1` and is reached through Vite's proxy. In dev the Host allow-list adds this machine's
  own IP addresses at the Vite port, read per request; hostnames other than `localhost` are still
  rejected, so the DNS-rebinding check holds. There is still no auth: anyone on the network can
  edit files and start agents while dev runs. `npm start` and the e2e server stay loopback-only.
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
- **JSON front matter (issue #6) is a `{` that opens the document, closed by its matching `}`.**
  Hugo's lexer takes any leading `{` and counts braces outside strings, which would swallow a
  document that opens with a `{{< shortcode >}}`. Stricter here, so ambiguous text stays ordinary
  markdown: the `{` must be the first character (after an optional BOM, no leading whitespace,
  like `---`), the matching `}` must end its line, and the slice must `JSON.parse` to an object.
  Anything else, a shortcode or unclosed or invalid JSON, splits as content and round-trips
  byte-identically; Hugo would reject most of it anyway.
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
- **A reload folds the open editor's text in before it merges,** so that what autosave has
  already written to the file is matched instead of added a second time — which is how a new
  block came back doubled. Since #30 the reload is a three-way merge ("A reload is a three-way
  merge" below), and `foldIn` in `doc-reducer.ts` does the fold under stored IDs.
- **Blocks that exist only in a derived document get IDs the store cannot mint** (`live1`, not
  `b3`). `liveDoc` is the job snapshot and folds the open editor in, but nothing reserves the IDs
  it would mint from the document's counter, so a snapshot could show the agent the slot's text as
  `b3` and the store later give `b3` to different text — an accepted op then lands on the wrong
  block. A derived ID is never in the store, so such an op is *missing* and withdrawn by the path
  every vanished block already takes. The price: an agent's edit of a paragraph the writer was
  still typing comes back stale rather than applied, which is the honest answer, since the writer
  kept typing. The contract moves as one: `BlockIdSchema` accepts `b<n>` and `live<n>` and nothing
  else (a test lists near-misses it rejects), and the README's job-file section, `job-files.ts`'s
  instruction text (its golden fixture regenerated for that one sentence) and `fake.ts`'s marker
  regex name both. The first attempt changed only `liveDoc` and was reverted (`cde17b2`), because
  the schema turned every job started with the editor open into a 400; a test still parses what
  `liveDoc` produces with `SnapshotSchema`.
- **A save that resolves after a reload is dropped,** since its hash would roll `baseHash` back
  to a revision the disk has moved past. The check is in the reducer rather than in `save()`:
  that is where document state transitions are owned, and the only client state the unit suite
  can reach.
- **Edit mode is entered on mouseup, with the cursor computed at mousedown.** A blur elsewhere can
  re-render and shift the layout between the two; a drag that selects text never enters edit mode,
  so text in a rendered block can be selected for a prompt.
- **Cursor near the click:** block-level tokens carry `data-line`; the text just before the caret
  is searched inside those source lines. markdown-it has no inline source maps; the fallback is
  the start of the line.
- **Saving:** 750 ms debounce, only when the text differs from disk, full text plus the base
  hash. A stale base is a 409 and triggers the same reload as a watcher event: a three-way merge
  (below). A file deleted from outside pauses autosave and is never recreated.
- **`fs.watch` on the document's directory** (sees save-by-rename), debounced, compared by
  content hash; hashes the server itself wrote are ignored, so a save through the server is
  announced by the save route instead, naming the tab (see "Two tabs on one document"). No
  `chokidar` needed so far.
- **Mermaid labels are SVG text (`htmlLabels: false`).** HTML labels live in `foreignObject`,
  which sanitising removes; SVG text also survives the standalone HTML export.
- **The mermaid source travels as the text of a `<pre>`,** not in a `data-` attribute: DOMPurify
  drops attribute values that contain `-->`.
- **Front matter summary and skill headers share one dependency-free key/value reader.** Display
  only; on anything unexpected the line just says "front matter". JSON front matter is read with
  `JSON.parse` instead, and only string title, date and tags are shown.
- **Always-visible controls in the editor itself: none.** The notice line appears only when there
  is something to say. The exceptions in the app are the two panel handles and the job count
  (under "Shell and panels" below).

## Two tabs on one document (issues #5, #29)

- **Documented rather than fixed at first (#5), because the fix that looks obvious makes it
  worse.** The watcher ignores the hash of every server write, so another tab's save never
  reached a tab as `doc.changed`, and the stale tab only learnt of it from its own 409 (#29).
  Emitting `doc.changed` from the PUT route fixes the staleness, but on its own it starts a save
  ping-pong: when both tabs have an editor open on the same block, each reload kept the local
  draft, and the `lastSeen` key (base hash plus text) re-armed the autosave.
- **Every save is announced, and names the tab that made it (#29).** The PUT body carries the
  tab ID (`SaveRequestSchema.tab`, the same `TabIdSchema` the event stream and jobs use); the
  route emits `doc.changed` with that `origin` right after the write, and the watcher, which
  knows the hash, stays quiet. The saving tab drops its own event: it has the text, and the PUT's
  answer brings the hash — reloading its own save would only race the typing that followed.
  Filtering in the client rather than skipping that tab's stream on the server keeps the event
  hub a plain fan-out. A PUT without a tab (a script) is still announced, without an origin.
- **The three-way merge (#30, next section) is the tie-break the ping-pong needed.** A reload
  that finds the disk changed the block an editor has open closes that editor and shows a
  conflict, so there is no draft left to save back; a plain origin check without it would still
  have saved the draft over the other tab's text. The other tab hears nothing more until the
  writer chooses, and `two-tabs.spec.ts` counts the saves to show it.
- **A reload read that a save or another reload overtook is dropped** (`stillNews` in
  `state/app.ts`, for events and for the reconnect re-check). With saves announced, a tab can
  read the file for another tab's event while its own save lands; merging that older text over
  the newer document would revert what came in between. A later write announces itself.
- **What the README says happens is tested** (`e2e/two-tabs.spec.ts`): a save reaches the other
  tab at once; the same block edited one after the other keeps both words; typed at once, a
  conflict with no ping-pong; a block finished with `Esc` before its autosave survives another
  tab's save arriving (#30).

## A reload is a three-way merge (issue #30)

- **base = the text last loaded or saved, mine = the live document, theirs = the disk.** Before,
  a reload (a watcher event, a reconnect, or a 409's body) reconciled the disk text against the
  document and the disk won everywhere except the open editor, so a block finished with `Esc` but
  not saved yet (the 750 ms debounce) was replaced by the disk's older copy with a generic notice.
  With a base, "changed here" and "changed there" can be told apart. `merge3` in
  `src/shared/blocks/merge.ts` is pure and has property tests; the reducer only folds the editor
  in, merges, and reconciles IDs against the merged text.
- **Compared block by block, each block with the whitespace in front of it.** The tokens joined
  are the text byte for byte, and the merged text is slices of the three inputs joined, so
  nothing is re-rendered (golden rule 5) and merging an untouched side gives the other side
  exactly. The gap goes with the block after it because that is where the editor's own
  operations put it (a delete takes the gap after the block, an insert brings the separator in
  front of it). Changes to base ranges that only touch at a boundary merge cleanly — edits of two
  adjacent paragraphs, or an insertion next to an edit — and two insertions at one place collide.
- **A stretch both sides changed takes the side that already holds everything the other wrote;
  failing that it is a conflict.** So the same edit on both sides, or a disk that has this tab's
  new block plus more, merges without a word; and an edit whose block the other side deleted
  keeps the edit (no text is lost that way; the deletion is what gives). Line-level merging
  inside a block was rejected: prose paragraphs are one line, so it would buy nothing but noise.
- **A conflict shows the disk's version in the document and keeps the writer's aside**
  (`Conflict` in `doc-reducer.ts`, a card after the passage: Keep mine / Take theirs / Keep
  both). The other way round — the writer's text in place with autosave paused — was rejected:
  a paused autosave holds every other edit hostage to one decision, and forgetting to choose
  would still be a silent overwrite the moment it resumed. Keep both adds only the blocks the
  writer wrote (`written`), after the disk's version, because the blocks of the passage the
  writer left alone are already there. A resolve works on the text and reconciles, so front
  matter and block kinds stay what the splitter says.
- **The open editor closes when the disk changed what it holds** (a conflict, or a disk change
  to a block the writer had not changed). Keeping it open would put the draft back over the
  disk's text on the next save — the silent overwrite of #29 and its ping-pong. What it held is
  in the document or in the conflict, and the undo step of the reload is the document as it was
  on screen, the editor's text included. This replaces the older rescues that put the editor's
  text back into the disk's version whatever the disk had done: a paragraph deleted outside
  while open with nothing unsaved in it now goes (undo brings it back), and one with unsaved
  text becomes a conflict. `e2e/external-change.spec.ts` and the reducer tests were changed on
  purpose for this, each scenario kept.
- **The save on its way is a base too** (`sentText`, set by `save()` through a `sending`
  action). When a reload brings exactly that text back (a reconnect's re-check can see this
  tab's own write before the PUT answers), it is this tab's own, and merging it against the
  last saved text would make every keystroke typed since a conflict with itself.
- **An unsettled conflict counts as unsaved:** the unload guard warns, a workspace switch waits,
  and a page reload keeps it in `sessionStorage` with the rest of the document's identity
  (`state/session.ts`). Its text is in neither the document nor the file.

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
  output kept; a dismissed job does not come back. A page reload keeps the tab's jobs
  ("Block identity across a page reload", which replaced OD3).
- **The fake adapter reads and writes the real file contract** and picks its scenario from a
  `fake:<name>` token in the instruction, so the demo and the tests share it. With
  `--fake-control` it stops at a checkpoint until `POST /api/__fake/release`; the route is mounted
  only with that flag (404 otherwise, unit-tested). Tests never sleep.
- **The prompt pill never takes focus by appearing.** A selection stays a selection (copy,
  extend, type over). Outside an editor, typing goes into the pill; `Ctrl/Cmd+I` enters it from
  anywhere, and for a selection made inside an editor the pill's placeholder says so. Taking
  focus there was tried again after the final review and rejected with a test run: the editor
  closes, "select a word and type its replacement" lands in the pill as an instruction (Enter
  would start an agent job), and Shift+Arrow stops extending the selection after its first step.
  Two e2e tests in `e2e/jobs-review.spec.ts` pin both the keyboard path and type-over. The pill
  is anchored to its block and repositions when the layout changes.
- **Review buttons keep the keyboard focus where it is** (`mousedown` is prevented). Otherwise
  pressing "Accept" blurs an open editor, the block re-renders, the layout shifts, and the click
  misses the button.
- **Always-visible control: the job count,** and only while at least one job exists and the agent
  panel is not beside the text: closed, or stacked after the article on a narrow window. It is the
  one place that shows running, failed, and stale work there, so nothing is lost silently; clicking
  it opens the panel (or scrolls to it), where the tray now lives as the transcript.

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
- **Workspace skills live in `<workspace>/.zen/skills/*.md` (issue #3).** Same header parser and
  zod schema as `skills/`, read through `resolveWithin` and opened `O_NOFOLLOW | O_NONBLOCK`;
  regular, singly linked, ≤ 64 KiB, UTF-8 files only, at most 100. A bad file becomes an entry in
  `GET /api/skills`'s `errors` (shown as a notice once, in the agent panel and in the palette)
  and never hides the valid ones: a typo in one prompt must not take away the rest.
- **A shipped skill's name cannot be taken by a workspace skill; the file is refused, not
  namespaced and not an override.** `/diagram` then means the same reviewed prompt in every
  workspace, a workspace copied from someone else cannot silently swap one out, and the `/name`
  parser needs no namespace syntax. Customising one is a copy under a new name. Considered and
  rejected: workspace-overrides-shipped (a workspace could replace a skill whose allowances were
  reviewed), and `ws:` prefixes (new syntax in the pill for a rare case).
- **A workspace skill may not declare `allow:` or `network: true`.** Its prompt is the writer's
  own file and is in trust like any instruction, but those two keys change the agent's command
  line, and the confinement is sentinel-checked only for reviewed repository files
  (`skills.test.ts` pins every shipped `allow` list). Refused with a reason, not silently dropped,
  so the writer is never surprised by a skill that runs with less than it asked for. `requires:`
  is allowed: it only adds a `PATH` preflight that fails early.
- **The skills list refreshes by event, and a switch needs no special code.** `GET /api/skills`
  reads `workspace.root` at request time, so the client's own reload after a switch lists the new
  workspace's skills. For edits made while the editor is open, `SkillsWatcher` watches
  `.zen/skills/` (or `.zen/` until it exists), re-reads after a 100 ms debounce, and emits
  `skills.changed` only when what the palette lists changed; it re-arms on `workspace.changed`.
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

## Block identity across a page reload (issue #2)

- **Identity lives in the tab's `sessionStorage`, not on the server.** Block IDs are minted by
  each tab's own counter, so two tabs on one article have two ID spaces: a server-side ID map
  keyed by (workspace, document, hash) would have to pick one tab's IDs, or become a document
  model the server does not otherwise have. `sessionStorage` is exactly the scope that has to
  survive: one tab, across its reloads. The article on disk is untouched (golden rule 6); the job
  snapshots already carry the IDs on the server side.
- **Read once, written on `pagehide`** (`state/session.ts` rules, `state/tab.ts` browser side).
  The page removes the keys as it starts and writes them again as it goes, so a tab *duplicated*
  while this one is open copies nothing and gets IDs and jobs of its own. A crash that skips
  `pagehide` loses the session: the jobs go stale with their output kept, as before. What is kept:
  the tab ID; each ready document's blocks with the open editor committed (the text autosave
  wrote) and its counter; held requests, the `inserted` map (order of a partly accepted result),
  conversation starts and composer drafts. zod-validated on read; a document whose gaps do not fit
  its blocks, repeats an ID or holds a `live<n>` is dropped, and a counter behind its IDs is moved
  past them.
- **Only unchanged text keeps its ID after a reload** (`reattach`, the strict half of
  `reconcile`). `reconcile` hands a changed run's first block the run's old ID, which is right for
  an edit the writer is watching; after an absence of unknown length that block can be unrelated
  text, and a proposal would sit on it. A fresh ID leaves the job without its target, and
  `checkTargets` marks it stale with its output kept.
- **A job knows which tab asked** (`owner`, the tab ID, in the request and in `job.json`; never in
  the agent's files). The tab that asked re-adopts its unsettled jobs after a reload when its
  document's identity came back; a research job needs none.
- **Another tab's job is shown, never applied.** Its targets and ops name the other tab's blocks,
  so here it gets no ghost diff, no pending decoration, no Accept, no claim in the scheduler
  (except an `article` job's barrier, which is about the whole document, not IDs), and no stale
  report from `checkTargets`; it can be cancelled or rejected, which needs no IDs. The row says
  "started in another tab". This also fixes a two-tab bug that predates the change: a job started
  in one tab arrived by SSE in the other and was reviewable there against that tab's IDs.
- **Liveness decides who may stale a job.** Each event stream names its tab
  (`/api/events?tab=<id>`, validated; anything else is not counted) and `GET /api/jobs` returns
  the tabs with an open stream. A tab that starts marks stale only the unsettled jobs nobody can
  apply: its own without identity, another tab's whose tab is gone, and ownerless ones from before
  this change. Opening a second tab therefore no longer stales the first tab's work. A tab that
  closes for good leaves its jobs until the next tab starts, which stales them.
- **A kept session is for one workspace.** It records the root it was written for and is dropped
  when the server is on another (a switch made meanwhile in another tab), and on this tab's own
  switch; the same slugs would name other articles there.
- **Held requests wait for their document.** After a reload a held request's document may still
  be loading; `pump` starts it only once the document is ready (the store subscription pumps
  again), drops it with a notice if the document failed to load, and `checkTargets` no longer
  judges a held request against a document that has no blocks yet. Every document the tab had open
  is preloaded, so a job or request about a document not on screen finds its blocks.

## Job retention (issue #4)

- **Finished means `settled`, `failed`, `cancelled` or `stale`** (`isFinished`, shared). `ready`
  is never finished, dismissed or not: a proposal awaiting a decision is kept until it is decided.
  Nothing queued or running is ever touched, and neither is a finished job whose agent handle is
  still live (a cancel the agent ignored): its process could still be writing into the directory.
- **Two ways out, both server-side.** An explicit *Clear finished jobs* removes every finished job
  of the open workspace; automatic pruning when a workspace opens (server start and every switch,
  before restart recovery) removes done, failed, cancelled and dismissed finished jobs whose
  `updatedAt` is older than `jobRetentionDays` (default 30, `0` = off). Why age and not a count: a
  burst of jobs would push out yesterday's failure before the writer saw it; age is predictable.
- **Pruning spares a stale job that was not dismissed.** It is in the agent panel with its output
  "so nothing is lost" (the stale rule); only the writer's own clear or dismiss lets it go. Done,
  failed and cancelled jobs of an earlier session are not shown at all after a restart, so a
  month-old one has no reader left.
- **The clear scans the disk, not just memory.** Restart recovery loads only stale jobs, so the
  finished jobs of earlier sessions exist only as directories; the in-memory state wins where
  there is one. A `job.json` whose id does not name its directory, or that does not parse, is
  left alone and reported: the agent can write that file, so it is never a reason to delete.
- **Deletion is its own no-follow walk** (`removeJobDir` in `job-io.ts`), not `rm -r`: the id must
  match the job id pattern (one segment, directly under `.zen/jobs`), `.zen/jobs` and the job
  directory must `lstat` as real directories, and inside it every non-directory — symlink, hard
  link, FIFO — is `unlink`ed, which removes the name and never what it points at.
- **A cleared job writes nothing more.** `update` and `progress` check that the entry is still the
  one in the map (as well as the epoch), so a run that settles after the clear cannot recreate the
  directory through `saveJobFile`'s `mkdir`.
- **The request names its workspace** (`x-openwrite-workspace`, as settings writes do) and the
  route has no `await` before the sweep, so a click from a tab still showing the previous
  workspace is refused with 409 instead of clearing the one that is open now. A `job.removed`
  event tells every tab to drop the cleared jobs.
- **Palette only, no confirmation.** It is rare housekeeping, so it gets no always-visible control
  and stays off the transcript. It is not behind a typed confirmation like erasing a workspace:
  it removes only finished work, never anything that could still enter the article, and the
  notice says how many jobs it cleared and kept.

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
- **An SVG is sanitised by a strict allow-list before it is stored or served** (`src/server/svg.ts`,
  issue #11). This replaces "a pasted SVG image is stored and exported unchanged": `nosniff`, the
  `default-src 'none'` CSP and `<img>`-only rendering stay, but they only hold while the file is
  shown by this server; the same bytes go into the writer's Hugo site and the export zip, where
  opening the file runs whatever script it carries. The sanitiser is a small, linear XML tokenizer
  that writes back only allow-listed elements and attributes, not a denylist:
  - **Removed, and named in the upload's `removed` list** (the editor shows them in a notice):
    `<script>`, `<foreignObject>`, `<iframe>`/`<embed>`/`<object>`, animation elements (they can
    set `href`), `<a>` (unwrapped: its content stays), every other element off the list with its
    content, every attribute off the list (so every `on*`), prefixed names except `xlink:href` and
    `xml:*`, processing instructions (`<?xml-stylesheet?>`), `href`s other than `#fragment` (on
    `<image>`, also a base64 PNG/JPEG/GIF/WebP/AVIF `data:` URL), `url()` other than `url(#…)` in
    attributes and CSS, `@import`, and a style sheet or declaration that still holds a CSS escape,
    `expression(`, `image-set(` and the like. Comments and the DOCTYPE go without mention.
  - **Refused with a 400 and the reason** (the paste notice reads "Could not add the image:
    x.svg was refused as an unsafe SVG: …"): not UTF-8, not well-formed, a root other than
    `<svg>` in the SVG namespace, a DOCTYPE with an internal subset (entities: XXE, billion
    laughs), any entity other than the five predefined and numeric ones, nesting deeper than 256.
    Removing these would mean guessing what the file meant, and an entity can hide anything.
  - **Why not a dependency:** DOMPurify needs a DOM (jsdom, which AGENTS.md rules out);
    `sanitize-html` is an HTML sanitiser with postcss and htmlparser2 behind it and no SVG
    allow-list. 600 lines (half of them the two allow-lists) with 44 tests in `svg.test.ts` are
    smaller than either. **Why not refuse
    everything off the list:** Inkscape, Illustrator and draw.io files always carry editor
    metadata, so a strict refusal would refuse most real drawings.
  - **Where it runs:** the paste/drop route (sanitised bytes are stored), a job's result check
    (an SVG it would refuse sends the agent to repair, like a malformed `result.json`), accepting
    a job's asset into the bundle (sanitised copy; one that changed since the check is a 409),
    and `fileResponse`, so a job preview and a file the writer copied into a bundle by hand are
    served clean too (unreadable → 415). The export zip copies the bundle as is: everything that
    entered it through openwrite is already clean, and "exact bytes" stays the export's promise.
  - **What the writer loses:** `<foreignObject>` HTML labels (draw.io, mermaid with
    `htmlLabels`) — a `<switch>` fallback `<text>` stays; animation; links; external fonts and
    images. Mermaid diagrams are not affected: they are rendered in the browser to inline SVG and
    sanitised by DOMPurify there, never stored as an asset.
- **An acceptance the client could not apply is withdrawn, not kept.** The server records
  "accepted" (and copies assets) before the client applies the op to the live document, which only
  the client knows. If the block vanished during that round trip, the client calls
  `POST /api/jobs/:id/decisions/withdraw`: the op is undecided again, a settled job is reviewable
  again, and a `blocks` job then goes stale as usual. Applying first and recording second was
  rejected: a failed recording would leave an applied edit that the job still offers as a ghost.
  A failed withdraw leaves the old behaviour (a notice), so it is never worse than before.
- **An image upload that finishes after its editor closed is announced,** with the file name and
  the reference to type; the reference is not guessed into a block the writer has left.
- **The block of an open editor is always in the document.** Every structural change goes through
  `change()` in the doc reducer; if a change takes the focused block away without touching it (an
  accepted op that opens a code fence swallows the blocks after it), the typed text is put back
  where it was, under its old ID, with a notice. An untouched open editor just closes. Deleting
  the focused block on purpose closes its editor and is not rescued.
- **Where a rescued block or an open new-block slot goes is decided by an unchanged neighbour,
  not by an ID.** `reconcile` gives the first block of a changed run the old ID of that run, and
  a replace op keeps the replaced block's ID, so after an outside edit an ID can answer for a
  different paragraph — one inserted in front of the edited block, say — and trusting it put the
  writer's text or slot on the wrong side of it. A neighbour counts only if it is still there
  under its ID *with its text*; the one before wins, then the one after. When both changed, the
  region was rewritten and nothing says where in it the position went, so the nearest block still
  answering to its ID is kept as the guess (the old rule).
- **When text fuses into a block that was already there, the editor follows it to the nearest
  block holding it, not the first.** An unclosed fence swallows what is put back after it, so the
  editor has to find the block that took the text in. An article can say the same thing twice —
  or contain the few words just typed — and the first match anywhere reopened the editor on that
  block. The holder is the match nearest the insertion point, the block before it first (the side
  a fusing fence is on). Backspace into a heading, which cannot fuse, stays on its own block by ID
  for the same reason.
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
  first. *Superseded by issue #2:* see "Block identity across a page reload".
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

## Managing workspaces

- **The workspace is retargeted in place, never replaced.** `Workspace` caches nothing — every
  path method resolves from `root` when it is called — while every route module destructures
  `ServerContext` at mount time (`routes/docs.ts`, `export.ts`, `config.ts`) and `mountJobRoutes`
  takes `jobs` as a bare parameter. Swapping the instances would strand every route closure;
  mutating them is also what `DocWatcher.reset()` already exists for.
- **Everything after `quiesce` is one synchronous block.** `writeDoc` is fully synchronous, so a
  concurrent `PUT /api/docs/:kind/:slug` either completes entirely against the old root or begins
  entirely against the new one. An `await` inside that block would let a half-applied switch
  write the old workspace's document into the new workspace.
- **A job carries the workspace generation it started in.** Cancelling an agent is not enough:
  `pump()` launches runs fire-and-forget and `saveJobFile` creates the directory it writes to, so
  a run still settling would create `<new workspace>/.zen/jobs/<old id>/`. The job's own state
  checkpoints do not cover a job created *while* the switch is waiting on `quiesce`, because
  nothing ever marked it stale. So `rebind()` moves an epoch that `run()`'s checkpoints,
  `update()` and `progress()` all consult.
- **`quiesce` waits for the runs it cancelled, but only for a budget.** Golden rule 8: a wedged
  agent may delay a switch by two seconds, never block the writer. The epoch fences whatever
  outlives the budget.
- **`workspacesFile` is required on `AppOptions`, not optional with an XDG default.** Injection
  is the only version in which the compiler proves that no test can write the developer's real
  `~/.config/openwrite/workspaces.json`. `XDG_CONFIG_HOME` is read in `main()` and nowhere else.
  It follows the `toolLookup` / `skillsDir` precedent.
- **The list degrades to `[]`; it never throws.** A missing, unreadable or hand-broken file must
  not stop the editor from starting, the same rule `loadConfig` follows.
- **The file is named `workspace-list.ts`, not `workspaces.ts`.** A file one letter away from the
  existing `workspace.ts` in the same directory is a readability trap.
- **No workspace route takes a filesystem path** (replaces "open takes a path"). Creating
  scaffolded, and opening switched the editor to, whatever absolute path the request named —
  `/` included — and in `npm run dev` that request can come from anyone on the network. Now
  `New workspace…` and `Open workspace…` take a *name* (kebab case, at most 64 characters, so it
  cannot spell `..`, a separator or an absolute path), resolved inside one folder the server owns:
  `<repo>/.openwrite/workspaces/` (`AppOptions.workspacesDir`, injected like `workspacesFile` so
  no test writes the real one). A symlink at `<home>/<name>` is refused, not followed, and the
  created directory's realpath is checked before anything is written into it. Switching to a
  remembered workspace goes by **id** (`POST /api/workspaces/:id/open`), as erase already did.
  A root outside the folder — a Hugo site — enters the list only through `--workspace` /
  `OPENWRITE_WORKSPACE`, which only the local user can type. The erase verb stays `erase`
  rather than a second `DELETE`, because two delete verbs — one meaning "forget", one meaning
  "destroy" — is how an accident happens.
- **The workspace request bodies are strict** (`z.strictObject`): erase, open and create. A
  plain `z.object` strips unknown keys, so a body carrying a `path` would be silently ignored
  rather than refused; on the routes that decide which directory the editor touches, a refusal
  is the clearer answer.
- **An absolute `contentDir` is still allowed** (OD1). It is the other way a request can point
  the editor outside the workspace, and it is the Hugo feature; restricting it is the writer's
  call, not a side effect of this fix.
- **`rm -r` is the delete, and a test is why.** `rmSync(root, { recursive: true, force: true })`
  unlinks a symlink instead of walking through it — proven by a real decoy inside a workspace
  pointing at a directory outside it, not by Node's documentation. The top is checked separately:
  a recorded root that is itself a symlink is refused rather than followed.
- **A workspace whose `contentDir` points outside it cannot be erased at all.** Deleting only
  what it owns would leave the writer believing the workspace is gone while their real Hugo posts
  remain. The refusal names `contentDir` so it is not mistaken for a bug; removing the entry from
  the list still works.
- **The tracked `sample-workspace/` is recognised by path**, resolved from `import.meta.dirname`
  the same way `main.ts` derives `REPO_ROOT`. There is no marker file inside it, and adding one
  would change what every test copies. The gitignored `.openwrite/sample-workspace` copy stays
  deletable: `defaultWorkspace()` re-creates it, and deleting it is already the documented reset.
- **`/api/health` reports `workspace.root`, not `options.workspace`.** The latter is the string
  the process started with and would keep naming the old workspace after a switch.
- **The switch clears the open documents and bumps a document session.** `resync()` reconciles
  every open document against disk, so a document left in the store after a switch would be read
  as an *outside change* to the new workspace's article of the same slug. The session counter
  covers what clearing cannot: a load or a save already in flight belongs to the workspace that
  is no longer open, and is dropped when it lands rather than written into the new one's state.
- **The switch waits for the saves; it does not fire them.** `flushAll` fires `void flush(...)`
  and returns void, so awaiting it guarantees nothing; `flush` is the one that returns a promise.
  After the server retargets, a save resolves against the new root, so the order is what keeps
  unsaved work. An e2e spec injects five seconds of save latency to force that order rather than
  race it.
- **`src/client/state/app.ts` was edited rather than worked around** (manager decision on Q3,
  option (a)). The alternative — a second state container for the confirmation dialog — would
  have shipped the race the session counter closes, and this client has exactly one store. The
  edits are four: the `confirm` palette mode, the workspace list in `AppState` beside `articles`
  and `skills` (the palette lists it the same way), the document session, and one `else if` for
  `workspace.changed`. The parallel work item that owned the file had merged, so the conflict
  risk was zero rather than merely low.
- **The delete confirmation trims surrounding space, like every other palette input.** A stray
  space is not evidence of an accident; a different name is, and is refused. The server compares
  without trimming, because it is a second lock and not a re-run of the typing.
- **The mutating workspace routes are serialised through one promise chain.** They all read the
  list, change the world and write it back; two interleaving across the `await` in `quiesce`
  would lose a write, or retarget while another request was halfway through an erase.
- **Live agent handles are tracked apart from the job list (#15, R6).** `rebind()` clears
  `entries`, and `cancelAll()` used to walk `entries`, so an agent that outlived the switch —
  one created while `quiesce` waited, or one whose cancel was slow — was unreachable from
  `shutdown()` and kept running and spending. Now every started handle sits in a `live` set until
  its own `done` settles; `cancelAll()` walks that set, and `rebind()` force-cancels whatever is
  still in it, since everything there belongs to the workspace being left. The epoch still fences
  the writes; this closes the process.
- **The list is written before the switch retargets anything (#15, R8).** `touch()` is the one
  fallible step of a switch. Written last, a failure 500'd a server that had already moved, with
  no `workspace.changed` for any client. Written first, it runs even before `quiesce`, so a
  failure stops no job either; the worst it leaves is an entry for a workspace that was not
  opened, which the palette can still open or forget.
- **The server keeps the realpath of the workspace it started on (#15, R9).** `validRoot` already
  gave every switch a realpath and the list stored realpaths, but `createApp` kept the lexical
  `--workspace`; through a symlink `active.root` matched no entry, and the client offered to
  erase the open workspace. One form everywhere is cheaper than teaching each comparison.
- **An entry's `path` must be absolute, in the schema and again in erase (#15, R7).** The shared
  schema tests the shape by regex (POSIX `/`, `C:\`, `\\server`) because it is imported by the
  client and cannot use `node:path`. A relative entry fails the file's schema, so, like any other
  hand-broken entry, the list reads as empty rather than guessing. Erase checks
  `path.isAbsolute` and refuses the filesystem root itself (`assertErasablePath`), because it is
  the one route that deletes and should not rely on a parse it does not see.

## Workspace switch safety (issue #15, R1–R5, R10)

- **A request is pinned to the workspace it was admitted under** (`pinWorkspace` in
  `src/server/http.ts`). "Everything after `quiesce` is one synchronous block" protects the
  switch, not the route on the other side: a `PUT` that entered under A and was still awaiting
  its body resumed after the switch against B, because `retarget` moves the shared object in
  place. The route now takes the root before its first `await` and checks it after the last one.
  Pinned: the document read and save, new article, image upload, settings save, both exports,
  and job creation — every route that reads or writes a workspace after awaiting a body.
- **Every request from the page also names the workspace the tab shows**
  (`x-openwrite-workspace`, set once in `api.ts`'s `request()` and on the export's own `fetch`).
  Pinning alone cannot catch a tab that has not heard of a switch yet: its request arrives after
  the switch and is admitted under B. The refusal is a 409 with `workspaceChanged: true`
  (`WorkspaceMovedSchema`), distinct from the document conflict, so the client follows the server
  instead of reconciling another workspace's text into its own. A header that does not decode is
  refused, not ignored. The header stays optional for requests typed by hand; the pin does not.
- **`null === null` stays the rule for "absent on both sides".** The sweep found six nullable
  hash comparisons (`writeDoc`, the watcher, `onDocChanged`, `resync`, and the reducer's `saved`
  and `external`). Each is correct *within one workspace* — a brief nobody wrote yet is created
  on its first save exactly because both hashes are null. What was missing was the workspace
  identity beside them, which the pin and the header now supply; changing the comparison would
  have broken creation instead.
- **A switch whose save fails does not happen.** `flush` resolves even when the save failed (it
  shows a notice and retries by itself), so `move` checks what is still dirty after flushing and
  refuses with the documents' names. The alternative, switching anyway, discards the only copy:
  there is no local draft store. A writer whose disk is gone cannot switch until the retry lands,
  which is the lesser harm; the unload guard still warns before a reload.
- **Another tab's unsaved text stops the follow and asks** (`moved`). A late save would write
  the old workspace's text into the new one (and is now refused), and following discards it.
  So a tab that hears of a switch while it holds unsaved text stays on its workspace, pauses
  autosave, ignores every event about the new workspace (documents, settings, jobs — they would
  land on the wrong documents), and shows a warning that stays until the writer chooses: *go back
  and save* (switch the server back and save there; other tabs follow as they would any switch)
  or *discard and follow*. A browser-storage rescue was rejected: it would keep article text
  outside the file, a second copy with its own staleness rules, for a case two buttons settle.
- **The tab that switches ignores `workspace.changed` while its switch is under way**
  (`switching`), rather than comparing roots. The server emits the event before it answers, and
  the store learns the new root only when the answer arrives, so the root comparison was always
  false for the asking tab and it adopted twice — clearing whatever was typed in between.
- **The document is inert while this tab switches.** The switch saves first and may wait up to
  `quiesce`'s budget for jobs; text typed meanwhile would be cleared by the adopt. Golden rule 8
  is about the writer's work being blocked by agents; here the writer asked to leave the document,
  and the status line says why it is still.
- **A reconnect checks the workspace before the documents.** `resync` on `hello` now asks for
  the open workspace first and, when it is not the tab's, hands it to the same handler as the
  live event; only then does it sync jobs and compare documents. Without it, a switch made while
  the stream was down made B's article of the same slug arrive as an outside change to A's.
- **A failure with no document open gets a notice of its own** (`AppState.notice`). It used to
  go to `console.error`, and the workspace commands — erase among them — are reachable from an
  empty workspace.
- **The erase confirmation carries a warning that stays** (`warning` on the `confirm` palette
  mode, in `--warn`, naming the path it deletes). The placeholder that carried it vanished on the
  first keystroke. Palette hints wrap (`overflow-wrap: anywhere`) instead of overflowing: a
  workspace path from `--workspace` can be one long word.

## Shell and panels (ui-rethink)

- **"No sidebar" is superseded.** The writer asked for two auto-hide, toggleable panels: left for
  files and actions, right for talking to the agent. They are closed on first run and open only on
  purpose, which keeps the zen default: with both closed the page is the old page plus two handles.
- **Always-visible controls: the two edge handles.** The work item asked for an on-screen toggle
  that can be discovered, not only a key. They are small text glyphs in `--quiet` on a 24×48 target
  (WCAG 2.5.8's minimum, without relying on spacing), and pressing one never blurs an open block
  (`mousedown` is prevented, as the review buttons do). Below 776px the block gutter reaches the
  window's edge, so the left handle leaves its fixed spot for the page's top padding, where it can
  never cover a block's drag handle; the key and the palette still reach the panel from anywhere.
- **Shortcuts `Ctrl/Cmd+B` and `Ctrl/Cmd+Alt+B`** are VS Code's two sidebar keys, which the writer
  already knows. CodeMirror binds neither, and they are matched on `event.code` because Option
  changes `event.key` on macOS. Browsers other than Chromium are not tested (Playwright runs
  Chromium only); the handles are the fallback. The keys are one table in `shell/keys.ts`.
- **A panel docks only when the column keeps 680px.** A docked panel reserves its width
  (`body[data-left|right="docked"]` padding), and the column is centred in what is left. When
  both cannot dock, the right panel keeps the dock: research answers arrive there unasked and must
  never cover the text. Below its width the right panel stacks after the article, the research
  panel's old behaviour generalised. The left panel becomes a drawer, and only after a hand-made
  opening in this page session, so a reload never comes back with the text covered. One pure
  function (`shell/layout.ts`) decides, so every threshold is unit-tested.
- **Closed panels are not mounted.** The zen spec's zero-landmark check holds, and nothing
  focusable hides off-screen. The composer's draft lives in the jobs store, so closing keeps it.
- **The right panel is a `region`, not an `aside`.** The research notes stay the only
  complementary landmark, so `research.spec`'s "none after discard" holds with the panel open.
- **Toggling never moves the focus; "Go to …" does.** Opening a panel while typing must not close
  the block (blur commits). The palette's Go to commands, Tab and a click are the ways in.
- **Escape belongs to the innermost owner.** Inside a panel it hands the keyboard back to where it
  was before (a drawer also closes); a docked panel stays open, since closing is the toggle's job.
  The handler sits on each panel's root, not on a global router, so Escape in a block keeps
  meaning "render it".
- **Bare Enter no longer enters the document from a focused button** (a bug found while building
  this: `App.tsx` swallowed Enter on the tray's button). Key precedence is now a pure, tested
  function (`shell/keys.ts`).
- **Panel state lives in `.zen/config.json` (`ui`), per workspace.** It is Q2's recorded default.
  Moving it to the browser (localStorage) would be about 20 lines in two files if the writer
  prefers that. zod 4's `.prefault({})` is used, because `.default({})` skips the inner defaults.
- **Every config write goes through one queue.** The quick toggles (`saveConfigPatch`: theme,
  panels) and the Settings form (`saveSettings`) share it. Each write builds its body when its
  turn comes, and toggles made while one waits share a single write. The server replaces the
  whole file on each PUT, so without the queue an earlier write could land last, or a background
  toggle could undo a Settings save. `refreshConfig` keeps the local theme and panels while a write
  is queued. This also fixes the same race the theme command had.
- **A config write names its workspace (`x-openwrite-workspace`), and a switch waits for the
  queue.** One server has one open workspace, and a switch (from this tab or another) can happen
  while a write is on its way. `PUT /api/config` refuses, with 409, a write made for a workspace
  that is no longer open. The check and the write run with no await between them, so no switch
  falls in between. A tab drains its config queue before it asks to switch, and reloads the config
  after a refusal. The header is optional, so a request without it still works as before.
- **A settings save touches the document watcher only when `contentDir` changed, and then it
  follows the documents instead of forgetting them.** Any other save (a panel toggle, a theme)
  leaves the watcher alone. A real `contentDir` change used to `reset()` it, and nothing
  re-registered an open document until it was read again — the client reads nothing on
  `config.changed` — so an outside change went unnoticed, even to `strategy.md`, whose path does
  not depend on `contentDir` at all. `DocWatcher.follow()` re-registers every tracked document at
  its new path with the hash the client last got, and checks it at once: an article whose slug
  now resolves to a different file (or to none) is announced like any outside change, so the
  editor reloads it, or pauses autosave instead of creating it. A workspace switch still
  `reset()`s: every document belongs to the old workspace, and the client drops them all.
- **The tray is promoted in place, not rewritten.** It keeps its "Agent jobs" region and count
  button, so the job specs run unchanged. Turns run oldest first, like a conversation, each with
  its scope and skill. `trayOpen` and "Show agent jobs" are gone; the panel toggle replaces them.
- **The prompt pill and ghost diffs stay in context.** The pill belongs at the selection it acts
  on and never takes focus by appearing; a diff has to sit on the text it changes.
- **The composer asks about the whole article or a research question.** Blocks scope stays with
  the pill, which has the selection. `/name` runs a skill with the skill's own scope, as the
  palette does.
- **Conversation context rides inside the job contract (Q1, middle path).** A follow-up turn's
  request carries the earlier turns about the same document (any entry point, since the last "New
  conversation" about that document, a few turns). The server writes them to `conversation.md`, re-bounded whatever
  arrives, to the limits in `CONVERSATION_LIMITS` (`src/shared/jobs/conversation.ts`; README lists
  them). `instruction.md` names the file in the `.zen/jobs/<id>/` form, so codex's path remap
  covers it. A first turn's files are exactly what they were. There is no adapter, `result.json`
  or scheduler change, no streaming and no resumable session: that would be a separate piece of
  work across four adapters.
- **Earlier agent output becomes later agent input.** Summaries and research notes are agent
  output (untrusted). They enter only a later job's input, bounded and labelled "context, not
  instructions", and every op still needs the writer's accept.
- **The turns are picked when the job is posted, not when it is requested.** A held request then
  carries what became of the job it waited for. "New conversation" is a timestamp compared with
  each job's `createdAt`, so a dismissed job cannot leave the thread's start dangling.
- **The palette groups commands** (Documents, Agent, Export, Workspace, App) with a required
  `group` on every command. It is one listbox with ARIA groups and one flat active index. Titles
  are kept: `runCommand` in e2e presses Enter on the first match, and a unit test pins the first
  match of all 18 queries the suite runs.
- **Every option has one home, written down** in `docs/ui-inventory.md`, and a unit test fails when
  a palette command is missing from it. Workspace rename, remove and delete stay in the palette
  only: the delete has its typed confirmation there, and none of the three belongs one click away.
- **No new colour tokens.** The panels use `--surface`, `--line`, `--fg`, `--quiet` and `--accent`,
  pairs the contrast test already checks. `--left-panel` and `--right-panel` are size tokens.
- **Assumed for the writer to confirm:**
  - the state is per workspace (Q2);
  - a narrow agent panel stacks under the article, with "Go to agent" to jump there;
  - the shortcuts are the VS Code pair.

  Each is a cheap change.

## Type and spacing scales (issue #9)

- **One type scale and one spacing scale, on `:root` in `theme.css`.** Every component rule
  refers to a token; `src/client/theme-scale.test.ts` fails on a raw px/rem size, a bare
  line-height, weight or letter-spacing, or a px/rem inline style outside the token block.
  Inventory before the change (all client CSS lives in `theme.css`; no inline style set a size):
  font-size 14 distinct values, line-height 8, letter-spacing 3, font-weight 1, font families 4
  stacks, spacing (margin/padding/gap/offsets) 18 distinct px values.
- **Interface text, px:** `--text-xs` 12, `--text-sm` 13, `--text-md` 14, `--text-lg` 15,
  `--text-xl` 16, `--text-prose` 18. `0.75rem` and `0.875rem` were 12px and 14px already; the
  composer's skill errors (`0.85em` of 14px, 11.9px) became `--text-xs`. The 12–15 steps stay one
  pixel apart on purpose: each is a distinct role (label / meta / panel / palette and source).
- **The article's scale stays in em** (`--prose-h1` 2em, `--prose-h2` 1.4em, `--prose-h3` 1.15em,
  `--prose-table` 0.9em, `--prose-code` 0.85em, `--prose-tag` 0.75em, `--prose-flow` 1.1em), so
  it follows `--text-prose`; its values are unchanged, and em spacing is allowed only under
  `.rendered`, where it is the article's rhythm.
- **Leading:** `--leading-none` 1, `-tight` 1.2, `-snug` 1.3, `-ui` 1.4, `-normal` 1.5,
  `-source` 1.65, `-prose` 1.7. The front matter's lone 1.6 merged into 1.5.
- **Weight and tracking:** `--weight-strong` 600; the uppercase labels' 0.04/0.06/0.08em became
  one `--tracking-caps` 0.06em (three labels that play one role should not differ by 0.02em).
- **Spacing:** `--space-1` … `--space-11` = 2, 4, 6, 8, 12, 16, 20, 24, 48, 72, 96px: a 4px grid
  with 2 and 6 for tight controls, and 48/72/96 for page-level gaps. Merges: 5→6 (settings
  inputs), 10→12 (palette items and labels, composer input, panel item gap, research note),
  14→12 (palette input, code block padding, link gaps, research note margin), 18→16 (settings
  save), 22→24 (panel sections), 28→24 (under the front matter), 80→96 (a panel's bottom padding).
  Accepted visual differences: code blocks are 4px shorter and the article starts ~5px higher
  under the front matter line; the column width and every size and line height of the article's
  text are unchanged. The standalone export (`src/server/export.ts`) keeps its own CSS (14px
  code-block padding); it is a separate document, not a client component.
- **Not tokenised, by rule:** borders, outlines and radii (hairlines), shadows, and widths and
  heights (the 680px column, panel widths, the 24×48 handle). One commented allow-list entry: the
  drag gutter's `left: -44px`, which follows the gutter's 40px width, not the scale; and the
  export stage's off-screen `left:-10000px` in `render/export-html.ts`.

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
