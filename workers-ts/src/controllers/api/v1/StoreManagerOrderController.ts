import type { Context } from 'hono';
import type { AppVariables,Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { StoreManagerOrderReadService,type ManagerOrderActionReader } from '@/services/store/StoreManagerOrderReadService';
import { StoreManagerOrderStatisticsService,type MANAGER_UNAVAILABLE_CAPABILITIES } from '@/services/store/StoreManagerOrderStatisticsService';
import type { StoreManagerScope } from '@/services/store/StoreManagerScope';
import { storeManagerFulfillmentActions } from '@/services/store/StoreManagerOrderOperationService';
import { managerFinancialActionAvailability } from '@/services/store/StoreManagerFinancialService';
import { managerOperationReadiness } from '@/services/store/ManagerOrderOperationRequest';
import { managerOperationActor } from './StoreManagerOrderOperationController';
import { jsonOk } from '@/utils/json';

type C=Context<{Bindings:Env;Variables:AppVariables}>;
function privateResponse(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');}
async function capabilities(db:DbClient,_scope:StoreManagerScope):Promise<typeof MANAGER_UNAVAILABLE_CAPABILITIES>{const readiness=await managerOperationReadiness(db);return{remark:readiness.available,change_price:readiness.available,confirm_offline:readiness.available,manual_delivery:readiness.available,split_delivery:readiness.available,electronic_waybill:false,refund_create:readiness.available,refund_decide:readiness.available,tracking:true,writeoff:false};}
function services(c:C){privateResponse(c);const actor=managerOperationActor(c),container=c.get('container');
  const actions:ManagerOrderActionReader=async(db,scope,order)=>{const readiness=await managerOperationReadiness(db),fulfillment=await storeManagerFulfillmentActions(db,scope,order),financial=await managerFinancialActionAvailability(db,scope,order,c.env),merged={...fulfillment,...financial,tracking:{available:order.deliveryType==='express'||order.deliveryType==='split'||order.pid===-1,reason:order.deliveryType==='express'||order.deliveryType==='split'||order.pid===-1?'':'该订单没有快递物流'},writeoff:{available:false,reason:'核销须独立当前核销身份与验证码授权'}};
    if(!readiness.available)for(const key of ['remark','manual_delivery','split_delivery','change_price','confirm_offline','refund_create','refund_decide'] as const)merged[key]={available:false,reason:readiness.reason};return merged;};
  return{uid:actor.uid,read:new StoreManagerOrderReadService(container,c.env,actions),statistics:new StoreManagerOrderStatisticsService(container,capabilities)};
}
export async function context(c:C){const s=services(c);return jsonOk(c,await s.statistics.context(s.uid,c.req.query()));}
export async function statistics(c:C){const s=services(c);return jsonOk(c,await s.statistics.statistics(s.uid,c.req.query()));}
export async function time(c:C){const s=services(c);return jsonOk(c,await s.statistics.time(s.uid,c.req.query()));}
export async function chart(c:C){const s=services(c);return jsonOk(c,await s.statistics.chart(s.uid,c.req.query()));}
export async function daily(c:C){const s=services(c);return jsonOk(c,await s.statistics.daily(s.uid,c.req.query()));}
export async function list(c:C){const s=services(c);return jsonOk(c,await s.read.list(s.uid,c.req.query()));}
export async function detail(c:C){const s=services(c);return jsonOk(c,await s.read.detail(s.uid,c.req.param('id'),c.req.query()));}
export async function deliveryGain(c:C){const s=services(c);return jsonOk(c,await s.read.deliveryGain(s.uid,c.req.param('id'),c.req.query()));}
export async function splitCartInfo(c:C){const s=services(c);return jsonOk(c,await s.read.splitCartInfo(s.uid,c.req.param('id'),c.req.query()));}
export async function deliveryDefaults(c:C){const s=services(c);return jsonOk(c,await s.read.deliveryDefaults(s.uid,c.req.query()));}
export async function carriers(c:C){const s=services(c);return jsonOk(c,await s.read.carriers(s.uid,c.req.query()));}
export async function deliveryAgents(c:C){const s=services(c);return jsonOk(c,await s.read.deliveryAgents(s.uid,c.req.query()));}
export async function express(c:C){const s=services(c);return jsonOk(c,await s.read.express(s.uid,c.req.param('id'),c.req.query()));}
