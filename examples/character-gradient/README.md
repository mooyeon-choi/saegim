# Character animation and gradients

This is the character example in the main README: [source comparison](../../docs/assets/character-conversion.gif), [title edit](../../docs/assets/character-title-edit.gif) and [palette edit](../../docs/assets/character-color-edit.gif). All right-hand panels are rendered by Saegim's real HTML/SVG engine.

| File | What to try |
| --- | --- |
| [character-source.mp4](character-source.mp4) | The actual input video, including the title composited before analysis |
| [project.json](project.json) | Automatic reconstruction, with frame redraw enabled in the editor |
| [title-edited.json](title-edited.json) | The same scene with `HELLO` changed to `SAEGIM` through the editor |
| [colors-edited.json](colors-edited.json) | The same scene with orange paints changed to teal, retaining gradient definitions |

Start the app and choose **프로젝트 열기** (Open project) to import a JSON file. The included projects work without a Higgsfield account or another generation. Each JSON is about 3.6 MB and contains 996 tracked elements (995 paths and one text node). Source-video references to temporary local storage have been removed; the MP4 above is provided separately for source comparison.

## Source and provenance

The source character was generated specifically for this demonstration with **Higgsfield / Seedance 2.5** on 2026-10-25, using text only and no reference media. It is an AI-generated example, separate from the repository's independently drawn basic-shape fixture. [The generation prompt and settings](generation.json) are included; regenerating from the prompt is not expected to reproduce identical pixels.

The generated file contains 97 frames at 24 FPS, 854 × 480, about 4.0417 seconds. The entire clip was retained at native dimensions. Before analysis, a raster `HELLO` title was composited into its empty left side using Arial Bold, then the result was encoded as a silent H.264 MP4. The left panel in the comparison GIF is this prepared input. No font binaries are included.

Saegim analyzed that input using its general `high` route and macOS Vision OCR. Higgsfield generated the input video only; it did not perform the SVG reconstruction. Frame redraw was then enabled through the editor. There was no manual contour, tracking, face or lighting cleanup.

The downloadable JSON files use the app's **schema 2 compressed composition**, with one segment containing the complete schema 1 scene. Compression does not simplify geometry or flatten text. The decoded scene and its SVG output were checked against the edited scene. This is the app's native format, not `object-scene-v1` or the separate parametric experiment schema.

## Title edit

Import `project.json`, select the `HELLO` text element, change **텍스트** to `SAEGIM`, then export JSON. The title remains real text. Its edit was performed through the app and checked after save/reload; the character's nodes, gradients and motion were unchanged. The longer phrase must still be checked against available space when choosing your own title.

## Palette edit

The color example is **script-assisted**, not the app's solid-fill picker. The picker intentionally replaces inferred shading with a solid color.

For this example, measured orange paints were selected using a fixed HLS rule: hue 0–37.8°, saturation above 0.42, lightness between 0.12 and 0.78. Hue was rotated by +150° while retaining HLS lightness and saturation. The same rule was applied to non-text fills, strokes and gradient-stop colors in every observation. This changes the cap and jacket to teal while leaving skin, eyes, background, shorts and title untouched in the reviewed frames.

Only color values were changed. Element IDs, geometry, layer order, keyframe times, gradient type, gradient coordinates, stop offsets and opacity remained identical. This retains the fitted shading structure; it does not recover physical lighting or provide automatic semantic clothing selection. The rule is specific to this example's palette and should not be assumed safe for arbitrary videos.

## Reproduce the conversion and renders

After the [normal setup](../../README.md#quick-start), with the local API running:

```sh
npm run workflow -- analyze \
  --input examples/character-gradient/character-source.mp4 \
  --out-dir artifacts/character-example/analysis --quality high
```

Open the resulting project in the editor, enable **프레임 다시 그리기**, make any edits, and export JSON. Automatic OCR currently requires macOS. The provided projects can be opened on other supported platforms without rerunning OCR.

Render one of the included projects directly:

```sh
npm run workflow -- render \
  --project examples/character-gradient/project.json \
  --out-dir artifacts/character-example/render --fps 20 --width 480

npm run workflow -- compare \
  --source examples/character-gradient/character-source.mp4 \
  --rendered artifacts/character-example/render/preview.mp4 \
  --output artifacts/character-example/comparison.gif --fps 20 --width 480
```

Use `title-edited.json` or `colors-edited.json` and another output folder to render each variant. The CLI creates its default ORIGINAL/RECONSTRUCTED header; the README GIFs have more descriptive headers added after rendering. Headers are presentation metadata, not reconstructed content.

## Verification and remaining differences

The [asset manifest](../../docs/assets/character-showcase-manifest.json) records the source hashes, analysis counts, edit checks, export sizes and GIF timing. The comparison uses the complete clip, including its first and last visible frames. The 20 FPS GIFs last 4.05 seconds because their duration is quantized to 50 ms frame delays.

Visual review samples 12 timestamps across the clip and uses enlarged character crops. This is not a visual review of every frame. All exported MP4/GIF frames are decoded for timing checks; decoded frame count is not reconstruction accuracy.

Thin nose/mouth lines are weakened or lost, and an eye pupil is missing in some reviewed frames. Cap, clothing and shoe edges remain rough; subtle shading and fine lines differ from the source. Color regions are tracked observations rather than semantic body parts or a recovered rig. The original generated character and its motion can also have imperfections. These examples show a usable editing workflow and its current limits, not exact recovery of source design files.
