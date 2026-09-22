# UI inventory — where every option lives

Every command, control and setting in openwrite, each with exactly one home and the reason it is
there, including the ones deliberately left where they were. `src/client/ui-inventory.test.ts`
fails when a palette command, a labelled control or a button's text in the app's surfaces is
missing from this page. Update this page in the same
PR as any new command, control or setting.

**The shape.** A centred 680px writing column, and two edge panels that are closed on first run.

- **Files and actions** (left): `Ctrl/Cmd+B` or its edge handle.
- **Agent** (right): `Ctrl/Cmd+Alt+B` or its edge handle.

The command palette (`Ctrl/Cmd+K`) reaches **every** command. It is the universal second route
to everything, so it is not counted as a home.

**Home codes:**

| code | where |
|---|---|
| **L·W**, **L·D**, **L·A** | left panel: the Workspace, Documents and Actions sections |
| **R** | the right panel (agent conversation) |
| **P** | palette only |
| **S** | the Settings dialog |
| **C** | in context, next to the thing it acts on |
| **K** | keyboard |

## Commands

The palette groups them as Documents, Agent, Export, Workspace, App (`src/client/palette/group.ts`).

### Static commands

| id | title | home | reason |
|---|---|---|---|
| `new-article` | New article… | L·D | creating a file belongs with the file list |
| `edit-strategy` | Edit strategy | L·D "strategy.md" | it opens a document |
| `edit-brief` | Edit brief | L·D "Brief" | the current article's companion document |
| `draft-brief` | Draft brief from my notes | R starter (a row on an empty transcript, a chip under the composer after) | an agent job, reviewed like any other |
| `draft-article` | Draft article from brief | R starter (a row on an empty transcript, a chip under the composer after) | an agent job, reviewed like any other |
| `ask-article` | Instruct the agent: whole article… | R composer ("Ask about: whole article") | an agent request; the palette's own prompt stays too |
| `ask-research` | Research question… | R composer ("Ask about: research") | an agent request; the palette's own prompt stays too |
| `export-markdown` | Export: markdown + assets (zip) | L·A | the clearest action on the article |
| `export-html` | Export: standalone HTML + assets (zip) | L·A | the same |
| `workspace-open-name` | Open workspace… | L·W | workspace navigation |
| `workspace-new` | New workspace… | L·W | workspace navigation |
| `theme` | Theme: switch to … | L·A | a one-click quick toggle; Settings keeps the exact choice |
| `settings` | Settings… | L·A (opens S) | the dialog stays modal: it is a form over `.zen/config.json` |
| `toggle-left` | Toggle files and actions | K `Ctrl/Cmd+B` + the left handle | the panel's own toggle, also searchable |
| `toggle-right` | Toggle agent panel | K `Ctrl/Cmd+Alt+B` + the right handle | the same; replaces "Show agent jobs" |
| `go-left` | Go to files and actions | P | the explicit way to put the keyboard in the panel |
| `go-right` | Go to agent | P | the same; also scrolls a stacked agent panel into view |

### Dynamic families

| id | title | home | reason |
|---|---|---|---|
| `open:<slug>` | Open article: … | L·D article list | the persistent file browser the app lacked |
| `skill:<name>` | Run skill: … | R `/name` chips | skills are agent requests; `/name` also works in the pill and the composer; a workspace skill's hint says "workspace skill" |
| `skill-error:<file>` | Skill not loaded: … | R "Skills not loaded" list | a `.zen/skills/` file that did not load is found where the skills are; running it repeats the reason as a notice |
| `workspace-open:<id>` | Switch to workspace: … | L·W "Switch workspace" | navigation |
| `workspace-rename:<id>` | Rename workspace: … | P | rare; the palette's text prompt does it well |
| `workspace-forget:<id>` | Remove workspace from the list: … | P | rare |
| `workspace-erase:<id>` | Delete workspace from disk: … | P | destructive: it stays behind the palette's typed confirmation, off every panel |

## Controls outside the palette

