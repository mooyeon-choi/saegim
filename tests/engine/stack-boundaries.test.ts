import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { MotionKeyframe, MotionNode, MotionProject } from '../../src/types';
import { evaluateNode, exportProjectJson, parseDocument, renderSvg, validateProject } from '../../src/engine';
import { createMotionRuntime } from '../../src/engine/runtime';
import { createProjectValidator } from '../../src/engine/validate';

const path = 'M0 0 L1000 0 L1000 1000 L0 1000 Z';
const key = (time: number, extra: Partial<MotionKeyframe> = {}): MotionKeyframe => ({ time, x:0,y:0,scaleX:1,scaleY:1,rotation:0,opacity:1,...extra });
const node = (extra: Partial<MotionNode> = {}): MotionNode => ({ id:'shape',name:'shape',type:'path',path,x:10,y:10,width:80,height:80,rotation:0,opacity:1,fill:'#ff0000',stroke:'none',strokeWidth:0,start:0,end:2,hidden:false,locked:false,keyframes:[],...extra });
const project = (nodes = [node()]): MotionProject => ({schemaVersion:1,id:'stack',name:'stack',width:100,height:100,duration:2,fps:2,background:'#ffffff',scenes:[],nodes});
const gradient = { type:'linear' as const,x1:0,y1:0,x2:1,y2:0,stops:[{offset:0,color:'#000000'},{offset:1,color:'#ffffff'}] };

