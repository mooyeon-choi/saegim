"""Adversarial evidence for holes, upper-layer coverage and observation cuts."""
import importlib.util
from pathlib import Path
import cv2
import numpy as np
import pytest

spec = importlib.util.spec_from_file_location('surface_refinement', Path(__file__).parents[2]/'scripts/refine_frame_surfaces.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


def scene(background=(20, 30, 40), interior=(230, 150, 40)):
    parent = np.zeros((80, 100), bool); parent[10:70, 10:90] = True
    hole = np.zeros_like(parent); hole[30:50, 40:60] = True; parent[hole] = False
    rgb = np.full((80, 100, 3), background, np.uint8); rgb[parent] = (50, 160, 200); rgb[hole] = interior
    return parent, hole, rgb


def test_background_visible_through_donut_is_not_filled_even_with_upper_color_region():
    parent, hole, rgb = scene(interior=(20, 30, 40))
    assert m.classify_hole(hole, parent, [(2, hole, True)], rgb)['kind'] == 'possible-hole'


def test_transparent_or_incomplete_foreground_cannot_authorize_hidden_fill():
    parent, hole, rgb = scene()
    assert m.classify_hole(hole, parent, [(2, hole, False)], rgb)['kind'] == 'uncertain'
    half = hole.copy(); half[:, 50:] = False
    assert m.classify_hole(hole, parent, [(2, half, True)], rgb)['kind'] == 'uncertain'
    assert m.classify_hole(hole, parent, [(2, hole, True)], rgb)['kind'] == 'covered-candidate'


def test_motion_requires_multiple_observations_and_never_crosses_a_cut():
    nodes = [{'id': 'back', 'x': 0, 'y': 0}, {'id': 'front', 'x': 8, 'y': 0}]
    def records(moving):
        return [dict(frame=i, parent=0, owner=1, parentId='back', ownerId='front', kind='covered-candidate', reason='opaque-upper-layer-covers-interior', relative=[i*4 if moving else 8, 0]) for i in range(3)]
    rows = records(True)
    assert m.confirm_occlusion(rows, 2, 2, nodes, [], [])[0]
    assert not m.confirm_occlusion(rows, 2, 2, nodes, [], [2])[0]
    assert not m.confirm_occlusion(rows[:2], 1, 1, nodes, [], [])[0]
    assert not m.confirm_occlusion(records(False), 2, 2, nodes, [], [])[0]


def test_small_holes_and_corners_survive_simplification():
    outer = np.array([[0,0],[10,0],[20,0],[20,20],[10,20],[0,20]], np.float32)
    inner = np.array([[9,9],[9,11],[11,11],[11,9]], np.float32)
    reduced = m.simplify([outer, inner], .6)
    assert len(reduced[0]) == 4 and len(reduced[1]) == 4
    assert cv2.contourArea(reduced[1], oriented=True) < 0
    assert sum(cv2.contourArea(r, oriented=True) for r in reduced) == pytest.approx(396)


def test_affine_roundtrip_and_unsupported_curves_are_explicit():
    node = dict(x=27, y=12, width=45, height=83, rotation=38)
    points = np.array([[0, 0], [1000, 0], [1000, 1000]], np.float32)
    assert np.allclose(m.to_local(m.to_world(points, node), node), points, atol=.001)
    assert m.polygons('M0 0 Q50 0 100 100 Z') is None
    assert m.polygons('M0 0 L100 0 L100 100 Z') is not None


def test_ellipse_fit_rejects_a_notch_and_keeps_real_orientation():
    theta = np.linspace(0, 2*np.pi, 40, endpoint=False)
    ellipse = np.column_stack([40+25*np.cos(theta), 30+15*np.sin(theta)]).astype(np.float32)
    node = dict(x=0, y=0, width=100, height=80, rotation=0)
    result = m.primitive_path(ellipse, node, .6)
    assert result and result.count(' C') == 4
    ellipse[10] = (40, 30)
    assert m.primitive_path(ellipse, node, .6) is None


def test_gradient_alpha_does_not_masquerade_as_opaque_owner():
    node = dict(opacity=1, fill='#ff0000')
    assert m.opaque_paint(node)
    node['gradient'] = {'stops':[{'color':'#ff0000ff'}, {'color':'#ff000080'}]}
    assert not m.opaque_paint(node)


def test_worker_fills_only_temporally_confirmed_covered_holes(tmp_path):
    source = tmp_path/'source.avi'
    writer = cv2.VideoWriter(str(source), cv2.VideoWriter_fourcc(*'MJPG'), 12, (100, 80))
    observations=[]
    for i in range(3):
        x=38+i*2
        image=np.full((80,100,3),(20,30,40),np.uint8)
        image[10:70,10:90]=(50,160,200); image[30:50,x:x+12]=(230,150,40)
        writer.write(cv2.cvtColor(image,cv2.COLOR_RGB2BGR))
        node=dict(type='path',x=0,y=0,width=100,height=80,rotation=0,opacity=1)
        parent={**node,'id':'back','fill':'#32a0c8','path':f'M100 125 L900 125 L900 875 L100 875 Z M{x*10} 375 L{x*10} 625 L{(x+12)*10} 625 L{(x+12)*10} 375 Z'}
        front={**node,'id':'front','x':x,'y':30,'width':12,'height':20,'fill':'#e69628','path':'M0 0 L1000 0 L1000 1000 L0 1000 Z'}
        observations.append({'time':i/12,'nodes':[parent,front]})
    writer.release()
    data={'width':100,'height':80,'frames':observations,'cuts':[]}
    output=m.run(data,source,0,.6)
    assert output['report']['inferredOccludedHoles']==3
    assert all(c['path'].count('M')==1 for c in output['changes'] if c['id']=='back')
    data['cuts']=[1/12]
    output=m.run(data,source,0,.6)
    assert output['report']['inferredOccludedHoles']==0
    assert all(c['path'].count('M')==2 for c in output['changes'] if c['id']=='back')


def test_static_source_rejects_segmentation_bbox_jitter_as_occlusion_motion():
    parent,hole,rgb=scene()
    flow,reliable=m.source_flow(rgb,rgb)
    value=m.relative_flow(flow,reliable,parent,hole)
    assert value is not None and value < .01
