# From video to editable elements

These are the actual projects behind the README's [conversion](../../docs/assets/conversion.gif), [title edit](../../docs/assets/title-edit.gif) and [color edit](../../docs/assets/color-edit.gif) GIFs. Unlike the separate authored sample, this example starts with a raster video and uses the application's analysis API.

| Project | What it shows |
| --- | --- |
| [project.json](project.json) | Automatic reconstruction: one rectangle, one ellipse and one real text element |
| [title-edited.json](title-edited.json) | `HELLO FRAME` changed to `HELLO SAEGIM` through the editor |
| [colors-edited.json](colors-edited.json) | Circle fill changed to `#25c6b5`, rectangle fill to `#9b87f5` through the editor |

Clone/download the repository, start the app, click **프로젝트 열기** (Open project), and select one of these files. The local source-video URL has been removed so projects do not point at the author's temporary API storage. No geometry, text, timing or analysis warnings were removed. The source video can be generated below and uploaded separately for comparison.

## Source and scope

- Source: `motion-shapes.mp4`, independently drawn with Pillow by [create-fixtures.py](../../scripts/create-fixtures.py), without the reconstruction engine.
- Source format: 480 × 270, 3 seconds, 30 FPS, 90 frames, no audio or scene cuts.
- Analysis: `standard`, 30 samples/second, 90 observations; macOS Vision OCR recognized the title. No manual contour, tracking or font cleanup was applied.
- Rendering: the actual standalone HTML/SVG player at 480 × 270, 20 FPS, 60 frames per variant. The comparison GIFs are 960 × 328 including their presentation header, loop for 3 seconds and contain no audio.
- Edits: made through the normal text/fill controls and exported as JSON. Title and color examples each start from the unedited reconstruction.

The source and documentation GIFs are synthetic project examples covered by the repository's MIT license. No third-party source video or font binary is embedded. Font availability, OCR and encoder versions can affect reproduction. Automatic OCR currently requires macOS; the included projects can be imported without rerunning OCR.

The reconstruction retains visible font, color and edge differences. This small flat-color example demonstrates the workflow; it is not a fidelity claim for arbitrary videos or complex characters. The color example uses solid fills and does not demonstrate shading-preserving recoloring.

## Reproduce the scene

From the repository root, install dependencies as described in the [README](../../README.md#quick-start), then generate the synthetic source:

```sh
.venv/bin/python scripts/create-fixtures.py
```

With `npm run dev` running in another terminal:

```sh
npm run workflow -- analyze \
  --input .data/qa-fixtures/motion-shapes.mp4 \
  --out-dir artifacts/readme-demo/analysis \
  --quality standard --sample-fps 30

npm run workflow -- render \
  --project artifacts/readme-demo/analysis/project.json \
  --out-dir artifacts/readme-demo/render --fps 20 --width 480

npm run workflow -- compare \
  --source .data/qa-fixtures/motion-shapes.mp4 \
  --rendered artifacts/readme-demo/render/preview.mp4 \
  --output artifacts/readme-demo/comparison.gif --fps 20 --width 480
```

The CLI comparison uses its default ORIGINAL/RECONSTRUCTED header. The README GIFs add explanatory headers after rendering; the scene pixels come from the same source and rendered videos.

To reproduce the edits, import the analyzed project, select `HELLO FRAME`, edit **텍스트**, then export a project JSON. For the color example, start again from the unedited project, select the circle and rectangle, and set **채우기** to the values above. Render the saved JSON with the same `render` command and a new output folder. You can also render the included edited projects directly.

## Verification performed

- All three 60-frame MP4s rendered successfully; no raster/media nodes in the SVG stage, browser errors or external requests were observed by the renderer.
- Title/fill changes survived JSON export and editor reload. IDs, layer order, duration, geometry and motion keyframes stayed unchanged; the unselected elements stayed unchanged.
- All 60 frames of each GIF decoded successfully with a total delay of 3,000 ms.
- Visual comparison used samples at 0, 0.35, 0.7, 1.05, 1.4, 1.75, 2.1, 2.45 and 2.95 seconds. This was sampled visual review, not a visual inspection of every frame.
- Public project data is the checked analysis/editor output with only the local `source` metadata removed.

[Asset sizes and SHA-256 values](../../docs/assets/showcase-manifest.json) identify the published GIFs.
