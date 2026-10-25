import fs from 'node:fs/promises';
import path from 'node:path';
import {root,inspectFiles} from './lib/release-files.mjs';
const report=await inspectFiles();
await fs.mkdir(path.join(root,'.cache'),{recursive:true});
await fs.writeFile(path.join(root,'.cache/public-source-check.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,files:undefined},null,2));
if(!report.passed)process.exitCode=1;
