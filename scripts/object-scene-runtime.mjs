/** Source-frame object/part renderer. Self-contained for offline HTML embedding.
 * Existing schema1/2 renderer and all approved artifacts are intentionally untouched.
 * No image nodes, arbitrary SVG fragments, or completed-frame crossfades are accepted.
 */
export function createObjectSceneRuntime() {
  const checked = new WeakMap(), geometryCache = new Map();
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const n = value => Number(Number(value).toFixed(5));
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const fail = message => { throw new Error(`Object scene: ${message}`); };
  const finite = (v, name, low = -1e6, high = 1e6) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < low || v > high) fail(`${name} must be finite in ${low}..${high}`); return v; };
  const id = (v, name) => { if (typeof v !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(v)) fail(`${name} needs a stable ASCII identifier`); return v; };
  const color = (v, name) => { if (typeof v !== 'string' || !/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|none|transparent)$/i.test(v)) fail(`${name} must be a HEX color, none, or transparent`); return v; };
  const rgba = value => {
    if (/^(none|transparent)$/i.test(value)) return [0,0,0,0];
    let v=value.slice(1); if(v.length<5)v=[...v].map(c=>c+c).join(''); if(v.length===6)v+='ff';
    return [0,2,4,6].map(i=>parseInt(v.slice(i,i+2),16));
  };
  const hex = values => '#'+values.map(v=>Math.round(clamp(v,0,255)).toString(16).padStart(2,'0')).join('');
  const mix = (a,b,t) => a+(b-a)*t;
  const mixColor = (a,b,t) => a===b?a:hex(rgba(a).map((v,i)=>mix(v,rgba(b)[i],t)));
  const opaqueBase = paint => paint.gradient ? paint.gradient.stops.every(s=>(s.opacity??1)===1&&rgba(s.color)[3]===255) : rgba(paint.fill)[3]===255;
  const defaultFields = (kind, value) => kind==='ellipse' ? {...value,rotation:value.rotation??0} : value;
  function gradientCheck(g, name) {
    if (g==null) return;
    if (!g || !['linear','radial'].includes(g.type)) fail(`${name}.type must be linear or radial`);
    const fields=g.type==='linear'?['x1','y1','x2','y2']:['cx','cy','r'];
    fields.forEach(k=>finite(g[k],`${name}.${k}`,k==='r'?.000001:-16,16));
    for(const k of ['fx','fy'])if(g[k]!==undefined)finite(g[k],`${name}.${k}`,-16,16);
    for(const k of ['scaleX','scaleY'])if(g[k]!==undefined){if(g.type!=='radial')fail(`${name}.${k} is only valid for radial gradients`);finite(g[k],`${name}.${k}`,.02,20);}
    if(!Array.isArray(g.stops)||g.stops.length<2||g.stops.length>32)fail(`${name} needs2..32 stops`);
    g.stops.forEach((s,i)=>{finite(s.offset,`${name}.stop.offset`,0,1);color(s.color,`${name}.stop.color`);if(s.opacity!==undefined)finite(s.opacity,`${name}.stop.opacity`,0,1);if(i&&s.offset<g.stops[i-1].offset)fail(`${name} stops must be ordered`);});
  }
  function layersCheck(layers,name) {
    if(layers===undefined)return;
    if(!Array.isArray(layers)||layers.length>16)fail(`${name} must contain at most16 layers`);
    layers.forEach((l,i)=>{if(!l?.gradient)fail(`${name}[${i}].gradient missing`);gradientCheck(l.gradient,`${name}[${i}]`);if(l.opacity!==undefined)finite(l.opacity,`${name}[${i}].opacity`,0,1);});
  }
  function pointCheck(p,name,length=2){if(!Array.isArray(p)||p.length!==length)fail(`${name} requires${length} coordinates`);p.forEach(v=>finite(v,name));}
  function geometryCheck(kind,g,name){
    if(!g||typeof g!=='object')fail(`${name} missing`);
    if(kind==='ellipse') { for(const k of ['cx','cy','rx','ry'])finite(g[k],`${name}.${k}`,k==='rx'||k==='ry'?.000001:-1e6,1e6);if(g.rotation!==undefined)finite(g.rotation,`${name}.rotation`,-1e7,1e7); }
    else {
      if(!Array.isArray(g.rings)||!g.rings.length||g.rings.length>128)fail(`${name}.rings must contain1..128 rings`);
      g.rings.forEach((ring,r)=>{
        if(kind==='contour'){
          if(!Array.isArray(ring.points)||ring.points.length<3||ring.points.length>2048)fail(`${name}.ring${r} requires3..2048 points`);
          ring.points.forEach(p=>pointCheck(p,name));if(ring.tension!==undefined)finite(ring.tension,`${name}.tension`,0,1);
          if(ring.points[0][0]===ring.points.at(-1)[0]&&ring.points[0][1]===ring.points.at(-1)[1])fail(`${name}: omit duplicate terminal contour point`);
        } else {
          pointCheck(ring.start,name);if(!Array.isArray(ring.cubics)||!ring.cubics.length||ring.cubics.length>2048)fail(`${name}.cubics requires1..2048 segments`);
          ring.cubics.forEach(c=>pointCheck(c,name,6));const last=ring.cubics.at(-1);if(Math.abs(last[4]-ring.start[0])>1e-6||Math.abs(last[5]-ring.start[1])>1e-6)fail(`${name}: cubic contour must close at its start`);
        }
      });
    }
    if(g.paintBox!==undefined){pointCheck(g.paintBox,`${name}.paintBox`,4);finite(g.paintBox[2],`${name}.paintBox.width`,.000001,1e6);finite(g.paintBox[3],`${name}.paintBox.height`,.000001,1e6);}
  }
  function paintCheck(value,name){
    if(value.fill!==undefined)color(value.fill,`${name}.fill`);gradientCheck(value.gradient,`${name}.gradient`);layersCheck(value.paintLayers,`${name}.paintLayers`);
    if(value.opacity!==undefined)finite(value.opacity,`${name}.opacity`,0,1);if(value.blurPx!==undefined)finite(value.blurPx,`${name}.blurPx`,0,12);if(value.z!==undefined)finite(value.z,`${name}.z`);if(value.visible!==undefined&&typeof value.visible!=='boolean')fail(`${name}.visible must be boolean`);
  }
  function validate(model){
    if(checked.has(model))return model;
    if(!model||model.kind!=='object-scene-v1')fail('kind must be object-scene-v1');
    if(model.motionInterpolation!==undefined&&model.motionInterpolation!=='coherent-gated')fail('motionInterpolation must be coherent-gated');
    if(model.materialInterpolation!==undefined&&!['field','parameters'].includes(model.materialInterpolation))fail('materialInterpolation must be field or parameters');
    finite(model.width,'width',1,16384);finite(model.height,'height',1,16384);finite(model.fps,'fps',.01,240);finite(model.frameCount,'frameCount',1,100000);if(!Number.isInteger(model.frameCount))fail('frameCount must be integer');
    if(!Array.isArray(model.shots)||!model.shots.length||model.shots.length>10000)fail('shots missing');
    let edge=0;const shotIds=new Set();
    for(const shot of model.shots){id(shot.id,'shot.id');if(shotIds.has(shot.id))fail('duplicate shot id');shotIds.add(shot.id);finite(shot.startFrame,'shot.startFrame',0,model.frameCount);finite(shot.endFrame,'shot.endFrame',0,model.frameCount);if(shot.startFrame!==edge||shot.endFrame<=edge)fail('shots must cover the timeline contiguously');edge=shot.endFrame;color(shot.background??'#000000','shot.background');
      if(shot.motionFields!==undefined){if(!Array.isArray(shot.motionFields)||model.motionInterpolation!=='coherent-gated')fail('motionFields require coherent-gated mode');const frames=new Set();for(const field of shot.motionFields){if(field.kind!=='coherent-source-flow-grid-v1')fail('unsupported coherent field');finite(field.frame,'field.frame',shot.startFrame,shot.endFrame-1);if(!Number.isInteger(field.frame)||field.frame>=shot.endFrame-1||frames.has(field.frame))fail('field must identify a unique within-shot interval');frames.add(field.frame);for(const k of ['gridWidth','gridHeight']){finite(field[k],k,2,129);if(!Number.isInteger(field[k]))fail('integer grid size required');}finite(field.xMax,'field.xMax',1,model.width);finite(field.yMax,'field.yMax',1,model.height);if(!Array.isArray(field.vectors)||field.vectors.length!==field.gridWidth*field.gridHeight)fail('field vector count mismatch');field.vectors.forEach(v=>pointCheck(v,'field vector'));}}
      if(!Array.isArray(shot.tracks))fail('shot.tracks missing');const ids=new Set();
      for(const track of shot.tracks){id(track.id,'track.id');if(ids.has(track.id))fail(`duplicate track id${track.id}`);ids.add(track.id);if(!['ellipse','contour','bezier'].includes(track.kind))fail(`unsupported geometry kind${track.kind}`);finite(track.startFrame,'track.startFrame',shot.startFrame,shot.endFrame);finite(track.endFrame,'track.endFrame',shot.startFrame,shot.endFrame);if(track.endFrame<=track.startFrame)fail('empty track lifetime');paintCheck(track,`track${track.id}`);
        if(track.recolorGroup!==undefined)id(track.recolorGroup,'recolorGroup');if(track.protectedPaint!==undefined&&typeof track.protectedPaint!=='boolean')fail('protectedPaint must be boolean');
        if(!Array.isArray(track.keys)||!track.keys.length)fail('track.keys missing');let previous=-Infinity;
        for(const key of track.keys){finite(key.frame,'key.frame',track.startFrame,track.endFrame);if(key.frame>=track.endFrame||key.frame<=previous)fail('keys must ascend strictly inside track lifetime');previous=key.frame;geometryCheck(track.kind,key.geometry,`track${track.id}@${key.frame}`);paintCheck(key,`track${track.id}@${key.frame}`);if(key.recolorGroup!==undefined&&key.recolorGroup!==null)id(key.recolorGroup,'key.recolorGroup');if(key.protectedPaint!==undefined&&typeof key.protectedPaint!=='boolean')fail('key.protectedPaint must be boolean');if(key.interpolateToNext!==undefined&&typeof key.interpolateToNext!=='boolean')fail('interpolateToNext must be explicit boolean');}
        if(track.keys[0].frame!==track.startFrame)fail('first key must equal track.startFrame');
      }
    }
    if(edge!==model.frameCount)fail('last shot must end at frameCount');checked.set(model,true);return model;
  }
  function locate(items,time,field){let lo=0,hi=items.length-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(items[mid][field]<=time)lo=mid;else hi=mid-1;}return lo;}
  function area(points){let sum=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];sum+=a[0]*b[1]-b[0]*a[1];}return sum/2;}
  function compatible(kind,a,b){
    if(kind==='ellipse')return true;
    if(a.rings.length!==b.rings.length)return false;
    return a.rings.every((r,i)=>{
      const s=b.rings[i];if(kind==='bezier')return r.cubics.length===s.cubics.length;
      if(r.points.length!==s.points.length)return false;
      const aa=area(r.points),ab=area(s.points);return Math.abs(aa)>1e-7&&Math.abs(ab)>1e-7&&aa*ab>0;
    });
  }
  function interpolateGeometry(kind,aa,bb,t){
    const a=defaultFields(kind,aa),b=defaultFields(kind,bb);let result;
    const pair=(x,y)=>x.map((v,i)=>mix(v,y[i],t));
    if(kind==='ellipse')result=Object.fromEntries(['cx','cy','rx','ry','rotation'].map(k=>[k,mix(a[k],b[k],t)]));
    else result={rings:a.rings.map((r,i)=>kind==='contour'?{points:r.points.map((p,j)=>pair(p,b.rings[i].points[j])),tension:mix(r.tension??.15,b.rings[i].tension??.15,t)}:{start:pair(r.start,b.rings[i].start),cubics:r.cubics.map((p,j)=>pair(p,b.rings[i].cubics[j]))})};
    if(a.paintBox&&b.paintBox)result.paintBox=pair(a.paintBox,b.paintBox);else if(a.paintBox)result.paintBox=a.paintBox;
    // A ring can collapse under an incorrect cyclic match despite equal counts.
    // Do not invent a flipped pose. Producer must split/review the bad interval.
    if(kind==='contour'&&result.rings.some((r,i)=>area(r.points)*area(a.rings[i].points)<=1e-7))return a;
    return result;
  }
  function interpolateGradient(a,b,t){
    if(!a||!b||a.type!==b.type||a.stops.length!==b.stops.length)return a;
    const result={type:a.type,stops:a.stops.map((s,i)=>({offset:mix(s.offset,b.stops[i].offset,t),color:mixColor(s.color,b.stops[i].color,t),opacity:mix(s.opacity??1,b.stops[i].opacity??1,t)}))};
    for(const k of a.type==='linear'?['x1','y1','x2','y2']:['cx','cy','r','fx','fy'])result[k]=mix(a[k]??a[k==='fx'?'cx':'cy'],b[k]??b[k==='fx'?'cx':'cy'],t);
    if(a.type==='radial')for(const k of ['scaleX','scaleY'])result[k]=mix(a[k]??1,b[k]??1,t);
    return result;
  }
  function keyPaint(track,key){return {fill:key.fill??track.fill??'#000000',gradient:key.gradient===null?undefined:key.gradient??track.gradient,paintLayers:key.paintLayers??track.paintLayers??[],opacity:key.opacity??track.opacity??1,visible:key.visible??track.visible??true,blurPx:key.blurPx??track.blurPx??0,z:key.z??track.z??0,recolorGroup:key.recolorGroup===null?undefined:key.recolorGroup??track.recolorGroup,protectedPaint:key.protectedPaint??track.protectedPaint??false};}
  function evaluate(model,sourceFrame,options={}){
    validate(model);finite(sourceFrame,'sourceFrame',-1e9,1e9);const frame=clamp(sourceFrame,0,sourceFrame>=model.frameCount?model.frameCount-1:model.frameCount),shot=model.shots[locate(model.shots,frame,'startFrame')];
    const materialInterpolation=options.materialInterpolation??model.materialInterpolation??'field';if(!['field','parameters'].includes(materialInterpolation))fail('materialInterpolation must be field or parameters');
    const coherent=model.motionInterpolation==='coherent-gated',anchorFrame=coherent?Math.floor(frame):frame,motionField=coherent&&frame>anchorFrame?shot.motionFields?.find(f=>f.frame===anchorFrame):undefined,flowAlpha=motionField?frame-anchorFrame:0;
    const tracks=[];
    shot.tracks.forEach((track,index)=>{
      if(anchorFrame<track.startFrame||anchorFrame>=track.endFrame)return;
      const i=locate(track.keys,anchorFrame,'frame'),left=track.keys[i],right=track.keys[i+1],a=keyPaint(track,left),b=right?keyPaint(track,right):a;
      const allowed=!coherent&&right&&left.interpolateToNext===true&&a.visible&&b.visible&&compatible(track.kind,left.geometry,right.geometry),t=allowed?(frame-left.frame)/(right.frame-left.frame):0;
      if(!a.visible)return;
      let geometry=left.geometry,paint=a;
      if(t>0){geometry=interpolateGeometry(track.kind,left.geometry,right.geometry,t);paint={...a,fill:mixColor(a.fill,b.fill,t),gradient:interpolateGradient(a.gradient,b.gradient,t),opacity:mix(a.opacity,b.opacity,t),blurPx:mix(a.blurPx,b.blurPx,t),paintLayers:a.paintLayers.length===b.paintLayers.length?a.paintLayers.map((l,j)=>({gradient:interpolateGradient(l.gradient,b.paintLayers[j].gradient,t),opacity:mix(l.opacity??1,b.paintLayers[j].opacity??1,t)})):a.paintLayers};}
      // Both endpoint fields cover the same current paint rectangle. An opaque
      // base makes source-over of the right compound field at t exactly equal
      // to (1-t)*left+t*right, regardless of lighting layer count or type.
      // Geometry, its coverage, and object opacity are each emitted only once.
      let kind=track.kind;if(motionField&&track.label!=='source-background-base'){const warped=warpGeometry(kind,geometry,motionField,flowAlpha);kind=warped.kind;geometry=warped.geometry;}
      const field=t>0&&materialInterpolation==='field'&&opaqueBase(a)&&opaqueBase(b);
      if(paint.opacity>0)tracks.push({id:track.id,label:track.label??'',kind,recolorGroup:track.recolorGroup,protectedPaint:track.protectedPaint===true,geometry,...paint,materialMode:field?'field':'parameters',materialFields:field?{from:a,to:b,alpha:t}:undefined,index,fromFrame:left.frame,toFrame:motionField?anchorFrame+1:allowed?right.frame:left.frame,alpha:motionField?flowAlpha:t});
    });
    tracks.sort((a,b)=>a.z-b.z||a.index-b.index);
    return {frame,sampledFrame:coherent&&!motionField?anchorFrame:frame,motionMode:coherent?(motionField?'coherent-field':'observation-hold'):'track-interpolation',shotId:shot.id,width:model.width,height:model.height,background:shot.background??'#000000',tracks};
  }
  function warpGeometry(kind,sourceGeometry,field,alpha){
 const W=field.gridWidth,H=field.gridHeight;
 function vector(x,y){const u=Math.max(0,Math.min(W-1,x/field.xMax*(W-1))),v=Math.max(0,Math.min(H-1,y/field.yMax*(H-1))),i=Math.min(W-2,Math.floor(u)),j=Math.min(H-2,Math.floor(v)),a=u-i,b=v-j;return[0,1].map(c=>(1-a)*(1-b)*field.vectors[j*W+i][c]+a*(1-b)*field.vectors[j*W+i+1][c]+(1-a)*b*field.vectors[(j+1)*W+i][c]+a*b*field.vectors[(j+1)*W+i+1][c]);}
 function point(p){const d=vector(...p);return[p[0]+alpha*d[0],p[1]+alpha*d[1]];}
 function box(b){const corners=[[b[0],b[1]],[b[0]+b[2],b[1]],[b[0],b[1]+b[3]],[b[0]+b[2],b[1]+b[3]]].map(point),xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);return[Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)];}
 function geometry(kind,g){if(kind==='ellipse'){
  const c=point([g.cx,g.cy]),xp=point([g.cx+1,g.cy]),xm=point([g.cx-1,g.cy]),yp=point([g.cx,g.cy+1]),ym=point([g.cx,g.cy-1]),a=(xp[0]-xm[0])/2,b=(yp[0]-ym[0])/2,cj=(xp[1]-xm[1])/2,d=(yp[1]-ym[1])/2,r=(g.rotation??0)*Math.PI/180,cos=Math.cos(r),sin=Math.sin(r),u=[(a*cos+b*sin)*g.rx,(cj*cos+d*sin)*g.rx],v=[(-a*sin+b*cos)*g.ry,(-cj*sin+d*cos)*g.ry],sxx=u[0]**2+v[0]**2,syy=u[1]**2+v[1]**2,sxy=u[0]*u[1]+v[0]*v[1],disc=Math.sqrt((sxx-syy)**2+4*sxy*sxy),l1=(sxx+syy+disc)/2,l2=(sxx+syy-disc)/2;
  let rotation=.5*Math.atan2(2*sxy,sxx-syy)*180/Math.PI,rx=Math.sqrt(Math.max(1e-8,l1)),ry=Math.sqrt(Math.max(1e-8,l2));
  // Select the eigenvector closest to the original x-axis, preserving which
  // normalized material axis represented rx versus ry.
  if(Math.abs(Math.cos((rotation-(g.rotation??0))*Math.PI/180))<Math.SQRT1_2){[rx,ry]=[ry,rx];rotation+=90;}while(rotation-(g.rotation??0)>90)rotation-=180;while(rotation-(g.rotation??0)<-90)rotation+=180;
  const out={cx:c[0],cy:c[1],rx,ry,rotation};if(g.paintBox)out.paintBox=[c[0]+(g.paintBox[0]-g.cx)*rx/g.rx,c[1]+(g.paintBox[1]-g.cy)*ry/g.ry,g.paintBox[2]*rx/g.rx,g.paintBox[3]*ry/g.ry];return out;
 }const out={rings:g.rings.map(r=>kind==='contour'?{...r,points:r.points.map(point)}:{start:point(r.start),cubics:r.cubics.map(c=>[...point(c.slice(0,2)),...point(c.slice(2,4)),...point(c.slice(4,6))])})};if(g.paintBox)out.paintBox=box(g.paintBox);return out;}

 function subdividedBezier(kind,g){
  const midpoint=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
  function subdivide(p,depth=0){const length=p.slice(1).reduce((v,a,i)=>v+Math.hypot(a[0]-p[i][0],a[1]-p[i][1]),0);if(length<=16||depth>=10)return[p];const a=midpoint(p[0],p[1]),b=midpoint(p[1],p[2]),c=midpoint(p[2],p[3]),d=midpoint(a,b),e=midpoint(b,c),m=midpoint(d,e);return[...subdivide([p[0],a,d,m],depth+1),...subdivide([m,e,c,p[3]],depth+1)];}
  const rings=g.rings.map(r=>{let curves=[];if(kind==='contour'){const pts=r.points,l=pts.length,t=(r.tension??.15)/6;for(let i=0;i<l;i++){const a=pts[(i+l-1)%l],b=pts[i],c=pts[(i+1)%l],d=pts[(i+2)%l];curves.push([b,[b[0]+t*(c[0]-a[0]),b[1]+t*(c[1]-a[1])],[c[0]-t*(d[0]-b[0]),c[1]-t*(d[1]-b[1])],c]);}}else{let prev=r.start;for(const c of r.cubics){curves.push([prev,c.slice(0,2),c.slice(2,4),c.slice(4,6)]);prev=c.slice(4,6);}}
   const segments=curves.flatMap(c=>subdivide(c));return{start:point(segments[0][0]),cubics:segments.map(c=>[...point(c[1]),...point(c[2]),...point(c[3])])};});const out={rings};if(g.paintBox)out.paintBox=box(g.paintBox);return out;
 }
 return kind==='ellipse'?{kind,geometry:geometry(kind,sourceGeometry)}:{kind:'bezier',geometry:subdividedBezier(kind,sourceGeometry)};
  }
  function cubicRoots(p0,p1,p2,p3){
    const a=-p0+3*p1-3*p2+p3,b=2*(p0-2*p1+p2),c=p1-p0;
    if(Math.abs(a)<1e-12)return Math.abs(b)<1e-12?[]:[-c/b];
    const d=b*b-4*a*c;if(d<0)return[];const s=Math.sqrt(d);return[(-b+s)/(2*a),(-b-s)/(2*a)];
  }
  const cubicAt=(p0,p1,p2,p3,t)=>{const u=1-t;return u*u*u*p0+3*u*u*t*p1+3*u*t*t*p2+t*t*t*p3;};
  function geometryDetails(kind,g){
    const prior=geometryCache.get(g);if(prior&&prior.kind===kind){geometryCache.delete(g);geometryCache.set(g,prior);return prior;}
    let path='',bounds,rotation='';
    if(kind==='ellipse'){
      bounds=[g.cx-g.rx,g.cy-g.ry,2*g.rx,2*g.ry];rotation=g.rotation?`rotate(${n(g.rotation)} ${n(g.cx)} ${n(g.cy)})`:'';
      path=`<ellipse cx="${n(g.cx)}" cy="${n(g.cy)}" rx="${n(g.rx)}" ry="${n(g.ry)}"/>`;
    } else {
      const rings=g.rings.map(r=>{
        if(kind==='bezier')return r;
        const p=r.points,t=(r.tension??.15)/6,cubics=[];
        for(let i=0;i<p.length;i++){const prev=p[(i+p.length-1)%p.length],a=p[i],b=p[(i+1)%p.length],next=p[(i+2)%p.length];cubics.push([a[0]+t*(b[0]-prev[0]),a[1]+t*(b[1]-prev[1]),b[0]-t*(next[0]-a[0]),b[1]-t*(next[1]-a[1]),b[0],b[1]]);}
        return {start:p[0],cubics};
      });
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;const add=(x,y)=>{minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);};
      const ds=[];
      for(const ring of rings){let p=ring.start;add(...p);let d=`M${p.map(n).join(' ')}`;
        for(const c of ring.cubics){d+=`C${c.map(n).join(' ')}`;add(c[4],c[5]);const roots=[...cubicRoots(p[0],c[0],c[2],c[4]),...cubicRoots(p[1],c[1],c[3],c[5])];for(const t of roots)if(t>0&&t<1)add(cubicAt(p[0],c[0],c[2],c[4],t),cubicAt(p[1],c[1],c[3],c[5],t));p=[c[4],c[5]];}
        ds.push(d+'Z');
      }
      bounds=[minX,minY,Math.max(.000001,maxX-minX),Math.max(.000001,maxY-minY)];path=`<path d="${ds.join(' ')}" fill-rule="evenodd" clip-rule="evenodd"/>`;
    }
    const value={kind,path,bounds,paintBox:g.paintBox??bounds,rotation};geometryCache.set(g,value);while(geometryCache.size>512)geometryCache.delete(geometryCache.keys().next().value);return value;
  }
  function hsv(channels){const a=channels.slice(0,3).map(v=>v/255),v=Math.max(...a),low=Math.min(...a),d=v-low;let h=0;if(d)h=(v===a[0]?(a[1]-a[2])/d+(a[1]<a[2]?6:0):v===a[1]?(a[2]-a[0])/d+2:(a[0]-a[1])/d+4)/6;return[h,v?d/v:0,v];}
  function rgb(values){let[h,s,v]=values;h=((h%1)+1)%1;s=clamp(s,0,1);v=clamp(v,0,1);const i=Math.floor(h*6),f=h*6-i,p=v*(1-s),q=v*(1-f*s),t=v*(1-(1-f)*s);return[[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i%6].map(x=>x*255);}
  function paintColor(value,track,options,context){
    if(track.protectedPaint||!track.recolorGroup||/^(none|transparent)$/i.test(value))return value;
    const source=rgba(value);
    if(typeof options.mapColor==='function'){const changed=options.mapColor(value,{trackId:track.id,label:track.label,recolorGroup:track.recolorGroup,...context});if(changed!==undefined){color(changed,'mapColor return');return hex([...rgba(changed).slice(0,3),source[3]]);}}
    const override=options.colorOverrides?.[track.recolorGroup];if(!override)return value;
    color(override.baseColor,'override.baseColor');color(override.targetColor,'override.targetColor');const a=hsv(source),base=hsv(rgba(override.baseColor)),target=hsv(rgba(override.targetColor));const hue=((a[0]-base[0]+1.5)%1)-.5;
    return hex([...rgb([target[0]+hue,base[1]>1e-6?a[1]*target[1]/base[1]:target[1],base[2]>1e-6?a[2]*target[2]/base[2]:target[2]]),source[3]]);
  }
  function renderLayer(model,sourceFrame,options={}){
    const pose=evaluate(model,sourceFrame,options),prefix=options.prefix??'object-scene';id(prefix,'options.prefix');let definitions='',body=`<rect data-scene-background="true" width="${n(pose.width)}" height="${n(pose.height)}" fill="${esc(pose.background)}"/>`;
    for(const track of pose.tracks){
      const name=`${prefix}-${pose.shotId}-${track.id}`,g=geometryDetails(track.kind,track.geometry),[x,y,w,h]=g.bounds,box=g.paintBox;
      // A clipPath on a group may antialias each paint plane separately in
      // browsers. One alpha mask forces source-over paints to be composed first.
      // Direct geometry stays in this same SVG: no nested <use> resource graphs.
      definitions+=`<mask id="${name}-clip" maskUnits="userSpaceOnUse" x="${n(x-2)}" y="${n(y-2)}" width="${n(w+4)}" height="${n(h+4)}" style="mask-type:alpha">${g.path.replace('/>', ' fill="white"/>')}</mask>`;
      const rectAttrs=`x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"`;
      const gradient=(value,suffix,context,owner=track)=>{
        const key=`${name}-${suffix}`,type=value.type==='linear'?'linearGradient':'radialGradient',fields=value.type==='linear'?['x1','y1','x2','y2']:['cx','cy','r','fx','fy'];
        const stretch=value.type==='radial'&&((value.scaleX??1)!==1||(value.scaleY??1)!==1)?` translate(${n(value.cx)} ${n(value.cy)}) scale(${n(value.scaleX??1)} ${n(value.scaleY??1)}) translate(${n(-value.cx)} ${n(-value.cy)})`:'';
        definitions+=`<${type} id="${key}" gradientUnits="userSpaceOnUse" gradientTransform="translate(${n(box[0])} ${n(box[1])}) scale(${n(box[2])} ${n(box[3])})${stretch}" ${fields.filter(k=>value[k]!==undefined).map(k=>`${k}="${n(value[k])}"`).join(' ')}>${value.stops.map((s,i)=>`<stop offset="${n(s.offset)}" stop-color="${esc(paintColor(s.color,owner,options,{...context,stopIndex:i}))}" stop-opacity="${n(s.opacity??1)}"/>`).join('')}</${type}>`;
        return `url(#${key})`;
      };
      const materialPlanes=(paint,suffix='')=>{
        const owner={...track,recolorGroup:paint.recolorGroup,protectedPaint:paint.protectedPaint};
        const basePaint=paint.gradient?gradient(paint.gradient,`${suffix}base-gradient`,{paint:'base-gradient'},owner):esc(paintColor(paint.fill,owner,options,{paint:'fill'}));
        let planes=`<rect ${rectAttrs} fill="${basePaint}"/>`;
        paint.paintLayers.forEach((layer,index)=>{planes+=`<rect ${rectAttrs} fill="${gradient(layer.gradient,`${suffix}layer-${index}`,{paint:'layer-gradient',layerIndex:index},owner)}" opacity="${n(layer.opacity??1)}"/>`;});
        return planes;
      };
      const fields=track.materialFields;
      const planes=fields?`<g data-material-field="from">${materialPlanes(fields.from,'from-')}</g><g data-material-field="to" opacity="${n(fields.alpha)}">${materialPlanes(fields.to,'to-')}</g>`:materialPlanes(track);
      let filter='';if(track.blurPx>0){const margin=3*track.blurPx;definitions+=`<filter id="${name}-blur" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="${n(x-margin)}" y="${n(y-margin)}" width="${n(w+2*margin)}" height="${n(h+2*margin)}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${n(track.blurPx)}"/></filter>`;filter=` filter="url(#${name}-blur)"`;}
      const outline=options.outlines?g.path.replace('/>',' fill="none" stroke="#50e4ff" stroke-width="1"/>'):'';
      body+=`<g id="${name}" data-track-id="${esc(track.id)}" data-part-id="${esc(track.id)}" data-label="${esc(track.label)}" opacity="${n(track.opacity)}"${g.rotation?` transform="${g.rotation}"`:''}><g${filter}><g mask="url(#${name}-clip)">${planes}</g></g>${outline}</g>`;
    }
    return {frame:pose.frame,sampledFrame:pose.sampledFrame,motionMode:pose.motionMode,shotId:pose.shotId,width:pose.width,height:pose.height,definitions,body,trackIds:pose.tracks.map(track=>track.id)};
  }
  function render(model,sourceFrame,options={}){const layer=renderLayer(model,sourceFrame,options);return`<svg xmlns="http://www.w3.org/2000/svg" width="${n(layer.width)}" height="${n(layer.height)}" viewBox="0 0 ${n(layer.width)} ${n(layer.height)}" role="img" aria-label="Source-derived vector object scene"><defs>${layer.definitions}</defs>${layer.body}</svg>`;}
  return {validate,evaluate,renderLayer,render};
}
