---
name: draft-brief
description: Draft the article's brief (angle, target reader, outline) from the notes in sources/
scope: article
document: brief
---
Draft this article's brief. The document you are editing (`article.md` in the job directory) is
the brief itself, not the article.

1. Read the writer's notes and reference files under `sources/` in the workspace, and
   `strategy.md` in the job directory for voice and audience.
2. If the article already has text (its path is in the instruction's Context section), read it
   so the brief matches where the piece is going.
3. Propose a brief with these parts, as markdown blocks:
   - `# Brief: <working title>`
   - **Angle** — one sentence: the claim the piece makes.
   - **Target reader** — who they are and what they already know.
   - `## Outline` — a numbered list of sections, each with one line on what it must deliver.
   - `## Sources` — which notes or files back which section.
4. If the brief is empty, insert everything after the start anchor. If it has content, replace
   or extend the existing blocks instead of duplicating them.

Keep it short: a brief is a plan, not a draft. Put open questions for the writer in `notes`.
