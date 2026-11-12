/** Refine already-observed app vectors; source silhouettes remain evidence, not ground truth. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {build} from 'esbuild';
import assert from 'node:assert/strict';

const {values:a}=parseArgs({options:{project:{type:'string'},source:{type:'string'},'source-start':{type:'string'},'out-dir':{type:'string'},tolerance:{type:'string'},python:{type:'string'},overwrite:{type:'boolean'},help:{type:'boolean'}}});
if(a.help){console.log('node scripts/refine-frame-surfaces.mjs --project project.json --source video.mp4 --out-dir artifacts/refined [--source-start 0] [--tolerance 0.6] [--overwrite]');process.exit(0);}
if(!a.project||!a.source||!a['out-dir'])throw Error('--project, --source and --out-dir are required');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.resolve(a['out-dir']);
await fs.mkdir(out,{recursive:true});
const destination=path.join(out,'project.json');
if(!a.overwrite&&await fs.stat(destination).catch(()=>null))throw Error('Output exists; choose another directory or --overwrite');
await fs.mkdir(path.join(root,'.cache'),{recursive:true});const bundle=path.join(root,'.cache',`surface-engine-${randomUUID()}.mjs`);
try{
 await build({entryPoints:[path.join(root,'src/engine/index.ts')],outfile:bundle,bundle:true,platform:'node',format:'esm'});
 const {parseDocument,validateProject,createProjectRenderer}=await import(pathToFileURL(bundle));
 const raw=await fs.readFile(a.project,'utf8'),original=parseDocument(raw);
 if(original.schemaVersion!==1)throw Error('This tool accepts app schema 1 only; decode each composition segment explicitly first.');
 if(original.temporal?.mode!=='frames')throw Error('Explicit frame redraw mode is required.');
 const fps=original.temporal.sampleFps;
 if(!Number.isFinite(fps)||fps<=0)throw Error('A finite observed sampleFps is required.');
 const times=Array.from({length:Math.ceil(original.duration*fps-1e-8)},(_,i)=>i/fps);
 // Arbitrary sparse/offset keyframes can change the between-frame semantics.
 // Reject them instead of silently re-timing an animation during refinement.
 for(const n of original.nodes)for(const k of n.keyframes)if(Math.abs(k.time*fps-Math.round(k.time*fps))>1e-5)throw Error('Keyframes must align to the observation grid.');
 const renderer=createProjectRenderer(original);
 const fields=['id','type','x','y','width','height','rotation','opacity','path','fill','gradient','occlusionPath','stackBoundary','paintRegions'];
 const frames=times.map(time=>({time,nodes:original.nodes.map(n=>renderer.evaluate(n.id,time)).filter(n=>n.visible).map(n=>Object.fromEntries(fields.filter(k=>n[k]!==undefined).map(k=>[k,n[k]])))}));
 const snapshots={schema:'evaluated-frame-surfaces-v1',width:original.width,height:original.height,cuts:original.temporal.cuts??[],frames};
 const snapshotFile=path.join(out,'observations.json');await fs.writeFile(snapshotFile,JSON.stringify(snapshots));
 const python=a.python??path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const evidenceFile=path.join(out,'surface-evidence.json');
 execFileSync(python,[path.join(root,'scripts/refine_frame_surfaces.py'),'--snapshots',snapshotFile,'--source',path.resolve(a.source),'--source-start',a['source-start']??'0','--tolerance',a.tolerance??'0.6','--output',evidenceFile],{stdio:'inherit'});
 const evidence=JSON.parse(await fs.readFile(evidenceFile,'utf8'));const project=structuredClone(original);
 const changes=new Map(evidence.changes.map(c=>[`${c.id}:${Math.round(c.time*fps)}`,c]));
 let changedStates=0;
 for(const node of project.nodes){
  if(node.type==='text'||!evidence.changes.some(c=>c.id===node.id))continue;
  const old=original.nodes.find(n=>n.id===node.id),keys=[];
  for(const time of times){const change=changes.get(`${node.id}:${Math.round(time*fps)}`);
   const state=renderer.evaluate(node.id,time);if(!state.visible)continue;const left=[...old.keyframes].reverse().find(k=>k.time<=time+1e-8)??old.keyframes[0];
   const existing=old.keyframes.find(k=>Math.abs(k.time-time)<1e-8);
   // Evaluated observations become held redraw states; preserve all original
   // paint, clipping, stack, transform and opacity fields at these exact times.
   const key=existing?structuredClone(existing):{...structuredClone(left),time,x:state.x-old.x-(old.width-state.width)/2,y:state.y-old.y-(old.height-state.height)/2,scaleX:state.scaleX,scaleY:state.scaleY,rotation:state.rotation-old.rotation,opacity:old.opacity?state.opacity/old.opacity:0,easing:'linear',fill:state.fill,gradient:state.gradient??null,paintRegions:state.paintRegions??[],stackBoundary:state.stackBoundary??null};
   if(change)changedStates++;key.path=change?.path??state.path;keys.push(key);
  }
  // Keep invisible/endpoint observations, including boundary opacity states.
  for(const key of old.keyframes)if(!keys.some(k=>Math.abs(k.time-key.time)<1e-8))keys.push(structuredClone(key));
  if(keys.length)node.keyframes=keys.sort((a,b)=>a.time-b.time);
 }
 const validated=validateProject(project),after=createProjectRenderer(validated);
 for(const t of times)for(const node of original.nodes){const before=renderer.evaluate(node.id,t),next=after.evaluate(node.id,t);for(const key of ['id','type','x','y','width','height','rotation','opacity','visible','fill','gradient','paintRegions','stackBoundary','occlusionPath','text','textWarp','textReveal'])assert.deepEqual(next[key],before[key],`${node.id}@${t}:${key}`);}
 assert.deepEqual(validated.nodes.filter(n=>n.type==='text'),original.nodes.filter(n=>n.type==='text'));
 assert.deepEqual(validated.temporal,original.temporal);assert.deepEqual(validated.nodes.map(n=>n.id),original.nodes.map(n=>n.id));
 await fs.writeFile(destination,JSON.stringify(validated)+'\n');
 const report={...evidence.report,changedStates,geometryOnly:true,paintAndTextPreserved:true,frameRedrawPreserved:true,idsAndZOrderPreserved:true,sourceProjectSHA256:createHash('sha256').update(raw).digest('hex'),projectSHA256:createHash('sha256').update(await fs.readFile(destination)).digest('hex')};
 await fs.writeFile(path.join(out,'refinement-check.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await fs.rm(bundle,{force:true});}
