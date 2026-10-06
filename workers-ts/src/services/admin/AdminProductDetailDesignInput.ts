import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { pcBannerRequestId } from './AdminPcBannerInput';
import { isProductDetailDesignValue,productDetailDesignPayload } from '../../../../view/common/productDetailDesign';
export const productDetailDesignOperationId=pcBannerRequestId;
export function productDetailDesignInput(input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ValidateException('商品详情设计请求须为JSON对象');
  const raw=input as Record<string,unknown>,keys=['operationId','revision','value'];
  if(Object.keys(raw).length!==keys.length||Object.keys(raw).some(key=>!keys.includes(key)))throw new ValidateException('须完整提交商品详情设计字段');
  const operationId=productDetailDesignOperationId(raw.operationId);
  if(typeof raw.revision!=='string'||!/^[a-f0-9]{64}$/.test(raw.revision)||!isProductDetailDesignValue(raw.value))throw new ValidateException('商品详情设计或版本无效');
  return {operationId,canonical:productDetailDesignPayload(raw.revision,raw.value)};
}
export class ProductDetailDesignStaleVersion extends ValidateException{
  readonly operation='update';constructor(public readonly operationId:string,public readonly payloadHash:string){super('商品详情设计已变化，请重新读取并确认');}
}
export class ProductDetailDesignRejected extends ValidateException{
  readonly operation='update';constructor(public readonly operationId:string,public readonly payloadHash:string){super('商品详情模板异常，不能自动覆盖导入数据');}
}
export async function readProductDetailDesignBody(request:Request){return parseLevelActivationJson(await readBoundedUtf8Text(request,8192));}
