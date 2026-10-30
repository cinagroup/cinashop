import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {ensureAction,ensureCanonical,type EnsureAction} from '../../../../view/common/ensureAuthor';

export function ensureInput<T>(run:()=>T):T {
  try{return run();}catch(error){throw new ValidateException(error instanceof Error?error.message:'商品保障参数无效');}
}
export function ensureActionHash(action:Omit<EnsureAction,'payload_hash'>) {
  return createHash('sha256').update(JSON.stringify(ensureCanonical(action))).digest('hex');
}
export function ensureRequest(value:unknown,actor:number) {
  return ensureInput(()=>{
    const action=ensureAction(value,actor);
    if(ensureActionHash(action)!==action.payload_hash)throw Error('原商品保障内容或摘要已变化');
    return action;
  });
}
export function ensureQuery(query:URLSearchParams) {
  if([...query].length)throw new ValidateException('商品保障作者不接受查询参数');
}
