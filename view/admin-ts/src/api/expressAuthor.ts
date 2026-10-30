import request,{getData} from '@/utils/request';
import type {ExpressTicket} from '../../../common/expressAuthor';
export const apiExpressCatalog=(signal?:AbortSignal)=>getData<unknown>(request.get('/express/catalog',{signal}));
export const apiExpressPrepare=(input:unknown,signal?:AbortSignal)=>getData<unknown>(request.post('/express/author/prepare',input,{signal}));
export const apiExpressCommit=(ticket:ExpressTicket,payload:unknown,signal?:AbortSignal)=>getData<unknown>(request.post('/express/author/commit',{seal:ticket.seal,payload},{signal}));
export const apiExpressReceipt=(ticket:ExpressTicket,signal?:AbortSignal)=>getData<unknown>(request.get(`/express/author/receipt/${ticket.operation_id}`,{signal}));
export const apiExpressResolve=(ticket:ExpressTicket,signal?:AbortSignal)=>getData<unknown>(request.post('/express/author/resolve',{seal:ticket.seal},{signal}));
