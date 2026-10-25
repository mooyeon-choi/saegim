import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import{fileURLToPath,pathToFileURL}from'node:url';import{parseArgs}from'node:util';import{build}from'esbuild';import{chromium}from'@playwright/test';import{createGradientFitter}from'./lib/gradient-fit.mjs';import{validateRegions}from'./export-elements.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function fitSurfaceGradients({library,regions,outDir,overwrite=false}){
 const out=path.resolve(outDir),lib=path.resolve(library),m=JSON.parse(await fs.readFile(path.join(lib,'manifest.json'))),ann=JSON.parse(await fs.readFile(regions));
 validateRegions(ann,{...m,temporal:{cuts:m.shots.slice(1).map(s=>s.start)}});
 if(!overwrite&&await fs.stat(path.join(out,'regions.json')).catch(()=>false))throw Error('Output exists; use another folder or --overwrite.');
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'surface-gradient-'));let browser;
 const reports=[];try{
  await build({entryPoints:[path.join(root,'src/engine/index.ts')],outfile:path.join(tmp,'engine.mjs'),bundle:true,platform:'node',format:'esm'});const engine=await import(pathToFileURL(path.join(tmp,'engine.mjs')));
  browser=await chromium.launch();const page=await browser.newPage();await page.addScriptTag({content:`window.gradientFitter=(${createGradientFitter.toString()})();`});
  for(const s of ann.sections){
   const entry=m.sections.find(v=>v.id===s.id);if(!entry||Math.abs(entry.time-s.time)>1e-6)throw Error('Section anchors must match the reference library.');
   const sourceFile=path.resolve(lib,entry.scene);if(!sourceFile.startsWith(lib+path.sep))throw Error('Scene path must remain inside the library.');const svg=await fs.readFile(sourceFile,'utf8');
   for(const l of s.layers){if(!l.surface||l.surface.fitColors===false)continue;const project=engine.validateProject(l.surface.project);
    const geometry=project.nodes.map(n=>{const base={...n,fill:'#ffffff',gradient:undefined,paintRegions:undefined,stroke:'none',strokeWidth:0,opacity:1};return{base:engine.createProjectRenderer({...project,nodes:[base]})(0),regions:(n.paintRegions??[]).map(r=>engine.createProjectRenderer({...project,nodes:[{...base,type:'path',path:r.path}]})(0))};});
    const fitted=await page.evaluate(async({svg,layerPath,geometry,nodes,width,height})=>{
     const W=Math.min(768,width),H=Math.round(W*height/width),size=W*H;
     async function pixels(svg){const doc=new DOMParser().parseFromString(svg,'image/svg+xml');if(doc.querySelector('parsererror,image,video,script,foreignObject'))throw Error('Reference must be pure vector SVG.');doc.documentElement.setAttribute('width',W);doc.documentElement.setAttribute('height',H);doc.documentElement.removeAttribute('style');const image=new Image();image.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(doc))));await image.decode();const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;canvas.getContext('2d').drawImage(image,0,0,W,H);return canvas.getContext('2d').getImageData(0,0,W,H).data;}
     const alpha=p=>Uint8Array.from({length:size},(_,i)=>p[i*4+3]>245?1:0);
     const source=await pixels(svg),visible=alpha(await pixels(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><path d="${layerPath}" fill="white" fill-rule="evenodd"/></svg>`));
     // Exclude color mixed with the occluding object along the old antialias edge.
     const safe=visible.slice();for(let y=2;y<H-2;y++)for(let x=2;x<W-2;x++){const i=y*W+x;if(!visible[i])continue;for(const d of[-2,-1,1,2,-W,-2*W,W,2*W])if(!visible[i+d]){safe[i]=0;break;}}
     const masks=[];for(const g of geometry)masks.push({base:alpha(await pixels(g.base)),regions:await Promise.all(g.regions.map(async v=>alpha(await pixels(v))))});
     const output=[];
     for(let index=0;index<nodes.length;index++){
      const n=nodes[index],mask=masks[index].base;let xmin=W,ymin=H,xmax=0,ymax=0;for(let i=0;i<size;i++)if(mask[i]){const x=i%W,y=Math.floor(i/W);xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}
      for(let part=-1;part<(n.paintRegions?.length??0);part++){
       const paint=part<0?n:n.paintRegions[part],prior=paint.gradient??{type:'linear',x1:0,y1:0,x2:0,y2:1,stops:[{offset:0,color:paint.fill},{offset:1,color:paint.fill}]};
       if(prior.stops.some(s=>!/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(s.color))){output.push({node:index,part,accepted:false,reason:'translucent-paint-preserved'});continue;}
       const domain=new Uint8Array(size),distance=new Float32Array(size);distance.fill(W+H);let unknown=0;
       for(let i=0;i<size;i++){
        if(!mask[i]||part>=0&&!masks[index].regions[part][i])continue;
        if(masks[index].regions.some((r,j)=>j>part&&r[i]))continue;
        if(masks.some((r,j)=>j>index&&r.base[i]&&nodes[j].opacity===1&&!(nodes[j].gradient?.stops.some(s=>s.color.length===9))))continue;
        domain[i]=1;if(!visible[i]){distance[i]=0;unknown++;}
       }
       // Two-pass Manhattan distance weights observations near the missing area.
       for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;if(x)distance[i]=Math.min(distance[i],distance[i-1]+1);if(y)distance[i]=Math.min(distance[i],distance[i-W]+1);}
       for(let y=H-1;y>=0;y--)for(let x=W-1;x>=0;x--){const i=y*W+x;if(x<W-1)distance[i]=Math.min(distance[i],distance[i+1]+1);if(y<H-1)distance[i]=Math.min(distance[i],distance[i+W]+1);}
       const samples=[];let count=0;for(let i=0;i<size;i++)if(domain[i]&&safe[i])count++;const stride=Math.max(1,Math.ceil(count/6000));let seen=0;
       for(let i=0;i<size;i++)if(domain[i]&&safe[i]&&seen++%stride===0){const x=i%W,y=Math.floor(i/W);samples.push({u:(x-xmin)/Math.max(1,xmax-xmin),v:(y-ymin)/Math.max(1,ymax-ymin),rgb:[source[i*4],source[i*4+1],source[i*4+2]],weight:1+3/(1+distance[i]/5)});}
       const fit=window.gradientFitter.fit(samples,prior);output.push({node:index,part,missingPixels:unknown,...fit});
      }
     }
     return output;
    },{svg,layerPath:l.path,geometry,nodes:project.nodes,width:m.width,height:m.height});
    for(const fit of fitted){if(fit.accepted){const node=project.nodes[fit.node],paint=fit.part<0?node:node.paintRegions[fit.part];paint.gradient=fit.gradient;paint.fill=fit.gradient.stops[0].color;}reports.push({section:s.id,layer:l.id,nodeId:project.nodes[fit.node].id,...fit});}
    l.surface.project=engine.validateProject(project);l.surface.colorFit={method:'measured-visible-surface-gradient',referenceTime:s.time,accepted:fitted.filter(f=>f.accepted).length};
   }
   console.log(JSON.stringify({section:s.id,measuredPaints:reports.filter(r=>r.section===s.id).length}));
  }
  await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'regions.json'),JSON.stringify(ann,null,2)+'\n');const measured=reports.filter(r=>Number.isFinite(r.beforeDeltaE76));const report={passed:true,method:'surface-separated sRGB spline fitting, held-out CIELAB DeltaE76, boundary-weighted observations',limits:['Scores measure held-out visible colors, not the unknowable hidden source colors.','Existing geometry and stack order are preserved. Inferred color is bounded by observed samples.'],fitted:reports.filter(r=>r.accepted).length,measured:measured.length,beforeMeanDeltaE76:measured.reduce((n,r)=>n+r.beforeDeltaE76,0)/Math.max(1,measured.length),afterMeanDeltaE76:measured.reduce((n,r)=>n+r.afterDeltaE76,0)/Math.max(1,measured.length),paints:reports};await fs.writeFile(path.join(out,'gradient-fit-report.json'),JSON.stringify(report,null,2)+'\n');return{passed:true,fitted:report.fitted,measured:report.measured,beforeMeanDeltaE76:report.beforeMeanDeltaE76,afterMeanDeltaE76:report.afterMeanDeltaE76};
 }finally{await browser?.close();await fs.rm(tmp,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const{values:v}=parseArgs({options:{library:{type:'string'},regions:{type:'string'},'out-dir':{type:'string'},overwrite:{type:'boolean'},help:{type:'boolean'}}});
 if(v.help)console.log('node scripts/fit-surface-gradients.mjs --library <reference-vector-library> --regions <surface-annotations.json> --out-dir <new-folder> [--overwrite]');
 else{if(!v.library||!v.regions||!v['out-dir'])throw Error('--library, --regions and --out-dir are required');console.log(JSON.stringify(await fitSurfaceGradients({library:v.library,regions:v.regions,outDir:v['out-dir'],overwrite:v.overwrite})));}
}
