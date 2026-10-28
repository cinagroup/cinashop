import type { Context } from 'hono';
import type { AppVariables,Env } from '@/env';
import { jsonOk,jsonFail } from '@/utils/json';
import { withdrawalView,withdrawalReceiptQuery,withdrawalMediaQuery } from '@/services/user/UserWithdrawalApplicationInput';
import { UserWithdrawalApplicationService } from '@/services/user/UserWithdrawalApplicationService';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
export async function bank(c:C){c.header('Cache-Control','private, no-store');const uid=c.get('uid');if(!uid)return jsonFail(c,'请先登录');const service=new UserWithdrawalApplicationService(c.get('container'),c.env.APP_KEY);if(new URL(c.req.url).searchParams.get('view')==='withdrawal_media')return jsonOk(c,await service.media(uid,withdrawalMediaQuery(c.req.raw)));withdrawalView(c.req.raw,'withdrawal_application');return jsonOk(c,await service.config(uid));}
export async function records(c:C){c.header('Cache-Control','private, no-store');const uid=c.get('uid');if(!uid)return jsonFail(c,'请先登录');return jsonOk(c,await new UserWithdrawalApplicationService(c.get('container'),c.env.APP_KEY).receipt(uid,withdrawalReceiptQuery(c.req.raw)));}
