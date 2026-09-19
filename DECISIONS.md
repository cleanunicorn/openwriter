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
- **Always-visible controls: none.** The notice line appears only when there is something to say.

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
