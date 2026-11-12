# Rich motion: characters, gradients and scene changes

This example follows the earlier Dream Stage visual studies with a new film: character and companion close-up, monitor/rocket reveal, foreground occlusion wipe, and a final stage with stairs, clouds, stars, rim lights and floor reflections. It uses stylized 2.5D shading over rounded geometric silhouettes.

[Full source comparison](../../docs/assets/rich-conversion.gif) · [Title edit](../../docs/assets/rich-title-edit.gif) · [Palette edit](../../docs/assets/rich-color-edit.gif)

| File | Content |
| --- | --- |
| [rich-source.mp4](rich-source.mp4) | Complete prepared 8.0417-second input, including the added final title |
| [project.json](project.json) | Editable reconstruction of the **final 2 seconds**, with frame redraw |
| [title-edited.json](title-edited.json) | Same final scene, with DREAM STAGE → SAEGIM STUDIO edited through the app |
| [colors-edited.json](colors-edited.json) | Same final scene, with cyan/teal paints changed to warm orange |
| [surface-refined.zip](surface-refined.zip) | Refined contours and tracked material-color edits; extract the app schema 1 JSON before importing |
| [generation.json](generation.json) | Generation prompt, settings, reference provenance and source hashes |

The comparison GIF covers the **entire film**. The three JSON projects cover source **6.0416666667–8.0416666667 seconds**, frames 145–192 inclusive, with their local timeline reset to 0–2 seconds. They are not projects for the whole film. Each compressed project is about 8.1 MB and contains 1,709 tracked elements, including one editable title. Choose **프로젝트 열기** in the editor to import a JSON file; no Higgsfield account or new generation is needed.

## Source preparation and conversion

Higgsfield / Seedance 2.5 generated the input on 2026-10-25 using three original Dream Stage styleframes from earlier work as image references. No third-party reference film was uploaded or included. The source has 193 frames at 24 FPS, 1280 × 720, lasting 8.0417 seconds. The reference images are retained privately; their provenance and hashes are listed. Prompt-only regeneration is not expected to reproduce identical pixels. The complete prepared input is included so the reconstruction can be tried independently of generation.

For this demonstration, the full clip was downscaled to 640 × 360. A raster `DREAM STAGE` title in Arial Bold was added at the top left over the final 48 frames before analysis. No shots were removed or retimed, and no contours were manually cleaned up. Audio and font binaries are not included. The left side of the conversion GIF is this prepared input, not the untouched 720p generation.

Saegim's local high-quality analyzer and macOS Vision OCR processed all 193 observation times. Local orchestration divided the work into frame ranges `[0,49)`, `[49,97)`, `[97,145)` and `[145,193)`, then assembled native app schema 2 segments. Those are processing boundaries, not scene cuts. The source cut scan found boundaries at 2.25 and 4.3333 seconds. Frame redraw is enabled, so the output does not crossfade incompatible shapes or blend across cuts. Higgsfield generated the source only; it did not perform the SVG conversion.

The final scene was also analyzed as a separate 48-frame excerpt for editing. The three original downloadable JSON files use native **app schema 2**, with one compressed schema 1 scene. Compression does not simplify geometry or flatten text. Source references to temporary storage are removed. These files are not `object-scene-v1` or parametric experiment inputs.

## Title edit

Import `project.json`, select the `DREAM STAGE` text element and change **텍스트** to `SAEGIM STUDIO`. The example was edited in the app and checked after save/reload. Unselected nodes, IDs, keyframes, gradients and layer order remain identical. Both strings fit the reviewed layout. The title is real text; changing it does not require regenerating the video.

## Palette edit

The color variant is a **script-assisted paint edit**. It selects measured cyan/teal colors with HLS hue 154.8–201.6°, saturation above 0.35 and lightness between 0.10 and 0.90. Hue is rotated by −160° while retaining HLS lightness and saturation. The fixed rule is applied to non-text fills, strokes and gradient-stop colors in every observation.

This changes the cap, shoes, floating companion and matching stage accents. It is a palette-wide transformation, not automatic semantic clothing selection. Other elements with the same selected hues also change. Blue/purple highlights and reflections outside that hue range remain cool; this is not a complete material/lighting replacement. The app's solid-fill control is a different operation and can flatten shading.

Only color values change. Geometry, element IDs, layer order, keyframe times, gradient type/coordinates, stop offsets and opacity are retained. This preserves the fitted gradient structure, not physical lighting or a recovered material model. The palette rule is specific to this example and must be checked before using it on another video.

## Try the local conversion

