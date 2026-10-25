import { describe, expect, it } from 'vitest';
import type { ForegroundMotionTrack, MotionComposition, MotionNode, MotionProject } from '../../src/types';
import { createProjectRenderer, createCompositionPlayer, encodeSegment, exportHtml, exportProjectJson, parseDocument, validateProject } from '../../src/engine';
import { createMotionRuntime } from '../../src/engine/runtime';
const node = (id: string, type: MotionNode['type'] = 'ellipse'): MotionNode => ({ id, name: id, type, x: 30, y: 30, width: 10, height: 10, rotation: 0, opacity: 1, fill: '#111111', stroke: 'none', strokeWidth: 0, start: 0, end: 1, hidden: false, locked: false, keyframes: [] });
const track = (): ForegroundMotionTrack => ({ id: 'eye', start: 0, end: .5, polygon: [[20, 20], [80, 20], [80, 60], [20, 60]], featherPx: 4, forward: [1, 0, 0, 1, 20, 0], label: 'Eye translation' });
function project(): MotionProject {
 const eye = node('eye-source'); eye.keyframes = [0,.5,1].map(t=>({time:t,x:t===0?0:20,y:0,scaleX:1,scaleY:1,rotation:0,opacity:1,easing:'linear'}));
 return { schemaVersion:1,id:'eye',name:'eye',width:100,height:100,duration:1,fps:2,background:'#ffffff',scenes:[],nodes:[eye,{...node('title','text'),x:5,y:80,text:'EDIT',fontSize:10,occlusionPath:'M0 0 L50 0 L50 100 L0 100 Z'},node('above-title','rect')],temporal:{mode:'blend',sampleFps:2,cuts:[]},foregroundMotion:{mode:'on',tracks:[track()]} };
}
const runtime=createMotionRuntime();
describe('local foreground endpoint alignment',()=>{
 it('aligns both observations at the same middle pose with one source group per endpoint',()=>{
  const renderer=createProjectRenderer(project()), pair=renderer.framePair(.25);
  expect(pair.foregroundStatus).toEqual({mode:'on',activeTrackIds:['eye'],supported:true});
  expect(pair.sharedMatrixTransforms!.map(t=>t.matrix)).toEqual([[1,0,0,1,10,0],[1,0,0,1,-10,0]]);
  expect(pair.from.svg.match(/data-node-id="eye-source"/g)).toHaveLength(1);
  expect(pair.to!.svg.match(/data-node-id="eye-source"/g)).toHaveLength(1);
  expect(pair.sharedDefinitions).toContain('-foreground-source');
  expect(pair.sharedDefinitions).not.toContain('data-node-id=');
  expect(pair.from.svg.indexOf('data-foreground-track=')).toBeLessThan(pair.from.svg.indexOf('data-node-id="title"'));
  expect(pair.from.svg.indexOf('data-node-id="title"')).toBeLessThan(pair.from.svg.indexOf('data-node-id="above-title"'));
  expect(pair.from.svg).toContain('-occlusion');
 });
 it('preserves exact observations and keeps supported status at an interval start',()=>{
  const p=project(), baseline={...p,foregroundMotion:undefined};
  for(const time of [0,.5])expect(runtime.render(validateProject(p),time)).toBe(runtime.render(validateProject(baseline),time));
  const pair=runtime.framePair(validateProject(p),0);expect(pair.foregroundStatus!.supported).toBe(true);expect(pair.sharedMatrixTransforms).toEqual([]);expect(pair.from.svg).not.toContain('data-foreground-track=');
 });
 it('reuses endpoint markup and definitions while changing only transform matrices',()=>{
  const p=project(),renderer=createProjectRenderer(p),a=renderer.framePair(.1),b=renderer.framePair(.2);
  expect(a.from).toBe(b.from);expect(a.to).toBe(b.to);expect(a.sharedDefinitions).toBe(b.sharedDefinitions);
  expect(a.sharedMatrixTransforms![0].matrix[4]).toBe(4);expect(b.sharedMatrixTransforms![0].matrix[4]).toBe(8);
  p.foregroundMotion!.tracks[0].forward[4]=999;expect(renderer.framePair(.2).sharedMatrixTransforms![0].matrix[4]).toBe(8);
 });
 it('leaves background formulas above aligned patches and onion ghosts out of source clones',()=>{
  const p=project();p.backgroundMotion={mode:'on',tracks:[{id:'background',start:0,end:1,anchorTime:0,polygon:[[2,2],[15,2],[15,15],[2,15]],featherPx:0,interpolation:'linear',keys:[{time:0,matrix:[1,0,0,1,0,0]},{time:1,matrix:[1,0,0,1,0,0]}],anchor:{background:'#ffff00',nodes:[]}}]};
  const pair=createProjectRenderer(p).framePair(.25,{onionTimes:[0]});
  expect(pair.from.svg.indexOf('data-foreground-track=')).toBeLessThan(pair.from.svg.indexOf('data-background-track='));
  const source=pair.from.svg.indexOf('-foreground-source');expect(pair.from.svg.indexOf('opacity="0.16"')).toBeLessThan(source);
  expect(pair.sharedDefinitions).not.toContain('opacity="0.16"');expect(pair.sharedTransforms).toHaveLength(1);
 });
 it('falls back when disabled, outside the matching pair, at cuts, or outside observed source bounds',()=>{
  const p=project();p.foregroundMotion!.mode='off';expect(createProjectRenderer(p).framePair(.25).sharedMatrixTransforms).toEqual([]);
  p.foregroundMotion!.mode='on';expect(createProjectRenderer(p).framePair(.75).foregroundStatus!.supported).toBe(false);
  p.foregroundMotion!.tracks[0].polygon=[[0,0],[20,0],[20,20],[0,20]];expect(createProjectRenderer(p).framePair(.25).foregroundStatus!.supported).toBe(false);
  const q=project();q.temporal!.cuts=[.5];expect(()=>validateProject(q)).toThrow(/컷/);
 });
 it('rejects non-adjacent/cut/folded/oversized inputs and retains serialization',()=>{
  const invalid=(f:(p:MotionProject)=>void,pattern?:RegExp)=>{const p=project();f(p);expect(()=>validateProject(p)).toThrow(pattern);};
  invalid(p=>{p.foregroundMotion!.tracks[0].end=.4;},/인접/);
  invalid(p=>{p.foregroundMotion!.tracks[0].forward=[-1,0,0,-1,0,0];},/중간/);
  invalid(p=>{p.foregroundMotion!.tracks[0].forward[0]=Infinity;});
  invalid(p=>{p.foregroundMotion!.tracks[0].polygon=[[0,0],[50,50],[0,50],[50,0]];},/ROI/);
  invalid(p=>{p.foregroundMotion!.tracks=Array.from({length:12289},(_,i)=>({...track(),id:String(i)}));},/12288/);
  invalid(p=>{p.foregroundMotion!.tracks=Array.from({length:17},(_,i)=>({...track(),id:String(i)}));},/동시에/);
  expect(parseDocument(exportProjectJson(project()))).toEqual(validateProject(project()));
  expect(exportHtml(project())).toContain('foregroundFrame');
 });
 it('works across storage boundaries, keeps edits and a two-child cache',async()=>{
  const a=project(),b=project();delete a.foregroundMotion;delete b.foregroundMotion;b.nodes[0].x=70;b.nodes[1].text='NEXT';
  const segments=await Promise.all([a,b].map((p,i)=>encodeSegment({id:String(i),name:String(i),start:i,end:i+1},p)));
  const fg=track();fg.start=.5;fg.end=1;const doc:MotionComposition={schemaVersion:2,id:'book',name:'book',width:100,height:100,duration:2,fps:2,background:'#fff',segments,temporal:{mode:'blend',sampleFps:2,cuts:[]},foregroundMotion:{mode:'on',tracks:[fg]}};
  const player=createCompositionPlayer(doc),pair=(await player.framePair(.75))!;expect(pair.foregroundStatus!.supported).toBe(true);expect(pair.to!.svg).toContain('NEXT');expect(pair.sharedMatrixTransforms).toHaveLength(2);
  b.nodes[1].text='CHANGED';player.setProjectOverride('1',b);expect((await player.framePair(.75))!.to!.svg).toContain('CHANGED');
  expect(player.cachedSegmentIds.length).toBeLessThanOrEqual(2);expect(parseDocument(exportProjectJson(doc)).foregroundMotion).toEqual(doc.foregroundMotion);player.dispose();
 });
 it('uses the same closed runtime in offline exports',()=>{
  const closed=(0,eval)(`(${createMotionRuntime.toString()})()`) as ReturnType<typeof createMotionRuntime>,p=validateProject(project());
  for(const t of [0,.125,.25,.499,.5])expect(closed.framePair(p,t).sharedMatrixTransforms?.map(v=>v.matrix)).toEqual(runtime.framePair(p,t).sharedMatrixTransforms?.map(v=>v.matrix));
 });
});
