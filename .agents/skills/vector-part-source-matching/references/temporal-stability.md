# Stabilize frame-by-frame SVG redraws

Use a sequence where a contour appears to crawl or a smooth surface changes shape between redraws. Keep the last accepted project and render as the baseline. Identify the source observations corresponding to both SVG exports, including clip offsets and variable frame timestamps. Keep cuts separate from processing segment boundaries.

## Decide which marks belong together

Use the source to establish the same surface across neighboring observations. Align each neighbor to the current frame using optical flow in both directions. Check the round-trip displacement, bounds and source color agreement. A newly revealed finger has no earlier visible surface to borrow. Reset correspondence at a real cut.

| Source evidence at the same moving location | SVG treatment |
| --- | --- |
| Little spatial color change | Keep the fill and part identity stable while supported by the source. |
| Color varies gradually over a surface | Fit a clipped gradient to visible samples of that surface. Retain its direction and stop positions while they still explain the current observation. |
| A narrow color step persists along the same moving edge | Inspect both sides. Fit their paints separately and follow the observed antialiased contour. A sharp rim light can belong inside a part. Use the stack, visible silhouette and neighboring motion to decide ownership. |
| The edge is newly visible, occluded, or disagrees after alignment | Mark the correspondence uncertain. Redraw the visible portion from current evidence and reacquire the track when it reappears. |

Keep region labels stable inside a shot when competing fits explain the current source equally well. Release the earlier label when the source shows a genuine change. Fit gradients in a common surface coordinate system. After subdivision, inspect where adjacent fits meet on moving jaws, sleeves and other boundaries. If rectangular patches show through, constrain the correction to the observed material contour and re-render. Choose the support size from the visible detail.

Protect editable text and intentional palette edits throughout the fit. Keep the glyphs out of underlying corrections, retain the text node, and check its edited appearance at first and last visibility. Preserve existing layer order and frame-redraw timing. Use neighboring frames as evidence for each redraw.

## Measure the exported result

Capture baseline and candidate PNGs from the actual SVG player with `workflow render --stills-dir`. Match the source dimensions and observation times. Run [the temporal comparison command](../../../../docs/scripts.md#프레임-간-떨림-검수) on the aligned PNGs. Supply the first observation after every real cut. For an intentionally recolored or retitled project, use equivalent original-palette/title exports for source matching and verify the requested edits separately.

- **Same-screen change** measures how much the SVG's frame-to-frame RGB change differs from the change in the source. Review the largest regressing pairs at normal speed and frame-step through them.
- **Tracked change** compares render-minus-source errors along reliable source motion. Inspect support counts for flat areas, shading and contour candidates. If correspondence disappears during fast movement, inspect that transition in the same-screen comparison. Empty support provides no measurement.
- **Spatial error** catches a stable but misplaced edge or a frozen surface. Overlay the relevant source and rendered part and inspect thin features at native resolution.

Accept a candidate against the previous accepted render after checking both temporal and spatial results, newly visible edges, joins and editability. Save the original / previous / candidate comparison at matched times. For a location-specific review, overlay the optional role maps with a legend and identify which labels are estimates. Use lossless PNGs for measurements. GIF quantization can add banding to the displayed gradients.
