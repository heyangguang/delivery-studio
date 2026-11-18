import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseDocument} from 'yaml';
const root=new URL('../../catalog/',import.meta.url).pathname;
let count=0;
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(path.endsWith('/component.yaml')||path.includes('/manifest/')&&path.endsWith('.yaml')){const doc=parseDocument(readFileSync(path,'utf8'));if(doc.errors.length)throw new Error(path+': '+doc.errors.map(x=>x.message).join('; '));count++;}}}
walk(root);console.log('PASS browser YAML parser reads '+count+' builtin manifest files');
