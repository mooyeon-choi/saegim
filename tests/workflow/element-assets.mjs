import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
import {unzipSync,strFromU8} from 'fflate';
import {fitSurfaceGradients} from '../../scripts/fit-surface-gradients.mjs';
import {sourceShots,validateRegions,exportElements} from '../../scripts/export-elements.mjs';
const meta={width:160,height:90,duration:2,temporal:{cuts:[1]},segments:[{start:0,end:.5},{start:.5,end:2}]};
const region=(id,start,end)=>({id,name:id,start,end,time:start,layers:[{id:'left',name:'Left <title>',path:'M0 0 H80 V90 H0 Z'},{id:'right',name:'Right',path:'M80 0 H160 V90 H80 Z'}]});
const annotations={schemaVersion:1,edgeOverlapPx:1.5,width:160,height:90,sections:[region('one',0,1),region('two',1,2)]};
test('source shots use cuts, not processing segments',()=>assert.deepEqual(sourceShots(meta).map(s=>[s.start,s.end]),[[0,1],[1,2]]));
test('annotations cannot cross cuts, overlap, leave gaps, inject markup or escape paths',()=>{
 for(const mutate of [a=>a.sections[0].end=1.1,a=>a.sections[1].start=1.01,a=>a.sections[1].time=2,a=>a.sections[0].layers[0].path='<script>',a=>a.sections[0].layers[0].id='../unsafe',a=>a.width=161,a=>a.edgeOverlapPx=-1,a=>a.sections[1].id='one']){const a=structuredClone(annotations);mutate(a);assert.throws(()=>validateRegions(a,meta));}
 assert.equal(validateRegions(annotations,meta).length,2);
});
test('actual export produces offline transparent vectors and navigable source cuts',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'element-assets-test-'));let browser;
 try{
  await build({entryPoints:['src/engine/index.ts'],outfile:path.join(tmp,'engine.mjs'),bundle:true,platform:'node',format:'esm'});const engine=await import(pathToFileURL(path.join(tmp,'engine.mjs')));
  const node={id:'shape',name:'shape',type:'rect',x:0,y:0,width:160,height:90,rotation:0,opacity:1,fill:'#ffff00',stroke:'none',strokeWidth:0,start:0,end:1,hidden:false,locked:false,keyframes:[],gradient:{type:'linear',x1:0,y1:0,x2:1,y2:1,stops:[{offset:0,color:'#ff0000'},{offset:1,color:'#0000ff'}]}};
  const base={schemaVersion:1,id:'fixture',name:'Fixture',width:160,height:90,duration:1,fps:12,background:'#000000',nodes:[node,{...node,id:'text',type:'text',name:'text',text:'Editable',fontFamily:'sans-serif',fontSize:12,x:2,y:10,width:65,height:20,gradient:undefined}],scenes:[{id:'scene',name:'scene',start:0,end:1}]};
  const first=await engine.encodeSegment({id:'s1',name:'First',start:0,end:1},base);
  const second=await engine.encodeSegment({id:'s2',name:'Second',start:1,end:2},{...base,id:'second'});
  const doc={schemaVersion:2,id:'doc',name:'Fixture <safe>',background:'#000000',width:160,height:90,duration:2,fps:12,segments:[first,second],temporal:{sampleFps:12,cuts:[1],mode:'off'}};
  await fs.writeFile(path.join(tmp,'project.json'),JSON.stringify(doc));await fs.writeFile(path.join(tmp,'regions.json'),JSON.stringify(annotations));
  const result=await exportElements({project:path.join(tmp,'project.json'),regions:path.join(tmp,'regions.json'),outDir:path.join(tmp,'out')});assert.equal(result.elements,4);assert.equal(result.shots,2);
  const files=unzipSync(await fs.readFile(path.join(tmp,'out/vector-elements.zip')));assert.equal(JSON.parse(strFromU8(files['manifest.json'])).sections.length,2);
  const asset=await fs.readFile(path.join(tmp,'out/cut-01/one/left.svg'),'utf8');assert.match(asset,/<text/);assert.match(asset,/<linearGradient/);assert.doesNotMatch(asset,/<(?:image|video|script|foreignObject)\b/);assert.match(asset,/Left &lt;title&gt;/);
  browser=await chromium.launch();const context=await browser.newContext({offline:true});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.goto(pathToFileURL(path.join(tmp,'out/index.html')).href);
  await page.getByRole('button',{name:'컷 2 · 1.00–2.00초',exact:true}).click();assert.equal(await page.locator('#section-name').textContent(),'two');await page.getByRole('button',{name:'전체 숨김',exact:true}).click();assert.equal(await page.locator('#stage img:not([hidden])').count(),0);await page.getByRole('button',{name:'선택 요소만',exact:true}).click();assert.equal(await page.locator('#stage img:not([hidden])').count(),1);
  await page.goto(pathToFileURL(path.join(tmp,'out/cut-01/one/left.svg')).href);assert.equal(await page.locator('svg').count(),1);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(tmp,{recursive:true,force:true});}
});

