import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { pcBannerRequestId } from './AdminPcBannerInput';
import { isUserCenterDesignValue,userCenterDesignPayload } from '../../../../view/common/userCenterDesign';
export const userCenterDesignOperationId=pcBannerRequestId;
export function userCenterDesignInput(input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ValidateException('个人中心设计须为JSON对象');
  const body=input as Record<string,unknown>;
  if(Object.keys(body).length!==3||Object.keys(body).some(key=>!['operationId','revision','value'].includes(key)))throw new ValidateException('须完整提交个人中心设计');
  const operationId=userCenterDesignOperationId(body.operationId);
  if(typeof body.revision!=='string'||!/^[a-f0-9]{64}$/.test(body.revision)||!isUserCenterDesignValue(body.value))throw new ValidateException('个人中心设计或版本无效');
  return{operationId,canonical:userCenterDesignPayload(body.revision,body.value)};
}
export class UserCenterDesignStaleVersion extends ValidateException{readonly operation='update';constructor(public readonly operationId:string,public readonly payloadHash:string){super('个人中心设计已变化，请重新读取并确认');}}
export class UserCenterDesignRejected extends ValidateException{readonly operation='update';constructor(public readonly operationId:string,public readonly payloadHash:string,message='个人中心三项配置异常，不能自动覆盖'){super(message);}}
export async function readUserCenterDesignBody(request:Request){return parseLevelActivationJson(await readBoundedUtf8Text(request,512*1024));}
