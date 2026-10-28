import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {reverseRouteSourceFollowup,type RouteSourceFollowup} from './routeSourceIncrement';

interface Source extends RouteSourceFollowup {
  file:string;before_bytes:number;after_bytes:number;before_git_blob_sha1:string;after_git_blob_sha1:string;
}
interface CurrentSource {file:string;bytes:number;sha256:string;git_blob_sha1:string}
export interface MessageCenterSourceBinding {
  schema:string;base_ref:string;current_ref:string;sources:Source[];harness_sources:Source[];current_sources:CurrentSource[];
  api_report:{before_sha256:string;after_sha256:string;before_bytes:number;after_bytes:number;path:Array<string|number>;
    source_file:string;before:string;after:string;counts:Record<string,number>;frontend_sources:number;registered_routes:number};
  preserved_dated_fixtures:Array<{file:string;bytes:number;sha256:string}>;boundary:string;
}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const blob=(s:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const raw=readFileSync(resolve(import.meta.dirname,'../fixtures/message-center-ci-source-binding-20261028.json'),'utf8');
if(sha(raw)!=='0fdeee7c06f44c4eeed9c1748a302df2c4a59733e78e48f83ed1eec65d85db3d')throw Error('Message center exact fixture bytes differ');
export const messageCenterSourceBinding=JSON.parse(raw)as MessageCenterSourceBinding;
function inventory(p:MessageCenterSourceBinding){
  if(sha(JSON.stringify(p))!=='31cbff49043de59f8e5ad84241ec6309684935512d9434de592a6a2d89808cd8')throw Error('Message center exact source/report/harness inventory differs');
}
function whole(source:string,p:Source,before:boolean){
  return Buffer.byteLength(source)===(before?p.before_bytes:p.after_bytes)
    &&sha(source)===(before?p.before_sha256:p.after_sha256)
    &&blob(source)===(before?p.before_git_blob_sha1:p.after_git_blob_sha1);
}
function inverse(source:string,p:Source){
  if(!whole(source,p,false))throw Error('Message center current whole source differs');
  const previous=reverseRouteSourceFollowup(source,p);
  if(!whole(previous,p,true))throw Error('Message center predecessor whole source differs');
  return previous;
}
/** Unknown bytes are preserved for the existing historical gates to reject.
 * The inverse checks full SHA/length/Git blob and each unique recorded edit/line. */
export function peelMessageCenterSourceIfPresent(file:string,source:string,p=messageCenterSourceBinding):string{
  inventory(p);const row=p.sources.find(x=>x.file===file);return row&&whole(source,row,false)?inverse(source,row):source;
}
export function reverseMessageCenterSource(file:string,source:string,p=messageCenterSourceBinding):string{
  inventory(p);const row=p.sources.find(x=>x.file===file);if(!row)throw Error('Unknown message center source');return inverse(source,row);
}
/** Harness changes are separately bound; no application consumer is rewritten. */
export function peelMessageCenterHarnessSourceIfPresent(file:string,source:string,p=messageCenterSourceBinding):string{
  inventory(p);const row=p.harness_sources.find(x=>x.file===file);return row&&whole(source,row,false)?inverse(source,row):source;
}
export function reverseMessageCenterHarnessSource(file:string,source:string,p=messageCenterSourceBinding):string{
  inventory(p);const row=p.harness_sources.find(x=>x.file===file);if(!row)throw Error('Unknown message center harness source');return inverse(source,row);
}
export function assertMessageCenterCurrentSource(file:string,source:string,p=messageCenterSourceBinding):void{
  inventory(p);const row=p.current_sources.find(x=>x.file===file);
  if(!row||Buffer.byteLength(source)!==row.bytes||sha(source)!==row.sha256||blob(source)!==row.git_blob_sha1)
    throw Error('Message center exact live consumer source differs');
}
const pretty=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
function reportWhole(value:unknown,p:MessageCenterSourceBinding['api_report'],before:boolean){
  const text=pretty(value);return Buffer.byteLength(text)===(before?p.before_bytes:p.after_bytes)
    &&sha(text)===(before?p.before_sha256:p.after_sha256);
}
function reportBridge<T>(input:T,reverse:boolean,p:MessageCenterSourceBinding):T{
  inventory(p);const report=p.api_report;
  if(!reportWhole(input,report,reverse?false:true))throw Error('Message center complete report input differs');
  const result=structuredClone(input);
  // One fixed scalar only; no route/call/source filtering or whole-report replacement.
  const sources=(result as unknown as {backend:{rootRouteSources:Array<{file:string;sha256:string}>}}).backend.rootRouteSources;
  const source=sources[2];
  if(!source||source.file!==report.source_file||source.sha256!==(reverse?report.after:report.before))
    throw Error('Message center complete report source scalar differs');
  source.sha256=reverse?report.before:report.after;
  if(!reportWhole(result,report,reverse?true:false))throw Error('Message center complete report result differs');
  return result;
}
export function peelMessageCenterReportIfPresent<T>(input:T,p=messageCenterSourceBinding):T{
  inventory(p);return reportWhole(input,p.api_report,false)?reportBridge(input,true,p):input;
}
export const reverseMessageCenterReport=<T>(input:T,p=messageCenterSourceBinding):T=>reportBridge(input,true,p);
export const applyMessageCenterReport=<T>(input:T,p=messageCenterSourceBinding):T=>reportBridge(input,false,p);
