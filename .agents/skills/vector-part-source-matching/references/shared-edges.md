# Reconstruct and verify a shared edge

## Identify the geometry

Inspect the decoded source at native resolution before the vectorizer reduces its palette. Step through adjacent observations within a shot. A narrow stroke has two outside edges and a measurable width. A material contact has visible neighborhoods from two faces. Stripes, highlights and gradients can change inside either face while its outer contour stays continuous. Check real gaps, keylines and third materials where a proposed straight join ends.

In the ordinary high-quality analyzer, a weakly colored contact pixel may belong to a face when its observed color agrees with a mixture of the two nearby materials. A neutral separator needs its own evidence. Where both sides support a straight contact, the analyzer samples across the edge normal and fits one subpixel line. Both contours use that line. A small backing overlap covers the front edge's antialiasing. Each face owns its clipped stripe direction, spacing, phase and lighting. Inspect stripe ends and real openings in the complete stack. A curved, blurred or occluded contact can lack enough evidence for this fit. Keep the observed frame geometry when the fit fails.

## Run from the input

Use a fresh output directory. Record the input digest, analysis quality, dimensions, observation times and any resize, frame selection or clip offset. Use the same analysis input and observation grid as the baseline for a reproducibility check. Keep the original at native resolution for measuring the edge. Use the current checkout's API and renderer.

```sh
npm run workflow -- analyze --input "$input" --quality high --out-dir "$run/analysis"
```

For frame-by-frame delivery, work on a separate app schema 1/2 JSON copy. Verify the observation times against the proposed grid and keep the original cuts and global time origin. For a confirmed uniform grid, set `temporal.mode` to `frames`. When its measured `sampleFps` and the project FPS differ only by floating-point roundoff, use the project's exact stored FPS for both redraw and export. Even a tiny numerical difference when seeking can change rasterized pixels. Preserve genuinely different observation and playback rates. Keep packed segments intact. Apply any requested text or palette edits to a separate delivery copy.

```sh
.venv/bin/python - "$run/analysis/project.json" "$run/project.json" <<'PY'
import json, math, sys
from pathlib import Path

project = json.loads(Path(sys.argv[1]).read_bytes())
if project.get("schemaVersion") not in (1, 2) or not project.get("temporal", {}).get("sampleFps"):
    raise SystemExit("Expected an analyzed app project with an observation grid.")
project["temporal"]["mode"] = "frames"
sample_fps = project["temporal"]["sampleFps"]
if math.isclose(sample_fps, project["fps"], rel_tol=4 * sys.float_info.epsilon):
    project["temporal"]["sampleFps"] = project["fps"]
with Path(sys.argv[2]).open("x", encoding="utf-8") as output:
    json.dump(project, output, ensure_ascii=False, separators=(",", ":"))
PY
```

```sh
npm run workflow -- render --project "$run/project.json" --width "$width" --fps "$fps" \
  --stills-dir "$run/stills" --out-dir "$run/player"
```

Set `width` and `fps` to the comparison grid. Render every observation from the offline player. Use the captured PNGs for measurements and the GIF for viewing. Keep video-specific colors, coordinates and time windows in ignored review data.

## Compare geometry, paint and replay

1. Locate the visible contact from the source alone. Sample multiple cross-sections perpendicular to it. Select a color signal that separates the faces, for example RGB projected along the difference between their local colors. Orient the normal from the low signal to the high signal. Estimate both endpoints from visible source interiors on that normal and normalize the transition to a coverage between zero and one. The crossing position equals the high endpoint's coordinate minus the integral of that coverage along the normal (trapezoidal sum in pixels). Use the same source endpoints, normals, pixel-center mapping and estimator for every render. Reject low contrast, third-material crossings and normals whose endpoints fall outside the visible contact. Record the measurement unit, supported frames and cross-sections.
2. Measure the absolute displacement along each normal. Report a typical value and a tail value such as the mean and 95th percentile. To isolate sawteeth from an overall offset, also measure the residual displacement after subtracting its local trend along contiguous supported stretches. Inspect magnified synchronized crops with identical scaling. Check the full image for lost separators, stripe leakage, misplaced gradients and fast rotations.
3. Compare full-sequence spatial and temporal error independently using [the temporal comparison workflow](../../../../docs/scripts.md#프레임-간-떨림-검수). Derive cut starts from actual source times. For a repeat run, count pixel-identical decoded frames and record the largest channel difference against the accepted render. Report identical results as reproduced. State which observations were measured and which frames were visually inspected.
