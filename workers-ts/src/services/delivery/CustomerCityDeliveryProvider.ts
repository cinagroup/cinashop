import type { Env } from '@/env';
import { CityDeliverySettingsResolver } from './CityDeliverySettingsResolver';
import { dadaApiSignature } from './DadaCityDeliveryProvider';
import { uuApiSignature } from './UuCityDeliveryProvider';

export interface CustomerCityEnv extends Env {
  CUSTOMER_CITY_CALLBACK_ORIGIN?: string;
  /** Explicit reviewed commissioning record; never inferred from a response shape. */
  CUSTOMER_CITY_UU_ORIGIN_BINDING_CONTRACT?: 'uu-v3-originId-return-v1';
}
export interface CustomerCityStation { type:0|1|2; relation_id:number; name:string; address:string; phone:string; city_name:string; shop_no:string }
export interface CustomerCityIssueInput { provider:'dada'|'uu'; provider_order_id:string; station:CustomerCityStation; receiver_name:string; receiver_phone:string; receiver_address:string; cargo_price:string; cargo_weight:string; delivery_remark:string }
export interface CustomerCityQuote { token:string; delivery_no:string; distance:number; fee:string; provider_order_id:string }
export interface CustomerCityIssued { provider_order_id:string; delivery_no:string; distance:number; fee:string }
export class CustomerCityProviderRejection extends Error { constructor(public readonly code:string){super(code);} }
const record=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
function identifier(v:unknown,label:string,max=32):string { if(typeof v!=='string'||!v||v.length>max||!/^[A-Za-z0-9._:-]+$/.test(v))throw Error(label);return v; }
function money(v:unknown):string { let s=String(v);if(!/^\d{1,6}(?:\.\d{1,2})?$/.test(s))throw Error('city_provider_fee_invalid');return Number(s).toFixed(2); }
function distance(v:unknown):number { if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1000000)throw Error('city_provider_distance_invalid');return v; }
async function bounded(response:Response):Promise<Record<string,unknown>> {
  const maximum=65536, declared=Number(response.headers.get('content-length')??'0');if(declared>maximum)throw Error('city_response_too_large');
  if(!response.body)throw Error('city_response_empty');const reader=response.body.getReader(),chunks:Uint8Array[]= [];let n=0;
  for(;;){const next=await reader.read();if(next.done)break;n+=next.value.byteLength;if(n>maximum){await reader.cancel();throw Error('city_response_too_large');}chunks.push(next.value);}
  const bytes=new Uint8Array(n);let off=0;for(const c of chunks){bytes.set(c,off);off+=c.byteLength;}const result=record(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)));if(!result)throw Error('city_response_invalid');return result;
}
/** Only fixed HTTPS provider endpoints. No merchant tokens/raw provider payloads in logs. */
export class CustomerCityDeliveryProvider {
  constructor(private readonly env:CustomerCityEnv,private readonly settings:CityDeliverySettingsResolver){}
  callback(provider:'dada'|'uu'):string {
    const raw=this.env.CUSTOMER_CITY_CALLBACK_ORIGIN;if(!raw)throw Error('city_callback_origin_unavailable');const url=new URL(raw);
    const host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.origin!==raw||url.username||url.password||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(host)||!host.includes('.')||!/^[a-z0-9.-]+$/.test(host))throw Error('city_callback_origin_invalid');
    const token=provider==='dada'?this.env.DADA_CALLBACK_TOKEN:this.env.UU_CALLBACK_TOKEN;
    if(!token||!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw Error('city_callback_token_invalid');
    return `${raw}/api/city_delivery/notify?provider=${provider}&token=${encodeURIComponent(token)}`;
  }
  private async dada(path:'/api/cityCode/list'|'/api/order/queryDeliverFee'|'/api/order/addAfterQuery',body:Record<string,unknown>|''){
    const c=await this.settings.dada(),fields={app_key:c.appKey,body:JSON.stringify(body),format:'json',source_id:c.sourceId,timestamp:Math.floor(Date.now()/1000),v:'1.0'};
    const response=await fetch('https://newopen.imdada.cn'+path,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({...fields,signature:dadaApiSignature(fields,c.appSecret)}),signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw Error('dada_http_'+response.status);const envelope=await bounded(response);
    if(!/^-?\d{1,8}$/.test(String(envelope.code))||!['success','fail','error'].includes(String(envelope.status)))throw Error('dada_envelope_unverified');
    if(String(envelope.code)!=='0'||envelope.status!=='success'){
      if(envelope.status==='success'||String(envelope.code)==='0')throw Error('dada_envelope_contradictory');
      throw new CustomerCityProviderRejection('dada_rejected_'+String(envelope.errorCode??envelope.code).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,32));
    }
    return envelope.result;
  }
  private async uu(path:'/openapi/v3/order/orderPrice'|'/openapi/v3/order/addOrder',body:Record<string,unknown>){
    if(this.env.CUSTOMER_CITY_UU_ORIGIN_BINDING_CONTRACT!=='uu-v3-originId-return-v1')throw Error('uu_origin_binding_contract_unverified');
    const c=await this.settings.uu(),timestamp=c.timestampUnit==='milliseconds'?Date.now():Math.floor(Date.now()/1000),biz=JSON.stringify(body);
    const response=await fetch('https://api-open.uupt.com'+path,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-App-Id':c.appId},body:JSON.stringify({openId:c.openId,timestamp,biz,sign:uuApiSignature(biz,c.appKey,timestamp)}),signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw Error('uu_http_'+response.status);const envelope=await bounded(response);
    if(!/^-?\d{1,8}$/.test(String(envelope.code))||!['0','1'].includes(String(envelope.state)))throw Error('uu_envelope_unverified');
    if(String(envelope.code)!=='1'||String(envelope.state)!=='1'){
      if(String(envelope.state)!=='0')throw Error('uu_envelope_contradictory');
      throw new CustomerCityProviderRejection('uu_rejected_'+String(envelope.code).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,32));
    }
    const result=record(envelope.body);if(!result)throw Error('uu_result_invalid');return result;
  }
  async quote(input:CustomerCityIssueInput):Promise<CustomerCityQuote>{
    if(input.provider==='dada'){
      const cities=await this.dada('/api/cityCode/list','');if(!Array.isArray(cities)||cities.length>2000)throw Error('dada_city_list_invalid');
      const name=input.station.city_name.replace(/市$/,''),matches=cities.map(record).filter((r):r is Record<string,unknown>=>!!r&&r.cityName===name);
      if(matches.length!==1)throw Error('dada_city_unavailable');const cityCode=identifier(matches[0].cityCode,'dada_city_code_invalid',20);
      const result=record(await this.dada('/api/order/queryDeliverFee',{shop_no:input.station.shop_no,origin_id:input.provider_order_id,city_code:cityCode,cargo_price:Number(input.cargo_price),is_prepay:0,receiver_name:input.receiver_name,receiver_address:input.receiver_address,receiver_phone:input.receiver_phone,cargo_weight:Number(input.cargo_weight),is_finish_code_needed:1,callback:this.callback('dada')}));
      if(!result)throw Error('dada_quote_invalid');return {token:'',delivery_no:identifier(result.deliveryNo,'dada_delivery_no_invalid'),distance:distance(result.distance),fee:money(result.fee),provider_order_id:input.provider_order_id};
    }
    // SDK V3 public fields are independently verified. Unknown origin/weight contract remains a commissioning gate.
    const result=await this.uu('/openapi/v3/order/orderPrice',{fromAddress:input.station.address,toAddress:input.receiver_address,sendType:'SEND',cityName:input.station.city_name,specialChannel:2});
    if(typeof result.priceToken!=='string'||!result.priceToken||result.priceToken.length>512)throw Error('uu_price_token_invalid');
    const cents=result.needPayMoney??result.totalMoney;if(typeof cents!=='number'||!Number.isSafeInteger(cents)||cents<0||cents>99999999)throw Error('uu_fee_invalid');
    return {token:result.priceToken,delivery_no:'',distance:distance(result.distance),fee:(cents/100).toFixed(2),provider_order_id:input.provider_order_id};
  }
  async issue(input:CustomerCityIssueInput,quote:CustomerCityQuote):Promise<CustomerCityIssued>{
    if(input.provider==='dada'){await this.dada('/api/order/addAfterQuery',{deliveryNo:quote.delivery_no});return {provider_order_id:input.provider_order_id,delivery_no:quote.delivery_no,distance:quote.distance,fee:quote.fee};}
    const result=await this.uu('/openapi/v3/order/addOrder',{priceToken:quote.token,receiver_phone:input.receiver_phone,pushType:'OPEN_ORDER',payType:'BALANCE_PAY',specialChannel:2,specialType:'NOT_NEED_WARM',...(input.delivery_remark?{note:input.delivery_remark}:{})});
    // Never invent the origin ID from orderCode. Payment links are an unresolved effect, not admitted shipment.
    if(result.orderUrl)throw Error('uu_payment_outcome_unverified');
    return {provider_order_id:identifier(result.originId,'uu_origin_binding_unverified'),delivery_no:identifier(result.orderCode,'uu_order_code_invalid'),distance:quote.distance,fee:quote.fee};
  }
}
