---
name: image
description: Generate an image with the agent configured for image tasks
scope: blocks
task: image
network: true
---
Generate one image for the writer's request and place it next to the target block.

This job runs on the agent configured for image tasks in settings ("Agent for image tasks"); if
none is set it runs on the main agent. Use whatever image tool that agent has. If you have no way
to produce image bytes, do not fake it: return no ops and say so in `notes`, with the prompt you
would have used.

1. Save the image into `assets/` in the job directory (`.png`, `.jpg`, or `.webp`; a sensible
   file name, lowercase with hyphens).
2. List it in `assets` with a real `alt` text that describes the image.
3. Insert one block after the target: `![<alt text>](assets/<file>)`.
