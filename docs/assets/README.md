# README visuals

These are deliberately selected public documentation examples. User-uploaded reference videos and ordinary generated research output remain excluded.

## Rich character motion

The `rich-*` assets show a new stylized 2.5D film generated with Higgsfield / Seedance 2.5, using three original Dream Stage styleframes from earlier work. Its close-up, rocket reveal, foreground wipe and final tableau include multiple objects, broad gradients, rim lights and reflections. [Source, projects and edit method](../../examples/rich-motion/README.md).

| Asset | Left | Right | Range |
| --- | --- | --- | --- |
| `rich-conversion.gif` | Prepared AI source | Actual SVG reconstruction with frame redraw | Full 8.0417-second source |
| `rich-title-edit.gif` | Unedited SVG | DREAM STAGE → SAEGIM STUDIO, edited in the app | Final 2 seconds |
| `rich-color-edit.gif` | Unedited SVG | Cyan/teal → warm orange paint and gradient-stop edit | Final 2 seconds |

These 768 × 274 silent GIFs include comparison labels and use 20 FPS. Full conversion has 161 frames / 8.05 seconds; each edit has 40 frames / 2 seconds. Analysis uses all 193 native timestamps at 24 FPS after downscaling the source to 640 × 360. [Rich asset manifest](rich-showcase-manifest.json). The generated input and the fitted SVG have visible differences; these are actual automatic drafts.

## Character and gradients

The three `character-*` GIFs use an original character clip generated specifically for this demonstration with Higgsfield / Seedance 2.5, followed by local video analysis and actual engine rendering. A raster title was added before analysis. See [the character example](../../examples/character-gradient/README.md) for the source MP4, prompt, importable projects, edit method and remaining defects.

| Asset | Left | Right |
| --- | --- | --- |
| `character-conversion.gif` | Prepared AI-generated source video | Actual automatic HTML/SVG draft with frame redraw |
| `character-title-edit.gif` | Unedited reconstruction | Title edited through the app: HELLO → SAEGIM |
| `character-color-edit.gif` | Unedited reconstruction | Script-assisted orange → teal paint/gradient-stop edit |

These silent GIFs contain 81 frames at 20 FPS, run for 4.05 seconds and measure 960 × 328 including labels. The source is 97 frames at 24 FPS, about 4.0417 seconds. The GIF duration is quantized to 50 ms delays. [Character asset manifest](character-showcase-manifest.json).

## Basic shapes

The original three GIFs use the repository's independently drawn synthetic fixture. They are not derived from user-uploaded reference videos. See [the basic reconstruction example](../../examples/reconstruction-demo/README.md) for provenance, reproducible commands, edit steps and verification limits.

| Asset | Left | Right |
| --- | --- | --- |
| `conversion.gif` | Independently drawn source video | Actual automatic HTML/SVG reconstruction |
| `title-edit.gif` | Unedited reconstruction | Same project with the title edited in the app |
| `color-edit.gif` | Unedited reconstruction | Same project with two shape fills edited in the app |

These silent GIFs contain 60 frames at 20 FPS, run for 3 seconds and measure 960 × 328 including labels. [Basic asset manifest](showcase-manifest.json).

All headers explain the comparisons and are not part of the reconstructed scenes. `editor.png` is a separate screenshot of the [authored editable-motion example](../../examples/editable-motion/README.md). It shows the editor interface, not an automatic conversion result.
