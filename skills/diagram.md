---
name: diagram
description: Produce a mermaid diagram as a fenced code block
scope: blocks
task: diagram
---
Produce a diagram for the writer's request as a fenced `mermaid` code block.

- Return it as markdown: an `insert_after` on the target block (or a `replace` if the target
  already is a mermaid block the writer wants changed).
- Use plain mermaid that renders without HTML labels: flowcharts (`graph TD` / `graph LR`),
  sequence diagrams, state diagrams. Keep node labels short; no styling directives, no click
  handlers, no `%%{init}%%` blocks.
- Add one sentence before or after the fence only if the diagram needs an introduction.
- No files are needed: `assets` stays empty.
