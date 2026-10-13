import { ServiceUnavailableException } from '@/utils/errors';
import { erpObject, erpUniqueJson } from './ErpInput';
import { erpPhpJson, erpPopSign } from './ErpProtocol';

export const ERP_PROVIDER_PATHS = {
  exchange:'/openWeb/auth/accessToken',refresh:'/openWeb/auth/refreshToken',shops:'/open/shops/query',
  order:'/open/orders/single/query',inventory:'/open/inventory/query',product:'/open/mall/item/query',received:'/open/aftersale/received/query',
} as const;
export type ErpProviderOperation=keyof typeof ERP_PROVIDER_PATHS;
export interface ErpProviderCredentials {appKey:string;appSecret:string;accessToken?:string}
export type ErpProviderFetch=(url:string,init:RequestInit)=>Promise<Response>;
const MAX_BYTES=262144;
const TIMEOUT_MS=8000;
const unavailable=()=>new ServiceUnavailableException('ERP 供应商暂不可用，请稍后重试');

/** Fixed POP origin/path, one bounded request, no redirect, no response errors
 * or transport credentials in logs/exception messages. Provider I/O must be
 * outside SQL transactions; the caller rechecks fresh SQL authority later. */
export class ErpProviderClient {
  constructor(private readonly fetcher:ErpProviderFetch=fetch) {}
  async post(operation:ErpProviderOperation,parameters:Record<string,string|number>):Promise<Record<string,unknown>> {
    const path=ERP_PROVIDER_PATHS[operation];
    if(!path || Object.values(parameters).some(value=>typeof value==='string' && value.length>65536)
      || Object.keys(parameters).some(key=>!['app_key','timestamp','charset','version','biz','sign','access_token','refresh_token','code','grant_type'].includes(key)))throw unavailable();
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    const timedOut=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{abort.abort();void reader?.cancel().catch(()=>{});reject(unavailable());},TIMEOUT_MS);});
    try {
      return await Promise.race([timedOut,(async()=>{
        const response=await this.fetcher(`https://openapi.jushuitan.com${path}`,{
          method:'POST',redirect:'manual',signal:abort.signal,headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json'},
          body:new URLSearchParams(Object.entries(parameters).map(([key,value])=>[key,String(value)])).toString(),
        });
        if(response.status!==200 || response.redirected || !response.body || !(response.headers.get('content-type')??'').toLowerCase().includes('application/json'))throw unavailable();
        const length=response.headers.get('content-length');
        if(length!==null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length)>MAX_BYTES))throw unavailable();
        reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
        while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();throw unavailable();}chunks.push(item.value);}
        const merged=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
        const body=erpObject(erpUniqueJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(merged)));
        if(body.code!==0 && body.code!=='0')throw unavailable();
        return erpObject(body.data);
      })()]);
    } catch {throw unavailable();} finally {if(timer!==undefined)clearTimeout(timer);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Pending read is canceled; no SQL can consume its late result. */}}}
  }
  async exchange(credentials:ErpProviderCredentials,code:string,now:number) {
    const parameters:Record<string,string|number>={app_key:credentials.appKey,timestamp:now,grant_type:'authorization_code',charset:'utf-8',code};
    parameters.sign=erpPopSign(parameters,credentials.appSecret);
    return this.post('exchange',parameters);
  }
  async refresh(credentials:ErpProviderCredentials,refreshToken:string,now:number) {
    const parameters:Record<string,string|number>={app_key:credentials.appKey,timestamp:now,grant_type:'refresh_token',charset:'utf-8',refresh_token:refreshToken};
    parameters.sign=erpPopSign(parameters,credentials.appSecret);
    return this.post('refresh',parameters);
  }
  async query(operation:Exclude<ErpProviderOperation,'exchange'|'refresh'>,credentials:ErpProviderCredentials,business:Record<string,unknown>,now:number) {
    if(!credentials.accessToken)throw unavailable();
    const parameters:Record<string,string|number>={app_key:credentials.appKey,access_token:credentials.accessToken,timestamp:now,version:'2',charset:'utf-8',biz:erpPhpJson(business)};
    parameters.sign=erpPopSign(parameters,credentials.appSecret);return this.post(operation,parameters);
  }
}
