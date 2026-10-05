import { http } from '@/utils/request';

interface WechatShareData { title:string;desc:string;link:string;imgUrl:string;success?:()=>void;fail?:()=>void }
export interface OrdinaryWechatSdk {
  config(options:{debug:boolean;appId:string;timestamp:number;nonceStr:string;signature:string;jsApiList:string[]}):void;
  ready(callback:()=>void):void; error(callback:(error:unknown)=>void):void;
  updateAppMessageShareData(options:WechatShareData):void;updateTimelineShareData(options:WechatShareData):void;
  onMenuShareAppMessage?(options:WechatShareData):void;onMenuShareTimeline?(options:WechatShareData):void;
}
interface WechatWindow extends Window { wx?:OrdinaryWechatSdk }
export const ORDINARY_WECHAT_SDK_URL='https://res.wx.qq.com/open/js/jweixin-1.6.0.js';
let scriptPromise:Promise<OrdinaryWechatSdk>|null=null;
export function ordinaryWechatBrowser():boolean{
  // #ifdef H5
  return typeof window!=='undefined'&&/MicroMessenger/iu.test(window.navigator.userAgent);
  // #endif
  // #ifndef H5
  return false;
  // #endif
}
function signingUrl():string{
  if(typeof window==='undefined')throw Error('当前平台不是微信网页');
  const current=new URL(window.location.href);current.hash='';
  if(current.protocol!=='https:'||current.username||current.password||current.origin!==window.location.origin||current.href.length>4096)throw Error('微信网页分享需要当前站点的安全 HTTPS 地址');
  return current.href;
}
function usableSdk(value:unknown):value is OrdinaryWechatSdk{
  if(!value||typeof value!=='object')return false;
  const sdk=value as Record<string,unknown>;
  return ['config','ready','error','updateAppMessageShareData','updateTimelineShareData'].every(method=>typeof sdk[method]==='function')
    &&['onMenuShareAppMessage','onMenuShareTimeline'].every(method=>sdk[method]===undefined||typeof sdk[method]==='function');
}
function loadSdk():Promise<OrdinaryWechatSdk>{
  const browser=window as WechatWindow;if(usableSdk(browser.wx))return Promise.resolve(browser.wx);
  if(scriptPromise)return scriptPromise;
  const promise=new Promise<OrdinaryWechatSdk>((resolve,reject)=>{
    const script=document.createElement('script');script.src=ORDINARY_WECHAT_SDK_URL;script.async=true;
    const timer=setTimeout(()=>{script.remove();reject(Error('微信分享组件读取超时，请重试'));},10000);
    const finish=()=>{clearTimeout(timer);script.onload=null;script.onerror=null;};
    script.onload=()=>{finish();usableSdk(browser.wx)?resolve(browser.wx):reject(Error('微信分享组件不可用，请重试'));};
    script.onerror=()=>{finish();script.remove();reject(Error('微信分享组件读取失败，请重试'));};
    document.head.appendChild(script);
  });
  scriptPromise=promise;void promise.catch(()=>{if(scriptPromise===promise)scriptPromise=null;});return promise;
}
function configData(value:unknown):{appId:string;timestamp:number;nonceStr:string;signature:string}{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('微信分享签名资料无效');
  const row=value as Record<string,unknown>;
  if(typeof row.appId!=='string'||!/^wx[a-f0-9]{16}$/iu.test(row.appId)||typeof row.timestamp!=='number'||!Number.isSafeInteger(row.timestamp)||row.timestamp<1||row.timestamp>2147483647
    ||typeof row.nonceStr!=='string'||!row.nonceStr||row.nonceStr.length>128||/[^A-Za-z0-9_-]/u.test(row.nonceStr)||typeof row.signature!=='string'||!(/^[a-f0-9]{40}$/iu.test(row.signature)))throw Error('微信分享签名资料无效');
  return {appId:row.appId,timestamp:row.timestamp,nonceStr:row.nonceStr,signature:row.signature};
}
/** Configure genuine JS-SDK sharing. A stale page never registers a replacement actor's metadata. */
export async function configureOrdinaryWechatShare(data:{url:string;title:string;image:string;summary:string},current:()=>boolean,complete:(message:string)=>void):Promise<void>{
  if(!current()||!ordinaryWechatBrowser())return;
  try{
    const signatureUrl=signingUrl(),link=new URL(data.url);
    if(link.origin!==window.location.origin||link.protocol!=='https:'||link.username||link.password)throw Error('微信分享链接与当前安全站点不一致');
    const config=configData(await http.get<unknown>('/wechat/config',{url:signatureUrl}));if(!current()||signingUrl()!==signatureUrl)return;
    const sdk=await loadSdk();if(!current()||signingUrl()!==signatureUrl)return;
    await new Promise<void>(resolve=>{
      const same=()=>{if(!current())return false;try{return signingUrl()===signatureUrl;}catch{return false;}};
      let finished=false;const finish=(message:string)=>{if(finished)return;finished=true;clearTimeout(timer);if(same())complete(message);resolve();};
      const timer=setTimeout(()=>finish('微信分享配置超时，请重试'),10000);
      try{sdk.error(()=>finish('微信分享配置失败，请重试'));
        sdk.ready(()=>{
        if(!same()){finish('');return;}
        try{const options:WechatShareData={title:data.title,desc:data.summary,link:data.url,imgUrl:data.image,fail:()=>{if(same())complete('微信分享资料设置失败，请重试');}};
          sdk.updateAppMessageShareData(options);sdk.updateTimelineShareData(options);sdk.onMenuShareAppMessage?.(options);sdk.onMenuShareTimeline?.(options);finish('微信分享已准备，可使用微信菜单发送给朋友或朋友圈');
        }catch{finish('微信分享资料设置失败，请重试');}
      });
        sdk.config({debug:false,...config,jsApiList:['updateAppMessageShareData','updateTimelineShareData','onMenuShareAppMessage','onMenuShareTimeline']});}
      catch{finish('微信分享配置失败，请重试');}
    });
  }catch(error){if(current())complete(error instanceof Error?error.message:'微信分享准备失败，请重试');}
}
