import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {hotwordAction,hotwordCanonical,type HotwordAction} from '../../../../view/common/hotwordAuthor';

export function hotwordInput<T>(run:()=>T):T {
  try{return run();}catch(error){throw new ValidateException(error instanceof Error?error.message:'搜索热词参数无效');}
}
export function hotwordActionHash(action:Omit<HotwordAction,'payload_hash'>) {
  return createHash('sha256').update(JSON.stringify(hotwordCanonical(action))).digest('hex');
}
export function hotwordRequest(value:unknown,actor:number) {
  return hotwordInput(()=>{
    const action=hotwordAction(value,actor);
    if(hotwordActionHash(action)!==action.payload_hash)throw Error('原搜索热词内容或摘要已变化');
    return action;
  });
}
export function hotwordQuery(query:URLSearchParams) {
  if([...query].length)throw new ValidateException('搜索热词作者不接受查询参数');
}
