import request,{getData} from '@/utils/request';
import type {ProductLabelAction} from '../../../common/productLabelAuthor';
const base='/product/label/author';
export const apiProductLabelAuthorCatalog=(signal?:AbortSignal)=>getData<unknown>(request.get(`${base}/catalog`,{signal}));
export const apiProductLabelAuthorCommit=(action:ProductLabelAction,signal?:AbortSignal)=>getData<unknown>(request.post(`${base}/commit`,action,{signal}));
export const apiProductLabelAuthorReceipt=(action:ProductLabelAction,signal?:AbortSignal)=>getData<unknown>(request.get(`${base}/receipt/${action.operation_id}`,{signal}));
export const apiProductLabelAuthorResolve=(action:ProductLabelAction,signal?:AbortSignal)=>getData<unknown>(request.post(`${base}/resolve`,action,{signal}));
export const apiProductLabelAuthorAttachmentCategories=(signal?:AbortSignal)=>getData<unknown>(request.get(`${base}/attachments/categories`,{signal}));
export const apiProductLabelAuthorAttachmentOptions=(params:{page:number;limit:number;pid:number;name:string},signal?:AbortSignal)=>getData<unknown>(request.get(`${base}/attachments/options`,{params,signal}));
