"""Assemble source observations into conservative, single-pose object tracks.

Inputs: --meta JSON and either --observations JSONL or --observations-dir containing
frame-XXXX.json. Every original observation is required. No image is emitted.
Geometry and paints come from the source builder, never the approved legacy model.
"""
from __future__ import annotations
import argparse,copy,hashlib,json,math,re
from collections import Counter
from pathlib import Path
import numpy as np
from scipy.optimize import linear_sum_assignment

KEY_FIELDS=('geometry','fill','gradient','paintLayers','opacity','visible','blurPx','z','provenance')
GENERIC={'source-surface','surface','background','source-derived-surface'}

def signed_area(points):
    a=np.asarray(points,dtype=float);b=np.roll(a,-1,axis=0)
    return float(np.sum(a[:,0]*b[:,1]-a[:,1]*b[:,0])/2)

def read_color(value):
    if value in('none','transparent',None):return np.zeros(3)
    v=value.lstrip('#');v=''.join(c*2 for c in v)if len(v)<5 else v
    return np.array([int(v[i:i+2],16)for i in(0,2,4)],float)

def observation_color(observation):
    gradient=observation.get('gradient')
    if gradient and gradient.get('stops'):
        return np.mean([read_color(s['color'])for s in gradient['stops']],axis=0)
    return read_color(observation.get('fill','#000000'))

def feature(observation):
    kind=observation['kind'];g=observation['geometry']
    if kind=='ellipse':
        cx,cy,rx,ry=[float(g[k])for k in('cx','cy','rx','ry')];angle=math.radians(g.get('rotation',0))
        ex=math.hypot(rx*math.cos(angle),ry*math.sin(angle));ey=math.hypot(rx*math.sin(angle),ry*math.cos(angle))
        box=np.array([cx-ex,cy-ey,cx+ex,cy+ey]);area=math.pi*rx*ry
    else:
        if kind=='contour':points=np.concatenate([np.asarray(r['points'],float)for r in g['rings']]);area=sum(abs(signed_area(r['points']))for r in g['rings'])
        elif kind=='bezier':points=np.concatenate([np.asarray([r['start'],*[pair for c in r['cubics']for pair in[c[:2],c[2:4],c[4:6]]]],float)for r in g['rings']]);area=0
        else:raise ValueError(f'Unsupported observation kind {kind}')
        low,high=points.min(0),points.max(0);box=np.r_[low,high]
        if area<1e-6:area=float(np.prod(np.maximum(1e-6,high-low)))
    center=(box[:2]+box[2:])/2;size=np.maximum(.001,box[2:]-box[:2])
    return {'box':box,'center':center,'size':size,'scale':max(1.,float(np.linalg.norm(size))),'area':max(.001,float(area)),'color':observation_color(observation)}

def resample_closed(points,count):
    a=np.asarray(points,float);d=np.roll(a,-1,axis=0)-a;lengths=np.linalg.norm(d,axis=1);total=float(lengths.sum())
    if total<1e-8:raise ValueError('Degenerate contour')
    cumulative=np.r_[0,np.cumsum(lengths)];positions=np.arange(count)*total/count;i=np.searchsorted(cumulative,positions,side='right')-1;i=np.minimum(i,len(a)-1)
    u=(positions-cumulative[i])/np.maximum(lengths[i],1e-12)
    return a[i]+d[i]*u[:,None]

def point_polyline_error(points,polyline):
    p=np.asarray(points,float);a=np.asarray(polyline,float);v=np.roll(a,-1,axis=0)-a;delta=p[:,None,:]-a[None,:,:]
    u=np.clip(np.sum(delta*v[None,:,:],axis=2)/np.maximum(1e-12,np.sum(v*v,axis=1))[None,:],0,1)
    dist=np.linalg.norm(delta-u[:,:,None]*v[None,:,:],axis=2)
    return float(dist.min(1).max(initial=0))

