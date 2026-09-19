# herdr as an adapter backend — evaluation

Date: 2026-09-19 · herdr 0.9.1 · Claude Code 2.1.278 · Linux

**Question (build spec, milestone 5):** can herdr launch an agent in a pane, report state
reliably, and let the job still complete through the file contract — and does it earn its place
for long-running or multi-agent jobs (session persistence, visibility into sub-agents, stepping
in when an agent blocks)?

**Answer: yes, as an optional backend.** All five adoption criteria held, so a `herdr` adapter
ships behind the same `AgentAdapter` interface (`src/server/adapters/herdr.ts`) together with an
"Open this job in herdr" line in the job tray. `claude` and `codex` stay the default, direct
adapters: they are simpler, headless, and need no server.

## Safety of the experiment

The evaluation itself ran inside a live herdr session, whose panes inherit
`HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_PANE_ID`, … An unscoped `herdr` command therefore
talks to the *live* session. Every command below ran through a wrapper that removes all
`HERDR_*` variables and names the test session explicitly:

```bash
env -u HERDR_SOCKET_PATH -u HERDR_SESSION -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID \
    -u HERDR_WORKSPACE_ID herdr --session openwrite-eval "$@"
```

Before any mutating command, a read-only check proved the scoping:

| Command | Result |
| --- | --- |
| `herdr status` (unscoped, inside the live pane) | `socket: ~/.config/herdr/sessions/<live>/herdr.sock` |
| `herdr --session openwrite-eval status` | `status: not running`, `socket: ~/.config/herdr/sessions/openwrite-eval/herdr.sock` |

`--session` wins over the inherited socket, and `status` creates nothing. `herdr server stop`
was never run. The live session had 3 workspaces, 4 tabs and 12 panes before the experiment and
the same after it (`herdr api snapshot`, counted); the eval session was stopped with
`herdr session stop openwrite-eval` and removed with `herdr session delete openwrite-eval`, after
`herdr session list` confirmed the name. The session list afterwards shows the live session
`running` and no `openwrite-eval`.

## What was tried

| # | Criterion | Command(s) | Observed |
| --- | --- | --- | --- |
| 1 | Starts with no TTY, from a script | `herdr --session openwrite-eval server` (background, `nohup`) | "herdr server running; … api socket: …/openwrite-eval/herdr.sock"; `status` → `running` within a second |
| 2 | Launch in a pane | `workspace create --cwd <workspace> --label … --no-focus` → `root_pane.pane_id = w1:p1`; `pane run w1:p1 <fixture>`; `pane wait-output w1:p1 --regex 'OPENWRITE-JOB-DONE \S+ exit=\d+'` | a deterministic fixture wrote `result.json` into `.zen/jobs/<id>/` and the marker line was matched |
| 3 | Agent state reported reliably | `agent start evalclaude --kind claude --pane w1:p1 -- --permission-mode dontAsk --restricted --tools … --allowedTools "Edit(.zen/jobs/<id>/**)" --safe-mode` | `agent_status: idle`, `interactive_ready: true` |
| 4 | Completion through the file contract | `agent prompt evalclaude "Read .zen/jobs/<id>/instruction.md and follow it exactly." --wait --until idle --until done --until blocked` | returned after 12 s with `agent_status: idle`; `result.json` held the expected `replace` op; the article was untouched |
| 5 | Cancel | `pane split --pane w1:p1 --direction down`, `pane run <new> <script that records its pid and a child's pid>`, `pane close <new>` | both processes were gone after the close |
| 6 | Socket API, without the CLI | newline-delimited JSON on `…/openwrite-eval/herdr.sock`: `{"id":"ow-1","method":"pane.list","params":{}}`, `{"id":"ow-2","method":"agent.list","params":{}}` | matching `{"id":…,"result":…}` replies. One request per connection: a second request on the same connection got `ECONNRESET`. `herdr api schema --json` lists 129 methods and events, including `events.subscribe`, `pane.agent_status_changed`, `pane.exited`, `pane.output_matched`. |

Two side findings went back into the direct adapter:

- claude printed `Permission allow rule (--allowed-tools): Write(…) is not matched by file
  permission checks — only Edit(path) rules are`. The `Write(path)` rule was removed; `Edit(path)`
  covers every file-editing tool.
- The same confinement flags work for an interactive claude, so the herdr adapter reuses them
  (`claudeConfinement` in `claude.ts`).

## What the adapter does

1. Makes sure the named session (`openwrite-jobs`; `adapters.herdr.session` overrides it) is
   running, starting `herdr --session <name> server` detached when it is not.
2. `workspace create --cwd <workspace> --label job-<id> --no-focus`, then
   `agent start job-<id> --kind claude --pane <pane> -- <confinement flags> [--model …] [extraArgs]`.
3. `agent prompt job-<id> "<prompt>" --wait --until idle --until done --until blocked`. While the
   agent is `blocked` it keeps waiting and the tray says how to attach — that is the point of
   this backend.
4. When the agent settles the job manager validates `result.json` exactly as for any adapter.
5. Cancel closes the job's own pane; the job's herdr workspace is closed when the job ends.

Every call removes the `HERDR_*` variables and passes `--session`, so running openwrite from
inside a herdr pane cannot touch that pane's session. The adapter never calls `server stop`.

"Open this job in herdr" shows and copies `herdr session attach <session>`: the server cannot
open a terminal for the writer.

## Limits

- **Only `claude` inside herdr.** Interactive `codex` flags were not verified, so the adapter
  does not offer it.
- **No budget cap.** `--max-budget-usd` and `--permission-prompts` exist only in print mode; an
  interactive agent relies on `dontAsk` for "never ask" and has no spend limit of its own. The
  job timeout still applies.
- **State is herdr's detection,** not the agent's own exit code. It was correct in every run
  here (idle → working → idle), but it is a heuristic over the terminal.
- **Tested against a stub.** `herdr.test.ts` drives the adapter with a scripted CLI (argv,
  session scoping, blocked → wait, cancel, missing herdr). The real end-to-end path was exercised
  by hand with the same commands, as recorded above; it is not part of any automated suite, and
  CI never runs herdr.
