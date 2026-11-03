/** Maintenance classification of signed notification history, never send
 * admission. Receipts remain historical facts when mutable projections drift. */
import { createHmac } from 'node:crypto';
import { routineEvidenceCanonical, routineEvidenceHmac } from '../src/services/payment/RoutineProviderObservation';
import { parseRoutineOriginalEvidence } from '../src/services/payment/RoutineOriginalPaymentEvidenceCodec';
import { parseRoutineSubscriptionAccountJournal, validateRoutineSubscriptionAccountHistory } from '../src/services/payment/RoutinePurposeAccountEvidenceCodec';
import { parseRoutineSubscriptionNoticeRequest, parseRoutineSubscriptionRefusalRequest, parseRoutineSubscriptionPinkRequest,
  parseRoutineSubscriptionNoticeIntent } from '../src/services/wechat/RoutineSubscriptionRequestEvidenceCodec';
import { parseRoutineSubscriptionAttempt, parseRoutineSubscriptionResult, validateRoutineSubscriptionAttemptChain } from '../src/services/wechat/RoutineSubscriptionDispatchEvidenceCodec';
import { routineSubscriptionNoticePrefix } from '../src/services/wechat/RoutineSubscriptionNoticeKinds';

type Row=Record<string,unknown>;
type Source={schema:string;name:string;oid:string;kind:string;owner:string;ownerOid:string};
type Context={database:string;databaseOid:string;observedAt:number};
type Request=ReturnType<typeof parseRoutineSubscriptionNoticeRequest>|ReturnType<typeof parseRoutineSubscriptionRefusalRequest>|ReturnType<typeof parseRoutineSubscriptionPinkRequest>;
const policyName='routine_subscription_account_policy',originalName='routine_original_payment_evidence';
const outboxName='store_order_outbox',deliveryName='order_notification_delivery',attemptName='routine_subscribe_attempt',resultName='routine_subscribe_result';
const layouts:Record<string,Record<string,number>>={
  [outboxName]:{id:23,event_key:1043,aggregate_type:1043,aggregate_id:23,event_type:1043,payload:3802,status:1043,
    dispatch_count:23,attempt_count:23,replay_count:23,available_time:23,lease_until:23,lease_token:1043,last_error:1043,
    enqueued_time:23,processed_time:23,add_time:23,update_time:23},
  [deliveryName]:{id:23,outbox_id:23,event_key:1043,order_id:23,withdrawal_id:23,user_id:23,notice_mark:1043,channel:1043,
    target:1043,template_code:1043,payload:3802,status:1043,dispatch_count:23,attempt_count:23,replay_count:23,
    available_time:23,lease_until:23,lease_token:1043,provider_reference:1043,provider_request_id:1043,response_code:1043,
    last_error:1043,sent_time:23,add_time:23,update_time:23},
  [attemptName]:{attempt_id:2950,delivery_id:23,attempt_no:23,source_key:1043,payload:3802,created_at:20,signature:1043},
  [resultName]:{result_id:1043,attempt_id:2950,payload:3802,created_at:20,signature:1043},
  [policyName]:{record_id:2950,account_id:1043,revision:23,payload:3802,created_at:20,signature:1043},
  [originalName]:{evidence_id:1043,order_no:1043,transaction_id:1043,source:1043,source_id:1043,format_version:21,payload:3802,created_at:20,signature:1043},
};
const fail=()=>new Error('Routine notification continuation draft incomplete');
const object=(v:unknown):Row|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Row:null;
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
function safely<T>(run:()=>T):T|null{try{return run();}catch{return null;}}
function group<T>(rows:T[],key:(r:T)=>unknown):Map<unknown,T[]>{
  const map=new Map<unknown,T[]>();for(const r of rows){const k=key(r),a=map.get(k)??[];a.push(r);map.set(k,a);}return map;
}
const rowStatuses=new Set(['PENDING','ENQUEUING','ENQUEUED','PROCESSING','RETRYABLE','SENT','SKIPPED','UNKNOWN','DEAD']);
export type RoutineNotificationContinuation=ReturnType<ReturnType<typeof routineNotificationAccumulator>['finish']>;

