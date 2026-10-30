import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {groupAction,groupCanonical,type GroupAction} from '../../../../view/common/groupAuthor';

export function groupInput<T>(run:()=>T):T {
  try{return run();}catch(error){throw new ValidateException(error instanceof Error?error.message:'用户分组参数无效');}
}
export function groupActionHash(action:Omit<GroupAction,'payload_hash'>) {
  return createHash('sha256').update(JSON.stringify(groupCanonical(action))).digest('hex');
}
export function groupRequest(value:unknown,actor:number) {
  return groupInput(()=>{
    const action=groupAction(value,actor);
    if(groupActionHash(action)!==action.payload_hash)throw Error('原用户分组内容或摘要已变化');
    return action;
  });
}
export function groupQuery(query:URLSearchParams) {
  if([...query].length)throw new ValidateException('用户分组作者不接受查询参数');
}