| control | home | reason |
|---|---|---|
| Left and right edge handles | C (screen edges) | the discoverable toggles; the only always-visible chrome the shell adds |
| Job count ("1 running · 2 to review") | C bottom-right while the agent panel is closed or stacked below the article; heads the transcript when the panel is open | running and failed work stays in sight; clicking it opens the panel or scrolls to it |
| Transcript rows: Cancel, Open notes, Review (or "Review in <document title>" for another document), Dismiss / Reject and dismiss, the agent's output, herdr Copy (with its "Copy result" status), a held request's Cancel | R | the conversation: what was asked and what came of it |
| Document, scope and skill chips on each turn (the document only when it is not the one on screen) | R | what each turn was about, at a glance; the transcript holds every document's turns |
| Research notes: Insert as block, Close, Discard these notes | R, above the transcript | a research answer is part of the conversation |
| Composer: "Message to the agent", "Ask about", Send, `/skill` chips, starters | R | whole-article requests and research questions get a home outside the palette |
| "Skills not loaded" list under the `/skill` chips (only while a `.zen/skills/` file is broken) | R | the reason a workspace skill is missing stays in sight until the file is fixed; a notice also says it once |
| "Carries the last N turns …" and New conversation | R, under the composer | shows what the next message sends the agent, and lets the writer start clean |
| Prompt pill ("Ask the agent"): "Instruction for the agent", scope, `/skill`, `Ctrl/Cmd+I`, type-to-pill, Escape | C at the selection | anchored to what is selected; it never takes focus by appearing |
| Ghost diff: Accept, Reject, Accept all, Reject all; keys `Enter`/`a`, `Backspace`/`Delete`/`r`, with `Ctrl/Cmd` for the whole job | C on the text | a decision sits on the text it changes |
| Pending and queued marks on blocks | C | spatial feedback; the transcript has the detail |
| Margin selection, shift-click, the drag handle | C | the writing surface |
| Click-to-edit, Escape or click away to render, arrows across blocks, Enter to split, Backspace to merge, paste or drop an image | C | the writing surface (not part of this redesign) |
| Front-matter line | C | the writing surface |
| Document notice + Dismiss | C | failures stay where the writer is |
| Loading…, the load error + Retry, "This document does not exist on disk." | C | the same |
| Empty workspace: "No article yet." + New article + the `Ctrl/Cmd+B` hint | C | the first step, in place |
| Start writing | C | belongs to the empty document |
| `strategy.md` / `brief · <slug>` label | C; the left panel marks the same document as current | which document this is, next to its text |
| Palette: query, arrows, Enter, Escape, "No matching command", text prompts, typed confirmation | P | the universal keyboard route |
| "All commands" (bottom of the left panel's Actions, with its `Ctrl/Cmd+K` hint) | L·A | the palette's door from the panel, for a writer who reaches for the mouse |

## Keys

| key | does | where |
|---|---|---|
| `Ctrl/Cmd+K` | palette | anywhere, even behind Settings |
| `Ctrl/Cmd+B` | toggle files and actions; never moves the focus | anywhere but a modal, also while typing |
| `Ctrl/Cmd+Alt+B` | toggle the agent panel; never moves the focus | the same |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl/Cmd+Y` | undo and redo across the document | outside a text field (inside a block: the block's own) |
| `Enter` | edit the first block | on the page, not on a button, link or other control |
| `Ctrl/Cmd+I` | into the prompt pill | while the pill is showing |
| `Escape` | the innermost thing only: closes the palette or Settings; renders the open block; closes the pill or clears the block selection; inside a panel, gives the keyboard back to where it was (a narrow-window drawer also closes). It never opens or closes a panel from the document. | — |

## Settings (all in S)

- Main agent
- Agent for image tasks
- Content directory, with its outside/invalid notices
- Theme (the exact choice)
- Jobs running at once
- Job timeout
- Per adapter: command, model, extra arguments
- The invalid-config and `--adapter` notices
- Save, Close, and the saved/error status ("Settings status")

They are the form over `.zen/config.json` and change rarely. The panels' open/closed state is kept
in the same file (`ui`), but it is a toggle, not a setting, so the form does not show it. In a
narrow window a remembered left panel stays closed after a reload until opened by hand.

## Removed or merged

- `show-jobs` ("Show agent jobs"): merged into `toggle-right`. The tray's own open/closed flag is gone.
- The research side panel's own placement (`has-research`): the agent panel's layout does the same
  job for everything in it.
- Two separate right-hand surfaces (tray list, research notes) became one panel.
- The empty state's "press Ctrl/Cmd+K and choose New article…" became a button in place.
