---
name: terminal-recording
description: Record a terminal session with asciinema and convert it to a gif with agg
scope: blocks
task: recording
requires: [asciinema, agg]
allow: [Bash(asciinema *), Bash(agg *), Bash(command -v *), Bash(bash *)]
---
Record a short terminal session that shows what the writer asks for.

1. First check the tools: run `command -v asciinema agg`. The editor already refuses to start
   this skill when either is missing; if one is missing anyway, do not try to install anything.
   Write a `result.json` with no ops and a `notes` field that names the missing tool and how to
   install it (`asciinema`: https://asciinema.org, `agg`: https://github.com/asciinema/agg), and stop.
2. Write the commands to show into `assets/<name>.sh` in the job directory. Keep it short,
   deterministic, and safe: no network, no secrets, nothing outside a temp directory.
3. Record it: `asciinema rec --overwrite -c "bash assets/<name>.sh" assets/<name>.cast`
4. Convert it: `agg assets/<name>.cast assets/<name>.gif`
5. Return both files in `assets` and insert one block after the target that shows the gif and
   links the cast: `![<alt text>](assets/<name>.gif)` followed by `[cast](assets/<name>.cast)`.