export function routineNotificationAccumulator(authenticator:string,fingerprintKey:string){
  if(typeof authenticator!=='string'||!authenticator||Buffer.byteLength(authenticator)>4096||authenticator===fingerprintKey)throw fail();
  const env={APP_KEY:authenticator},selected=new Map<string,Source>();
  const storage:Record<string,Row[]>=Object.fromEntries(Object.keys(layouts).map(n=>[n,[]]));
  const digest=(domain:string,value:unknown)=>createHmac('sha256',fingerprintKey)
    .update('cinashop.routine-notification-continuation-draft.v1\0'+domain+'\0').update(routineEvidenceCanonical(value)).digest('hex');
  // Exact existing payment-classifier record domains make the references
  // joinable without exposing original evidence IDs or policy signatures.
  const paymentDigest=(domain:string,value:unknown)=>createHmac('sha256',fingerprintKey)
    .update('cinashop.routine-payment-continuation-draft.v1\0'+domain+'\0').update(routineEvidenceCanonical(value)).digest('hex');
  let context:Context|undefined,roles:ReadonlyArray<{oid:string;name:string;login:boolean}>|undefined,retainedRows=0,retainedBytes=0;
  return{
    accepts:(r:{schema:string;name:string})=>r.schema==='public'&&Object.hasOwn(layouts,r.name),
    context(value:Context,currentRoles:ReadonlyArray<{oid:string;name:string;login:boolean}>){
      if(context||roles||currentRoles.length>16384||!Number.isSafeInteger(value.observedAt)||value.observedAt<=0)throw fail();
      context={...value};roles=currentRoles.map(r=>({...r}));
    },
    relation(source:Source,columns:{name:string;oid:number;namespace:string}[]){
      if(source.schema!=='public'||!Object.hasOwn(layouts,source.name))return;
      const layout=layouts[source.name];
      if(selected.has(source.name)||source.kind!=='r'||!source.owner||!/^[1-9][0-9]*$/u.test(source.ownerOid)
        ||columns.length!==Object.keys(layout).length
        ||Object.entries(layout).some(([name,oid])=>columns.filter(c=>c.name===name&&c.oid===oid&&c.namespace==='pg_catalog').length!==1))throw fail();
      selected.set(source.name,{...source});
    },
    row(relation:{schema:string;name:string},framed:string){
      if(relation.schema!=='public'||!Object.hasOwn(layouts,relation.name))return;
      const prefix=/^[0-9]+:\([0-9]+,[0-9]+\):/u.exec(framed);if(!prefix)throw fail();
      const raw=object(JSON.parse(framed.slice(prefix[0].length),(key:string,value:unknown,ctx?:{source?:string})=>{
        // Match the existing payment classifier's exact numeric-token view
        // even for invalid reference rows containing these nested key names.
        if((relation.name===policyName||relation.name===originalName)&&(key==='price'||key==='pay_price')&&typeof value==='number'){
          if(typeof ctx?.source!=='string')throw fail();return ctx.source;
        }return value;
      }));if(!raw)throw fail();
      retainedRows++;retainedBytes+=Buffer.byteLength(framed);
      if(retainedRows>16384||retainedBytes>8388608)throw fail();storage[relation.name].push(raw);
    },
    finish(relations:{name:string;schema:string;oid:string;rowCount:string;digest:string}[],inventorySourceDigest:string){
      if(!context||!roles)throw fail();
      const owner=selected.get(policyName),scope=owner?{database:context.database,databaseOid:context.databaseOid,maintenance:owner.owner,maintenanceOid:owner.ownerOid}:null;
      const actor=(value:{role:string;roleOid:string})=>{
        const now=roles!.find(r=>r.oid===value.roleOid);
        return{actorDigest:digest('historical-actor',value),currentRole:!now?'missing' as const:now.name!==value.role?'renamed' as const:now.login?'login_present' as const:'login_disabled' as const};
      };
      const policies=storage[policyName].map(raw=>({raw,row:scope?safely(()=>parseRoutineSubscriptionAccountJournal(env,raw,scope)):null}));
      const policyGroups=group(policies,p=>p.raw.account_id),policyChains=new Map<unknown,boolean>();
      for(const [key,rows]of policyGroups){
        policyChains.set(key,Boolean(scope&&rows.length<=64&&Buffer.byteLength(JSON.stringify(rows.map(r=>r.raw)))<=1048576
          &&rows.every(r=>r.row)&&safely(()=>{validateRoutineSubscriptionAccountHistory(rows.map(r=>r.row!).sort((a,b)=>a.revision-b.revision),String(key));return true;})));
      }
      const policyReference=(policy:ReturnType<typeof parseRoutineSubscriptionAccountJournal>)=>{
        if(!owner)return'source_missing' as const;
        const saved=policies.filter(p=>p.raw.record_id===policy.record_id);
        return!saved.length?'missing' as const:saved.length!==1||!saved[0].row?'invalid' as const
          :!same(saved[0].row,policy)?'mismatch' as const:policyChains.get(policy.account_id)?'matched' as const:'broken_chain' as const;
      };
      const originals=storage[originalName].map(raw=>({raw,row:safely(()=>parseRoutineOriginalEvidence(env,raw))}));
      const originalLink=(id:string)=>{const saved=originals.filter(o=>o.raw.evidence_id===id);return saved.length===1?paymentDigest('original-record',saved[0].raw):null;};
      const policyLink=(id:string)=>{const saved=policies.filter(p=>p.raw.record_id===id);return saved.length===1?paymentDigest('policy-record',[policyName,saved[0].raw]):null;};
      const originalReference=(facts:{evidenceId:string;evidenceSignature:string;appId:string;rootId:number;buyerUid:number})=>{
        if(!selected.has(originalName))return'source_missing' as const;
        const saved=originals.filter(p=>p.raw.evidence_id===facts.evidenceId);
        if(!saved.length)return'missing' as const;
        const o=saved.length===1?saved[0].row:null;if(!o)return'invalid' as const;
        const b=o.payload.binding;
        return o.signature===facts.evidenceSignature&&o.payload.observation.facts.appId===facts.appId&&b.state==='bound'
          &&b.local.domain==='store_order'&&b.local.orderId===facts.rootId&&b.local.buyerUid===facts.buyerUid?'matched' as const:'mismatch' as const;
      };
      const outboxes=storage[outboxName].map(raw=>{
        const p=object(raw.payload),candidate=p?.routineSubscriptionRequest;
        const relevant=typeof raw.event_key==='string'&&routineSubscriptionNoticePrefix(raw.event_key);
        let request:Request|null=null;
        if(relevant&&scope&&candidate!==undefined)request=safely(()=>{
          const format=object(candidate)?.format;
          return format===2?parseRoutineSubscriptionNoticeRequest(env,candidate,scope)
            :format===3?parseRoutineSubscriptionRefusalRequest(env,candidate,scope):parseRoutineSubscriptionPinkRequest(env,candidate,scope);
        });
        const eventType=request?.format===2?'order.delivery.notice':request?.format===3?'order.refund.refused.notice':'order.pink.success.notice';
        const sourceMatches=request!==null&&p!==null&&raw.aggregate_type==='order'&&raw.aggregate_id===request.aggregateId
          &&raw.event_key===request.eventKey&&raw.event_type===eventType&&raw.add_time===request.eventTime
          &&same(request.body,Object.fromEntries(Object.keys(request.body).map(k=>[k,p[k]])));
        const marker=object(candidate);
        // PHP's fictitious notice is SMS/inbox only. Its real producer uses a
        // legacy pin and deliberately never creates a subscription request.
        const excluded=relevant&&raw.event_type==='order.delivery.notice'&&p?.deliveryType==='fictitious'&&candidate===undefined;
        const state=!relevant?'unrelated' as const:excluded?'outside_subscription_contract' as const:candidate===undefined?'legacy_unattributed' as const
          :marker?.unavailable===true&&Object.keys(marker).length===2&&[2,3,4].includes(Number(marker.format))?'unavailable' as const
          :!scope?'scope_unavailable' as const:!request?'invalid' as const:sourceMatches?'authenticated_source_match' as const:'authenticated_source_mismatch' as const;
        return{raw,request,state};
      });
      const publicOutboxes=outboxes.map(({raw,request,state})=>({recordDigest:digest('outbox',raw),outboxDigest:digest('outbox-id',raw.id),state,
        format:request?.format??null,eventDigest:request?digest('event',request.eventKey):null,
        buyerDigest:request?digest('buyer',request.body.userId):null,...(request?actor(request.actor):{actorDigest:null,currentRole:null})}));
      const deliveries=storage[deliveryName].map(raw=>{
        const p=object(raw.payload),candidate=p?.routineSubscriptionIntent;
        const intent=scope&&raw.channel==='wechat_routine'&&candidate!==undefined?safely(()=>parseRoutineSubscriptionNoticeIntent(env,candidate,scope)):null;
        const sources=outboxes.filter(o=>o.raw.id===raw.outbox_id),source=sources.length===1?sources[0]:null;
        const expectedMark=source?.request?.format===4?'order_user_groups_success':source?.request?.format===3?'send_order_refund_no_status'
          :source?.request?.format===2?source.request.body.deliveryType==='express'?'order_postage_success'
            :source.request.body.deliveryType==='fictitious'?'order_fictitious_success':'order_deliver_success':null;
        const sourceMatch=Boolean(intent&&source?.request&&source.state==='authenticated_source_match'
          &&intent.requestSignature===source.request.signature&&intent.eventKey===source.request.eventKey&&intent.createdAt>=source.request.eventTime
          &&intent.source.orderId===source.request.body.orderId&&intent.source.buyerUid===source.request.body.userId
          &&intent.source.templateMark===(source.request.format===4?'3098':source.request.format===3?'1451':source.request.body.deliveryType==='express'?'1458':'1128'));
        const rowMatch=Boolean(intent&&raw.id===intent.deliveryId&&raw.outbox_id===intent.outboxId&&raw.event_key===intent.eventKey
          &&raw.order_id===intent.source.orderId&&raw.withdrawal_id===null&&raw.user_id===intent.source.buyerUid
          &&raw.notice_mark===expectedMark&&raw.target===intent.request.touser&&raw.template_code===intent.request.template_id
          &&raw.add_time===intent.createdAt&&p?.kind==='wechat_routine'&&p.routineAppId===intent.source.appId
          &&p.url===intent.request.page&&same(p.data,Object.fromEntries(Object.entries(intent.request.data).map(([key,v])=>[key,v.value])))
          &&same(Object.keys(p).sort(),['kind','routineAppId','routineSubscriptionIntent','data','url'].sort()));
        return{raw,intent,sourceMatch,rowMatch};
      });
      const parsedAttempts=storage[attemptName].map(raw=>({raw,row:scope?safely(()=>parseRoutineSubscriptionAttempt(env,raw,scope)):null}));
      const parsedResults=storage[resultName].map(raw=>{
        const saved=parsedAttempts.filter(a=>a.raw.attempt_id===raw.attempt_id),a=saved.length===1?saved[0].row:null;
        return{raw,row:a&&scope?safely(()=>parseRoutineSubscriptionResult(env,raw,a,scope)):null,attemptPresent:saved.length>0};
      });
      const publicAttempts=parsedAttempts.map(({raw,row})=>{
        const saved=parsedResults.filter(r=>r.raw.attempt_id===raw.attempt_id),delivery=deliveries.filter(d=>d.raw.id===raw.delivery_id);
        return{recordDigest:digest('attempt',raw),attemptDigest:digest('attempt-id',raw.attempt_id),authenticity:row?'authenticated' as const:scope?'invalid' as const:'scope_unavailable' as const,
        accountDigest:row?digest('app-account',row.payload.facts.appId):null,
        deliveryDigest:digest('delivery-id',raw.delivery_id),deliveryPresence:!selected.has(deliveryName)?'source_missing' as const
          :!delivery.length?'missing' as const:delivery.length===1?'present' as const:'ambiguous' as const,
        result:!saved.length?'unknown' as const:!scope?'scope_unavailable' as const:saved.length!==1||!saved[0].row?'invalid' as const
          :saved[0].row.payload.result.code===0?'verified_accepted' as const:'verified_rejected' as const,
        policy:row?policyReference(row.payload.policy):'not_evaluated' as const,
        original:row?originalReference(row.payload.facts):'not_evaluated' as const,
        originalRecordDigest:row?originalLink(row.payload.facts.evidenceId):null,policyRecordDigest:row?policyLink(row.payload.policy.record_id):null,
        ...(row?actor(row.payload.actor):{actorDigest:null,currentRole:null})};});
      const publicResults=parsedResults.map(({raw,row,attemptPresent})=>({recordDigest:digest('result',raw),attemptDigest:digest('attempt-id',raw.attempt_id),
        resultDigest:digest('result-id',raw.result_id),
        state:!attemptPresent?'attempt_missing' as const:!scope?'scope_unavailable' as const:!row?'invalid' as const:row.payload.result.code===0?'verified_accepted' as const:'verified_rejected' as const}));
      const publicDeliveries=deliveries.map(({raw,intent,sourceMatch,rowMatch})=>{
        const relevant=raw.channel==='wechat_routine'&&typeof raw.event_key==='string'&&routineSubscriptionNoticePrefix(raw.event_key);
        const key=relevant?routineEvidenceHmac(env,'subscription-delivery-source-key',[raw.event_key,'wechat_routine']):null;
        const attempts=storage[attemptName].filter(a=>a.delivery_id===raw.id||key!==null&&a.source_key===key);
        const ids=new Set(attempts.map(a=>a.attempt_id)),results=storage[resultName].filter(r=>ids.has(r.attempt_id));
        const chain=relevant&&scope?safely(()=>validateRoutineSubscriptionAttemptChain(env,attempts,results,scope,{deliveryId:raw.id as number,eventKey:raw.event_key as string})):null;
        const last=chain?.attempts.at(-1),lastResult=chain?.results.at(-1);
        const identity={id:raw.id,outboxId:raw.outbox_id,eventKey:raw.event_key,orderId:raw.order_id,withdrawalId:raw.withdrawal_id,
          userId:raw.user_id,noticeMark:raw.notice_mark,channel:raw.channel,target:raw.target,templateCode:raw.template_code,payload:raw.payload,addTime:raw.add_time};
        const intentMatches=last?last.payload.intentDigest===routineEvidenceHmac(env,'subscription-delivery-intent',identity):null;
        const currentProjection=lastResult?.payload.result.code===0?raw.status==='SENT'&&raw.provider_reference===lastResult.result_id&&raw.response_code==='0'
          ?'matched' as const:'drifted' as const:'not_evaluated' as const;
        return{recordDigest:digest('delivery',raw),deliveryDigest:digest('delivery-id',raw.id),outboxDigest:digest('outbox-id',raw.outbox_id),eventDigest:relevant?digest('event',raw.event_key):null,
          staging:!relevant?'unrelated' as const:object(raw.payload)?.routineSubscriptionIntent===undefined?'legacy_unattributed' as const
            :!scope?'scope_unavailable' as const:!intent?'invalid' as const:sourceMatch&&rowMatch?'authenticated_source_match' as const:'authenticated_source_mismatch' as const,
          source:!sourceMatch?'unresolved' as const:'matched' as const,policy:intent?policyReference(intent.policy):'not_evaluated' as const,
          original:intent?originalReference(intent.source):'not_evaluated' as const,
          originalRecordDigest:intent?originalLink(intent.source.evidenceId):null,policyRecordDigest:intent?policyLink(intent.policy.record_id):null,
          dispatch:!relevant?'not_applicable' as const:!scope?'scope_unavailable' as const:!chain?'invalid_chain' as const:!chain.attempts.length?'not_attempted' as const
            :chain.state==='unknown'?'unknown' as const:lastResult?.payload.result.code===0?'accepted' as const:'rejected' as const,
          attempts:attempts.length,intentMatches,currentProjection,
          mutableStatus:typeof raw.status==='string'&&rowStatuses.has(raw.status)?raw.status:'invalid',
          ...(intent?actor(intent.actor):{actorDigest:null,currentRole:null})};
      });
      const sources=relations.filter(r=>r.schema==='public'&&selected.has(r.name)).map(r=>({name:r.name,oid:r.oid,
        owner:selected.get(r.name)!.owner,ownerOid:selected.get(r.name)!.ownerOid,rowCount:r.rowCount,digest:r.digest}));
      const body={version:1 as const,purpose:'routine_notification_continuation_draft' as const,
        scope:'four_notification_roots_and_two_historical_reference_roots' as const,
        activationAllowed:false as const,permitIssued:false as const,switchCommissioned:false as const,subscriptionSendAuthorized:false as const,
        currentBusinessEligibility:'not_evaluated' as const,catalogCommissioning:'not_evaluated' as const,credentials:'not_evaluated' as const,
        externalQueueAndProviderState:'not_evaluated' as const,externalSourcesIncluded:false as const,
        inventorySourceDigest,missingSources:Object.keys(layouts).filter(n=>!selected.has(n)),unclassifiedRelationCount:relations.length-sources.length,sources,
        counts:{outboxes:publicOutboxes.length,deliveries:publicDeliveries.length,attempts:publicAttempts.length,results:publicResults.length,
          authenticatedAttempts:publicAttempts.filter(a=>a.authenticity==='authenticated').length,
          authenticatedResults:publicResults.filter(r=>r.state==='verified_accepted'||r.state==='verified_rejected').length},
        outboxes:publicOutboxes,deliveries:publicDeliveries,attempts:publicAttempts,results:publicResults};
      return{...body,classificationDigest:digest('classification',body)};
    },
  };
}
