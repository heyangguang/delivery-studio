import { isMap, isSeq, Scalar } from "yaml";
import {parseManifest, type Doc, type Path} from "./wbdoc";
import { bi } from "./i18n";

type Reference = {path: Path; file: string; node: any; identity?: string; expanded?: any; parent?: any};
export function expandFiles(files: Record<string,string>) {
 const refs: Reference[]=[];const seen=new Set<string>();let total=0;
 const load=(file:string,path:Path,depth:number):any=>{
  if(depth>12||seen.has(file))throw new Error(file+bi("：循环引用或重复归属", ": circular reference or duplicate ownership"));seen.add(file);
  if(files[file]===undefined)throw new Error(file+bi("：引用文件不存在", ": referenced file does not exist"));
  total+=files[file].length;if(total>8*1024*1024)throw new Error(bi("清单过大", "Manifest is too large"));
  const doc=parseManifest(files[file]);if(doc.errors.length)throw new Error(file+"："+doc.errors[0].message);
  const walk=(node:any,p:Path,parent?:any):any=>{
   if(isMap(node)&&node.has("$file")){
    const ref=String(node.get("$file"));
    if(node.items.length!==1||!/^manifest\/[A-Za-z0-9_.@+/-]+\.yaml$/.test(ref)||ref.includes(".."))throw new Error(file+bi("：无效 $file 引用", ": invalid $file reference"));
    const entry:Reference={path:p,file:ref,node:node.clone(),parent};refs.push(entry);
    const loaded=load(ref,p,depth+1);entry.expanded=loaded;if(isMap(loaded)&&loaded.has("id"))entry.identity=String(loaded.get("id"));return loaded;
   }
   if(isMap(node))for(const item of node.items)item.value=walk(item.value,[...p,String(item.key)],node);
   if(isSeq(node))node.items=node.items.map((item,i)=>walk(item,[...p,i],node));
   return node;
  };
  return walk(doc.contents,path);
 };
 const doc=parseManifest(files["component.yaml"]||"");doc.contents=load("component.yaml",[],0);
 return {doc,refs};
}

// Apply the form edit to the expanded document, then project each owned
// fragment back into its original file. Other files remain byte-identical.
export function editManifestFiles(files:Record<string,string>, edit:(doc:Doc)=>void):Record<string,string>{
 const {doc,refs}=expandFiles(files);
 const originalPresets=doc.getIn(["detail","presets"],true);
 const originalNodes=isSeq(originalPresets)?[...originalPresets.items]:[];
 edit(doc);
 const out:Record<string,string>={};
 for(const ref of [...refs].reverse()){
  const find=(node:any,wanted:any,path:Path=[]):Path|undefined=>{
   if(node===wanted)return path;
   if(isMap(node))for(const pair of node.items){const found=find(pair.value,wanted,[...path,String(pair.key)]);if(found)return found;}
   if(isSeq(node))for(let i=0;i<node.items.length;i++){const found=find(node.items[i],wanted,[...path,i]);if(found)return found;}
   return undefined;
  };
  let target=find(doc.contents,ref.expanded);
  if(!target){
   const parentPath=ref.parent?find(doc.contents,ref.parent):undefined;
   if(parentPath){
    const key=ref.path[ref.path.length-1];
    if(typeof key==="number"){
     if(isSeq(ref.parent)&&ref.identity){const index=ref.parent.items.findIndex((n:any)=>isMap(n)&&String(n.get("id"))===ref.identity);if(index>=0)target=[...parentPath,index];}
    }else target=[...parentPath,key];
   } else if(ref.path.length===0)target=[];
  }
  if(!target)continue;
  const node=doc.getIn(target,true) as any;
  if(node===undefined)continue;
  const fragment=parseManifest(files[ref.file]);
  if(JSON.stringify(fragment.toJS())!==JSON.stringify(node?.toJSON?.() ?? node)){
   fragment.contents=node?.clone?.() ?? new Scalar(node);
   out[ref.file]=fragment.toString({lineWidth:0});
  }
  doc.setIn(target,ref.node);
 }
 const presets=doc.getIn(["detail","presets"],true);
 if(isSeq(presets))presets.items.forEach((node,index)=>{
  if(!isMap(node)||node.has("$file")||originalNodes.includes(node))return;
  const id=String(node.get("id")||"scheme").replace(/[^A-Za-z0-9_-]/g,"-")||"scheme";
  let file="manifest/schemes/"+id+".yaml";let suffix=2;
  while(files[file]!==undefined||out[file]!==undefined)file="manifest/schemes/"+id+"-"+(suffix++)+".yaml";
  const fragment=parseManifest("");fragment.contents=node.clone() as any;out[file]=fragment.toString({lineWidth:0});
  doc.setIn(["detail","presets",index],doc.createNode({$file:file}));
 });
 const before=parseManifest(files["component.yaml"]);
 if(JSON.stringify(before.toJS())!==JSON.stringify(doc.toJS()))out["component.yaml"]=doc.toString({lineWidth:0});
 return out;
}
