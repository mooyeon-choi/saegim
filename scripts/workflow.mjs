import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const localPython=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const python=existsSync(localPython)?localPython:process.env.FRAMEFORM_PYTHON??localPython;
const tasks={
  analyze:[python,'scripts/analyze-video.py'],
  render:[process.execPath,'scripts/render-project.mjs'],
  elements:[process.execPath,'scripts/export-elements.mjs'],
  'fit-surfaces':[process.execPath,'scripts/fit-surface-gradients.mjs'],
  compare:[python,'scripts/compare-video.py'],
  fixtures:[python,'scripts/create-fixtures.py'],
  'verify-fixtures':[python,'scripts/verify-analysis.py'],
  'render-fixtures':[process.execPath,'scripts/visual-qa.mjs'],
  'compare-fixtures':[python,'scripts/compare-frames.py'],
  'release-check':[process.execPath,'scripts/release-check.mjs'],
  package:[process.execPath,'scripts/package-source.mjs'],
};
const [task='help',...args]=process.argv.slice(2);
if(['help','--help','list'].includes(task)){
  console.log('npm run workflow -- <task> [arguments]\n\n'+Object.entries(tasks).map(([name,[,file]])=>`${name.padEnd(18)} ${file}`).join('\n')+'\n\ndoctor             Local dependency checks; no installs or downloads');
}else if(task==='doctor'){
  const check=(name,command,argv)=>{const r=spawnSync(command,argv,{cwd:root,encoding:'utf8'});return{name,passed:!r.error&&r.status===0,detail:r.error?.message||(r.status===0?r.stdout.trim():r.stderr.trim()).slice(0,600)};};
  const checks=[check('Node',process.execPath,['--version']),check('Python + analysis packages',python,['-c','import sys,fastapi,cv2,numpy,scipy,PIL,imageio_ffmpeg;print(sys.version);print(imageio_ffmpeg.get_ffmpeg_exe())']),check('Browser dependencies',process.execPath,['--input-type=module','-e',"import{chromium}from'@playwright/test';import fs from'node:fs';if(!fs.existsSync(chromium.executablePath()))process.exit(1);console.log(chromium.executablePath())"])];
  console.log(JSON.stringify({passed:checks.every(c=>c.passed),checks},null,2));if(checks.some(c=>!c.passed))process.exitCode=1;
}else if(tasks[task]){
  const [command,...initial]=tasks[task];
  if(command===python&&!existsSync(python)&&!process.env.FRAMEFORM_PYTHON)throw Error('Run npm run setup first.');
  const child=spawn(command,[...initial,...args],{cwd:root,stdio:'inherit'});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('exit',code=>{process.exitCode=code??1;});
}else{console.error(`Unknown task: ${task}. Use npm run workflow -- list.`);process.exitCode=1;}
