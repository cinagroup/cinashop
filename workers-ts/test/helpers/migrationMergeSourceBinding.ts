/** Explicit source views for the two immutable parents of the migration merge.
 * Current runtime tests always import the real merged implementation. Historical
 * byte proofs first verify the full merged image, then reverse only listed exact
 * line edits to their own reviewed parent. A separate accepted-author view binds
 * two later checkpoint changes to their original immutable author proofs.
 * No substring or hash fallback. */
import {createHash} from 'node:crypto';
import {execFileSync as diskExecFileSync} from 'node:child_process';
import {readFileSync as diskReadFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(import.meta.dirname,'../../..');
type Parent='main'|'checkpoint';
interface Edit {start:number;after:string[];before:string[]}
interface Image {current_sha256:string;parent_sha256:string;edits:Edit[]}
interface Binding {current_inventory:string[];parents:Record<Parent,{commit:string;inventory:string[];sources:Record<string,Image>;ast_report:Image}>;checkpoint_accepted_author:{sources:Record<string,Image>;ast_report:Image}}
const raw=diskReadFileSync(resolve(root,'workers-ts/test/fixtures/migration-merge-source-binding-20261030.json'),'utf8');
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const PIN='11b657f6c1d223bcc730a21c604c4a89b61d379ac4145ea5b4938559db7ce4cb';
if(sha(raw)!==PIN)throw Error('Migration merge binding bytes differ');
const binding=JSON.parse(raw) as Binding;
function projectImage(file:string,source:string,row:Image):string {
 if(sha(source)!==row.current_sha256)throw Error(`Merged source differs: ${file}`);
 const lines=source.match(/[^\n]*\n|[^\n]+$/g)??[];
 let prior=lines.length;
 for(const edit of [...row.edits].reverse()){
  if(!Number.isSafeInteger(edit.start)||edit.start<0||edit.start+edit.after.length>prior
   ||JSON.stringify(lines.slice(edit.start,edit.start+edit.after.length))!==JSON.stringify(edit.after))throw Error(`Merge inverse edit differs: ${file}`);
  lines.splice(edit.start,edit.after.length,...edit.before);prior=edit.start;
 }
 const value=lines.join('');if(sha(value)!==row.parent_sha256)throw Error(`Merge parent bytes differ: ${file}`);return value;
}
export function projectMigrationMergeSource(file:string,source:string,parent:Parent):string {
 const row=binding.parents[parent].sources[file];return row?projectImage(file,source,row):source;
}
export function projectAcceptedCheckpointSource(file:string,source:string):string {
 const row=binding.checkpoint_accepted_author.sources[file];return row?projectImage(file,source,row):source;
}
function reader(parent:Parent,accepted=false):typeof diskReadFileSync {
 return ((file:Parameters<typeof diskReadFileSync>[0],options?:Parameters<typeof diskReadFileSync>[1])=>{
  const value=diskReadFileSync(file,options);if(typeof file==='number')return value;
  const path=resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file));
  const name=relative(root,path).replace(/\\/g,'/');if(!binding.parents[parent].sources[name]&&!(accepted&&binding.checkpoint_accepted_author.sources[name]))return value;
  const text=typeof value==='string'?value:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);const original=projectMigrationMergeSource(name,text,parent);const previous=accepted?projectAcceptedCheckpointSource(name,original):original;
  return typeof value==='string'?previous:Buffer.from(previous,'utf8');
 }) as typeof diskReadFileSync;
}
export const readMainMergePredecessor=reader('main');
export const readCheckpointMergePredecessor=reader('checkpoint');
export const readCheckpointAcceptedAuthorView=reader('checkpoint',true);
export function projectMigrationMergeReport<T>(report:T,parent:Parent):T {
 return JSON.parse(projectImage('actual parent AST report',JSON.stringify(report,null,2)+'\n',binding.parents[parent].ast_report)) as T;
}

export function projectAcceptedCheckpointReport<T>(report:T):T {
 const parent=projectMigrationMergeReport(report,'checkpoint');
 return JSON.parse(projectImage('accepted App author AST report',JSON.stringify(parent,null,2)+'\n',binding.checkpoint_accepted_author.ast_report)) as T;
}

function inventoryReader(parent:Parent):typeof diskExecFileSync {
 return ((...args:unknown[])=>{
  const value=Reflect.apply(diskExecFileSync,undefined,args) as string|Buffer;
  const [command,argv,options]=args;
  if(command!=='git'||!Array.isArray(argv)||JSON.stringify(argv)!==JSON.stringify(['ls-files','-co','--exclude-standard','-z'])||!options||typeof options!=='object')return value;
  const selected=options as {cwd?:string|URL;encoding?:unknown};
  const cwd=typeof selected.cwd==='string'?selected.cwd:selected.cwd instanceof URL?fileURLToPath(selected.cwd.href):undefined;
  if(selected.encoding!=='utf8'||cwd===undefined||resolve(cwd)!==root)return value;
  if(typeof value!=='string')throw Error('Merge inventory requires exact UTF-8 reads');
  const actual=value.split('\0').filter(Boolean).sort();
  if(JSON.stringify(actual)!==JSON.stringify(binding.current_inventory))throw Error('Migration merge complete inventory differs');
  return binding.parents[parent].inventory.join('\0')+'\0';
 }) as typeof diskExecFileSync;
}
export const mainMergePredecessorExecFileSync=inventoryReader('main');
export const checkpointMergePredecessorExecFileSync=inventoryReader('checkpoint');