After [setup](../../README.md#quick-start), with the API running, analyze the same final excerpt:

```sh
npm run workflow -- analyze \
  --input examples/rich-motion/rich-source.mp4 \
  --out-dir artifacts/rich-example/analysis --quality high \
  --clip-start 6.041666666666667 --clip-end 8.041666666666666
```

Open the result, enable **프레임 다시 그리기**, edit and save. Automatic text recognition currently requires macOS; provided projects can be opened on other supported platforms without running OCR again. To examine other shots, select their source ranges explicitly. Complex full-length high-quality analysis can exceed per-project element limits, so short processing ranges are useful.

Render the included final scene directly and compare it with the aligned source excerpt:

```sh
npm run workflow -- render \
  --project examples/rich-motion/project.json \
  --out-dir artifacts/rich-example/render --fps 20 --width 384

npm run workflow -- compare \
  --source examples/rich-motion/rich-source.mp4 \
  --source-start 6.041666666666667 \
  --rendered artifacts/rich-example/render/preview.mp4 \
  --output artifacts/rich-example/comparison.gif --fps 20 --width 384
```

Use `title-edited.json` or `colors-edited.json` with a new output folder for each edit. README headers were added after rendering; the scene pixels come from the source and actual engine output.

## Verification and limits

The [asset manifest](../../docs/assets/rich-showcase-manifest.json) records source hashes, analysis counts, project compression checks, title/palette preservation checks, export sizes, GIF timing and sampled visual review.

The complete film was rendered at the source rate of 24 FPS before both sides were converted together to a 20 FPS GIF. This keeps source-frame selection aligned. GIFs use a 256-color palette with ordered dithering for manageable downloads.

The complete comparison GIF has 161 frames at 20 FPS and lasts 8.05 seconds, quantized to 50 ms delays. Each final-scene edit GIF has 40 frames and lasts 2 seconds. GIF output FPS is not an accuracy score or extra source observations. All exported frames are decoded for timing validation; selected timestamps and enlarged crops are reviewed visually, not every frame.

The reconstruction is an automatic draft. In the reviewed jump around 4.9 seconds, thin closed-eye and mouth lines disappear; the tiny companion can also lose its eyes in wide shots. Cap/hand rim lights become thicker, and broad soft gradients and reflections split into visible bands or patches. Rocket/cloud/stair contours remain rough. The fitted title font weight and outline differ from the source. Detected color regions are not semantic body parts, a skeleton or recovered source design layers. The generated source can also have imperfect anatomy or movement. These examples demonstrate the editable workflow and its visible limits.


## Surface-aware refinement

`surface-refined.zip` contains the additional **app schema 1** finale project `surface-refined.json`. Extract the ZIP, then open its JSON in the editor. The archive keeps the example below this repository’s 10 MiB per-file policy. It keeps real text, IDs, z-order, gradient parameters and frame redraw. The previous palette-only example remains available as a baseline.

The refinement has two parts:

1. A reusable `workflow refine-surfaces` step simplifies observed paths within a pixel budget and tests ellipse fits. It preserves small details and holes. An interior is filled only when an opaque upper layer covers it and bidirectional source motion supports an independently moving foreground element in at least two neighboring observations. Source motion is also compared with surrounding background, since background visible through a real hole can have relative motion. Cuts separate evidence. A bounding-box-only prototype falsely treated segmentation jitter as motion and was rejected.
2. For this color demonstration, four **manually traced source-visible material outlines** (cap, two shoes, companion) were propagated through the 48 neighboring source frames. Their clipped SVG paint regions use a continuous linear-RGB material-chroma replacement with a luminance-neutral delta and gamut limiting. This replaces the narrow hue threshold inside those materials. Neutral highlights remain light; colored-light residuals can remain. Existing palette edits elsewhere are retained. This is an annotated example, not a general semantic material parser, and the standalone geometry command does not create these material annotations.

The final two-second excerpt has little motion. Its 96 bounding-box-based fill candidates were rejected by the source-motion check: **no hidden holes were automatically filled in this example**. Genuine-hole candidates and ambiguous interiors stay unchanged. Moving opaque occluders, real holes, transparency, static-source jitter and cut boundaries are covered by separate synthetic tests.

Across 48 observations, bounded polyline simplification reduced vertices from 1,216,258 to 1,207,866 (0.69%). No ellipse fit met the tolerance on this fragmented reconstruction. This is modest simplification, not recovery of whole semantic parts. The unedited-color geometry comparison changed mean RGB absolute error against the source from 9.25670 to 9.25614 on a 0–255 scale; this is effectively unchanged overall fidelity, not a meaningful accuracy gain. The main visible gain is the material color coverage: cool-colored pixels inside four eroded annotated surfaces fell from 26,138 to 19 across all observations. That count describes this selected color-edit defect, not reconstruction accuracy or every edge pixel.

All 48 source / previous / refined frames were inspected in contact sheets, with enlarged cap and shoe crops. The actual editor passed import, title change to `SAEGIM STUDIO`, save, reload and JSON export; non-text nodes were unchanged by that title edit. All 48 packaged-project SVG observations equal the reviewed schema 1 renders. New comparison GIFs retain 48 observations with 40/50 ms delays totaling 2 seconds. Broad quantized lighting bands, rough contours, small facial details and the floor reflection colors still differ from the source. The other six seconds have not received this refinement.

[Full comparison GIF](../../docs/assets/rich-surface-refinement.gif) · [Detail GIF](../../docs/assets/rich-material-detail.gif) · [Refinement report](../../docs/assets/rich-surface-refinement.json)
