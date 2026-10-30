import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {productLabelAction,productLabelCanonical,type ProductLabelAction} from '../../../../view/common/productLabelAuthor';

export function productLabelInput<T>(run:()=>T):T {
  try{return run();}catch(error){throw new ValidateException(error instanceof Error?error.message:'商品标签参数无效');}
}
export function productLabelActionHash(action:Omit<ProductLabelAction,'payload_hash'>) {
  return createHash('sha256').update(JSON.stringify(productLabelCanonical(action))).digest('hex');
}
export function productLabelRequest(value:unknown,actor:number) {
  return productLabelInput(()=>{
    const action=productLabelAction(value,actor);
    if(productLabelActionHash(action)!==action.payload_hash)throw Error('原商品标签内容或摘要已变化');
    return action;
  });
}
export function productLabelQuery(query:URLSearchParams) {
  if([...query].length)throw new ValidateException('商品标签作者不接受查询参数');
}
