import { describe, expect, it } from 'vitest';
import type { MotionProject, MotionNode } from '../../src/types';
import { createProjectRenderer, validateProject, exportProjectJson, parseDocument, createCompositionPlayer, encodeSegment } from '../../src/engine';
import { createMotionRuntime } from '../../src/engine/runtime';
const runtime = createMotionRuntime();
function fixture(): MotionProject {
 const shape: MotionNode = {id:'eye',name:'eye',type:'ellipse',x:25,y:25,width:30,height:20,rotation:0,opacity:1,fill:'#000000',stroke:'none',strokeWidth:0,start:0,end:1,hidden:false,locked:false,keyframes:[{time:0,x:0,y:0,scaleX:1,scaleY:1,rotation:0,opacity:1},{time:.5,x:20,y:0,scaleX:1,scaleY:.3,rotation:0,opacity:1}]};
 return {schemaVersion:1,id:'detail',name:'detail',width:120,height:100,duration:1,fps:2,background:'#eeeeee',scenes:[],nodes:[shape,{...shape,id:'text',type:'text',x:10,y:75,width:90,height:20,text:'EDIT',fontSize:15,keyframes:[],occlusionPath:'M0 0 L10 0 L10 10 Z'}],temporal:{mode:'blend',sampleFps:2,cuts:[]},foregroundMotion:{mode:'on',tracks:[{id:'local-eye',start:0,end:.5,polygon:[[20,20],[100,20],[100,65],[20,65]],featherPx:0,forward:[1,0,0,1,20,0],appearance:{midpoint:.25,sharpness:2}}]}};
}
describe('continuous local appearance weighting',()=>{
 it('is continuous, monotone and endpoint-preserving with its declared midpoint',()=>{
  for(const midpoint of [.15,.25,.5,.75,.85])for(const sharpness of [1,2,4]) {
   const curve={midpoint,sharpness};
   expect(runtime.appearanceWeight(0,curve)).toBe(0);expect(runtime.appearanceWeight(1,curve)).toBe(1);
   expect(runtime.appearanceWeight(midpoint,curve)).toBeCloseTo(.5,14);
   const values=Array.from({length:1001},(_,i)=>runtime.appearanceWeight(i/1000,curve));
   for(let i=1;i<values.length;i++)expect(values[i]).toBeGreaterThanOrEqual(values[i-1]);
   expect(runtime.appearanceWeight(.5+1e-7,curve)-runtime.appearanceWeight(.5-1e-7,curve)).toBeLessThan(3e-6);
  }
 });
 it('uses one common local patch in both observations while retaining geometric alpha',()=>{
  const pair=createProjectRenderer(fixture()).framePair(.25);
  expect(pair.mix).toBe(.5);expect(pair.sharedOpacityTransforms).toHaveLength(1);
  expect(pair.sharedOpacityTransforms![0].opacity).toBeCloseTo(.9,14);
  expect(pair.sharedMatrixTransforms!.map(t=>t.matrix)).toEqual([[1,0,0,1,10,0],[1,0,0,1,-10,0]]);
  const href=pair.from.svg.match(/<use href="([^"]+-common)" data-foreground-track=/)![1];
  expect(pair.to!.svg).toContain(`href="${href}"`);
  expect(pair.sharedDefinitions!.match(/-common"/g)).toHaveLength(1);
  expect(pair.sharedDefinitions!.match(/fill="#eeeeee"/g)).toHaveLength(2);
  expect(pair.sharedDefinitions).not.toContain('data-node-id=');
  expect(pair.from.svg.indexOf('data-foreground-track=')).toBeLessThan(pair.from.svg.indexOf('data-node-id="text"'));
  expect(pair.from.svg).toContain('-occlusion');
 });
 it('keeps original observation pixels/serialization paths and cache reuse compatible',()=>{
  const p=fixture(),baseline=structuredClone(p);delete baseline.foregroundMotion;
  for(const time of [0,.5])expect(runtime.render(validateProject(p),time)).toBe(runtime.render(validateProject(baseline),time));
  const renderer=createProjectRenderer(p),a=renderer.framePair(.125),b=renderer.framePair(.25);
  expect(a.from).toBe(b.from);expect(a.to).toBe(b.to);expect(a.sharedDefinitions).toBe(b.sharedDefinitions);
  expect(a.sharedOpacityTransforms![0].opacity).toBe(.5);expect(b.sharedOpacityTransforms![0].opacity).toBeCloseTo(.9,14);
  const legacy=fixture();delete legacy.foregroundMotion!.tracks[0].appearance;
  expect(createProjectRenderer(legacy).framePair(.25).sharedOpacityTransforms).toEqual([]);
  expect(parseDocument(exportProjectJson(p))).toEqual(validateProject(p));
 });
 it('retains earlier model priority then applies smaller suffix patches without recursive warping',()=>{
  const p=fixture(),small=p.foregroundMotion!.tracks[0];
  p.foregroundMotion!.tracks=[{...small,id:'macro',appearance:undefined},small];
  const pair=createProjectRenderer(p).framePair(.25);
  expect(pair.from.svg.indexOf('data-foreground-track="macro"')).toBeLessThan(pair.from.svg.indexOf('data-foreground-track="local-eye"'));
  expect(pair.from.svg.match(/data-node-id="eye"/g)).toHaveLength(1);
  expect(pair.sharedDefinitions).not.toContain('data-foreground-track=');
  expect(pair.foregroundStatus!.activeTrackIds).toEqual(['macro','local-eye']);
 });
 it('validates appearance bounds, 16 simultaneous patches, opaque frames, and cuts',()=>{
  for(const appearance of [{midpoint:0,sharpness:1},{midpoint:.5,sharpness:0},{midpoint:.5,sharpness:4.01},{midpoint:NaN,sharpness:2}]) {
   const p=fixture();p.foregroundMotion!.tracks[0].appearance=appearance;expect(()=>validateProject(p)).toThrow(/appearance/);
  }
  const p=fixture();p.foregroundMotion!.tracks=Array.from({length:16},(_,i)=>({...p.foregroundMotion!.tracks[0],id:String(i)}));
  expect(validateProject(p).foregroundMotion!.tracks).toHaveLength(16);
  p.foregroundMotion!.tracks.push({...p.foregroundMotion!.tracks[0],id:'seventeen'});expect(()=>validateProject(p)).toThrow(/16/);
  const transparent=fixture();transparent.background='none';expect(()=>validateProject(transparent)).toThrow();
  const cut=fixture();cut.temporal!.cuts=[.5];expect(()=>validateProject(cut)).toThrow(/컷/);
 });
 it('runs identically in the closed exported runtime and across composition storage boundaries',async()=>{
  const p=validateProject(fixture()),closed=(0,eval)(`(${createMotionRuntime.toString()})()`) as ReturnType<typeof createMotionRuntime>;
  for(const time of [.01,.125,.25,.49])expect(closed.framePair(p,time).sharedOpacityTransforms!.map(v=>v.opacity)).toEqual(runtime.framePair(p,time).sharedOpacityTransforms!.map(v=>v.opacity));
  const child=fixture();delete child.foregroundMotion;
  const segments=await Promise.all([0,1].map(i=>encodeSegment({id:String(i),name:String(i),start:i,end:i+1},child)));
  const model=fixture().foregroundMotion!;model.tracks[0].start=.5;model.tracks[0].end=1;
  const player=createCompositionPlayer({schemaVersion:2,id:'book',name:'book',width:120,height:100,duration:2,fps:2,background:'#eeeeee',segments,temporal:{mode:'blend',sampleFps:2,cuts:[]},foregroundMotion:model});
  const pair=(await player.framePair(.75))!;expect(pair.sharedOpacityTransforms![0].opacity).toBeCloseTo(.9,14);expect(player.cachedSegmentIds.length).toBeLessThanOrEqual(2);player.dispose();
 });
});