test('declared back surfaces fill occlusions below foreground, preserving undeclared holes and editable text',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'element-surfaces-test-'));let browser;
 try{
  const node={id:'blue',name:'Blue',type:'rect',x:0,y:0,width:160,height:90,rotation:0,opacity:1,fill:'#0000ff',stroke:'none',strokeWidth:0,start:0,end:1,hidden:false,locked:false,keyframes:[]};
  const project={schemaVersion:1,id:'test',name:'Test',width:160,height:90,duration:1,fps:12,background:'#00000000',nodes:[node,{...node,id:'front',x:60,y:25,width:40,height:40,fill:'#ff0000'},{...node,id:'caption',type:'text',text:'Edit me',x:2,y:4,width:50,height:18,fontSize:12}],scenes:[{id:'s',name:'s',start:0,end:1}]};
  const full='M0 0 H160 V90 H0 Z',hole=full+' M60 25 H100 V65 H60 Z';
  await fs.writeFile(path.join(tmp,'project.json'),JSON.stringify(project));
  browser=await chromium.launch();const page=await browser.newPage();
  const pixel=async(file,x,y)=>page.evaluate(async({svg,x,y})=>{const img=new Image();img.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg)));await img.decode();const c=document.createElement('canvas');c.width=160;c.height=90;c.getContext('2d').drawImage(img,0,0,160,90);return [...c.getContext('2d').getImageData(x,y,1,1).data]},{svg:await fs.readFile(file,'utf8'),x,y});
  for(const mode of ['underlay','replace']){
   const ann={schemaVersion:1,width:160,height:90,sections:[{id:'one',name:'One',start:0,end:1,time:0,layers:[{id:'front',name:'Front',path:'M60 25 H100 V65 H60 Z'},{id:'back',name:'Back',path:hole,surface:{mode,project:{...project,id:'surface',nodes:[node]}}}]}]};
   await fs.writeFile(path.join(tmp,'regions.json'),JSON.stringify(ann));const out=path.join(tmp,mode);await exportElements({project:path.join(tmp,'project.json'),regions:path.join(tmp,'regions.json'),outDir:out,smoothPx:1});
   assert.deepEqual(await pixel(path.join(out,'cut-01/one/back.svg'),80,45),[0,0,255,255]);
   assert.deepEqual(await pixel(path.join(out,'cut-01/one/stack.svg'),80,45),[255,0,0,255]);
   const svg=await fs.readFile(path.join(out,'cut-01/one/back.svg'),'utf8');if(mode==='underlay')assert.match(svg,/<text/);
   if(mode==='underlay'){
    const fitInput=structuredClone(ann);fitInput.sections[0].layers[1].surface.project.nodes[0].fill='#00ff00';const input=path.join(tmp,'fit-input.json');await fs.writeFile(input,JSON.stringify(fitInput));
    const fittedDir=path.join(tmp,'fitted');const stats=await fitSurfaceGradients({library:out,regions:input,outDir:fittedDir});assert.ok(stats.fitted>0);const fitted=JSON.parse(await fs.readFile(path.join(fittedDir,'regions.json')));for(const stop of fitted.sections[0].layers[1].surface.project.nodes[0].gradient.stops)assert.equal(stop.color,'#0000ff');
   }
   delete ann.sections[0].layers[1].surface;await fs.writeFile(path.join(tmp,'holes.json'),JSON.stringify(ann));
  }
  const raw=path.join(tmp,'raw');await exportElements({project:path.join(tmp,'project.json'),regions:path.join(tmp,'holes.json'),outDir:raw,smoothPx:1});
  assert.equal((await pixel(path.join(raw,'cut-01/one/back.svg'),80,45))[3],0);
 }finally{await browser?.close();await fs.rm(tmp,{recursive:true,force:true});}
});
