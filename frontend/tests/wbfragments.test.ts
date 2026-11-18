import {editManifestFiles,expandFiles} from '../src/wbfragments';
import {addItem} from '../src/wbdoc';
import {isSeq} from 'yaml';
const assert=(v:unknown,msg:string)=>{if(!v)throw new Error(msg)};
const files={
 'component.yaml':'component: demo\ndetail:\n  presets:\n    - {$file: manifest/schemes/a.yaml}\n    - {$file: manifest/schemes/b.yaml}\nparams: {$file: manifest/common/params.yaml}\n',
 'manifest/schemes/a.yaml':'id: a\nname: A\n',
 'manifest/schemes/b.yaml':'id: b\nname: B\n',
 'manifest/common/params.yaml':'- {key: port, type: int, default: 80}\n'
};
let out=editManifestFiles(files,()=>{});assert(Object.keys(out).length===0,'no-op changes files');
out=editManifestFiles(files,d=>d.setIn(['detail','presets',0,'name'],'A2'));assert(Object.keys(out).join()==='manifest/schemes/a.yaml','A changes B or root');
out=editManifestFiles(files,d=>d.setIn(['detail','presets',0,'id'],'renamed'));assert(Object.keys(out).join()==='manifest/schemes/a.yaml','rename loses ownership');
out=editManifestFiles(files,d=>{const seq=d.getIn(['detail','presets'],true);if(isSeq(seq))seq.items.reverse()});assert(Object.keys(out).join()==='component.yaml','reorder rewrites fragments');assert(expandFiles({...files,...out}).doc.toJS().detail.presets[0].id==='b','reorder wrong');
out=editManifestFiles(files,d=>d.deleteIn(['detail','presets',0]));assert(Object.keys(out).join()==='component.yaml','delete changes other fragment');assert(expandFiles({...files,...out}).doc.toJS().detail.presets[0].id==='b','delete wrong');
out=editManifestFiles(files,d=>addItem(d,['detail','presets'],{id:'c',name:'C'}));assert(Object.keys(out).sort().join()==='component.yaml,manifest/schemes/c.yaml','new scheme not separate');assert(expandFiles({...files,...out}).doc.toJS().detail.presets[2].id==='c','new scheme lost');
const legacy={'component.yaml':'component: demo\ndetail: {presets: [{id: a, name: A}]}\n'};
assert(Object.keys(editManifestFiles(legacy,()=>{})).length===0,'legacy no-op dirty');
console.log('PASS no-op, isolated save, rename, reorder, deletion, addition and legacy');

const nested={...files,'manifest/schemes/a.yaml':'id: a\nname: A\nparams: {$file: manifest/common/a-params.yaml}\n','manifest/common/a-params.yaml':'port: 80\n'};
out=editManifestFiles(nested,d=>{const seq=d.getIn(['detail','presets'],true);if(isSeq(seq))seq.items.reverse();d.setIn(['detail','presets',1,'params','port'],81)});
assert(Object.keys(out).sort().join()==='component.yaml,manifest/common/a-params.yaml','nested reorder loses ownership');
assert(expandFiles({...nested,...out}).doc.toJS().detail.presets[1].params.port===81,'nested data wrong');
console.log('PASS nested fragment ownership survives ancestor reorder');
