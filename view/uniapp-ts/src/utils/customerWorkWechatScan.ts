import { http } from '@/utils/request';
import { ORDINARY_WECHAT_SDK_URL,ordinaryWechatBrowser } from './ordinaryWechatShare';
interface CustomerWechatScanner {
  config(value:{debug:boolean;appId:string;timestamp:number;nonceStr:string;signature:string;jsApiList:string[]}):void;
  ready(callback:()=>void):void;error(callback:()=>void):void;
  scanQRCode(value:{needResult:1;scanType:string[];success:(result:{resultStr?:unknown})=>void;fail:()=>void;cancel:()=>void}):void;
}
let sdkPromise:Promise<CustomerWechatScanner>|null=null;
export const customerWorkWechatScannerAvailable=ordinaryWechatBrowser;
function validSdk(value:unknown):value is CustomerWechatScanner{return !!value&&typeof value==='object'&&['config','ready','error','scanQRCode'].every(key=>typeof (value as Record<string,unknown>)[key]==='function');}
function url(){const value=new URL(window.location.href);value.hash='';if(value.protocol!=='https:'||value.origin!==window.location.origin||value.username||value.password||value.href.length>4096)throw Error('微信扫码需要当前站点的安全 HTTPS 地址');return value.href;}
function sdk(){const wx=(window as Window&{wx?:unknown}).wx;if(validSdk(wx))return Promise.resolve(wx);if(sdkPromise)return sdkPromise;
  const promise=new Promise<CustomerWechatScanner>((resolve,reject)=>{const script=document.createElement('script');script.src=ORDINARY_WECHAT_SDK_URL;script.async=true;const timer=setTimeout(()=>{script.remove();reject(Error('微信扫码组件读取超时'));},10000);
    const finish=()=>{clearTimeout(timer);script.onload=null;script.onerror=null;};script.onload=()=>{finish();const loaded=(window as Window&{wx?:unknown}).wx;validSdk(loaded)?resolve(loaded):reject(Error('微信扫码组件不可用'));};script.onerror=()=>{finish();script.remove();reject(Error('微信扫码组件读取失败'));};document.head.appendChild(script);});
  sdkPromise=promise;void promise.catch(()=>{if(sdkPromise===promise)sdkPromise=null;});return promise;
}
export async function customerWorkWechatScan(current:()=>boolean,options:{scanTypes?:Array<'qrCode'|'barCode'>;rawResult?:boolean;readSignature?:(url:string)=>Promise<unknown>}={}):Promise<string|null>{
  if(options.scanTypes&&(!options.scanTypes.length||options.scanTypes.length>2||new Set(options.scanTypes).size!==options.scanTypes.length||options.scanTypes.some(type=>!['qrCode','barCode'].includes(type))))throw Error('微信扫码类型无效');
  // #ifdef H5
  if(!current()||!ordinaryWechatBrowser())return null;const signatureUrl=url(),same=()=>{try{return current()&&url()===signatureUrl;}catch{return false;}};
  const raw=await(options.readSignature?options.readSignature(signatureUrl):http.get<unknown>('/wechat/config',{url:signatureUrl}));if(!same())return null;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('微信扫码签名资料无效');const config=raw as Record<string,unknown>;
  if(typeof config.appId!=='string'||!/^wx[a-f0-9]{16}$/iu.test(config.appId)||typeof config.timestamp!=='number'||!Number.isSafeInteger(config.timestamp)||config.timestamp<1||typeof config.nonceStr!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(config.nonceStr)||typeof config.signature!=='string'||!/^[a-f0-9]{40}$/iu.test(config.signature))throw Error('微信扫码签名资料无效');
  const loaded=await sdk();if(!same())return null;
  return new Promise<string|null>((resolve,reject)=>{let done=false;const finish=(value:string|null,error?:Error)=>{if(done)return;done=true;clearTimeout(timer);if(!same())resolve(null);else if(error)reject(error);else resolve(value);};const timer=setTimeout(()=>finish(null,Error('微信扫码配置或扫描超时，请手动输入')),30000);
    try{loaded.error(()=>finish(null,Error('微信扫码配置失败，请手动输入')));loaded.ready(()=>{if(!same()){finish(null);return;}loaded.scanQRCode({needResult:1,scanType:options.scanTypes??['barCode'],success:result=>{const raw=result.resultStr;if(typeof raw!=='string'){finish(null,Error('微信扫码未返回有效条码'));return;}const comma=raw.indexOf(',');finish(options.rawResult?raw:comma>=0?raw.slice(comma+1):raw);},fail:()=>finish(null,Error('微信扫码失败，可手动输入')),cancel:()=>finish(null)});});loaded.config({debug:false,appId:config.appId as string,timestamp:config.timestamp as number,nonceStr:config.nonceStr as string,signature:config.signature as string,jsApiList:['scanQRCode']});}catch{finish(null,Error('微信扫码不可用，可手动输入'));}
  });
  // #endif
  // #ifndef H5
  return null;
  // #endif
}
