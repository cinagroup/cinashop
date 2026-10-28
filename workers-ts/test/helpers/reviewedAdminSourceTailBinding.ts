import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {reverseRouteSourceFollowup,type RouteSourceFollowup} from './routeSourceIncrement';
interface Source extends RouteSourceFollowup{file:string;before_bytes:number;after_bytes:number;before_git_blob_sha1:string;after_git_blob_sha1:string}
export interface ReviewedAdminSourceTailBinding{schema:string;base_ref:string;current_ref:string;stages:Array<{before_ref:string;after_ref:string;sources:Source[]}>;harness_sources:Source[];current_sources:Array<{file:string;bytes:number;sha256:string;git_blob_sha1:string}>;boundary:string}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),blob=(s:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const raw=readFileSync(resolve(import.meta.dirname,'../fixtures/reviewed-admin-source-tail-20261028.json'),'utf8');
if(sha(raw)!=='cb790c08f93a374148eafea6a2aeddd005e3625af3408a089238d2c1907d325b')throw Error('Reviewed Admin source tail fixture bytes differ');
export const reviewedAdminSourceTailBinding=JSON.parse(raw)as ReviewedAdminSourceTailBinding;
function inventory(p:ReviewedAdminSourceTailBinding){if(sha(JSON.stringify(p))!=='4aa2405e2d936e4668df760001cb08c6a1190cbe4a0bd51666a61c23b6f2b7ec')throw Error('Reviewed Admin source tail exact inventory differs');}
function whole(s:string,p:Source,before:boolean){return Buffer.byteLength(s)===(before?p.before_bytes:p.after_bytes)&&sha(s)===(before?p.before_sha256:p.after_sha256)&&blob(s)===(before?p.before_git_blob_sha1:p.after_git_blob_sha1);}
function inverse(s:string,p:Source){if(!whole(s,p,false))throw Error('Reviewed Admin source tail current whole source differs');const before=reverseRouteSourceFollowup(s,p);if(!whole(before,p,true))throw Error('Reviewed Admin source tail predecessor whole source differs');return before;}
/** Only an entire known later production source is reversed. Unknown input is
 * retained for the original dated bridge to reject with its own whole hash. */
export function peelReviewedAdminSourceTailIfPresent(file:string,source:string,p=reviewedAdminSourceTailBinding):string{inventory(p);for(const stage of[...p.stages].reverse()){const row=stage.sources.find(x=>x.file===file);if(row&&whole(source,row,false))source=inverse(source,row);}return source;}
export function reverseReviewedAdminSourceTail(file:string,source:string,p=reviewedAdminSourceTailBinding):string{const before=peelReviewedAdminSourceTailIfPresent(file,source,p);if(before===source)throw Error('Unknown complete reviewed Admin source tail');return before;}
/** Recover exact pre-adapter harness bytes for immutable dated preserved-file
 * assertions. This is test-only history; native current proofs use real fs. */
export function peelReviewedAdminHistoricalSourceIfPresent(file:string,source:string,p=reviewedAdminSourceTailBinding):string{inventory(p);const harness=p.harness_sources.find(x=>x.file===file);if(harness&&whole(source,harness,false))return inverse(source,harness);return peelReviewedAdminSourceTailIfPresent(file,source,p);}
export function hasReviewedAdminHistoricalSource(file:string,p=reviewedAdminSourceTailBinding){inventory(p);return p.harness_sources.some(x=>x.file===file)||p.stages.some(s=>s.sources.some(x=>x.file===file));}