def cyclic_match(a,b):
    """Find same-winding cyclic correspondence; never reverse the ring."""
    fa=np.fft.fft(a,axis=0);fb=np.fft.fft(b,axis=0)
    correlation=np.fft.ifft(fa*np.conj(fb),axis=0).real.sum(1)
    shift=int(np.argmax(correlation));aligned=np.roll(b,shift,axis=0)
    rms=float(np.sqrt(np.mean((a-aligned)**2)))
    return shift,rms

def bbox_iou(a,b):
    overlap=np.maximum(0,np.minimum(a[2:],b[2:])-np.maximum(a[:2],b[:2]));inter=float(np.prod(overlap));aa=float(np.prod(a[2:]-a[:2]));bb=float(np.prod(b[2:]-b[:2]));return inter/max(1e-6,aa+bb-inter)

def compatible_material(a,b):
    if a.get('protectedPaint',False)!=b.get('protectedPaint',False):return False
    if a.get('recolorGroup')!=b.get('recolorGroup'):return False
    la,lb=a.get('label',''),b.get('label','')
    generic=lambda label:label in GENERIC or label.startswith('surface-')
    if not generic(la)and not generic(lb)and la!=lb:return False
    return True

def align_geometry(previous,current,fa,fb,max_resample_error=2.):
    """Return aligned current geometry and evidence, or a conservative rejection."""
    kind=previous['kind'];a=previous['geometry'];b=current['geometry']
    if kind!=current['kind']:return None,'kind-change'
    if kind=='ellipse':
        ratios=np.log(np.maximum(.001,[a['rx'],a['ry']])/np.maximum(.001,[b['rx'],b['ry']]))
        shape=float(np.linalg.norm(ratios)/math.sqrt(2))*.12
        angle_a=float(a.get('rotation',0));angle_b=float(b.get('rotation',0));angle_b+=360*round((angle_a-angle_b)/360)
        # A principal-axis flip may preserve the ellipse while rotating its paint.
        # Do not silently rotate gradients or interpolate such an uncertain event.
        if abs(angle_b-angle_a)>65:return None,'large-paint-frame-rotation'
        geometry=copy.deepcopy(b);geometry['rotation']=round(angle_b,5)
        return {'geometry':geometry,'shapeRms':shape,'ringShifts':[],'resampled':[]},None
    if len(a['rings'])!=len(b['rings']):return None,'ring-count-change'
    if kind=='bezier':
        if any(len(x['cubics'])!=len(y['cubics'])for x,y in zip(a['rings'],b['rings'])):return None,'cubic-topology-change'
        aa=np.concatenate([np.asarray([r['start'],*[c[i:i+2]for c in r['cubics']for i in(0,2,4)]])for r in a['rings']]);bb=np.concatenate([np.asarray([r['start'],*[c[i:i+2]for c in r['cubics']for i in(0,2,4)]])for r in b['rings']])
        rms=float(np.sqrt(np.mean(((aa-fa['center'])/fa['scale']-(bb-fb['center'])/fb['scale'])**2)))
        return {'geometry':copy.deepcopy(b),'shapeRms':rms,'ringShifts':[],'resampled':[]},None
    count=len(a['rings']);costs=np.full((count,count),1e6);choices={};reasons=Counter()
    for i,ra in enumerate(a['rings']):
        pa=np.asarray(ra['points'],float);aa=signed_area(pa)
        for j,rb in enumerate(b['rings']):
            pb=np.asarray(rb['points'],float);ab=signed_area(pb)
            if abs(aa)<1e-7 or abs(ab)<1e-7 or aa*ab<=0:reasons['winding-change']+=1;continue
            resampled=False;error=0.
            if len(pa)!=len(pb):
                # Preserve low-vertex straight silhouettes. Organic adaptive
                # sampling may join only if native geometric error is bounded.
                if min(len(pa),len(pb))<=8:reasons['straight-vertex-count-change']+=1;continue
                original=pb;pb=resample_closed(pb,len(pa));error=point_polyline_error(original,pb)
                if error>max_resample_error:reasons['resample-error']+=1;continue
                resampled=True
            na=(pa-fa['center'])/fa['scale'];nb=(pb-fb['center'])/fb['scale'];shift,rms=cyclic_match(na,nb);aligned=np.roll(pb,shift,axis=0)
            mid=(pa+aligned)/2;ma=signed_area(mid)
            if aa*ma<=0 or abs(ma)<.35*min(abs(aa),abs(ab)):reasons['midpoint-collapse']+=1;continue
            # Same ring count does not identify holes. Cost includes location in
            # the whole object, making an unrelated hole an expensive match.
            costs[i,j]=rms;choices[(i,j)]={'points':aligned.round(5).tolist(),'tension':rb.get('tension',.15),'shift':shift,'resampled':resampled,'resampleMaxErrorPx':error,'shapeRms':rms,'fromRing':j}
    rows,columns=linear_sum_assignment(costs)
    if len(rows)!=count or any(costs[i,j]>=1e5 for i,j in zip(rows,columns)):return None,(reasons.most_common(1)[0][0]if reasons else 'ring-correspondence')
    geometry=copy.deepcopy(b);geometry['rings']=[];selected=[]
    for i,j in sorted(zip(rows,columns)):
        value=choices[(i,j)];geometry['rings'].append({'points':value['points'],'tension':value['tension']});selected.append(value)
    rms=max(value['shapeRms']for value in selected)
    return {'geometry':geometry,'shapeRms':rms,'ringShifts':[{'fromRing':v['fromRing'],'shift':v['shift']}for v in selected],'resampled':[{'ring':i,'maxErrorPx':v['resampleMaxErrorPx']}for i,v in enumerate(selected)if v['resampled']]},None

