import {describe,it,expect} from 'vitest';
import {validateProject,parseDocument,exportProjectJson,createProjectRenderer} from '../../src/engine';
import {createMotionRuntime} from '../../src/engine/runtime';
import type {MotionProject} from '../../src/types';
function project():MotionProject{return {schemaVersion:1,id:'exit',name:'exit',width:100,height:100,duration:1,fps:2,background:'#ffffff',scenes:[],nodes:[{id:'body',name:'body',type:'ellipse',x:65,y:30,width:30,height:30,rotation:0,opacity:1,fill:'#ff0000',stroke:'none',strokeWidth:0,start:0,end:1,hidden:false,locked:false,keyframes:[{time:0,x:0,y:0,scaleX:1,scaleY:1,rotation:0,opacity:1,easing:'linear'},{time:.5,x:20,y:0,scaleX:1,scaleY:1,rotation:0,opacity:1,easing:'linear'}]}],temporal:{mode:'blend',sampleFps:2,cuts:[]},foregroundMotion:{mode:'on',tracks:[{id:'exit',start:0,end:.5,polygon:[[60,15],[100,15],[100,75],[60,75]],featherPx:0,forward:[1,0,0,1,20,0],appearance:{midpoint:.55,sharpness:2},viewportFallback:'from'}]}}}
describe('observed viewport fallback',()=>{
 it('keeps one fully covered endpoint and clips the other to observed pixels',()=>{
  const p=project(),pair=createProjectRenderer(p).framePair(.25);
  expect(pair.foregroundStatus?.supported).toBe(true);
  expect(pair.sharedDefinitions?.match(/viewBox="0 0 100 100" overflow="hidden"/g)).toHaveLength(2);
  expect(pair.sharedOpacityTransforms).toHaveLength(2);
  expect(pair.from.svg).toContain('data-foreground-track="exit"');
  delete p.foregroundMotion!.tracks[0].viewportFallback;
  expect(createProjectRenderer(p).framePair(.25).foregroundStatus?.supported).toBe(false);
 });
 it('uses the second known endpoint symmetrically for an entering subject',()=>{
  const p=project(),t=p.foregroundMotion!.tracks[0];t.viewportFallback='to';t.polygon=[[0,15],[40,15],[40,75],[0,75]];
  const pair=createProjectRenderer(p).framePair(.25);expect(pair.foregroundStatus?.supported).toBe(true);
  expect(pair.sharedOpacityTransforms!.find(x=>x.id.endsWith('-appearance'))!.opacity).toBeCloseTo(1-createMotionRuntime().appearanceWeight(.5,t.appearance!),12);
  expect(pair.sharedDefinitions).toContain('-from-transform-valid');expect(pair.sharedDefinitions).not.toContain('-to-transform-valid');
  t.viewportFallback='from';expect(createProjectRenderer(p).framePair(.25).foregroundStatus?.supported).toBe(false);
 });
 it('removes the validity feather continuously at the approaching endpoint',()=>{
  const p=project(),renderer=createProjectRenderer(p);
  const weights=[.01,.25,.5,.75,.99].map(a=>{
   const pair=renderer.framePair(a/2);expect(pair.foregroundStatus?.supported).toBe(true);
   return pair.sharedOpacityTransforms!.find(x=>x.id.endsWith('-valid-endpoint'))!.opacity;
  });
  expect(weights[0]).toBeLessThan(.001);expect(weights[4]).toBeGreaterThan(.999);
  expect(weights).toEqual([...weights].sort((a,b)=>a-b));
  const a=renderer.framePair(.1),b=renderer.framePair(.4);expect(a.sharedDefinitions).toBe(b.sharedDefinitions);
 });
 it('never permits a polygon outside the first endpoint or both endpoints',()=>{
  const p=project();p.foregroundMotion!.tracks[0].polygon=[[0,15],[100,15],[100,75],[0,75]];
  expect(createProjectRenderer(p).framePair(.25).foregroundStatus?.supported).toBe(false);
 });
 it('requires the supported fallback value and a common appearance layer',()=>{
  const p=project();delete p.foregroundMotion!.tracks[0].appearance;
  expect(()=>validateProject(p)).toThrow(/viewportFallback/);
  for(const value of ['both','off',true,null]){
   const q=project() as any;q.foregroundMotion.tracks[0].viewportFallback=value;
   expect(()=>validateProject(q)).toThrow(/viewportFallback/);
  }
 });
 it('preserves the exact observations, text-independent data and serialization',()=>{
  const p=project(),base={...p,foregroundMotion:undefined},runtime=createMotionRuntime();
  for(const time of [0,.5])expect(runtime.render(validateProject(p),time)).toBe(runtime.render(validateProject(base),time));
  expect(parseDocument(exportProjectJson(p))).toEqual(validateProject(p));
  const closed=(0,eval)(`(${createMotionRuntime.toString()})()`);
  expect(closed.framePair(validateProject(p),.25).sharedMatrixTransforms.map((x:any)=>x.matrix)).toEqual(runtime.framePair(validateProject(p),.25).sharedMatrixTransforms?.map(x=>x.matrix));
 });
});
