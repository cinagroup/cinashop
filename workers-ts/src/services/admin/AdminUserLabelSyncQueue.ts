import {createHmac,timingSafeEqual} from 'node:crypto';
import {eq} from 'drizzle-orm';
import type {Env} from '@/env';
import {createAdminDatabaseSession} from '@/lib/di';
import {systemAdmin} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {labelActorStamp,AdminUserLabelAuthorService,labelRequest} from './AdminUserLabelAuthorService';
import {AdminUserLabelSyncService} from './AdminUserLabelSyncService';
import type {AdminAuthorityActor} from './AdminAuthorityWriteService';
import type {LabelAction} from '../../../../view/common/labelAuthor';
export interface UserLabelSyncMessage {action:'dispatchUserLabelSync';command:LabelAction;actor_stamp:string;expires_at:number;seal:string}
const sign=(env:Env,m:Omit<UserLabelSyncMessage,'seal'>)=>createHmac('sha256',env.APP_KEY).update('user-label-sync-queue-v1:'+JSON.stringify(m)).digest('hex');
export function isUserLabelSyncMessage(v:unknown):v is UserLabelSyncMessage{return !!v&&typeof v==='object'&&!Array.isArray(v)&&'action'in v&&v.action==='dispatchUserLabelSync';}
function checked(v:unknown,env:Env):UserLabelSyncMessage{if(!isUserLabelSyncMessage(v)||Object.keys(v).length!==5||typeof v.actor_stamp!=='string'||!/^[a-f0-9]{64}$/.test(v.actor_stamp)||typeof v.seal!=='string'||!/^[a-f0-9]{64}$/.test(v.seal)||!Number.isSafeInteger(v.expires_at))throw Error('Invalid label sync queue command');const command=labelRequest(v.command,v.command.actor_id);if(command.operation!=='sync')throw Error('Invalid label sync queue operation');const data={action:'dispatchUserLabelSync' as const,command,actor_stamp:v.actor_stamp,expires_at:v.expires_at},expected=sign(env,data);if(!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(v.seal,'hex')))throw Error('Invalid label sync queue seal');return {...data,seal:v.seal};}
export async function enqueueUserLabelSync(env:Env,command:LabelAction,actor:AdminAuthorityActor){if(command.operation!=='sync'||!env.ORDER_QUEUE?.send)return false;const data={action:'dispatchUserLabelSync' as const,command,actor_stamp:labelActorStamp(env.APP_KEY,actor.authVersion),expires_at:actor.expiresAt};await env.ORDER_QUEUE.send({...data,seal:sign(env,data)});return true;}
/** Only a server-signed, unexpired Admin command can open the independent Admin
 * role. No browser-supplied SQL or application-role fallback exists. Live staff,
 * role, password version and original durable actor stamp are rechecked before
 * every provider stage. A queue retry can never resend an existing dispatch. */
export async function dispatchQueuedUserLabelSync(value:unknown,env:Env){const message=checked(value,env);if(message.expires_at<=Math.floor(Date.now()/1000))return {done:true,reason:'expired'};const session=createAdminDatabaseSession(env);try{const author=new AdminUserLabelAuthorService(session.container,env),service=new AdminUserLabelSyncService(author);const[row]=await session.container.db.select({pwd:systemAdmin.pwd}).from(systemAdmin).where(eq(systemAdmin.id,message.command.actor_id)).limit(1);if(!row||labelActorStamp(env.APP_KEY,md5(row.pwd))!==message.actor_stamp)return {done:true,reason:'credential_changed'};const actor={id:message.command.actor_id,authVersion:md5(row.pwd),expiresAt:message.expires_at};const events=await author.transaction(actor,false,false,tx=>author.events(tx,message.command));if(!events.length||events.at(-1)!.result.data.actorStamp!==message.actor_stamp||events.at(-1)!.result.data.expiresAt!==message.expires_at)throw Error('Label queue does not match the durable command');let prior=-1;for(let i=0;i<12;i++){const r=await service.advance(message.command,actor);if(['committed','not_applied','stopped'].includes(r.state))return {done:true,reason:r.state};if(r.step===prior)return {done:false,reason:'unknown'};prior=r.step;}return {done:false,reason:'bounded_continuation'};}finally{await session.close();}}
