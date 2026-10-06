import type {Context} from 'hono';
import type {Env,AppVariables} from '@/env';
import {jsonOk} from '@/utils/json';
import {ValidateException} from '@/utils/errors';
import {readBoundedUtf8Text} from '@/utils/request-body';
import {customerWorkActor} from './CustomerWorkController';
import {CustomerWorkUserReadService,customerUserQuery} from '@/services/customer-work/CustomerWorkUserReadService';
import {CustomerWorkUserOperationService} from '@/services/customer-work/CustomerWorkUserOperationService';
import type {CustomerUserOperationKind} from '@/services/customer-work/CustomerWorkUserOperationRequest';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function input(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');if(Object.values(c.req.queries()).some(v=>v.length!==1))throw new ValidateException('用户查询参数不能重复');return{actor:customerWorkActor(c),query:c.req.query(),reader:new CustomerWorkUserReadService(c.get('container'),c.env),writer:new CustomerWorkUserOperationService(c.get('container'))};}
async function body(c:C){if(new URL(c.req.url).search||!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'')||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('用户操作仅接受无查询参数的UTF-8 JSON');const raw=await readBoundedUtf8Text(c.req.raw,262144);try{return JSON.parse(raw) as unknown;}catch{throw new ValidateException('用户操作JSON无效');}}
async function write(c:C,kind:CustomerUserOperationKind){const s=input(c);return jsonOk(c,await s.writer.execute(kind,{actor:s.actor,request_key:c.req.header('Idempotency-Key')??''},await body(c)));}
export async function userList(c:C){const s=input(c);return jsonOk(c,await s.reader.list(s.actor,s.query));}
export async function userGroups(c:C){const s=input(c);return jsonOk(c,await s.reader.groups(s.actor,s.query));}
export async function userLevels(c:C){const s=input(c);return jsonOk(c,await s.reader.levels(s.actor,s.query));}
export async function userLabels(c:C){const s=input(c);return jsonOk(c,await s.reader.labels(s.actor,s.query));}
export async function couponGrants(c:C){const s=input(c);return jsonOk(c,await s.reader.couponGrants(s.actor,s.query));}
export async function userDetail(c:C){const s=input(c);return jsonOk(c,await s.reader.detail(s.actor,c.req.param('uid'),s.query));}
export async function userCoupons(c:C){const s=input(c);return jsonOk(c,await s.reader.coupons(s.actor,c.req.param('uid'),s.query));}
export async function replaceUserLevel(c:C){return write(c,'replace_level');}
export async function replaceUserGroup(c:C){return write(c,'replace_group');}
export async function replaceUserLabels(c:C){return write(c,'replace_labels');}
export async function grantUserCoupons(c:C){return write(c,'grant_coupons');}
export async function adjustUserMembership(c:C){return write(c,'adjust_membership');}
export async function adjustUserMoney(c:C){return write(c,'adjust_money');}
export async function adjustUserIntegral(c:C){return write(c,'adjust_integral');}
export async function userOperationOutcome(c:C){const s=input(c);customerUserQuery(s.query,[]);if(Object.keys(s.query).length)throw new ValidateException('用户回执不接受查询身份');return jsonOk(c,await s.writer.outcome(s.actor,c.req.param('key')));}
export async function abandonUserOperation(c:C){const s=input(c);return jsonOk(c,await s.writer.abandon(s.actor,c.req.param('key')??'',await body(c)));}
