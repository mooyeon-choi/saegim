# Agent workflow

Open the repository in your coding agent, install the dependencies in the [README](../README.md), and provide a local source path and output directory. If the agent does not discover skills automatically, explicitly ask it to read `AGENTS.md` and the appropriate `SKILL.md`.

| Skill | Use |
| --- | --- |
| [Motion graphics reconstruction](../.agents/skills/motion-graphics-reconstruction/SKILL.md) | Analyze a video, preserve edits and cuts, reconstruct and compare |
| [Vector part source matching](../.agents/skills/vector-part-source-matching/SKILL.md) | Refine contours, stacking, gradients and lighting in an existing vector project |

These are repository instructions, not a standalone conversion engine or MCP service. They need local media, this code and installed dependencies. Analysis does not require an external AI API key; your coding agent's access and data policies are separate.

## Example request

> Read AGENTS.md and the reconstruction skill. Convert the local file I provide, preserve editable text, identify real cuts, and save a project and source comparison under artifacts/my-video. Report observed failures and regions that still need annotations.

For existing parts:

> Read the part-matching skill. Use the current render as a fixed baseline. Refine the largest contour and lighting errors first, comparing each candidate with the same source region and times. Preserve stable IDs, title editing and frame redraw. Include overlays and a comparison GIF.

## Comparison loop

1. Record source metadata, selected range, project schema and edit requirements.
2. Save the baseline project and render. Choose fixed comparison times and regions.
3. Inspect contours, overlap order and visible color samples. Keep source-specific masks and corrections in ignored data.
4. Change a bounded part, render again, and compare baseline/candidate/source at identical times and crops.
5. Reject regressions and check adjacent frames, cut boundaries and text editing.
6. Save the accepted project, measurements and comparisons. State which frames were actually reviewed.

If the user requests a team, assign separate parts or read-only review tasks against the same frozen baseline. Give one owner responsibility for integrating changes and re-rendering the combined result. Workers must not independently overwrite the same project artifact.

Do not treat output FPS as reconstruction accuracy, raw RGB differences as similarity percentages, or sampled review as full-video review. Do not hide incompatible geometry by blending full frames across cuts.

## Reproducible public examples

Use [the authored sample](../examples/editable-motion/README.md) or synthetic fixture tools in [scripts.md](scripts.md) for issues without private media. Label authored examples separately from analyzed outputs. Do not commit user uploads, source-specific palettes, masks or research notes.
