import fs from 'node:fs/promises';
import path from 'node:path';
import {zipSync,unzipSync} from 'fflate';
import {root,inspectFiles,sha} from './lib/release-files.mjs';
const report=await inspectFiles();
if(!report.passed)throw Error(`Source checks failed. Run npm run release:check (${report.issues.length}issues).`);
const entries={};
for(const item of report.files){const bytes=await fs.readFile(path.join(root,item.path));if(sha(bytes)!==item.sha256)throw Error(`File changed while packaging: ${item.path}`);entries[`saegim/${item.path}`]=new Uint8Array(bytes);}
entries['SOURCE_MANIFEST.json']=new TextEncoder().encode(JSON.stringify({files:report.files,scope:report.scope},null,2)+'\n');
const zipped=zipSync(entries,{level:9}),roundtrip=unzipSync(zipped);
for(const item of report.files)if(sha(roundtrip[`saegim/${item.path}`])!==item.sha256)throw Error(`Archive verification failed: ${item.path}`);
const out=path.join(root,'dist/github-source');await fs.mkdir(out,{recursive:true});
const archive=path.join(out,'saegim-source.zip');await fs.writeFile(archive,zipped);
await fs.writeFile(path.join(out,'package-check.json'),JSON.stringify({passed:true,fileCount:report.fileCount,sourceBytes:report.totalBytes,archiveBytes:zipped.length,archiveSHA256:sha(zipped),allEntriesVerified:true},null,2)+'\n');
console.log(JSON.stringify({passed:true,archive,fileCount:report.fileCount,archiveBytes:zipped.length}));
