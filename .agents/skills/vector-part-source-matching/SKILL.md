---
name: vector-part-source-matching
description: Iteratively match editable SVG parts to a supplied source image or video in this reconstruction repository. Use for part-by-part contour, stack, gradient and lighting refinement with original-versus-render comparisons. Requires local source media and an existing vector project; does not automatically infer hidden geometry or recover original design files.
---

# Match vector parts to source

Work from this repository root. Read [script contracts](../../../docs/scripts.md) for tools you use. For initial video conversion or ordinary export, use the companion [reconstruction skill](../motion-graphics-reconstruction/SKILL.md). This skill refines an existing reconstruction; keep case-specific paths, masks, palettes, part identities and corrections in ignored `artifacts/<run>/` data.

## Establish comparable evidence

- Identify the actual input schema and renderer. App schema 1/2, `object-scene-v1` and the parametric experiment are different formats. Validate the selected format before editing it.
- Preserve a baseline project and actual rendered images. Record source/project hashes, source timestamps or frame indices, clip offset, source and render dimensions, crop coordinates and renderer settings. Resolve alignment, fonts and color/alpha compositing before treating their errors as geometry errors. Derive times and cuts from the input, including variable-frame-rate timestamps when applicable.
- Inventory the requested part IDs, stack order, editable text, intentional color changes and active time mode. Intentional edits are excluded from source-color matching, not silently reverted. If the user wants one shape per part, retain one complete outer contour with internal gradient/paint regions as needed.
- Mark source-visible pixels and independently observed boundary segments for each part. Distinguish occluded regions, uncertain antialiased edges, reflected light, cast shadows and the surrounding background. Hidden surfaces can be filled for a coherent stack but are **inferred**, not measured source matches. A mask derived only from the candidate contour is not independent ground truth.

## Compare every requested part

For aligned source/render stills, prepare a `part-comparison-v1` manifest using the [part comparison contract](../../../docs/scripts.md#부품별-원본-비교), then run:

```sh
.venv/bin/python scripts/compare-parts.py \
  --manifest artifacts/my-run/comparison-input.json \
  --out-dir artifacts/my-run/comparison
```

The manifest supplies frame times, source/current/optional baseline images, fixed part ROIs and optional independently annotated visible-color masks. Keep those annotations fixed across iterations. This tool creates context crops, 50% overlays, amplified differences and RGB error reports; it does not align images, identify parts, render a project or measure silhouette accuracy. Capture the actual renderer first and export isolated SVG parts separately. Use a new comparison directory per candidate to retain evidence.

For each part at each reviewed time, capture from the **actual project renderer**:

1. The source context crop and the reconstructed crop at the same coordinates and scale.
2. A 50% overlay or alternating source/render view to reveal doubled edges, plus a labelled difference image when useful.
3. The isolated vector part on a neutral/checkered background, retaining its own clipping and gradients. Also inspect it in the full stack; isolation changes which hidden areas are visible.

Use the same crop for baseline and candidate, with enough surrounding context to show overlapping neighbors and light spill. Label a source crop containing neighboring objects as a context crop, not an isolated source part. Exports or thumbnails made from an earlier candidate cannot verify the final project.

Keep measurements separate:

- **Shape:** compare independently annotated visible boundaries in source-pixel units; report a typical and tail error, such as median and 95th-percentile edge distance. Match edges belonging to the same part; an overlapping prop, pupil or neighboring object is not that part's outer contour. Use silhouette overlap only where a reliable source-visible silhouette exists. Exclude inferred edges rather than declaring them correct.
- **Color/shading:** compare visible pixels belonging to the same material, excluding occluders and uncertain boundaries. Use held-out samples for gradient selection. State the metric and support size; RGB error or a gradient-fit score is not a reconstruction-accuracy percentage.
- **Composition/time:** check silhouette placement, occlusion order, contact points, lighting across neighboring surfaces, and changes between source-adjacent frames. A good full-frame average can conceal a poor eye, finger or prop.

If independent masks are unavailable, still deliver visual comparisons and describe the uncertain regions; do not manufacture a quantitative silhouette score. Preserve review coverage by part and frame so unreviewed areas remain explicit.

## Refine, render, decide, repeat

Work on the largest supported mismatch first, using small reversible candidates. Prefer this order when defects interact:

1. **Geometry:** position, size, pose and characteristic corners/curves. Preserve intentional straight edges and genuine holes. Reduce point count only when the source overlay supports it; smoothing alone can shrink narrow features.
2. **Stack and contact:** repair front/back ownership, complete occluded solid surfaces and align touching parts. Remove obsolete fragments only after checking whether they are geometry, reflection or shadow. Do not hide mismatch by growing every part or globally feathering borders.
3. **Surface appearance:** fit broad gradients from visible same-surface samples, then add supported highlight/shadow regions clipped to that part. A light patch is not automatically a separate silhouette or a cutout. Check gradient coordinates after geometry changes and avoid hard internal seams.
4. **Time:** repeat the comparison at first/last visibility, fast motion, overlap changes and both sides of a cut. Add observed anchors or split an unstable interval as supported by source frames. Preserve frame-by-frame redraw when enabled; do not replace it with interpolation, frame blending or embedded source pixels. Never interpolate across real cuts.

After each candidate, render again and compare against both the source and the previous accepted version. Accept only when the intended defect improves without an unexplained regression in neighboring parts, other reviewed frames or required editability. If a tradeoff is necessary, record it rather than hiding it in an aggregate score. Reject a failed candidate and keep the last accepted version.

Keep a compact iteration log: changed parts/parameters, evidence frames, baseline and candidate measurements, visual findings, accept/reject decision and remaining defects. Keep annotations used to fit a candidate separate from validation observations where practical. For a short changed shot, inspect every changed frame; for a larger task, state the sampling coverage and add frames around discovered failures.

Stop when the requested tolerances are met on the reviewed evidence, or when further supported candidates no longer improve the result. Establish tolerances from output scale and source certainty, not from a universal pixel threshold. If distinct attempts plateau, preserve the best accepted result and explain the limiting evidence or model feature. Do not keep adding geometry indefinitely or claim pixel identity for inferred surfaces.

## Preserve and deliver

- Verify stable IDs, z-order, clipping, real text and its timing, current color edits, shot boundaries and time mode. Test a text edit through save/reload/export when those paths could be affected. Check that unchanged regions or frames still render as before.
- Inspect the final exported HTML/SVG, arbitrary seeking and any comparison GIF/video against the same source times. Output FPS alone does not establish visual fidelity. Follow repository checks for affected source code.
- Deliver the accepted project, per-part comparison board or viewer, and a concise report of improvements, rejected tradeoffs, residual errors and exact review coverage. Link the real artifacts; do not call a sampled review a full-video review.
- This workflow does not authorize external uploads or publication. It also does not imply a universal semantic-part parser; source annotations and manual fitting remain explicit inputs when used.
