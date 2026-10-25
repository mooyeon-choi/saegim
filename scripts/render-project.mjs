/** Export any validated app project and render its standalone SVG player. */
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {randomUUID, createHash} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const {values:args}=parseArgs({options:{project:{type:'string'},'out-dir':{type:'string'},fps:{type:'string'},width:{type:'string'},python:{type:'string'},'html-only':{type:'boolean'},overwrite:{type:'boolean'},help:{type:'boolean'}}});
if(args.help){console.log('node scripts/render-project.mjs --project project.json --out-dir artifacts/run [--fps 24] [--width 960] [--html-only] [--overwrite]');process.exit(0);}
if(!args.project||!args['out-dir'])throw Error('--project and --out-dir are required');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.resolve(args['out-dir']);
const htmlPath=path.join(out,'index.html'),videoPath=path.join(out,'preview.mp4');
for(const file of [htmlPath,...args['html-only']?[]:[videoPath]])if(!args.overwrite&&await fs.stat(file).catch(()=>null))throw Error(`Output exists: ${file}. Choose another out-dir or --overwrite.`);
await fs.mkdir(out,{recursive:true});await fs.mkdir(path.join(root,'.cache'),{recursive:true});
const bundle=path.join(root,'.cache',`render-engine-${randomUUID()}.mjs`);
const hash=data=>createHash('sha256').update(data).digest('hex');
let browser,encoder,encoderDone;
const report={passed:false,externalRequests:[],browserErrors:[]};
try{
  await build({entryPoints:[path.join(root,'src/engine/index.ts')],outfile:bundle,bundle:true,platform:'node',format:'esm'});
  const {parseDocument,exportHtml}=await import(pathToFileURL(bundle));
  const raw=await fs.readFile(path.resolve(args.project),'utf8'),doc=parseDocument(raw),html=exportHtml(doc);
  await fs.writeFile(htmlPath,html);
  Object.assign(report,{projectSHA256:hash(raw),htmlSHA256:hash(html),duration:doc.duration,schemaVersion:doc.schemaVersion,html:'index.html'});
  if(args['html-only']){report.passed=true;console.log(JSON.stringify(report));}
  else{
    const fps=Number(args.fps??doc.fps),width=Number(args.width??960);
    if(!Number.isFinite(fps)||fps<1||fps>240||!Number.isInteger(width)||width<64||width>3840||width%2)throw Error('fps must be finite 1..240; width must be even 64..3840');
    const height=Math.max(2,Math.round(width*doc.height/doc.width/2)*2),count=Math.ceil(doc.duration*fps-1e-8);
    const localPython=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const python=args.python??(existsSync(localPython)?localPython:process.env.FRAMEFORM_PYTHON??localPython);
    const ffmpeg=execFileSync(python,['-c','import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],{encoding:'utf8'}).trim();
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,offline:true});
    const page=await context.newPage();page.on('pageerror',e=>report.browserErrors.push(String(e)));
    await context.route(/^https?:/,async route=>{report.externalRequests.push(route.request().url());await route.abort();});
    await page.goto(pathToFileURL(htmlPath).href,{waitUntil:'load',timeout:180000});
    await page.evaluate(async()=>{await window.motionPlayer.ready;window.motionPlayer.pause();await document.fonts.ready;});
    await page.addStyleTag({content:`html,body{margin:0!important;padding:0!important;width:${width}px!important;height:${height}px!important;overflow:hidden!important}body{visibility:hidden}#stage,#stage *{visibility:visible}#stage{position:fixed!important;left:0;top:0;width:${width}px!important;height:${height}px!important;aspect-ratio:auto!important;border:0!important;border-radius:0!important;box-shadow:none!important}#stage svg{display:block;width:100%!important;height:100%!important;max-width:none!important}`});
    let stderr='';
    encoder=spawn(ffmpeg,['-y','-v','error','-f','image2pipe','-vcodec','png','-framerate',String(fps),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-frames:v',String(count),'-movflags','+faststart',videoPath],{stdio:['pipe','ignore','pipe']});
    encoder.stderr.on('data',b=>stderr+=b);
    encoderDone=new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('close',code=>code===0?resolve():reject(Error(stderr||`Encoder exited${code}`)));});
    let encoderFailure;encoderDone.catch(error=>encoderFailure=error);encoder.stdin.on('error',error=>encoderFailure=error);
    const samples=[];
    for(let i=0;i<count;i++){
      if(encoderFailure)throw encoderFailure;
      await page.evaluate(async t=>{await window.motionPlayer.seek(t);await document.fonts.ready;if(document.querySelector('#stage image,#stage video,#stage canvas,#stage foreignObject'))throw Error('Raster or media in reconstructed stage');await new Promise(requestAnimationFrame);},Math.min(i/fps,doc.duration));
      const png=await page.screenshot({type:'png',animations:'disabled'});
      await new Promise((resolve,reject)=>encoder.stdin.write(png,error=>error?reject(error):resolve()));
      if(i===0||i===count-1){const name=`frame-${String(i).padStart(6,'0')}.png`;await fs.writeFile(path.join(out,name),png);samples.push({frame:i,file:name,sha256:hash(png)});}
      if(i%Math.max(1,Math.round(fps))===0||i===count-1)console.log(JSON.stringify({frame:i+1,frames:count}));
    }
    encoder.stdin.end();await encoderDone;
    const metadata=JSON.parse(execFileSync(python,['-c','import cv2,json,sys;c=cv2.VideoCapture(sys.argv[1]);fps=c.get(cv2.CAP_PROP_FPS);n=0\nwhile c.read()[0]: n+=1\nc.release();print(json.dumps({"decodedFrames":n,"fps":fps}))',videoPath],{encoding:'utf8'}));
    if(metadata.decodedFrames!==count||Math.abs(metadata.fps-fps)>.001||report.browserErrors.length||report.externalRequests.length)throw Error('Frame count, FPS or browser validation failed');
    Object.assign(report,{passed:true,video:'preview.mp4',videoSHA256:hash(await fs.readFile(videoPath)),width,height,projectFPS:doc.fps,fps,frames:count,decodedFrames:metadata.decodedFrames,encodedDuration:count/fps,originalIntermediateGroundTruth:false,samples});
    console.log(JSON.stringify({passed:true,video:videoPath,frames:count}));
  }
}catch(error){report.failure=String(error.stack??error);throw error;}
finally{if(encoder&&encoder.exitCode===null)encoder.kill();if(browser)await browser.close();await fs.rm(bundle,{force:true});await fs.writeFile(path.join(out,'render-check.json'),JSON.stringify(report,null,2)+'\n');}
