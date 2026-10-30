import {afterEach,describe,expect,it,vi} from 'vitest';
import {EnterpriseWechatProviderClient,EnterpriseWechatProviderError,checkedCorpTagCreateRequest,checkedCorpTagCreateResponse,type CorpTagCreateRequest} from '@/services/work/EnterpriseWechatProviderClient';
import {checkedLabelDirectoryCatalog} from '@/services/work/LabelDirectorySyncPlan';

const request:CorpTagCreateRequest={group_name:'Customers',order:5,tag:[{name:'VIP',order:9}]};
function tag(id='et-vip',name='VIP'){return{id,name,order:9,create_time:1788000000};}
function group(tags=[tag()]){return{group_id:'et-customers',group_name:'Customers',order:5,create_time:1788000000,tag:tags};}
const ack=()=>({errcode:0,errmsg:'ok',tag_group:group()});
const response=(value:unknown,init:ResponseInit={})=>new Response(JSON.stringify(value),{...init,headers:{'content-type':'application/json',...init.headers}});
function fixture(replies:Array<Response|Error>){
 const values=new Map<string,string>(),calls:Array<{url:URL;init?:RequestInit}>=[];
 const binding={async get(key:string,type?:string){const value=values.get(key)??null;return value&&type==='json'?JSON.parse(value):value;},async put(key:string,value:string){values.set(key,value);},async delete(key:string){values.delete(key);}} as unknown as KVNamespace;
 const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:new URL(String(input)),init});const next=replies.shift();if(!next)throw Error('Unexpected controlled provider request');if(next instanceof Error)throw next;return next;}) as typeof fetch;
 const env={CONFIG_KV:binding,WECHAT_WORK_CORP_SECRET:'unused-company-secret',WECHAT_WORK_DIRECTORY_SECRET:'unused-directory-secret',WECHAT_WORK_EXTERNAL_CONTACT_SECRET:'controlled-external-secret'};
 return{client:new EnterpriseWechatProviderClient(env,{corpId:'ww-label-directory'},fetcher),calls,values};
}
const token=(value='controlled-token')=>response({errcode:0,access_token:value,expires_in:7200});
async function failure(promise:Promise<unknown>){try{await promise;}catch(error){expect(error).toBeInstanceOf(EnterpriseWechatProviderError);return error as EnterpriseWechatProviderError;}throw Error('Expected provider failure');}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe('bounded corporate directory writes and full reads through the real provider transport',()=>{
 it('uses only the external-contact credential, exact POST body, HTTPS and existing token cache',async()=>{const f=fixture([token(),response(ack()),response({errcode:0,tag_group:[group()]})]);await expect(f.client.corpTagCreate(request)).resolves.toEqual(ack());await f.client.corpTagDirectory();expect(f.calls).toHaveLength(3);expect(f.calls[0]!.url.pathname).toBe('/cgi-bin/gettoken');expect(f.calls[0]!.url.searchParams.get('corpsecret')).toBe('controlled-external-secret');const write=f.calls[1]!;expect(write.url.origin).toBe('https://qyapi.weixin.qq.com');expect(write.url.pathname).toBe('/cgi-bin/externalcontact/add_corp_tag');expect(write.url.searchParams.get('access_token')).toBe('controlled-token');expect(write.init).toMatchObject({method:'POST',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(request)});expect(write.init!.signal).toBeInstanceOf(AbortSignal);expect(JSON.parse(f.calls[2]!.init!.body as string)).toEqual({tag_id:[],group_id:[]});expect(f.values.size).toBe(1);});
 it('addresses an existing group by remote string ID without ignored fields',async()=>{const f=fixture([token(),response(ack())]);await f.client.corpTagCreate({group_id:'et-customers',tag:[{name:'VIP',order:9}]});expect(JSON.parse(f.calls[1]!.init!.body as string)).toEqual({group_id:'et-customers',tag:[{name:'VIP',order:9}]});});
 it('validates and copies the exact request without rewriting Unicode or uint32 order',()=>{const input={group_name:'客'.repeat(30),order:0xffff_ffff,tag:[{name:'😀'.repeat(30),order:0xffff_ffff}]},checked=checkedCorpTagCreateRequest(input);expect(checked).toEqual(input);checked.tag[0]!.name='Changed';expect(input.tag[0]!.name).toBe('😀'.repeat(30));});
 it.each([
  null,{}, {group_name:'G',tag:[]},{group_name:'G',tag:Array.from({length:101},(_,i)=>({name:`T ${i}`}))},
  {group_name:'G',tag:[{name:'Same'},{name:'Same'}]}, {group_name:'G',tag:[{name:'x'.repeat(31)}]},
  {group_id:'et-g',group_name:'G',tag:[{name:'T'}]}, {group_id:'et-g',order:1,tag:[{name:'T'}]},
  {group_id:'x'.repeat(65),tag:[{name:'T'}]}, {group_name:' G',tag:[{name:'T'}]},
  {group_name:'G',tag:[{name:'T\n'}]}, {group_name:'G',tag:[{name:'T',order:'1'}]},
  {group_name:'G',tag:[{name:'T',order:0x1_0000_0000}]}, {group_name:'G',tag:[{name:'T'}],agentid:1},
 ] as const)('rejects an invalid durable request before token/provider I/O: %j',async bad=>{const f=fixture([]);const error=await failure(f.client.corpTagCreate(bad as unknown as CorpTagCreateRequest));expect(error.kind).toBe('terminal');expect(f.calls).toEqual([]);});
 it('rejects missing configuration before network I/O',async()=>{let calls=0;const provider=new EnterpriseWechatProviderClient({CONFIG_KV:{} as KVNamespace},{corpId:'ww-local'},async()=>{calls++;throw Error('Forbidden network');});expect((await failure(provider.corpTagCreate(request))).kind).toBe('configuration');expect(calls).toBe(0);});
 it('refreshes once only after an explicit invalid-token rejection',async()=>{const f=fixture([token('old'),response({errcode:40014}),token('new'),response(ack())]);await f.client.corpTagCreate(request);expect(f.calls.filter(c=>c.url.pathname.endsWith('/add_corp_tag'))).toHaveLength(2);expect(f.calls.at(-1)!.url.searchParams.get('access_token')).toBe('new');});
 it('never makes a third write after two explicitly invalid tokens',async()=>{const f=fixture([token('old'),response({errcode:40014}),token('new'),response({errcode:40014})]);expect((await failure(f.client.corpTagCreate(request))).kind).toBe('configuration');expect(f.calls.filter(c=>c.url.pathname.endsWith('/add_corp_tag'))).toHaveLength(2);});
 it.each([
  ['network',new Error('sensitive URL or secret must not escape')],
  ['server failure',response({errcode:-1},{status:503})],
  ['gateway timeout',response({errcode:-1},{status:504})],
  ['bad JSON',new Response('not JSON: sensitive provider content')],
  ['missing business code',response({tag_group:group()})],
  ['partial success ACK',response({errcode:0,tag_group:{group_id:'et-customers'}})],
  ['missing created tag',response({errcode:0,tag_group:group([])})],
  ['wrong group',response({errcode:0,tag_group:{...group(),group_id:'et-other',group_name:'Other'}})],
  ['oversized response',new Response('{}',{headers:{'content-length':String(1024*1024+1)}})],
 ] as const)('keeps %s UNKNOWN and never blindly retries the directory write',async(_name,result)=>{const f=fixture([token(),result]);const error=await failure(f.client.corpTagCreate(request));expect(error.kind).toBe('unknown');expect(error.message).toBe('enterprise_wechat_provider_unknown');expect(f.calls.filter(c=>c.url.pathname.endsWith('/add_corp_tag'))).toHaveLength(1);});
 it('classifies explicit rate limiting without automatically redelivering the command',async()=>{const f=fixture([token(),response({errcode:45009},{status:429,headers:{'Retry-After':'20'}})]);const error=await failure(f.client.corpTagCreate(request));expect(error).toMatchObject({kind:'retryable',retryAfterSeconds:20});expect(f.calls).toHaveLength(2);});
 it('accepts a complete directory above 512KiB through its separate 1MiB boundary',async()=>{const tags=Array.from({length:4000},(_,i)=>tag(`et-${String(i).padStart(60,'0')}`,'X'.repeat(24)+String(i).padStart(6,'0'))),body={errcode:0,tag_group:[group(tags)]},bytes=new TextEncoder().encode(JSON.stringify(body)).length;expect(bytes).toBeGreaterThan(512*1024);expect(bytes).toBeLessThan(1024*1024);const f=fixture([token(),response(body)]);expect(checkedLabelDirectoryCatalog(await f.client.corpTagDirectory()).groups[0]!.tags).toHaveLength(4000);expect(JSON.parse(f.calls[1]!.init!.body as string)).toEqual({tag_id:[],group_id:[]});});
 it('retains the old 512KiB targeted read budget',async()=>{const f=fixture([token(),new Response('{}',{headers:{'content-length':String(512*1024+1)}})]);await expect(f.client.corpTagList([],[])).rejects.toBeInstanceOf(EnterpriseWechatProviderError);expect(f.calls).toHaveLength(2);});
 it('rejects a declared full-directory response beyond 1MiB',async()=>{const f=fixture([token(),new Response('{}',{headers:{'content-length':String(1024*1024+1)}})]);await expect(f.client.corpTagDirectory()).rejects.toBeInstanceOf(EnterpriseWechatProviderError);expect(f.calls).toHaveLength(2);});
 it('does not mistake a duplicate/partial provider ACK for an idempotency receipt',()=>{const expected={group_name:'Customers',tag:[{name:'VIP'},{name:'Regular'}]};expect(()=>checkedCorpTagCreateResponse({errcode:0,tag_group:group([tag(),tag('et-vip','Regular')])},expected)).toThrow();expect(()=>checkedCorpTagCreateResponse({...ack(),has_more:false},request)).toThrow();});
});
