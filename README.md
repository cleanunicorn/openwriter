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
