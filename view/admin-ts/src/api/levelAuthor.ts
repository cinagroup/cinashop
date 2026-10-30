import request,{getData} from '@/utils/request';
import type {LevelAction} from '../../../common/levelAuthor';
export const apiLevelCatalog=(signal?:AbortSignal)=>getData<unknown>(request.get('/level/catalog',{signal}));
export const apiLevelWrite=(action:LevelAction,signal?:AbortSignal)=>getData<unknown>(request.post('/level/author/commit',action,{signal}));
export const apiLevelReceipt=(action:LevelAction,signal?:AbortSignal)=>getData<unknown>(request.get(`/level/author/receipt/${action.operation_id}`,{signal}));
export const apiLevelResolve=(action:LevelAction,signal?:AbortSignal)=>getData<unknown>(request.post('/level/author/resolve',action,{signal}));
export const apiLevelImageOptions=(params:Record<string,unknown>,signal?:AbortSignal)=>getData<unknown>(request.get('/level/attachment-options',{params,signal}));
export const apiLevelImageCategories=(signal?:AbortSignal)=>getData<unknown>(request.get('/level/attachment-categories',{signal}));
