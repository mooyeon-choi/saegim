import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {zipSync, strToU8} from 'fflate';
import {assetGallery} from './lib/asset-gallery.mjs';
import {createPathSmoother} from './lib/svg-curves.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=value=>createHash('sha256').update(value).digest('hex');
const safeId=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);

/** Shot boundaries are source cuts, never processing-segment boundaries. */
export function sourceShots(document){
 const cuts=[0,...(document.temporal?.cuts??[]).filter(t=>t>0&&t<document.duration),document.duration];
 return [...new Set(cuts)].sort((a,b)=>a-b).slice(0,-1).map((start,i,array)=>({id:`cut-${String(i+1).padStart(2,'0')}`,name:`컷 ${i+1}`,start,end:array[i+1]??document.duration}));
}

/** Masks are caller-supplied visible-surface annotations in project coordinates. */
export function validateRegions(value,document){
 if(value?.schemaVersion!==1||value.width!==document.width||value.height!==document.height||!Array.isArray(value.sections)||!value.sections.length)throw Error('Regions require schemaVersion 1, matching dimensions and sections.');
 if(value.edgeOverlapPx!==undefined&&(!finite(value.edgeOverlapPx)||value.edgeOverlapPx<0||value.edgeOverlapPx>8))throw Error('edgeOverlapPx must be 0–8 source pixels.');
 const shots=sourceShots(document),ids=new Set();let end=0;
 for(const section of value.sections){
  if(!safeId(section.id)||ids.has(section.id)||typeof section.name!=='string'||!section.name.trim())throw Error('Section IDs must be unique safe slugs; names must be nonempty.');ids.add(section.id);
  if(![section.start,section.end,section.time].every(finite)||Math.abs(section.start-end)>1e-6||section.end<=section.start||section.end>document.duration+1e-6||section.time<section.start||section.time>=section.end)throw Error('Sections must cover the timeline in order, with a representative time inside each section.');
  const shot=shots.find(s=>section.start>=s.start-1e-6&&section.end<=s.end+1e-6);if(!shot)throw Error('A section cannot cross a source cut.');
  if(!Array.isArray(section.layers)||!section.layers.length||section.layers.length>100)throw Error('Each section requires 1–100 annotated layers.');
  const layerIds=new Set();
  for(const layer of section.layers){
   if(!safeId(layer.id)||layerIds.has(layer.id)||typeof layer.name!=='string'||!layer.name.trim())throw Error('Layer IDs must be unique safe slugs; names must be nonempty.');layerIds.add(layer.id);
   if(layer.surface && (!['replace','underlay'].includes(layer.surface.mode)||layer.surface.project?.schemaVersion!==1||layer.surface.project.width!==document.width||layer.surface.project.height!==document.height))throw Error('Surface requires replace/underlay and a matching schema 1 project.');
   if(typeof layer.path!=='string'||!layer.path.trim()||layer.path.length>2e6||!/^[MmLlHhVvCcSsQqTtAaZz0-9eE.+,\s-]+$/.test(layer.path)||!/[Zz]\s*$/.test(layer.path))throw Error('Layer masks require closed SVG paths, not markup.');
  }
  end=section.end;
 }
 if(Math.abs(end-document.duration)>1e-6)throw Error('Sections must cover the full document duration.');
 return shots;
}

