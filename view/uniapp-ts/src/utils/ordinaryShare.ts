import { integralSiteOrigin } from '../../../common/integralPurchase';
export function ordinarySharePath(id:number,uid=0):string{
  if(!Number.isSafeInteger(id)||id<1||id>2147483647||!Number.isSafeInteger(uid)||uid<0||uid>2147483647)return '';
  return `/pages/goods/detail?id=${id}${uid?`&spid=${uid}`:''}`;
}
export function ordinaryShareUrl(path:string,siteUrl:string):string{
  if(!/^\/pages\/goods\/detail\?id=[1-9]\d*(?:&spid=[1-9]\d*)?$/u.test(path))return '';
  // #ifdef H5
  if(typeof window!=='undefined'){try{const url=new URL(window.location.href);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password){url.search='';url.hash=path;return url.href;}}catch{return '';}}
  // #endif
  const origin=integralSiteOrigin(siteUrl);return origin?`${origin}/#${path}`:'';
}
export function ordinaryReferral(value:unknown):number{if(value===undefined||value==='')return 0;if(typeof value!=='string'||!(/^[1-9]\d*$/u.test(value))||Number(value)>2147483647)throw Error('推荐人链接无效');return Number(value);}
export function ordinaryShareRoute(options:{id?:unknown;spid?:unknown;scene?:unknown}|undefined):{id:unknown;spid:unknown}{
  if(options?.scene===undefined)return{id:options?.id,spid:options?.spid};
  if(options.id!==undefined||options.spid!==undefined||typeof options.scene!=='string'||options.scene.length>96)throw Error('微信商品场景参数无效');
  let scene:string;try{scene=decodeURIComponent(options.scene);}catch{throw Error('微信商品场景参数无效');}
  if(new TextEncoder().encode(scene).byteLength>32||!/^id=[1-9]\d*(?:&spid=[1-9]\d*)?$/u.test(scene))throw Error('微信商品场景参数无效');
  const query=new URLSearchParams(scene),id=query.get('id'),spid=query.get('spid')??undefined;
  if(!id||Number(id)>2147483647)throw Error('微信商品场景标识无效');ordinaryReferral(spid);return{id,spid};
}
export function shareOrdinaryInApp(options:{url:string;title:string;image:string;summary:string},scene:'WXSceneSession'|'WXSceneTimeline',complete:(message:string)=>void,current:()=>boolean){
  if(!current())return;if(!options.url){complete('商家尚未配置可分享的商品网页');return;}
  if(typeof uni.getProvider!=='function'||typeof uni.share!=='function'){complete('当前平台不支持微信应用分享');return;}
  uni.getProvider({service:'share',success:result=>{if(!current())return;if(!result.provider.some(provider=>provider==='weixin')){complete('当前设备没有可用的微信分享服务');return;}
    uni.share({provider:'weixin',scene,type:0,href:options.url,title:options.title,summary:options.summary,imageUrl:options.image,success:()=>{if(current())complete('已调用微信分享');},fail:()=>{if(current())complete('微信分享失败，请重试');}});
  },fail:()=>{if(current())complete('读取分享服务失败，请重试');}});
}
