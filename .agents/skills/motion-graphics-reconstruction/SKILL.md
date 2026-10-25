---
name: motion-graphics-reconstruction
description: Reconstruct a supplied local 2D motion-graphics video into editable HTML/SVG with this repository. Use for video analysis, text or scoped color edits, shape/gradient reconstruction, temporal continuity, and source-versus-render comparison GIFs. Requires this repository and local input media; not a general image-generation skill.
---

# Motion graphics reconstruction

Work from this repository root. Read [README](../../../README.md) for setup and limits and [script contracts](../../../docs/scripts.md) for the chosen tool. Keep the user's source media and outputs under ignored working folders such as `artifacts/<run>/`; never overwrite the source.

## Choose the input and preserve intent

- Use the supplied local video. If none is accessible, ask for its path before analysis. Do independent setup or synthetic validation meanwhile.
- Read duration, dimensions, frame rate, existing project schema and analysis warnings. Do not assume a duration, shot list, font, character identity or palette from another video.
- Preserve requested text, colors, excluded subjects and previous edits. Write new outputs to a separate run unless overwrite was requested.
- Use the application's general analysis route first. Explain limits from observed results rather than promising exact recovery of original design files or hidden geometry.

## Analyze, edit and export

1. Run `npm run doctor`; install missing dependencies with the documented setup. Start `npm run dev` if the API is not running.
2. Run `npm run workflow -- analyze --input <video> --out-dir artifacts/<run>`. Select `--quality` and `--sample-fps` for the task. The sample-FPS option controls standard mode; high mode uses min(source FPS, 24). A clip needs both `--clip-start` and `--clip-end`; record its source-time offset. If high mode exceeds project budgets, use shorter clips or an explicitly reported standard-mode retry. Inspect `analysis.warnings`: standard mode can drop lower-ranked elements. Never report that fallback as preserving every detail.
3. Open the resulting project in the web editor to inspect and edit. Save the edited JSON separately. Keep actual text nodes editable; verify a changed phrase still fits and retains transforms, timing and occlusion. A raster/outline appearance alone is not proof of editable text.
4. Run `npm run workflow -- render --project <edited-json> --out-dir artifacts/<run>/render`. This accepts app schema 1 or 2, exports offline HTML and renders MP4 without audio. Match the desired time sampling; increasing output FPS does not recover missing observations.
5. Run `npm run workflow -- compare --source <video> --rendered <render>/preview.mp4 --output artifacts/<run>/comparison.gif`. For a selected clip, pass the same `--source-start`. Inspect the comparison and its timing report.

The app color control can replace estimated gradients with a flat color. Do not describe this as shading-preserving material editing. For that requirement, use explicit material groups in the experimental object model and verify its separate renderer.

## Refine shapes and continuity

For repeated part-by-part source matching, use the companion [Vector Part Source Matching skill](../vector-part-source-matching/SKILL.md). It keeps baseline/candidate comparisons, visible-source evidence and editability checks together.

- Prefer stable shapes, gradient stops and transforms over blending two whole frames. Choose trusted observed anchors within one shot, and preserve their geometry and appearance at the anchor times.
- Separate background, surface, shadow, highlight and foreground layers. Keep source stack order and clipping; inspect boundaries against both neighboring colors.
- Split unstable regions into smaller surfaces or shorter intervals. Preserve topology/point correspondence before interpolation. On cuts, ambiguous matching, new occlusion or major shape changes, split tracks or hold a supported observation instead of stretching or crossfading incompatible geometry.
- Treat object IDs and material groups as input data. Recolor only selected groups, preserving excluded objects and unchanged source materials. Check small objects and final shots as well as close-ups.
- For caller-supplied contour/ellipse/Bezier observations, see `object_scene_tracks.py` and `object-scene-runtime.mjs` in the script contracts. These are not video-to-object parsers and their `object-scene-v1` output is not an app project. `parametric-vector-model.mjs` has another explicit experimental schema. Never silently convert among these formats.

## Export separated vector elements

Use `workflow elements` with caller-defined regions to export representative static SVGs. For jagged contours, start with `--smooth-px 2` or `3` and inspect small details and actual holes. For an occluded solid surface, provide a complete schema 1 `surface.project`: use `underlay` to preserve known paint, or `replace` for a simple reconstructed shape. Put foreground occluders first in the layer array. Never fill every hole indiscriminately. Use `workflow fit-surfaces` to fit gradients from visible same-surface samples; inspect excluded material colors and held-out color error, and never report that score as hidden-source accuracy. Keep case geometry in ignored annotations, mark hidden surfaces as inferred, and test the element alone and in its complete stack. See the script contracts for the exact schema and limitations.

## Verify and deliver

- Check the first and final visible frame, both sides of every real cut, representative midpoints, fast limbs, small objects, occlusion, gradient edges and edited text. Sampled visual review does not imply every frame was visually reviewed.
- Verify duration and source offset, frame decoding, arbitrary seek, offline playback, no unexpected external requests, no embedded source video/image in the reconstructed stage, and that JSON edits survive save/reload/export.
- Run relevant engine/API/browser tests after code changes. The repository has synthetic fixtures that do not require reference media. Record actual commands, failures and limitations; do not infer a fidelity score from frame count or RGB differences.
- Deliver the edited JSON, standalone HTML, comparison GIF and concise validation findings using real file links. If reconstruction has obvious remaining defects, name them rather than calling it a completed high-fidelity match.
- Keep case data out of public source. For a requested release, run `npm run release:check` and `npm run release:package`. Packaging does not authorize remote publication.
