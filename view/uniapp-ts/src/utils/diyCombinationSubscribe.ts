import { http } from '@/utils/request';
export type CombinationTemplateIds = readonly [string, string];
/** Server values are provider IDs, never the short administrative template keys.
 * This read is prepared before a tap, since the native API requires a gesture.
 * https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html */
export function checkedCombinationTemplateIds(raw: unknown): CombinationTemplateIds | null {
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
 const source=raw as Record<string, unknown>, ids=[source.pink_true,source.pink_status];
 if (!ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=256&&id.trim()===id&&!/[\s\u0000-\u001f\u007f]/u.test(id)) || ids[0]===ids[1]) return null;
 return ids as [string,string];
}
export const readCombinationTemplateIds = async () => checkedCombinationTemplateIds(await http.get<unknown>('/wechat/teml_ids',{}, {noAuth:true}));
export function combinationWechatPlatform() {
 let enabled=false;
 // #ifdef MP-WEIXIN
 enabled=true;
 // #endif
 return enabled;
}
/** Call synchronously from the original tap. A refusal, filter, failure, or
 * unavailable SDK must not prevent access to activity details. Each invocation
 * settles once; the caller owns its live-context/navigation guard. */
export function requestCombinationSubscription(ids: CombinationTemplateIds|null, current:()=>boolean, settled:()=>void) {
 if (!current()) return;
 let finished=false;
 const done=()=>{if(finished)return;finished=true;if(current())settled();};
 // #ifdef MP-WEIXIN
 if (ids && typeof uni.requestSubscribeMessage==='function') {
  try { uni.requestSubscribeMessage({tmplIds:[...ids],success:done,fail:done}); } catch { done(); }
  return;
 }
 // #endif
 done();
}