export async function exportElements({project,regions,outDir,overwrite=false,smoothPx=0}){
 if(!finite(smoothPx)||smoothPx<0||smoothPx>8)throw Error('smoothPx must be 0–8 source pixels.');
 const out=path.resolve(outDir),projectBytes=await fs.readFile(project),annotations=JSON.parse(await fs.readFile(regions,'utf8'));
 if(!overwrite&&await fs.stat(path.join(out,'manifest.json')).catch(()=>false))throw Error('Output exists; use another directory or --overwrite.');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'frameform-elements-'));let browser;
 try{
  await build({entryPoints:[path.join(root,'src/engine/index.ts')],outfile:path.join(temp,'engine.mjs'),bundle:true,platform:'node',format:'esm'});
  const engine=await import(pathToFileURL(path.join(temp,'engine.mjs')).href);const doc=engine.parseDocument(projectBytes.toString());const shots=validateRegions(annotations,doc);
  for(const section of annotations.sections)for(const layer of section.layers)if(layer.surface){
   const surface=engine.validateProject(layer.surface.project);
   if(surface.background!=='#00000000'||!surface.nodes.length||surface.nodes.some(n=>n.keyframes.length||n.hidden||n.start!==0)||surface.backgroundMotion||surface.foregroundMotion)throw Error('Surfaces require transparent #00000000 background and visible static nodes starting at 0.');
   layer.surface.project=surface;layer.surface.svg=engine.createProjectRenderer(surface)(0);
  }
  browser=await chromium.launch();const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  const manifest={schemaVersion:1,name:doc.name,width:doc.width,height:doc.height,duration:doc.duration,fps:doc.fps,sourceProjectSHA256:hash(projectBytes),shots,processingSegments:doc.schemaVersion===2?doc.segments.map(({id,start,end})=>({id,start,end})):[],sections:[],limits:['대표 시각의 정적 SVG입니다. 모든 영상 프레임에 적용한 결과는 아닙니다.', '배면 도형이 지정된 요소는 가려진 면을 추정해 채웁니다. 지정되지 않은 요소의 실제 구멍과 보이는 영역은 유지합니다.']};
  manifest.smoothPx=smoothPx;manifest.stackOrder='front-to-back';
  await page.addScriptTag({content:`window.pathSmoother=(${createPathSmoother.toString()})();`});
  manifest.edgeOverlapPx=annotations.edgeOverlapPx??0;
  const files={};let loadedId,render;
  for(const section of annotations.sections){
   const shot=shots.find(s=>section.start>=s.start-1e-6&&section.end<=s.end+1e-6);const folder=`${shot.id}/${section.id}`;
   let localTime=section.time;
   if(doc.schemaVersion===2){const pos=engine.getSegmentAt(doc,section.time);localTime=pos.localTime;if(loadedId!==pos.segment.id){render=engine.createProjectRenderer(await engine.decodeSegment(pos.segment));loadedId=pos.segment.id;}}
   else render??=engine.createProjectRenderer(doc);
   const svg=render(localTime);
   const assets=await page.evaluate(({svg,layers,width,height,sectionId,edgeOverlapPx,smoothPx})=>{
    const ns='http://www.w3.org/2000/svg',parser=new DOMParser(),xml=new XMLSerializer();
    let original=parser.parseFromString(svg,'image/svg+xml').documentElement;
    if(original.nodeName!=='svg'||original.querySelector('parsererror,image,video,script,foreignObject'))throw Error('Expected a pure vector SVG.');
    document.body.replaceChildren(document.importNode(original,true));const live=document.body.firstElementChild;live.style.cssText=`position:absolute;width:${width}px;height:${height}px;`;
    const stats={changed:0,curves:0,corners:0,maxSampledError:0};
    const smooth=(d,matrix)=>{if(!smoothPx)return d;const r=window.pathSmoother.smooth(d,{tolerance:smoothPx,matrix});stats.changed+=Number(r.changed);stats.curves+=r.curves;stats.corners+=r.corners;stats.maxSampledError=Math.max(stats.maxSampledError,r.maxError);return r.path;};
    if(smoothPx)for(const p of live.querySelectorAll('path')){const m=p.getCTM();if(m){const before=p.getAttribute('d'),after=smooth(before,[m.a,m.b,m.c,m.d]);
     // Keep known paint beneath the fitted contour: adjacent independently fitted
     // color regions must not reveal the unrelated scene background through cracks.
     if(after!==before&&!p.closest('defs,clipPath,mask')){const backing=p.cloneNode(true);backing.removeAttribute('id');backing.setAttribute('data-contour-underlay','true');p.before(backing);}p.setAttribute('d',after);}}
    original=live.cloneNode(true);original.removeAttribute('style');
    const rename=(element,prefix)=>{const ids=new Map([...element.querySelectorAll('[id]')].map(n=>[n.id,prefix+n.id]));for(const n of element.querySelectorAll('*'))for(const a of [...n.attributes]){let v=a.name==='id'?(ids.get(a.value)??a.value):a.value;v=v.replace(/url\(#([^)]+)\)/g,(m,id)=>ids.has(id)?`url(#${ids.get(id)})`:m);if(a.localName==='href'&&v.startsWith('#')&&ids.has(v.slice(1)))v='#'+ids.get(v.slice(1));n.setAttribute(a.name,v);}};
    const nodeBounds=new Map();for(const node of live.querySelectorAll('[data-node-id]')){const b=node.getBoundingClientRect(),r=live.getBoundingClientRect();nodeBounds.set(node.getAttribute('data-node-id'),{x:b.x-r.x,y:b.y-r.y,width:b.width,height:b.height});}
    const result=[];
    for(const layer of layers){
     const layerPath=smooth(layer.path,[1,0,0,1]);
     const mask=document.createElementNS(ns,'path');mask.setAttribute('d',layerPath);live.append(mask);let b=mask.getBBox();mask.remove();
     if(![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0||b.x < -smoothPx-1||b.y < -smoothPx-1||b.x+b.width>width+smoothPx+1||b.y+b.height>height+smoothPx+1)throw Error(`Invalid mask bounds: ${layer.id}`);
     let surfaceGroup;
     if(layer.surface){
      const surface=parser.parseFromString(layer.surface.svg,'image/svg+xml').documentElement;
      if(surface.querySelector('parsererror,image,video,script,foreignObject'))throw Error('Surface must be pure SVG.');
      surface.querySelector(':scope > rect')?.remove(); // The validated transparent project background.
      rename(surface,`${sectionId}-${layer.id}-surface-`);
      surfaceGroup=document.createElementNS(ns,'g');surfaceGroup.setAttribute('data-surface-mode',layer.surface.mode);
      while(surface.firstChild)surfaceGroup.append(surface.firstChild);
      live.append(surfaceGroup);const r=surfaceGroup.getBBox();surfaceGroup.remove();
      if(![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.width<=0||r.height<=0)throw Error('Empty surface.');
      b=layer.surface.mode==='replace'?r:{x:Math.min(b.x,r.x),y:Math.min(b.y,r.y),width:Math.max(b.x+b.width,r.x+r.width)-Math.min(b.x,r.x),height:Math.max(b.y+b.height,r.y+r.height)-Math.min(b.y,r.y)};
     }
     const padding=Math.ceil(edgeOverlapPx)+1;
     const bounds={x:Math.max(0,Math.floor(b.x)-padding),y:Math.max(0,Math.floor(b.y)-padding),width:0,height:0};bounds.width=Math.min(width,Math.ceil(b.x+b.width)+padding)-bounds.x;bounds.height=Math.min(height,Math.ceil(b.y+b.height)+padding)-bounds.y;
     if(bounds.width<=0||bounds.height<=0)throw Error(`Surface must intersect the project viewport: ${layer.id}`);
     const copy=original.cloneNode(true);let pruned=0;
     // Retain intersecting vector groups in original stack order and retain their definitions.
     for(const node of copy.querySelectorAll('[data-node-id]')){const r=nodeBounds.get(node.getAttribute('data-node-id'));if(r&&(r.x+r.width<bounds.x||r.y+r.height<bounds.y||r.x>bounds.x+bounds.width||r.y>bounds.y+bounds.height)){node.remove();pruned++;}}
     const prefix=`${sectionId}-${layer.id}-`,idMap=new Map([...copy.querySelectorAll('[id]')].map(n=>[n.id,prefix+n.id]));
     for(const node of copy.querySelectorAll('*')){for(const a of [...node.attributes]){let v=a.value;if(a.name==='id')v=idMap.get(v)??v;v=v.replace(/url\(#([^)]+)\)/g,(m,id)=>idMap.has(id)?`url(#${idMap.get(id)})`:m);if((a.localName==='href')&&v.startsWith('#')&&idMap.has(v.slice(1)))v='#'+idMap.get(v.slice(1));node.setAttribute(a.name,v);}}
     const clip=document.createElementNS(ns,edgeOverlapPx?'mask':'clipPath');clip.id=prefix+'visible';clip.setAttribute(edgeOverlapPx?'maskUnits':'clipPathUnits','userSpaceOnUse');const contour=document.createElementNS(ns,'path');contour.setAttribute('d',layerPath);contour.setAttribute('clip-rule','evenodd');contour.setAttribute('fill-rule','evenodd');
     if(edgeOverlapPx){clip.setAttribute('x','0');clip.setAttribute('y','0');clip.setAttribute('width',String(width));clip.setAttribute('height',String(height));contour.setAttribute('fill','white');contour.setAttribute('stroke','white');contour.setAttribute('stroke-width',String(2*edgeOverlapPx));contour.setAttribute('stroke-linejoin','round');}
     clip.append(contour);
     const defs=document.createElementNS(ns,'defs');defs.append(clip);const group=document.createElementNS(ns,'g');group.setAttribute('data-element-id',layer.id);group.setAttribute('aria-label',layer.name);group.setAttribute(edgeOverlapPx?'mask':'clip-path',`url(#${clip.id})`);
     while(copy.firstChild)group.append(copy.firstChild);copy.append(defs,group);
     if(surfaceGroup){
      if(layer.surface.mode==='replace'){group.replaceChildren(surfaceGroup);group.removeAttribute('mask');group.removeAttribute('clip-path');defs.replaceChildren();}
      else copy.insertBefore(surfaceGroup,group);
     }
     copy.removeAttribute('style');copy.setAttribute('viewBox',`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);copy.setAttribute('width',String(bounds.width));copy.setAttribute('height',String(bounds.height));copy.setAttribute('aria-label',layer.name);
     const title=document.createElementNS(ns,'title');title.textContent=layer.name;copy.prepend(title);
     const stackSvg=xml.serializeToString(copy),inner=[...copy.children].filter(n=>n.tagName!=='title').map(n=>xml.serializeToString(n)).join('');
     // Downloaded assets keep the exact matte; overlap belongs only to recomposition.
     if(edgeOverlapPx&&layer.surface?.mode!=='replace'){const exact=document.createElementNS(ns,'clipPath');exact.id=clip.id;exact.setAttribute('clipPathUnits','userSpaceOnUse');const p=contour.cloneNode(true);p.removeAttribute('stroke');p.removeAttribute('stroke-width');exact.append(p);defs.replaceChildren(exact);group.removeAttribute('mask');group.setAttribute('clip-path',`url(#${exact.id})`);}
     result.push({id:layer.id,name:layer.name,bounds,svg:xml.serializeToString(copy),stackSvg,inner,paths:copy.querySelectorAll('path').length,gradients:copy.querySelectorAll('linearGradient,radialGradient').length,pruned});
    }
    return {items:result,stats};
   },{svg,layers:section.layers,width:doc.width,height:doc.height,sectionId:section.id,edgeOverlapPx:manifest.edgeOverlapPx,smoothPx});
   const entry={id:section.id,name:section.name,cutId:shot.id,start:section.start,end:section.end,time:section.time,scene:`${folder}/scene.svg`,stack:`${folder}/stack.svg`,layers:[]};
   files[entry.scene]=strToU8(svg);
   files[entry.stack]=strToU8(`<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">${assets.items.slice().reverse().map(a=>a.inner).join('')}</svg>`);
   entry.smoothing=assets.stats;
   for(const asset of assets.items){const file=`${folder}/${asset.id}.svg`,stackFile=`${folder}/stack/${asset.id}.svg`;files[file]=strToU8(asset.svg);files[stackFile]=strToU8(asset.stackSvg);const surface=section.layers.find(l=>l.id===asset.id).surface;let surfaceFile;if(surface){surfaceFile=`${folder}/${asset.id}-surface.json`;files[surfaceFile]=strToU8(JSON.stringify(surface.project,null,2)+'\n');}
    entry.layers.push({zIndex:section.layers.length-entry.layers.length,surface:surface?{mode:surface.mode,inferred:true,colorFit:surface.colorFit,file:surfaceFile}:undefined,id:asset.id,name:asset.name,bounds:asset.bounds,file,stackFile,paths:asset.paths,gradients:asset.gradients,sha256:hash(files[file])});}
   manifest.sections.push(entry);console.log(JSON.stringify({section:section.id,time:section.time,elements:entry.layers.length}));
  }
  if(errors.length)throw Error(errors.join('\n'));
  manifest.elementCount=manifest.sections.reduce((n,s)=>n+s.layers.length,0);
  files['manifest.json']=strToU8(JSON.stringify(manifest,null,2)+'\n');files['index.html']=strToU8(assetGallery(manifest));
  files['README.txt']=strToU8('index.html을 브라우저에서 열어 컷과 편집 구간별 SVG 요소를 확인하세요.\nscene.svg는 분리 전 장면, stack.svg는 이름이 있는 요소 그룹을 다시 쌓은 장면입니다.\n각 요소 SVG는 투명 배경의 정적 벡터이며 좌표·기준 시각은 manifest.json에 기록됩니다.\n가려진 면은 지정한 surface 프로젝트로만 추정해 채웁니다. 의미별 마스크와 배면 도형은 입력 주석 데이터이며 자동 복원이 아닙니다.\n');
  await fs.mkdir(out,{recursive:true});
  for(const [file,bytes]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(out,file)),{recursive:true});await fs.writeFile(path.join(out,file),bytes);}
  await fs.writeFile(path.join(out,'vector-elements.zip'),zipSync(files,{level:6}));
  const report={passed:true,shots:shots.length,sections:manifest.sections.length,elements:manifest.elementCount,sourceProjectSHA256:manifest.sourceProjectSHA256,maskSHA256:hash(await fs.readFile(regions)),smoothPx,surfaces:manifest.sections.flatMap(s=>s.layers).filter(l=>l.surface).length,rasterEmbedded:false,browserErrors:errors};
  await fs.writeFile(path.join(out,'export-check.json'),JSON.stringify(report,null,2)+'\n');return report;
 }finally{await browser?.close();await fs.rm(temp,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {values}=parseArgs({options:{project:{type:'string'},regions:{type:'string'},'out-dir':{type:'string'},overwrite:{type:'boolean'},'smooth-px':{type:'string'},help:{type:'boolean'}}});
 if(values.help)console.log('node scripts/export-elements.mjs --project <schema1-or-2.json> --regions <visible-region-annotations.json> --out-dir <folder> [--smooth-px 0..8] [--overwrite]');
 else {if(!values.project||!values.regions||!values['out-dir'])throw Error('--project, --regions and --out-dir are required');console.log(JSON.stringify(await exportElements({project:values.project,regions:values.regions,outDir:values['out-dir'],overwrite:values.overwrite,smoothPx:Number(values['smooth-px']??0)})));}
}