describe('selective stack boundary contract', () => {
  it('holds opt-in observations, clears with null and leaves omitted options byte-identical', () => {
    const p=project(), original=renderSvg(p,.25); p.nodes[0].keyframes=[key(0,{stackBoundary:null})];
    const without=structuredClone(p); delete without.nodes[0].keyframes[0].stackBoundary;
    expect(renderSvg(p,.25)).toBe(renderSvg(without,.25)); expect(renderSvg(p,.25)).toBe(original);
    const n=node({stackBoundary:{featherPx:0},keyframes:[key(0,{stackBoundary:{featherPx:1,cornerRadiusPx:2}}),key(.5,{stackBoundary:null}),key(1)]});
    expect(evaluateNode(n,.499).stackBoundary).toEqual({featherPx:1,cornerRadiusPx:2}); expect(evaluateNode(n,.5).stackBoundary).toBeUndefined(); expect(evaluateNode(n,1).stackBoundary).toEqual({featherPx:0});
  });
  it('preserves serializable options and self-contained offline renderer and validator', () => {
    const p=project([node({stackBoundary:{featherPx:.2,cornerRadiusPx:2},paintRegions:[{path,fill:'#00ff00',featherPx:.6}]})]), safe=validateProject(p);
    expect(parseDocument(exportProjectJson(p))).toEqual(safe);
    const runtime=(0,eval)(`(${createMotionRuntime.toString()})()`), validator=(0,eval)(`(${createProjectValidator.toString()})()`);
    expect(validator.validateProject(p)).toEqual(safe); expect(runtime.render(safe,.25)).toBe(createMotionRuntime().render(safe,.25));
    p.nodes[0].stackBoundary!.featherPx=2; expect(safe.nodes[0].stackBoundary!.featherPx).toBe(.2);
  });
  it('rejects inactive feathers, invalid ranges, text/line and nonopaque effective base paints', () => {
    const check=(n:MotionNode)=>expect(()=>validateProject(project([n]))).toThrow();
    check(node({paintRegions:[{path,fill:'#fff',featherPx:0}]}));
    for(const featherPx of [-1,9,Infinity,NaN]) check(node({stackBoundary:{featherPx}}));
    check(node({stackBoundary:{featherPx:0,cornerRadiusPx:4.1}}));
    for(const type of ['text','line'] as const) check(node({type,stackBoundary:{featherPx:0}}));
    for(const fill of ['#fff8','#ffffff80','rgba(1,2,3,.5)','rgb(1 2 3 / 20%)','transparent','none']) check(node({fill,stackBoundary:{featherPx:0}}));
    check(node({stackBoundary:{featherPx:0},gradient:{...gradient,stops:[{offset:0,color:'#0000'},{offset:1,color:'#ffff'}]}}));
    check(node({stackBoundary:{featherPx:0},gradient,keyframes:[key(0),key(1,{stackBoundary:null,gradient:{...gradient,stops:[{offset:0,color:'#0000'},{offset:1,color:'#ffff'}]}})]}));
    check(node({paintRegions:[{path,fill:'#fff',featherPx:1}],keyframes:[key(0,{stackBoundary:{featherPx:0}}),key(1,{stackBoundary:null})]}));
    for(const fill of ['#ffff','#ffffffff','rgba(1,2,3,1)','rgb(1 2 3 / 100%)']) expect(()=>validateProject(project([node({fill,opacity:.25,stackBoundary:{featherPx:0}})]))).not.toThrow();
    expect(()=>validateProject(project([node({fill:'none',gradient,stackBoundary:{featherPx:0}})]))).not.toThrow();
  });
  it('round-trips transparent internal lighting while requiring an opaque base at every observation', () => {
    const lighting={...gradient,stops:[{offset:0,color:'#ffffff80'},{offset:1,color:'#ffffff00'}]};
    const p=project([node({stackBoundary:{featherPx:0},paintRegions:[{path,fill:'#00000040'}],keyframes:[key(0,{paintRegions:[{path,fill:'none',gradient:lighting}]}),key(.5,{paintRegions:[{path,fill:'transparent'}]})]})]);
    const safe=validateProject(p);
    expect(parseDocument(exportProjectJson(p))).toEqual(safe);
    const validator=(0,eval)(`(${createProjectValidator.toString()})()`);
    expect(validator.validateProject(p)).toEqual(safe);
    const runtime=(0,eval)(`(${createMotionRuntime.toString()})()`);
    expect(runtime.render(safe,.25)).toBe(createMotionRuntime().render(safe,.25));
    expect(evaluateNode(safe.nodes[0],.499).paintRegions![0].gradient).toEqual(lighting);
    expect(evaluateNode(safe.nodes[0],.5).paintRegions![0].fill).toBe('transparent');
    p.nodes[0].keyframes[1].fill='#ff000080';
    expect(()=>validateProject(p)).toThrow(/기본 채색/);
  });
  it('rounds closed relative/multi-ring polygon corners without rewriting stored paths or complex curves', () => {
    const n=node({path:'m0 0 l1000 0 0 1000 -1000 0 z m250 250 l0 500 500 0 0 -500 z',stackBoundary:{featherPx:0,cornerRadiusPx:2}});
    const original=n.path, svg=renderSvg(project([n]),.25), contour=svg.match(/id="[^"]*-stack-contour" d="([^"]+)"/)![1];
    expect(contour.match(/ Q/g)).toHaveLength(8); expect(contour.match(/ Z/g)).toHaveLength(2); expect(n.path).toBe(original); expect(svg).toContain(`d="${original}"`);
    for(const complex of ['M0 0 Q500 0 1000 1000 Z','M0 0 L1000 0 L1000 1000','M0 0 H1000 V1000 Z']) {
      n.path=complex; const s=renderSvg(project([n]),0); expect(s.match(/id="[^"]*-stack-contour" d="([^"]+)"/)![1]).toBe(complex);
    }
  });
});

let browser:Browser,page:Page;
beforeAll(async()=>{browser=await chromium.launch({headless:true});page=await browser.newPage();});
afterAll(async()=>{await browser?.close();});
async function pixels(p:MotionProject, scale=2, time=.25) {
  const svg=renderSvg(validateProject(p),time);
  return page.evaluate(async({svg,scale})=>{const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await image.decode();const canvas=document.createElement('canvas');canvas.width=100*scale;canvas.height=100*scale;const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0,canvas.width,canvas.height);return Array.from(ctx.getImageData(0,0,canvas.width,canvas.height).data);},{svg,scale});
}
const sample=(p:number[],x:number,y:number,scale=2)=>p.slice((Math.floor(y*scale)*100*scale+Math.floor(x*scale))*4,(Math.floor(y*scale)*100*scale+Math.floor(x*scale))*4+4);
function close(a:number[],b:number[],tolerance=1){expect(Math.max(...a.map((n,i)=>Math.abs(n-b[i])))).toBeLessThanOrEqual(tolerance);}

// Pixel readback uses a real browser; allow slower CI hosts without weakening pixel assertions.
describe('browser pixels: stack coverage and painter order',()=>{
  it('applies silhouette alpha and partial node opacity once even under a full overlay',async()=>{
    const n=node({type:'ellipse',x:10.2,y:10.2,width:79.5,height:79.5,fill:'#00ff00',opacity:.45});const expected=await pixels(project([n]));
    n.fill='#ff0000';n.stackBoundary={featherPx:0};n.paintRegions=[{path:'M-1000 -1000 L2000 -1000 L2000 2000 L-1000 2000 Z',fill:'#00ff00'}];
    const actual=await pixels(project([n]));expect(actual.reduce((max,v,i)=>Math.max(max,Math.abs(v-expected[i])),0)).toBeLessThanOrEqual(2);
  }, 30_000);
  it('keeps original offset/nonuniform geometry gradient bbox and gradient on overlays',async()=>{
    const n=node({width:80,height:40,path:'M100 -200 L900 -200 L900 1200 L100 1200 Z',gradient}); const expected=await pixels(project([n]));
    n.stackBoundary={featherPx:0,cornerRadiusPx:2};n.paintRegions=[{path:'M500 -1000 L2000 -1000 L2000 2000 L500 2000 Z',fill:'#ff00ff',gradient}];
    const actual=await pixels(project([n]));for(const x of [19,25,45,51,65,80]) close(sample(actual,x,30),sample(expected,x,30));
  }, 30_000);
  it('keeps later paints and foreground eye nodes in front, with even-odd holes',async()=>{
    const n=node({stackBoundary:{featherPx:0},paintRegions:[{path,fill:'#00ff00'},{path:path+' M250 250 L750 250 L750 750 L250 750 Z',fill:'#0000ff'}]});
    const eye=node({id:'eye',type:'ellipse',x:47,y:47,width:6,height:6,fill:'#000000'}), actual=await pixels(project([n,eye]));
    close(sample(actual,20,20),[0,0,255,255]);close(sample(actual,40,40),[0,255,0,255]);close(sample(actual,50,50),[0,0,0,255]);
  }, 30_000);
  it('softens only a local alpha boundary, keeps far RGB unchanged and does not create outside halos',async()=>{
    const n=node({stackBoundary:{featherPx:0},paintRegions:[{path:'M500 0 L1000 0 L1000 1000 L500 1000 Z',fill:'#0000ff',featherPx:2}]});
    const actual=await pixels(project([n]),4);
    close(sample(actual,40,50,4),[255,0,0,255]);close(sample(actual,60,50,4),[0,0,255,255]);
    const edge=sample(actual,50,50,4);expect(edge[0]).toBeGreaterThan(20);expect(edge[2]).toBeGreaterThan(20);expect(edge[1]).toBe(0);
    n.stackBoundary!.featherPx=2;const inward=await pixels(project([n]),4);
    close(sample(inward,9.5,50,4),[255,255,255,255]);close(sample(inward,30,50,4),[255,0,0,255]);expect(sample(inward,10.25,50,4)[1]).toBeGreaterThan(20);
  }, 30_000);
  it('composites translucent lighting once over the opaque base without holes or an overbright border',async()=>{
    const n=node({stackBoundary:{featherPx:0},paintRegions:[{path,fill:'#ffffff80'}]});
    const p=project([n]);p.background='#0000ff';const actual=await pixels(p,4);
    for(const x of [10.5,11,20,50,89]) close(sample(actual,x,50,4),[255,128,128,255],2);
    close(sample(actual,9.5,50,4),[0,0,255,255]);
  }, 30_000);
  it('renders white-to-transparent lighting over the base and holds complete frame observations',async()=>{
    const light={...gradient,stops:[{offset:0,color:'#ffffffff'},{offset:1,color:'#ffffff00'}]};
    const n=node({stackBoundary:{featherPx:0},keyframes:[key(0,{paintRegions:[{path,fill:'none',gradient:light}]}),key(.5,{paintRegions:[{path,fill:'rgba(0,0,0,0.5)'}]})]});
    const p=project([n]);p.background='#0000ff';p.temporal={mode:'frames',sampleFps:2,cuts:[]};
    const first=await pixels(p,1,0), held=await pixels(p,1,.49), next=await pixels(p,1,.5);
    expect(held).toEqual(first);
    for(const x of [11,30,50,70,88]) {
      const shade=Math.round(255*(1-(x+.5-10)/80));
      close(sample(first,x,50,1),[255,shade,shade,255],2);
      close(sample(next,x,50,1),[127,0,0,255],2);
    }
    close(sample(next,9,50,1),[0,0,255,255]);
    const restored=parseDocument(exportProjectJson(p)) as MotionProject;
    expect(await pixels(restored,1,.49)).toEqual(first);
  }, 30_000);
  it('rounds selected corners with bounded displacement while retaining a small central hole',async()=>{
    const n=node({path:path+' M400 400 L400 600 L600 600 L600 400 Z',stackBoundary:{featherPx:0,cornerRadiusPx:4}}), actual=await pixels(project([n]),4);
    close(sample(actual,10,10,4),[255,255,255,255]);close(sample(actual,15,15,4),[255,0,0,255]);close(sample(actual,50,50,4),[255,255,255,255]);
    close(sample(actual,8,50,4),[255,255,255,255]);close(sample(actual,90.5,50,4),[255,255,255,255]);
  }, 30_000);
});

describe('stack masks instanced by affine foreground patches',()=>{
  it('shares one hidden legacy vector source without changing visible nodes or source data',()=>{
    const n=node({opacity:.6,stackBoundary:{featherPx:0,cornerRadiusPx:2},paintRegions:[{path,fill:'#00ff00',featherPx:.35}],keyframes:[key(0),key(.5,{x:5})]});
    const p=project([n]);p.temporal={mode:'blend',sampleFps:2,cuts:[]};
    p.foregroundMotion={mode:'on',tracks:Array.from({length:3},(_,i)=>({id:`limb-${i}`,start:0,end:.5,polygon:[[20,20],[80,20],[80,80],[20,80]],featherPx:2,forward:[1,0,0,1,5,0]}))};
    const original=JSON.stringify(p), runtime=createMotionRuntime(), pair=runtime.framePair(p,.25), svg=pair.from.svg;
    expect(svg.match(/id="[^"]*-foreground-source"/g)).toHaveLength(1);
    expect(svg.match(/ data-node-id=/g)).toHaveLength(1);
    expect(svg.match(/ data-foreground-node-id=/g)).toHaveLength(1);
    expect(svg).toContain('-n0-stack-alpha');expect(svg).toContain('-fg-n0-paint-base-coverage');
    expect(svg).not.toContain('-fg-n0-stack-alpha');
    const ids=[...svg.matchAll(/ id="([^"]+)"/g)].map(m=>m[1]);expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(p)).toBe(original);
    expect(runtime.framePair(p,0).from.svg).not.toContain('data-foreground-node-id');
    const inactive=structuredClone(p);inactive.nodes[0].keyframes=[key(0,{stackBoundary:null}),key(.5,{stackBoundary:null})];
    expect(createMotionRuntime().framePair(inactive,.25).from.svg).not.toContain('data-foreground-node-id');
    const noPatch=structuredClone(p);noPatch.foregroundMotion!.mode='off';
    expect(createMotionRuntime().framePair(noPatch,.25).from.svg).not.toContain('data-foreground-node-id');
    const ordinary=structuredClone(p);delete ordinary.nodes[0].stackBoundary;delete ordinary.nodes[0].paintRegions![0].featherPx;
    expect(createMotionRuntime().framePair(ordinary,.25).from.svg).not.toContain('data-foreground-node-id');
  });
  it('keeps aligned paint and eye pixels stable across cross-SVG source reuse and seek histories',async()=>{
    const n=node({type:'ellipse',x:25,y:25,width:30,height:30,fill:'#ff5500',opacity:.8,keyframes:[key(0),key(.5,{x:20}),key(1),key(1.5,{x:20})]});
    const eye=node({id:'eye',type:'ellipse',x:36,y:34,width:8,height:8,fill:'#000000',keyframes:structuredClone(n.keyframes)});
    const p=project([n,eye]);p.temporal={mode:'blend',sampleFps:2,cuts:[]};
    p.foregroundMotion={mode:'on',tracks:Array.from({length:4},(_,i)=>({id:`limb-${i}`,start:0,end:.5,polygon:[[20,10],[90,10],[90,90],[20,90]],featherPx:2,forward:[1,0,0,1,20,0]}))};
    const runtimeSource=createMotionRuntime.toString();
    await page.setViewportSize({width:100,height:100});
    const init=async(stack:boolean)=>{
      await page.setContent('<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#stage{width:100px;height:100px}#stage svg{display:block;width:100%;height:100%}</style><div id="stage"></div>');
      const value=structuredClone(p);if(stack)for(const item of value.nodes)item.stackBoundary={featherPx:0};
      await page.evaluate(({source,project})=>{const rt=(0,eval)(`(${source})()`);const apply=rt.createStageRenderer(document.getElementById('stage'));(window as any).__seek=(time:number)=>apply(rt.framePair(project,time));},{source:runtimeSource,project:validateProject(value)});
    };
    const capture=async(t:number)=>{
      await page.evaluate(t=>(window as any).__seek(t),t);const png=(await page.screenshot()).toString('base64');
      return page.evaluate(async png=>{const im=new Image();im.src='data:image/png;base64,'+png;await im.decode();const c=document.createElement('canvas');c.width=c.height=100;const ctx=c.getContext('2d')!;ctx.drawImage(im,0,0);return Array.from(ctx.getImageData(0,0,100,100).data);},png);
    };
    await init(false);const baseline=await capture(.25);
    await init(true);const fresh=await capture(.25);
    expect(fresh.reduce((max,v,i)=>Math.max(max,Math.abs(v-baseline[i])),0)).toBeLessThanOrEqual(2);
    // Assert the intended aligned center rather than accepting two equally
    // broken temporal blends as the reference.
    expect(sample(fresh,50,38,1)[0]).toBeLessThan(2);expect(sample(fresh,29,38,1)[0]).toBe(255);
    const masks=await page.locator('[id$="-stack-alpha"]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('maskUnits')));
    expect(masks.length).toBeGreaterThan(0);expect(masks.every(v=>v==='userSpaceOnUse')).toBe(true);
    const hidden=await page.locator('[id$="-foreground-source"]').evaluateAll(nodes=>nodes.map(n=>({parent:n.parentElement?.tagName,stackMasks:n.querySelectorAll('[id$="-stack-alpha"]').length,logical:n.querySelectorAll('[data-node-id]').length,sourceNodes:n.querySelectorAll('[data-foreground-node-id]').length})));
    expect(hidden.length).toBe(2);expect(hidden.every(n=>n.parent==='defs'&&n.stackMasks===0&&n.logical===0&&n.sourceNodes===2)).toBe(true);
    for(const prior of [1.25,0,.5]){await capture(prior);const again=await capture(.25);expect(again.reduce((max,v,i)=>Math.max(max,Math.abs(v-fresh[i])),0)).toBeLessThanOrEqual(2);}
  }, 30_000);
});
