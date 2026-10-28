import {createUserCenterRequests} from '@/api/userCenter';

export interface AgentExplanationDocument {id:number;type:2;content_preview:string}
const invalid=():never=>{throw Error('分销说明响应不完整，请重新读取');};

/** Public projection: status never controls whether the PHP document is read. */
export function decodeAgentExplanation(value:unknown):AgentExplanationDocument|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const data=value as Record<string,unknown>;
  if(Object.keys(data).sort().join(',')!=='member_explain,version'||data.version!==1)return invalid();
  if(data.member_explain===null)return null;
  if(!data.member_explain||typeof data.member_explain!=='object'||Array.isArray(data.member_explain))return invalid();
  const row=data.member_explain as Record<string,unknown>;
  if(Object.keys(row).sort().join(',')!=='content_preview,id,type'||row.type!==2
    ||!Number.isSafeInteger(row.id)||Number(row.id)<-2147483648||Number(row.id)>2147483647
    ||typeof row.content_preview!=='string'||new TextEncoder().encode(row.content_preview).byteLength>4_000_000)return invalid();
  return{id:Number(row.id),type:2,content_preview:row.content_preview};
}

export function createAgentExplanationRequests(current:()=>boolean) {
  const scope=createUserCenterRequests(current);
  return{...scope,read:async()=>decodeAgentExplanation(await scope.request('agent/explanation','GET'))};
}
export type AgentExplanationRequests=ReturnType<typeof createAgentExplanationRequests>;
