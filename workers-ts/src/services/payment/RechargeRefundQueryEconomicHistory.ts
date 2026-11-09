/** Complete physical query cause, not a funds permit or a provider capability. */
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { ServiceUnavailableException } from '@/utils/errors';
import { captureRechargeRefundScope,type RechargeRefundScope } from './RechargeRefundJournalCodec';
import type { RechargeRefundRecord } from './RechargeRefundLedger';
import type { RechargeRefundStateRow } from './RechargeRefundAccounting';
import type { RechargeRefundFirstRequest } from './RechargeRefundFirstRequest';
import { parseRechargeRefundQueryResult,type RechargeRefundQueryAttempt,type RechargeRefundQueryObservation } from './RechargeRefundQueryCodec';
import type { RechargeRefundProviderHistory } from './RechargeRefundQueryHistoryCodec';
import { parseRechargeRefundCallbackProviderUniverse,type RechargeRefundCallbackProviderUniverse } from './RechargeRefundCallbackHistoryCodec';
import { readRechargeRefundMixedProviderHistoryTx,rechargeRefundMixedHistoryInput } from './RechargeRefundMixedProviderHistory';

type Signing=Pick<Env,'APP_KEY'>;
export interface RechargeRefundQueryEconomicHistoryInput {
 readonly operation:unknown;readonly attempts:unknown;readonly policies:unknown;readonly results:unknown;readonly providerResultId:unknown;
}
export interface RechargeRefundQueryEconomicBasis {
 readonly scope:RechargeRefundScope;readonly operation:RechargeRefundRecord;
 readonly attempt:RechargeRefundRecord;readonly request:RechargeRefundFirstRequest['payload'];
 readonly query:RechargeRefundQueryAttempt;readonly record:RechargeRefundRecord;readonly observation:RechargeRefundQueryObservation;
 readonly history:RechargeRefundProviderHistory;readonly providerUniverse:RechargeRefundCallbackProviderUniverse;
}
const fail=():never=>{throw new ServiceUnavailableException('充值退款查询结算历史存在缺失或矛盾，请保留原操作人工核对');};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
/** Each journal/batch keeps its independent bound; no combined16KiB copier.
 * Supplying signed rows here never establishes their physical SQL existence. */
export function parseRechargeRefundQueryEconomicBasis(env:Signing,expectedScope:RechargeRefundScope,
 input:RechargeRefundQueryEconomicHistoryInput):RechargeRefundQueryEconomicBasis{
 if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return fail();
 const d=Object.getOwnPropertyDescriptors(input),keys=['operation','attempts','policies','results','providerResultId'];
 if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!('value'in d[k])))return fail();
 const row=Object.fromEntries(keys.map(k=>[k,d[k].value]));
 if(!uuid(row.providerResultId))return fail();
 const scope=captureRechargeRefundScope(expectedScope),providerUniverse=parseRechargeRefundCallbackProviderUniverse(env,scope,row.operation,row.attempts,row.policies,row.results),h=providerUniverse.requestQueryHistory;
 const cause=h.results.find(r=>r.record.result_id===row.providerResultId);
 if(providerUniverse.disposition!=='terminal_evidence'||h.totalAttempts<2||!cause||cause.record.source!=='query'
  ||!['SUCCESS','CLOSED'].includes(cause.observation.status))return fail();
 const query=h.queries.find(q=>q.attempt.attempt_id===cause.record.attempt_id);if(!query)return fail();
 const parsed=parseRechargeRefundQueryResult(env,scope,h.operation,h.first.attempt,h.firstApproval,query.attempt,query.approval,cause.record);
 return Object.freeze({scope,operation:h.operation,attempt:h.first.attempt,request:h.first.payload,query,record:parsed.record,
  observation:parsed.observation,history:h,providerUniverse});
}
export function rechargeRefundQueryEconomicHistoryInput(h:RechargeRefundQueryEconomicBasis):RechargeRefundQueryEconomicHistoryInput{
 return {...rechargeRefundMixedHistoryInput(h.providerUniverse),providerResultId:h.record.result_id};
}
export interface RechargeRefundQueryEconomicPhysicalHistory {
 readonly basis:RechargeRefundQueryEconomicBasis;readonly state:Readonly<RechargeRefundStateRow>;readonly local:RechargeRefundRecord|null;
}
/** The actual terminal state must name any separated local row. Neither a
 * query cause nor replay can discard callback/unknown/conflicting rows. */
export async function readRechargeRefundQueryEconomicHistoryTx(tx:DbClient,env:Signing,role:RechargeRefundRuntimeRole,
 operationId:unknown,providerResultId:unknown,localResultId?:unknown,mode:'read'|'write'='write'):Promise<RechargeRefundQueryEconomicPhysicalHistory>{
 if(!uuid(providerResultId))return fail();
 const physical=await readRechargeRefundMixedProviderHistoryTx(tx,env,role,operationId,localResultId,mode);
 const basis=parseRechargeRefundQueryEconomicBasis(env,physical.universe.requestQueryHistory.scope,
  {...rechargeRefundMixedHistoryInput(physical.universe),providerResultId});
 return Object.freeze({basis,state:physical.state,local:physical.local});
}