def load_rows(args,frame_count):
    if args.observations_dir:
        for frame in range(frame_count):
            p=args.observations_dir/f'frame-{frame:04d}.json'
            if not p.is_file():raise ValueError(f'Missing actual observation: {p}')
            raw=p.read_bytes();row=json.loads(raw);assert row['frame']==frame,(p,row.get('frame'));row['_observationSHA256']=hashlib.sha256(raw).hexdigest();yield row
    else:
        with args.observations.open()as stream:
            for expected,line in enumerate(stream):
                row=json.loads(line);assert row['frame']==expected,(expected,row.get('frame'));row['_observationSHA256']=hashlib.sha256(line.encode()).hexdigest();yield row

def assemble(meta,rows,max_shape_rms=.14,max_resample_error=2.,ambiguity_margin=.025):
    width,height,fps,frame_count=[meta[k]for k in('width','height','fps','frameCount')]
    if any(not isinstance(v,(int,float))or not math.isfinite(v)or v<=0 for v in(width,height,fps,frame_count)):raise ValueError('Positive finite source dimensions, fps and frameCount required')
    if not isinstance(frame_count,int):raise ValueError('frameCount must be an integer')
    if any(not isinstance(f,int)or not 0<f<frame_count for f in meta.get('cuts',[])):raise ValueError('cuts must be integer source frames strictly inside timeline')
    if not 0<max_shape_rms<1 or not 0<=max_resample_error<=8 or not 0<=ambiguity_margin<1:raise ValueError('Invalid conservative matching thresholds')
    cuts=sorted(set(int(f)for f in meta.get('cuts',[])if 0<f<frame_count));boundaries=[0,*cuts,frame_count];canvas_diagonal=math.hypot(width,height)
    model={'kind':'object-scene-v1','width':width,'height':height,'fps':fps,'frameCount':frame_count,'materialInterpolation':'field','shots':[]}
    report={'passed':False,'sourceFrames':frame_count,'cuts':cuts,'rules':{'adjacentObservationsOnly':True,'maxNormalizedShapeRms':max_shape_rms,'maxNativeResampleErrorPx':max_resample_error,'ambiguityMargin':ambiguity_margin,'noRasterOrCompletedFrameCrossfade':True,'genericLabelDoesNotClaimSemanticIdentity':True},'shots':[],'frameLedger':[],'matchingRejectedReasons':{},'counts':Counter()}
    shot_index=-1;shot=None;active=[];previous_frame=-1;global_reasons=Counter();next_id=0
    for row in rows:
        frame=int(row['frame'])
        if frame!=previous_frame+1 or frame>=frame_count:raise ValueError(f'Expected original frame{previous_frame+1}, got{frame}')
        previous_frame=frame
        if shot is None or frame>=shot['endFrame']:
            shot_index+=1;next_id=0;active=[];shot={'id':f'shot-{shot_index:02d}','startFrame':boundaries[shot_index],'endFrame':boundaries[shot_index+1],'background':row.get('background','#000000'),'tracks':[]};model['shots'].append(shot);shot_report={'id':shot['id'],'startFrame':shot['startFrame'],'endFrame':shot['endFrame'],'observations':0,'matchedIntervals':0,'newTracks':0};report['shots'].append(shot_report)
            bg={'id':f'{shot["id"]}-background','label':'source-background-base','kind':'contour','startFrame':frame,'endFrame':shot['endFrame'],'z':-1000000,'keys':[]};shot['tracks'].append(bg)
        background_key={'frame':frame,'geometry':{'rings':[{'points':[[0,0],[width,0],[width,height],[0,height]],'tension':0}]},'fill':row.get('background',shot['background']),'interpolateToNext':True,'provenance':{'method':'source-background-color','sourceFrame':frame}}
        bg['keys'].append(background_key)
        observations=row.get('observations')
        if not isinstance(observations,list):raise ValueError(f'frame{frame} observations missing')
        known=[o['id']for o in observations if o.get('id')]
        if len(set(known))!=len(known):raise ValueError(f'frame{frame} has duplicate stable IDs')
        features=[feature(o)for o in observations];shot_report['observations']+=len(observations);report['counts']['observations']+=len(observations)
        costs=np.full((len(active),len(observations)),1e6);details={};rejected=Counter()
        # Vectorize the inexpensive source-observation gates. The exact same
        # accepted candidates, top-eight order, geometry checks and Hungarian
        # assignment are retained; only N current observations are evaluated in
        # NumPy rather than one Python call per potential pair.
        current_ids=np.array([o.get('id')or ''for o in observations],dtype=object)
        kinds=np.array([o['kind']for o in observations],dtype=object)
        groups=np.array([o.get('recolorGroup')for o in observations],dtype=object)
        protected=np.array([o.get('protectedPaint',False)for o in observations],dtype=bool)
        visible=np.array([o.get('visible',True)for o in observations],dtype=bool)
        labels=np.array([o.get('label','')for o in observations],dtype=object)
        generic=np.array([label in GENERIC or label.startswith('surface-')for label in labels],dtype=bool)
        centers=np.array([f['center']for f in features],dtype=float).reshape(-1,2)
        scales=np.array([f['scale']for f in features]);areas=np.array([f['area']for f in features])
        colors=np.array([f['color']for f in features],dtype=float).reshape(-1,3)
        for i,previous in enumerate(active):
            old,fa=previous['observation'],previous['feature'];velocity=previous.get('velocity',np.zeros(2));predicted=fa['center']+velocity
            eligible=(current_ids==(old.get('id')or ''))&(kinds==old['kind'])&(groups==old.get('recolorGroup'))&(protected==old.get('protectedPaint',False))
            label=old.get('label','')
            if label not in GENERIC and not label.startswith('surface-'):eligible&=generic|(labels==label)
            rejected['visibility-change']+=int(np.count_nonzero(eligible&(visible!=old.get('visible',True))));eligible&=visible==old.get('visible',True)
            gates=np.minimum(np.maximum(np.maximum(12.,.4*np.minimum(fa['scale'],scales)),.022*canvas_diagonal+float(np.linalg.norm(velocity))*.25),.18*canvas_diagonal)
            distances=np.linalg.norm(centers-predicted,axis=1);area_changes=np.abs(np.log(areas/fa['area']));color_distances=np.linalg.norm(colors-fa['color'],axis=1)/441.67295593
            rejected['center-jump']+=int(np.count_nonzero(eligible&(distances>gates)));eligible&=distances<=gates
            rejected['area-change']+=int(np.count_nonzero(eligible&(area_changes>1.)));eligible&=area_changes<=1.
            if not old.get('id'):rejected['material-change']+=int(np.count_nonzero(eligible&(color_distances>.42)));eligible&=color_distances<=.42
            pre=distances/gates+.25*area_changes+.2*color_distances
            candidate_indices=np.flatnonzero(eligible);candidate_indices=candidate_indices[np.lexsort((candidate_indices,pre[candidate_indices]))[:8]]
            for j in candidate_indices:
                j=int(j);distance=float(distances[j]/gates[j]);area_change=float(area_changes[j]);color_distance=float(color_distances[j])
                current,fb=observations[j],features[j];aligned,reason=align_geometry(old,current,fa,fb,max_resample_error)
                if aligned is None:rejected[reason]+=1;continue
                shape=aligned['shapeRms']
                if shape>max_shape_rms:rejected['shape-change']+=1;continue
                predicted_box=fa['box']+np.tile(velocity,2);iou=bbox_iou(predicted_box,fb['box'])
                cost=.30*distance+.28*shape/max_shape_rms+.18*area_change+.12*min(1,color_distance/.42)+.12*(1-iou)
                if cost>.66:rejected['combined-cost']+=1;continue
                costs[i,j]=cost;details[(i,j)]={**aligned,'cost':cost,'confidence':round(1-cost,5),'centerErrorFraction':distance,'areaLogChange':area_change,'colorDistance':color_distance}
        matches={};used=set()
        if active and observations:
            rows_idx,cols_idx=linear_sum_assignment(costs)
            for i,j in zip(rows_idx,cols_idx):
                if costs[i,j]>=1e5:continue
                old=active[i]['observation'];alternatives=np.sort(costs[i][costs[i]<1e5])
                if not old.get('id')and len(alternatives)>1 and alternatives[1]-alternatives[0]<ambiguity_margin:rejected['ambiguous-assignment']+=1;continue
                # Symmetric check also stops two similar parts competing for one.
                column=np.sort(costs[:,j][costs[:,j]<1e5])
                if not old.get('id')and len(column)>1 and column[1]-column[0]<ambiguity_margin:rejected['ambiguous-assignment']+=1;continue
                matches[j]=(int(i),details[(i,j)]);used.add(i)
        new_active=[];ledger=[]
        for j,(observation,fb)in enumerate(zip(observations,features)):
            key={k:copy.deepcopy(observation[k])for k in KEY_FIELDS if k in observation};key.update(frame=frame,interpolateToNext=False);key.setdefault('fill','#000000');key.setdefault('z',j)
            if j in matches:
                i,detail=matches[j];previous=active[i];track=previous['track'];key['geometry']=detail['geometry'];track['keys'][-1]['interpolateToNext']=True;track['keys'][-1]['trackingToNext']={k:detail[k]for k in('confidence','shapeRms','ringShifts','resampled','centerErrorFraction','areaLogChange','colorDistance')};track['keys'].append(key);track['endFrame']=min(frame+1,shot['endFrame']);velocity=fb['center']-previous['feature']['center'];report['counts']['matchedIntervals']+=1;shot_report['matchedIntervals']+=1
                if detail['resampled']:report['counts']['boundedResampledMatches']+=1
                match_info={'fromFrame':frame-1,'confidence':detail['confidence'],'shapeRms':round(detail['shapeRms'],6),'resampledRings':len(detail['resampled'])}
            else:
                next_id+=1;track={'id':f'{shot["id"]}-track-{next_id:05d}','label':observation.get('label','source-surface'),'kind':observation['kind'],'startFrame':frame,'endFrame':min(frame+1,shot['endFrame']),'z':observation.get('z',j),'keys':[key]}
                for k in('recolorGroup','protectedPaint'):
                    if k in observation:track[k]=observation[k]
                if observation.get('id'):track['sourceIdentity']=observation['id']
                shot['tracks'].append(track);report['counts']['newTracks']+=1;shot_report['newTracks']+=1;velocity=np.zeros(2);match_info=None
            aligned_observation={**observation,'geometry':key['geometry']};new_active.append({'track':track,'observation':aligned_observation,'feature':feature(aligned_observation),'velocity':velocity})
            ledger.append({'trackId':track['id'],'label':track['label'],'kind':track['kind'],'sourceObservation':j,'sourceFrame':frame,'match':match_info})
        rejected=Counter({reason:count for reason,count in rejected.items()if count});active=new_active;global_reasons.update(rejected)
        coordinate_count=8;emitted_path_coordinates=26;gradient_count=0;paint_planes=2
        for item in active:
            observation=item['observation']
            geometry=observation['geometry'];kind=observation['kind']
            coordinate_count+=5 if kind=='ellipse' else sum(len(r['points'])*2 if kind=='contour' else 2+len(r['cubics'])*6 for r in geometry['rings'])
            if kind!='ellipse':emitted_path_coordinates+=sum(2+len(r['points'])*6 if kind=='contour' else 2+len(r['cubics'])*6 for r in geometry['rings'])
            gradient_count+=int(bool(observation.get('gradient')))+len(observation.get('paintLayers',[]))
            paint_planes+=1+len(observation.get('paintLayers',[]))
        observation_sha=row.get('_observationSHA256')or hashlib.sha256(json.dumps(row,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        report['frameLedger'].append({'frame':frame,'frame24':frame,'shotId':shot['id'],'sourceObservationSHA256':observation_sha,'sourceRGBSHA256':row.get('sourceRGBSHA256',row.get('analysis',{}).get('sourceRGBSHA256')),'sourceObservationCount':len(observations),'activeTrackCount':len(active),'primitiveCount':len(active)+1,'geometryCoordinateCount':coordinate_count,'pathCoordinateCount':emitted_path_coordinates,'paintPlaneCountIncludingBackdrop':paint_planes,'gradientCount':gradient_count,'rasterCount':0,'semanticCoverage':'Only supplied semantic IDs are identified; generic source-surface coverage is not whole-object recognition.','objects':ledger,'rejectedCandidateReasons':dict(rejected)})
        if frame%24==0:print(json.dumps({'frame':frame,'matched':len(matches),'new':len(observations)-len(matches),'active':len(active)}),flush=True)
    if previous_frame+1!=frame_count:raise ValueError(f'Only{previous_frame+1}actual frames supplied; expected{frame_count}')
    report['matchingRejectedReasons']=dict(global_reasons);report['counts']=dict(report['counts']);report['passed']=True;report['trackCountIncludingBackground']=sum(len(s['tracks'])for s in model['shots']);report['keyCountIncludingBackground']=sum(len(t['keys'])for s in model['shots']for t in s['tracks']);report['noSourceIntermediateGroundTruth']=True
    model['provenance']={'method':'source-observation-geometry-material-tracks','sourceFrameCount':frame_count,'semantics':'Only explicitly supplied known part IDs are semantic; source-surface tracks are not claimed to be whole-object recognition.'}
    return model,report

def main():
    p=argparse.ArgumentParser();p.add_argument('--meta',type=Path,required=True);group=p.add_mutually_exclusive_group(required=True);group.add_argument('--observations',type=Path);group.add_argument('--observations-dir',type=Path);p.add_argument('--out',type=Path,required=True);p.add_argument('--report',type=Path,required=True);p.add_argument('--max-shape-rms',type=float,default=.14);p.add_argument('--max-resample-error',type=float,default=2.);p.add_argument('--ambiguity-margin',type=float,default=.025);args=p.parse_args()
    meta=json.loads(args.meta.read_text());model,report=assemble(meta,load_rows(args,meta['frameCount']),args.max_shape_rms,args.max_resample_error,args.ambiguity_margin)
    args.out.parent.mkdir(parents=True,exist_ok=True);args.report.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open('w')as stream:json.dump(model,stream,separators=(',',':'),ensure_ascii=False,allow_nan=False)
    report['modelSHA256']=hashlib.sha256(args.out.read_bytes()).hexdigest();report['assemblerSHA256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest();report['metaSHA256']=hashlib.sha256(args.meta.read_bytes()).hexdigest();report['inputs']={'observations':str(args.observations)if args.observations else None,'observationsDir':str(args.observations_dir)if args.observations_dir else None};args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False)+'\n');print(json.dumps({k:report[k]for k in('passed','modelSHA256','trackCountIncludingBackground','keyCountIncludingBackground','counts')}))
if __name__=='__main__':main()
