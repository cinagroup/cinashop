import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {ruleAction,ruleCanonical,type RuleAction} from '../../../../view/common/ruleAuthor';

export function ruleInput<T>(run:()=>T):T {
  try{return run();}catch(error){throw new ValidateException(error instanceof Error?error.message:'规格模板参数无效');}
}
export function ruleActionHash(action:Omit<RuleAction,'payload_hash'>) {
  return createHash('sha256').update(JSON.stringify(ruleCanonical(action))).digest('hex');
}
export function ruleRequest(value:unknown,actor:number) {
  return ruleInput(()=>{
    const action=ruleAction(value,actor);
    if(ruleActionHash(action)!==action.payload_hash)throw Error('原规格模板内容或摘要已变化');
    return action;
  });
}
export function ruleQuery(query:URLSearchParams) {
  if([...query].length)throw new ValidateException('规格模板作者不接受查询参数');
}
