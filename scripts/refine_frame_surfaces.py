"""Conservative surface decisions on renderer-evaluated frame observations.

This intermediate format is not an app project. Pixel masks are analysis only;
only vector contours and evidence leave this process. No source pixels are
embedded in the exported reconstruction.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import cv2
import numpy as np
from scipy.ndimage import binary_fill_holes


def polygons(path):
    if not isinstance(path, str) or re.search(r'[^MLZmlz0-9eE.,+\s-]', path):
        return None  # Unsupported geometry stays untouched, never approximated blindly.
    tokens = re.findall(r'[MLZmlz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?', path)
    rings, ring, pos, command, i = [], [], np.zeros(2), '', 0
    try:
        while i < len(tokens):
            if tokens[i] in 'MLZmlz':
                command = tokens[i]; i += 1
                if command.upper() == 'Z':
                    if len(ring) < 3: return None
                    rings.append(np.array(ring, np.float32)); pos = ring[0]; ring = []; command = ''; continue
            if command.upper() not in ('M', 'L') or i + 1 >= len(tokens): return None
            point = np.array([float(tokens[i]), float(tokens[i+1])]); i += 2
            if command.islower(): point += pos
            if command.upper() == 'M' and ring: return None
            ring.append(point); pos = point; command = 'l' if command.islower() else 'L'
        return rings if rings and not ring else None
    except (ValueError, IndexError):
        return None


def to_world(points, node):
    p = points * [node['width']/1000, node['height']/1000]
    center = np.array([node['width']/2, node['height']/2])
    a = np.deg2rad(node['rotation']); rotation = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    return ((p-center)@rotation.T + center + [node['x'], node['y']]).astype(np.float32)


def to_local(points, node):
    center = np.array([node['width']/2, node['height']/2])
    a = np.deg2rad(node['rotation']); rotation = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    return ((points-[node['x'], node['y']]-center)@rotation + center) / [node['width']/1000, node['height']/1000]


def raster(rings, shape):
    result = np.zeros(shape, np.uint8)
    if rings: cv2.fillPoly(result, [np.round(r*16).astype(np.int32) for r in rings], 1, shift=4)
    return result.astype(bool)


def path_string(rings, node):
    encode = lambda x: f'{x:.3f}'.rstrip('0').rstrip('.')
    return ' '.join('M'+' L'.join(f'{encode(x)} {encode(y)}' for x, y in to_local(r, node))+' Z' for r in rings)


def primitive_path(ring, node, tolerance):
    """Fit an ellipse only when BOTH outlines agree within the pixel budget."""
    area = cv2.contourArea(ring, oriented=True)
    if len(ring) < 12 or abs(area) < 50: return None
    hull_area = cv2.contourArea(cv2.convexHull(ring))
    if hull_area <= 0 or abs(area)/hull_area < .975: return None
    center, axes, degrees = cv2.fitEllipse(ring)
    radii = np.array(axes)/2
    if min(radii) < 2 or max(radii)/min(radii) > 10: return None
    if abs(np.pi*np.prod(radii)-abs(area)) > abs(area)*.015: return None
    a = np.deg2rad(degrees); rotation = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    def world(unit): return np.array(unit)*radii@rotation.T+center
    angles = np.linspace(0, 2*np.pi, 129)[:-1]
    sample = world(np.column_stack([np.cos(angles), np.sin(angles)])).astype(np.float32)
    # Sampling is denser than the output curve tessellation; keep a small
    # reserve for the cubic approximation to an ideal ellipse.
    limit = tolerance*.85
    if max(abs(cv2.pointPolygonTest(ring, tuple(map(float, p)), True)) for p in sample) > limit: return None
    if max(abs(cv2.pointPolygonTest(sample, tuple(map(float, p)), True)) for p in ring) > limit: return None
    k = .5522847498307936
    points = [[1,0],[1,k],[k,1],[0,1],[-k,1],[-1,k],[-1,0],[-1,-k],[-k,-1],[0,-1],[k,-1],[1,-k],[1,0]]
    if area < 0: points = [[x,-y] for x,y in points]
    local = to_local(world(points), node)
    encode = lambda p: f'{p[0]:.4f} {p[1]:.4f}'
    return 'M'+encode(local[0])+''.join(' C'+' '.join(encode(p) for p in local[i:i+3]) for i in (1,4,7,10))+' Z'


def simplify(rings, tolerance):
    result = []
    for ring in rings:
        area = cv2.contourArea(ring, oriented=True)
        # Bound both local edge displacement and area; preserve tiny details.
        epsilon = min(tolerance, max(.08, np.sqrt(abs(area))*.025))
        candidate = cv2.approxPolyDP(ring, epsilon, True).reshape(-1, 2)
        new_area = cv2.contourArea(candidate, oriented=True)
        if len(candidate) >= 3 and area*new_area > 0 and abs(new_area-area) <= max(.4, abs(area)*.015):
            result.append(candidate)
        else:
            result.append(ring)
    return result


def classify_hole(hole, parent, owners, rgb):
    """A nested color alone never proves an occluder. Temporal confirmation follows."""
    count = int(hole.sum())
    outside = cv2.dilate(parent.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool) & ~binary_fill_holes(parent)
    if count < 9 or outside.sum() < 9: return {'kind': 'uncertain', 'reason': 'insufficient-support'}
    inside_color = np.median(rgb[hole], axis=0)
    # Compare to actual surrounding pixels, not a single global canvas color.
    colors = rgb[outside].astype(float)
    background_match = float(np.mean(np.linalg.norm(colors-inside_color, axis=1) < 14))
    if background_match > .35:
        return {'kind': 'possible-hole', 'reason': 'matches-surrounding-background', 'backgroundMatch': background_match}
    for index, mask, opaque in reversed(owners):
        coverage = float(np.count_nonzero(hole & mask)/count)
        if opaque and coverage >= .995:
            return {'kind': 'covered-candidate', 'owner': index, 'coverage': coverage,
                    'backgroundMatch': background_match, 'reason': 'opaque-upper-layer-covers-interior'}
    return {'kind': 'uncertain', 'reason': 'no-opaque-upper-owner', 'backgroundMatch': background_match}


def opaque_paint(node):
    if node['opacity'] < .995 or any(node.get(k) for k in ('occlusionPath', 'stackBoundary', 'paintRegions')):
        return False
    colors = [s['color'] for s in node['gradient']['stops']] if node.get('gradient') else [node.get('fill', '')]
    return all(re.fullmatch(r'#[0-9a-fA-F]{6}(?:[fF]{2})?', c) for c in colors)


def source_flow(a, b):
    """Bidirectional image flow; vector bbox jitter is not object motion."""
    a = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY); b = cv2.cvtColor(b, cv2.COLOR_RGB2GRAY)
    forward = cv2.calcOpticalFlowFarneback(a,b,None,.5,3,21,4,7,1.5,0)
    backward = cv2.calcOpticalFlowFarneback(b,a,None,.5,3,21,4,7,1.5,0)
    yy,xx = np.mgrid[:a.shape[0],:a.shape[1]].astype(np.float32)
    x,y = xx+forward[:,:,0], yy+forward[:,:,1]
    returned = cv2.remap(backward,x,y,cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
    reliable = (np.linalg.norm(forward+returned,axis=2)<1) & (x>=0) & (x<a.shape[1]-1) & (y>=0) & (y<a.shape[0]-1)
    return forward, reliable


def relative_flow(flow, reliable, parent, owner):
    # Avoid mixed antialiasing pixels at the actual silhouette.
    masks = [cv2.erode(m.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool) for m in (parent,owner)]
    if any(np.count_nonzero(m & reliable)<9 or np.mean(reliable[m])<.65 for m in masks): return None
    velocities = [np.median(flow[m & reliable],axis=0) for m in masks]
    return float(np.linalg.norm(velocities[0]-velocities[1]))


def confirm_occlusion(records, index, frame_index, nodes, masks, cuts):
    """Require the same foreground track to move relative to its enclosing surface.

    Static insets and static holes remain ambiguous. We do not invent a hidden
    surface just because the front color happens to differ from the background.
    """
    current = records[index]; parent = nodes[current['parent']]; owner = nodes[current['owner']]
    support, relative_motion = 0, 0.0
    current_relative = np.array([owner['x']-parent['x'], owner['y']-parent['y']])
    for other in records:
        if other['frame'] == frame_index or abs(other['frame']-frame_index) > 4: continue
        if any(min(frame_index, other['frame']) < cut <= max(frame_index, other['frame']) for cut in cuts): continue
        if other['parentId'] != parent['id'] or other.get('ownerId') != owner['id'] or other.get('reason') != 'opaque-upper-layer-covers-interior': continue
        support += 1
        relative_motion = max(relative_motion, float(np.linalg.norm(current_relative-np.array(other['relative']))))
    return support >= 2 and relative_motion >= .6, support, relative_motion


def run(snapshot, source, source_start, tolerance):
    width, height = snapshot['width'], snapshot['height']
    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened(): raise ValueError('Cannot open source video')
    if (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))) != (width, height):
        raise ValueError('Source and project dimensions must match; resize the source explicitly first')
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not np.isfinite(fps) or fps <= 0: raise ValueError('Invalid source FPS')
    # Sequential decoding uses measured PTS when the backend supplies them. This
    # tool requires aligned CFR observations; VFR must be resampled explicitly.
    targets = [source_start+frame['time'] for frame in snapshot['frames']]
    requested = {round(t*fps) for t in targets}
    frames, index = {}, 0
    while True:
        ok, bgr = cap.read()
        if not ok: break
        pts = cap.get(cv2.CAP_PROP_POS_MSEC)/1000
        if not np.isfinite(pts) or abs(pts-index/fps) > .002:
            raise ValueError('This refinement tool requires constant-frame-rate input with readable PTS')
        if index in requested: frames[index] = (pts, cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        index += 1
    cap.release()
    if not requested.issubset(frames): raise ValueError('Source does not cover project observations')
    records, geometry, stats = [], [], {'beforeVertices': 0, 'afterVertices': 0, 'unsupportedStates': 0}
    shape = (height, width)
    for fi, frame in enumerate(snapshot['frames']):
        target = source_start+frame['time']; pts, rgb = frames[round(target*fps)]
        if abs(pts-target) > .51/fps: raise ValueError('Source does not cover project observations')
        nodes = frame['nodes']; masks, rings_list = [], []
        for node in nodes:
            raw = polygons(node.get('path')) if node['type'] == 'path' else None
            rings = [to_world(r, node) for r in raw] if raw and node['width'] > 0 and node['height'] > 0 else None
            rings_list.append(rings)
            masks.append(raster(rings, shape) if rings else np.zeros(shape, bool))
        refined = []
        for ni, (node, rings, mask) in enumerate(zip(nodes, rings_list, masks)):
            if not rings:
                stats['unsupportedStates'] += 1; refined.append(None); continue
            simple = simplify(rings, tolerance)
            # Reject topology changes and visible raster area drift beyond the
            # subpixel edge band. A hole cannot disappear through simplification.
            has_holes = any(cv2.contourArea(r, oriented=True) < 0 for r in rings)
            old_holes = None
            if has_holes:
                old_holes = binary_fill_holes(mask) & ~mask
                new_mask = raster(simple, shape); new_holes = binary_fill_holes(new_mask) & ~new_mask
                old_components = cv2.connectedComponents(old_holes.astype(np.uint8))[0]
                new_components = cv2.connectedComponents(new_holes.astype(np.uint8))[0]
                if old_components != new_components: simple = rings
            refined.append(simple)
            stats['beforeVertices'] += sum(map(len, rings)); stats['afterVertices'] += sum(map(len, simple))
            if not has_holes: continue
            if node.get('occlusionPath') or node.get('stackBoundary') or node.get('paintRegions') or node['opacity'] < .995: continue
            for ri, ring in enumerate(rings):
                if cv2.contourArea(ring, oriented=True) >= 0: continue
                hole = raster([ring], shape) & old_holes
                if hole.sum() < 9: continue
                owners = [(j, masks[j], opaque_paint(nodes[j])) for j in range(ni+1, len(nodes))]
                decision = classify_hole(hole, mask, owners, rgb)
                record = {'frame': fi, 'time': frame['time'], 'parent': ni, 'parentId': node['id'], 'ring': ri, 'pixels': int(hole.sum()), **decision}
                if 'owner' in decision:
                    owner = nodes[decision['owner']]; record.update(ownerId=owner['id'], relative=[owner['x']-node['x'], owner['y']-node['y']])
                records.append(record)
        geometry.append(refined)
        if fi % 8 == 0: print(json.dumps({'analyzedFrames': fi+1, 'frames': len(snapshot['frames'])}), flush=True)
    cut_frames = [next((i for i, frame in enumerate(snapshot['frames']) if frame['time'] >= t-1e-8), len(snapshot['frames'])) for t in snapshot['cuts']]
    changed, filled, ellipses = [], 0, 0
    flow_cache, cache_frame = {}, -1
    for index, record in enumerate(records):
        if record['kind'] != 'covered-candidate': continue
        fi = record['frame']; nodes = snapshot['frames'][fi]['nodes']
        confirmed, support, motion = confirm_occlusion(records, index, fi, nodes, None, cut_frames)
        image_motion, foreground_motion = [], []
        if confirmed:
            if cache_frame != fi: flow_cache = {}; cache_frame = fi
            masks = []
            for ni in (record['parent'], record['owner']):
                node = nodes[ni]; masks.append(raster([to_world(r,node) for r in polygons(node['path'])], shape))
            exterior = cv2.dilate(masks[0].astype(np.uint8),np.ones((9,9),np.uint8)).astype(bool) & ~binary_fill_holes(masks[0])
            neighbors = {r['frame'] for r in records if r['parentId']==record['parentId'] and r.get('ownerId')==record['ownerId'] and 0<abs(r['frame']-fi)<=4 and r.get('reason')=='opaque-upper-layer-covers-interior'}
            for neighbor in sorted(neighbors):
                if any(min(fi,neighbor)<cut<=max(fi,neighbor) for cut in cut_frames): continue
                if neighbor not in flow_cache:
                    flow_cache[neighbor] = source_flow(frames[round(targets[fi]*fps)][1], frames[round(targets[neighbor]*fps)][1])
                value = relative_flow(*flow_cache[neighbor], *masks)
                outside_value = relative_flow(*flow_cache[neighbor], exterior, masks[1])
                if value is not None and outside_value is not None:
                    # Background seen through a moving hole has relative motion
                    # too. It must not be promoted to an opaque foreground owner.
                    image_motion.append(min(value,outside_value))
                    foreground_motion.append(outside_value)
            confirmed = sum(v>=.6 for v in image_motion)>=2
        record.update(temporalSupport=support, relativeMotionPx=round(motion, 4), sourceFlowSupport=sum(v>=.6 for v in image_motion),
                      sourceRelativeFlowMaxPx=round(max(image_motion,default=0),4), sourceOwnerBackgroundFlowMaxPx=round(max(foreground_motion,default=0),4),
                      kind='inferred-occlusion' if confirmed else 'uncertain', inferred=confirmed)
        if confirmed: filled += 1
    for fi, (frame, refined) in enumerate(zip(snapshot['frames'], geometry)):
        for ni, (node, rings) in enumerate(zip(frame['nodes'], refined)):
            if rings is None: continue
            remove = {r['ring'] for r in records if r['frame'] == fi and r['parent'] == ni and r['kind'] == 'inferred-occlusion'}
            parts, primitive_count = [], 0
            for ri, ring in enumerate(rings):
                if ri in remove: continue
                primitive = primitive_path(ring, node, tolerance)
                parts.append(primitive or path_string([ring], node))
                ellipses += int(primitive is not None)
                primitive_count += int(primitive is not None)
            original_count = sum(map(len, polygons(node['path'])))
            if not remove and not primitive_count and sum(map(len, rings)) == original_count:
                continue
            new_path = ' '.join(parts)
            changed.append({'time': frame['time'], 'id': node['id'], 'path': new_path, 'filledHoles': len(remove)})
    digest = hashlib.sha256()
    with source.open('rb') as file:
        for chunk in iter(lambda: file.read(1024*1024), b''): digest.update(chunk)
    source_hash = digest.hexdigest()
    return {'schema': 'frame-surface-refinement-v1', 'changes': changed, 'decisions': records,
            'report': {**stats, 'ellipseContours': ellipses, 'frames': len(snapshot['frames']), 'inferredOccludedHoles': filled,
                       'preservedPossibleHoles': sum(r['kind'] == 'possible-hole' for r in records),
                       'preservedUncertainHoles': sum(r['kind'] == 'uncertain' for r in records),
                       'toleranceSourcePixels': tolerance, 'sourceStart': source_start,
                       'sourceFPS': fps, 'sourceSHA256': source_hash, 'sourceTimes': targets,
                       'hiddenGeometryIsInferred': True}}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--snapshots', required=True); p.add_argument('--source', required=True); p.add_argument('--source-start', type=float, default=0)
    p.add_argument('--tolerance', type=float, default=.6); p.add_argument('--output', required=True)
    args = p.parse_args()
    if not 0 < args.tolerance <= 1 or not np.isfinite(args.source_start) or args.source_start < 0: p.error('tolerance must be (0, 1]; source-start must be finite and nonnegative')
    data = json.loads(Path(args.snapshots).read_text())
    if data.get('schema') != 'evaluated-frame-surfaces-v1': p.error('Expected evaluated-frame-surfaces-v1 from refine-frame-surfaces.mjs')
    result = run(data, Path(args.source), args.source_start, args.tolerance)
    Path(args.output).write_text(json.dumps(result, separators=(',', ':'))+'\n')
    print(json.dumps(result['report']))

if __name__ == '__main__': main()
