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
