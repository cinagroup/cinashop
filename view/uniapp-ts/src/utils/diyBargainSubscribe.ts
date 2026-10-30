import { http } from '@/utils/request';
export type BargainTemplateId = string;
/** Server values are provider IDs, never the short administrative template keys.
 * This read is prepared before a tap, since the native API requires a gesture.
 * https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html */
export function checkedBargainTemplateId(raw: unknown): BargainTemplateId | null {
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
 const source=raw as Record<string,unknown>,id=source.bargain_success;
 return typeof id==='string'&&id.length>0&&id.length<=256&&id.trim()===id&&!/[\s\u0000-\u001f\u007f]/u.test(id)?id:null;
}
export const readBargainTemplateId = async () => checkedBargainTemplateId(await http.get<unknown>('/wechat/teml_ids',{}, {noAuth:true}));
export function bargainWechatPlatform() {
 let enabled=false;
 // #ifdef MP-WEIXIN
 enabled=true;
 // #endif
 return enabled;
}
/** Call synchronously from the original tap. A refusal, filter, failure, or
 * unavailable SDK must not prevent access to activity details. Each invocation
 * settles once; the caller owns its live-context/navigation guard. */
export function requestBargainSubscription(id: BargainTemplateId|null, current:()=>boolean, settled:()=>void) {
 if (!current()) return;
 let finished=false;
 const done=()=>{if(finished)return;finished=true;if(current())settled();};
 // #ifdef MP-WEIXIN
 if (id && typeof uni.requestSubscribeMessage==='function') {
  try { uni.requestSubscribeMessage({tmplIds:[id],success:done,fail:done}); } catch { done(); }
  return;
 }
 // #endif
 done();
}
