import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {unitAction,unitCanonical,type UnitAction} from '../../../../view/common/unitAuthor';

export function unitInput<T>(run:()=>T):T {
  try{return run();}catch(error){throw new ValidateException(error instanceof Error?error.message:'商品单位参数无效');}
}
export function unitActionHash(action:Omit<UnitAction,'payload_hash'>) {
  return createHash('sha256').update(JSON.stringify(unitCanonical(action))).digest('hex');
}
export function unitRequest(value:unknown,actor:number) {
  return unitInput(()=>{
    const action=unitAction(value,actor);
    if(unitActionHash(action)!==action.payload_hash)throw Error('原商品单位内容或摘要已变化');
    return action;
  });
}
export function unitQuery(query:URLSearchParams) {
  if([...query].length)throw new ValidateException('商品单位作者不接受查询参数');
}
