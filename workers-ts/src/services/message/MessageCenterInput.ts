import { AuthException, ValidateException } from '@/utils/errors';

export type MessageView = 'center' | 'list' | 'detail';
export interface MessageQuery { modern: boolean; page: number; limit: number; pc?: true }
export interface MessageActor { uid: number; pwd: string }
const views: Record<MessageView,string> = {center:'message_center',list:'system_messages',detail:'system_message_detail'};
export const MESSAGE_MAX_BYTES = 1024 * 1024;
export function messageInteger(value: unknown, name: string, minimum=0, maximum=2147483647): number {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<minimum||value>maximum)throw new ValidateException(name+'无效');return value;
}
export function messageActor(uid: unknown, account: unknown): MessageActor {
 if(!account||typeof account!=='object')throw new AuthException();
 const row=account as Record<string,unknown>;
 if(typeof uid!=='number'||row.uid!==uid||!Number.isSafeInteger(uid)||uid<=0||uid>2147483647||typeof row.pwd!=='string'||row.pwd.length>256)throw new AuthException();
 return {uid,pwd:row.pwd};
}
export function parseMessageQuery(kind: MessageView, params: URLSearchParams): MessageQuery {
 let modern=false,pc=false;const allowed=kind==='detail'?['view']:['view','page','limit'];
 for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)throw new ValidateException('消息查询参数无效');
 if(params.has('view')){
  const value=params.get('view');
  pc=kind==='center'&&value==='pc_message_summary'||kind==='list'&&value==='pc_system_messages';
  if(value!==views[kind]&&!pc)throw new ValidateException('消息视图无效');modern=true;
 }
 function number(key:string,fallback:number,max:number){const raw=params.get(key);if(raw===null)return fallback;if(!/^[1-9]\d*$/u.test(raw))throw new ValidateException('消息分页无效');const n=Number(raw);return messageInteger(n,'消息分页',1,max);}
 if(pc&&kind==='center'&&(params.has('page')||params.has('limit')))throw new ValidateException('消息摘要不接受分页');
 const page=kind==='detail'?1:number('page',1,pc?2147483647:1000),limit=kind==='detail'?1:number('limit',pc?7:20,100);
 if(pc&&kind==='list'&&limit!==7)throw new ValidateException('PC消息每页为7条');
 return {modern,page,limit,...(pc?{pc:true as const}:{})};
}
export function parseMessageId(value: unknown): number {
 if(typeof value!=='string'||!/^[1-9]\d*$/u.test(value))throw new ValidateException('消息ID无效');return messageInteger(Number(value),'消息ID',1);
}
export function messageText(value: unknown, name: string, max: number): string {
 if(value===null&&name==='消息正文')return '';
 if(typeof value!=='string'||value.length>max||new TextEncoder().encode(value).length>max*4||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))throw new ValidateException(name+'超出完整读取范围');return value;
}
export function assertMessageBytes(value: unknown){if(new TextEncoder().encode(JSON.stringify(value)).length>MESSAGE_MAX_BYTES)throw new ValidateException('消息超过完整读取容量');}
/** Literal PHP app/common.php time_tran units and first nonzero floor; no host timezone. */
export function phpMessageTime(at:number,now:number):string|null {
 for(const [seconds,unit] of [[31536000,'年'],[2592000,'个月'],[604800,'星期'],[86400,'天'],[3600,'小时'],[60,'分钟'],[1,'秒']] as const){const amount=Math.floor((now-at)/seconds);if(amount!==0)return amount+unit+'前';}return null;
}
