import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const roots=new Set(['.gitignore','.editorconfig','.nvmrc','README.md','README.ko.md','AGENTS.md','CONTRIBUTING.md','SECURITY.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md','LICENSE','LICENSE.md','LICENSE.txt','index.html','package.json','package-lock.json','requirements.txt','playwright.config.ts','tsconfig.json','vite.config.ts']);
const dirs=['src/','server/','tests/','scripts/','public/','docs/','examples/','.github/','.agents/'];
const excluded=/^(?:artifacts|dist|node_modules|\.data|\.cache|\.venv|\.git|test-results|playwright-report)\/|(?:^|\/)\.env(?:\.|$)|(?:^|\/)__pycache__\//;
const suspicious=[['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['access-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/],['user-home-path',/\/(?:Users|home)\/[A-Za-z0-9_.-]+\//]];

export async function inspectFiles(){
  let candidates;
  try{candidates=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);}
  catch{throw Error('Run inside a Git checkout (or git init after extracting the source package).');}
  const issues=[],files=[];
  for(const name of [...new Set(candidates)].sort()){
    if(excluded.test(name)||(!roots.has(name)&&!dirs.some(d=>name.startsWith(d))))issues.push({file:name,reason:'outside-public-source-scope'});
    const stat=await fs.lstat(path.join(root,name)).catch(()=>null);
    if(!stat){issues.push({file:name,reason:'missing-file'});continue;}
    if(!stat.isFile()){issues.push({file:name,reason:'non-regular-file'});continue;}
    if(stat.size>10*1024*1024){issues.push({file:name,reason:'source-file-over-10MiB-project-policy'});continue;}
    const bytes=await fs.readFile(path.join(root,name));
    if(!bytes.includes(0)){
      const text=bytes.toString('utf8');
      for(const [kind,pattern]of suspicious){const match=pattern.exec(text);if(match)issues.push({file:name,line:text.slice(0,match.index).split('\n').length,reason:kind});}
    }
    files.push({path:name,bytes:stat.size,sha256:sha(bytes)});
  }
  for(const file of ['README.md','package.json','package-lock.json','requirements.txt','.agents/skills/motion-graphics-reconstruction/SKILL.md'])if(!files.some(f=>f.path===file))issues.push({file,reason:'required-source-file-missing'});
  const catalogFile=path.join(root,'scripts/catalog.json');
  const catalog=JSON.parse(await fs.readFile(catalogFile,'utf8'));
  const entries=Array.isArray(catalog)?catalog:(catalog.scripts??catalog.entries??[]);
  const listed=new Set(entries.map(entry=>entry.path??entry.file));
  for(const file of files.filter(f=>/^scripts\/.+\.(?:mjs|py)$/.test(f.path)))if(!listed.has(file.path))issues.push({file:file.path,reason:'script-missing-from-catalog'});
  return {passed:issues.length===0,scope:'Current tracked and non-ignored untracked working files; no staging, commit, remote or upload.',fileCount:files.length,totalBytes:files.reduce((n,f)=>n+f.bytes,0),files,issues,limits:['Pattern scan is not a comprehensive secret audit.','10MiB is this project source-package policy, not a GitHub platform limit.']};
}
