import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {parameterAction,parameterCanonical,type ParameterAction} from '../../../../view/common/parameterAuthor';

export function parameterInput<T>(run:()=>T):T {
  try{return run();}catch(error){throw new ValidateException(error instanceof Error?error.message:'参数模板参数无效');}
}
export function parameterActionHash(action:Omit<ParameterAction,'payload_hash'>) {
  return createHash('sha256').update(JSON.stringify(parameterCanonical(action))).digest('hex');
}
export function parameterRequest(value:unknown,actor:number) {
  return parameterInput(()=>{
    const action=parameterAction(value,actor);
    if(parameterActionHash(action)!==action.payload_hash)throw Error('原参数模板内容或摘要已变化');
    return action;
  });
}
export function parameterQuery(query:URLSearchParams) {
  if([...query].length)throw new ValidateException('参数模板作者不接受查询参数');
}
