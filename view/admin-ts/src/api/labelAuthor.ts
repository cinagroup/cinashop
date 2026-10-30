import request,{getData} from '@/utils/request';
import type {LabelAction} from '../../../common/labelAuthor';
export const apiLabelCatalog=(signal:AbortSignal)=>getData(request.get('/user_label/catalog',{signal}));
export const apiLabelCommit=(a:LabelAction,signal:AbortSignal)=>getData(request.post('/user_label/author/commit',a,{signal}));
export const apiLabelReceipt=(a:LabelAction,signal:AbortSignal)=>getData(request.get(`/user_label/author/receipt/${a.operation_id}`,{signal}));
export const apiLabelResolve=(a:LabelAction,signal:AbortSignal)=>getData(request.post('/user_label/author/resolve',a,{signal}));
export const apiLabelAdvance=(a:LabelAction,signal:AbortSignal)=>getData(request.post('/user_label/sync/advance',a,{signal}));
