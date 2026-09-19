---
name: draft-article
description: Draft the article from its brief, following the strategy
scope: article
document: article
---
Draft the article from its brief.

1. Read `brief.md` and `strategy.md` in the job directory. The brief decides the angle, the
   reader, and the outline; the strategy decides voice and structure rules.
2. Read the files under `sources/` that the brief points to. Do not invent facts, numbers, or
   quotes: where a source is missing, leave a visible `TODO:` line and say so in `notes`.
3. Write one block per paragraph, heading, list, or code fence. Leave the front matter alone.
4. If the article is empty (or has only front matter), insert the draft after the start anchor
   or after the last existing block. If it already has sections, fill and extend them rather
   than starting over.

Hugo shortcodes (`{{< … >}}`, `{{% … %}}`) must pass through unchanged.
