import axios from 'axios';
import { clearAuth, getAdminSession, getToken } from '@/utils/auth';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { previewMode, refundRequest, apiAdminRefundOperation } from './refund';
import { applyCreationFinancialResult, applyCreationResponse, creationFinancialIntent, creationSelection, creationVersion,
  parseCreationIntent, parseCreationQuote, verifyCreationIntent, type CreationIntent, type CreationMode, type CreationSelection } from '@/utils/refundCreation';

async function send(actorId: number, endpoint: string, body: unknown, signal?: AbortSignal, intent?: CreationIntent) {
  if(previewMode)throw Error('预览模式不提交主动退款，请连接隔离测试接口');
  const token=getToken(),scope=createAdminSessionScope(),abort=()=>scope.dispose();
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const owns=()=>scope.isCurrent() && getAdminSession()?.userInfo.id===actorId;
  try {
    if(!owns())throw Error('登录身份已变化，请重新打开主动退款');
    if(intent)await verifyCreationIntent(intent,actorId,intent.orderId);
    if(!owns())throw Error('登录身份已变化，请重新打开主动退款');
    const response=await refundRequest.post('/refund/creation/'+endpoint,body,{signal:scope.signal,headers:{
      'Authori-zation':'Bearer '+token,'X-Refund-Operation-Scope':'v1:admin:'+actorId,
      ...(intent?{'Idempotency-Key':intent.nonce}:{}),
    }});
    if(!owns())throw Error('登录身份已变化，原操作保留待核对');
    const value:unknown=response.data;
    if(!value || typeof value!=='object' || !('status' in value) || !('data' in value))throw Error('主动退款响应无效');
    if(value.status!==200) {
      if([410000,410001,410002].includes(Number(value.status))){clearAuth();window.dispatchEvent(new Event('admin-auth-expired'));}
      throw Error('msg' in value && typeof value.msg==='string'?value.msg:'主动退款未得到有效回执');
    }
    return value.data;
  } catch(error) {
    if(owns() && axios.isAxiosError(error) && error.response?.status===401){clearAuth();window.dispatchEvent(new Event('admin-auth-expired'));}
    throw error;
  } finally {signal?.removeEventListener('abort',abort);scope.dispose();}
}
export async function apiCreationQuote(actorId: number, selection: CreationSelection, signal?: AbortSignal) {
  const input=creationSelection(selection.orderId,selection.mode,selection.items);
  return parseCreationQuote(await send(actorId,'quote',input,signal),input);
}
export async function apiCreationAction(input: CreationIntent, mode: CreationMode, signal?: AbortSignal) {
  if(!['create','execute','receipt','abandon'].includes(mode))throw Error('主动退款操作方式无效');
  const intent=parseCreationIntent(input,input.actorId,input.orderId);
  return applyCreationResponse(intent,await send(intent.actorId,mode,mode==='receipt'?{version:creationVersion}:intent.body,signal,intent),mode);
}
export async function apiCreationFinancialReceipt(input: CreationIntent, signal?: AbortSignal) {
  const intent=await verifyCreationIntent(input,input.actorId,input.orderId);
  const operation=await creationFinancialIntent(intent);
  return applyCreationFinancialResult(intent,await apiAdminRefundOperation(operation,'receipt',signal));
}
