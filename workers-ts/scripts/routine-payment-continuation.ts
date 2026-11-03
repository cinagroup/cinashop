/** Pure diagnostic over the inventory's physical row stream. Authenticated
 * payment history and current policy observations are separate dimensions. */
import { createHmac } from 'node:crypto';
import { parseRoutineOriginalEvidence, type RoutineOriginalEvidence } from '../src/services/payment/RoutineOriginalPaymentEvidenceCodec';
import { parseRoutineApprovedAccountJournal, parseRoutineApprovedUse, validateRoutineApprovedAccountHistory,
  type RoutineApprovedAccountJournal as RoutineApprovedJournal, type RoutineApprovedScope } from '../src/services/payment/RoutineApprovedPaymentEvidenceCodec';
import { parseRoutineRefundAccountJournal, parseRoutineShippingAccountJournal, parseRoutineSubscriptionAccountJournal,
  validateRoutineRefundAccountHistory, validateRoutineShippingAccountHistory, validateRoutineSubscriptionAccountHistory,
  type RoutineRefundAccountJournal, type RoutineShippingAccountJournal, type RoutineSubscriptionAccountJournal } from '../src/services/payment/RoutinePurposeAccountEvidenceCodec';
import { routineEvidenceCanonical } from '../src/services/payment/RoutineProviderObservation';

type Row = Record<string, unknown>;
type Domain = 'store_order' | 'recharge' | 'membership';
type Source = { schema:string;name:string;oid:string;kind:string;owner:string;ownerOid:string };
type Context = { database:string;databaseOid:string;observedAt:number };
type Chain = 'complete' | 'invalid_record' | 'broken' | 'over_runtime_capacity';
type PolicyKind = 'account' | 'query' | 'refund' | 'shipping' | 'subscription';
type Journal = RoutineApprovedJournal | RoutineRefundAccountJournal | RoutineShippingAccountJournal | RoutineSubscriptionAccountJournal;
type PolicyEntry = {raw:Row;source:string;kind:PolicyKind|null;subject:unknown;row:Journal|null;chain:Chain};
type Local = {raw:Row;domain:Domain;id:number;uid:number;number:string;cents:number;paid:number;payType:string;tradeNo:string;root:boolean;inactive:boolean};
type LocalMatch = 'paid_match' | 'unpaid_match' | 'unresolved_binding' | 'source_missing' | 'missing' | 'ambiguous'
  | 'invalid_physical' | 'unsupported_child_or_type' | 'identity_or_amount_changed' | 'payment_changed' | 'invalid_original';
type Related = 'consistent' | 'conflict' | 'invalid_evidence' | 'over_runtime_capacity' | 'invalid_original';
type Saved = 'matched' | 'missing' | 'mismatch' | 'invalid' | 'not_evaluated';
export type RoutinePaymentContinuation = {
  version:1;purpose:'routine_payment_continuation_draft';scope:'only_nine_named_public_heap_roots';
  activationAllowed:false;permitIssued:false;switchCommissioned:false;
  refundRequestAuthorized:false;shippingUploadAuthorized:false;subscriptionSendAuthorized:false;
  catalogCommissioning:'not_evaluated';credentials:'not_evaluated';providerCurrentState:'not_evaluated';
  dispatchAndResults:'not_evaluated';identityAttribution:'not_evaluated';externalSourcesIncluded:false;
  inventorySourceDigest:string;missingSources:string[];unclassifiedRelationCount:number;
  sources:{name:string;oid:string;owner:string;ownerOid:string;rowCount:string;digest:string}[];
  counts:{originals:number;verifiedSuccesses:number;invalidOriginals:number;uses:number;authenticatedUses:number;
    invalidUses:number;policies:number;invalidPolicies:number;localOrders:number};
  originals:{recordDigest:string;accountDigest:string|null;orderDigest:string|null;buyerDigest:string|null;
    authenticity:'verified_success'|'invalid';binding:'bound'|'unresolved'|'invalid';local:LocalMatch;related:Related;
    approvedUse:'none_recorded'|'authenticated_scope_match'|'non_authorizing_scope_mismatch'|'unresolved';
    source:'callback'|'signed_query'|null;inactivePhysical:boolean|null}[];
  uses:{recordDigest:string;originalDigest:string|null;authenticity:'authenticated'|'invalid'|'original_missing'|'original_invalid'|'policy_source_missing';
    scopeMatches:boolean|null;savedJournals:Saved;policyChains:'complete'|'unresolved'|'not_evaluated'}[];
  policies:{recordDigest:string;kind:PolicyKind|null;accountDigest:string|null;credentialDigest:string|null;
    authenticity:'authenticated'|'invalid';chain:Chain;latest:boolean|null;state:'active'|'revoked'|null;
    interval:'valid_at_snapshot'|'not_started'|'expired'|null;purposes:string[];templateCount:number|null;
    accountRevisionReference:Saved|'not_applicable'}[];
  localOrders:{recordDigest:string;domain:Domain;orderDigest:string|null;state:'invalid'|'unsupported_child_or_type'|'duplicate_number'
    |'no_authenticated_original'|'has_authenticated_original';paid:boolean|null;inactive:boolean|null}[];
  classificationDigest:string;
};
const originalName='routine_original_payment_evidence', policyName='routine_payment_account_policy', useName='routine_payment_account_use';
const purposes = {routine_refund_account_policy:'refund',routine_shipping_account_policy:'shipping',routine_subscription_account_policy:'subscription'} as const;
const domains = {store_order:'store_order',user_recharge:'recharge',other_order:'membership'} as const;
const policyLayout = {record_id:2950,account_id:1043,revision:23,payload:3802,created_at:20,signature:1043};
const localLayout = {id:23,uid:23,order_id:1043,paid:21,trade_no:1043};
const layouts:Record<string,Record<string,number>>={
  [originalName]:{evidence_id:1043,order_no:1043,transaction_id:1043,source:1043,source_id:1043,format_version:21,payload:3802,created_at:20,signature:1043},
  [policyName]:{record_id:2950,kind:1043,subject_id:1043,revision:23,payload:3802,created_at:20,signature:1043},
  [useName]:{use_id:1043,evidence_id:1043,payload:3802,created_at:20,signature:1043},
  store_order:{...localLayout,pay_price:1700,pay_type:1043,pid:23,is_del:21,is_system_del:21},
  user_recharge:{...localLayout,price:1700,recharge_type:1043},
  other_order:{...localLayout,pay_price:1700,pay_type:1043,type:21,is_del:21},
  routine_refund_account_policy:policyLayout,routine_shipping_account_policy:policyLayout,routine_subscription_account_policy:policyLayout,
};
const fail=()=>new Error('Routine payment continuation draft incomplete');
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const token=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{2,64}$/u.test(v);
function group<T>(values:T[],key:(v:T)=>string):Map<string,T[]>{
  const result=new Map<string,T[]>();for(const v of values){const k=key(v),a=result.get(k)??[];a.push(v);result.set(k,a);}return result;
}
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const bounded=(rows:Row[])=>rows.length<=64&&Buffer.byteLength(JSON.stringify(rows))<=1048576;
function cents(value:unknown):number|null{
  if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/u.test(value))return null;
  const [whole,fraction='']=value.split('.'),amount=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  return amount>0n&&amount<=2147483647n?Number(amount):null;
}
function local(domain:Domain,raw:Row):Local|null{
  const amount=cents(domain==='recharge'?raw.price:raw.pay_price),payType=domain==='recharge'?raw.recharge_type:raw.pay_type;
  if(!id(raw.id)||!id(raw.uid)||!token(raw.order_id)||amount===null||(raw.paid!==0&&raw.paid!==1)
    ||typeof payType!=='string'||payType.length>32||typeof raw.trade_no!=='string'||raw.trade_no.length>100)return null;
  const root=domain==='store_order'?raw.pid===0||raw.pid===-1:domain==='membership'?raw.type===0||raw.type===1:true;
  return{raw,domain,id:raw.id,uid:raw.uid,number:raw.order_id,cents:amount,paid:raw.paid,payType,tradeNo:raw.trade_no,root,
    inactive:raw.is_del!==undefined&&raw.is_del!==0||raw.is_system_del!==undefined&&raw.is_system_del!==0};
}

export function routinePaymentAccumulator(authenticator:string,fingerprintKey:string){
  if(typeof authenticator!=='string'||!authenticator||Buffer.byteLength(authenticator)>4096||authenticator===fingerprintKey)throw fail();
  const env={APP_KEY:authenticator},selected=new Map<string,Source>(),storage:Record<string,Row[]>=Object.fromEntries(Object.keys(layouts).map(n=>[n,[]]));
  const digest=(domain:string,value:unknown)=>createHmac('sha256',fingerprintKey)
    .update('cinashop.routine-payment-continuation-draft.v1\0'+domain+'\0').update(routineEvidenceCanonical(value)).digest('hex');
  let context:Context|undefined,retainedRows=0,retainedBytes=0;
  const scopeFor=(name:string):RoutineApprovedScope|null=>{const source=selected.get(name);return source&&context?
    {database:context.database,databaseOid:context.databaseOid,maintenance:source.owner,maintenanceOid:source.ownerOid}:null;};
  return{
    accepts:(relation:{schema:string;name:string})=>relation.schema==='public'&&Object.hasOwn(layouts,relation.name),
    context(value:Context){if(context||!Number.isSafeInteger(value.observedAt)||value.observedAt<=0)throw fail();context={...value};},
    relation(source:Source,columns:{name:string;oid:number;namespace:string}[]){
      if(source.schema!=='public'||!Object.hasOwn(layouts,source.name))return;
      if(selected.has(source.name)||source.kind!=='r'||!source.owner||!/^[0-9]+$/u.test(source.ownerOid))throw fail();
      const expected=layouts[source.name];
      if(Object.entries(expected).some(([name,oid])=>columns.filter(c=>c.name===name&&c.oid===oid&&c.namespace==='pg_catalog').length!==1)
        ||!Object.hasOwn(domains,source.name)&&columns.length!==Object.keys(expected).length)throw fail();
      selected.set(source.name,{...source});
    },
    row(relation:{schema:string;name:string},framed:string){
      if(relation.schema!=='public'||!Object.hasOwn(layouts,relation.name))return;
      const prefix=/^[0-9]+:\([0-9]+,[0-9]+\):/u.exec(framed);if(!prefix)throw fail();
      // Node24 JSON source context preserves exact PG numeric price tokens;
      // full inventory hashing still uses untouched server text for all fields.
      const raw:unknown=JSON.parse(framed.slice(prefix[0].length),(key:string,value:unknown,ctx?:{source?:string})=>{
        if((key==='price'||key==='pay_price')&&typeof value==='number'){
          if(typeof ctx?.source!=='string')throw fail();return ctx.source;
        }return value;
      });
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw fail();
      const row=Object.fromEntries(Object.keys(layouts[relation.name]).map(k=>[k,(raw as Row)[k]]));
      retainedRows++;retainedBytes+=Buffer.byteLength(JSON.stringify(row));if(retainedRows>16384||retainedBytes>8388608)throw fail();
      storage[relation.name].push(row);
    },
    finish(relations:{schema:string;name:string;oid:string;rowCount:string;digest:string}[],inventorySourceDigest:string):RoutinePaymentContinuation{
      if(!context)throw fail();
      const observedAt=context.observedAt;
      const originals=storage[originalName].map(raw=>{try{return{raw,row:parseRoutineOriginalEvidence(env,raw)};}catch{return{raw,row:null};}});
      const byEvidence=group(originals,r=>String(r.raw.evidence_id)),byNumber=group(originals,r=>String(r.raw.order_no)),byTransaction=group(originals,r=>String(r.raw.transaction_id));
      const physical=Object.entries(domains).flatMap(([name,domain])=>storage[name].map(raw=>({raw,domain,row:local(domain,raw)})));
      const localByNumber=group(physical,p=>String(p.raw.order_id)),localById=group(physical,p=>JSON.stringify([p.domain,p.raw.id]));
      const policies:PolicyEntry[]=[];
      for(const source of [policyName,...Object.keys(purposes)])for(const raw of storage[source]){
        const scope=scopeFor(source);if(!scope)throw fail();
        let row:Journal|null=null;try{row=source===policyName?parseRoutineApprovedAccountJournal(env,raw,scope)
          :source==='routine_refund_account_policy'?parseRoutineRefundAccountJournal(env,raw,scope)
          :source==='routine_shipping_account_policy'?parseRoutineShippingAccountJournal(env,raw,scope):parseRoutineSubscriptionAccountJournal(env,raw,scope);}catch{/* retain invalid row */}
        const kind:PolicyKind|null=source===policyName?(raw.kind==='account'||raw.kind==='query'?raw.kind:null):purposes[source as keyof typeof purposes];
        policies.push({raw,source,kind,subject:source===policyName?raw.subject_id:raw.account_id,row,chain:'invalid_record'});
      }
      const histories=group(policies,p=>JSON.stringify([p.source,p.kind,p.subject]));
      const latest=new Set<Journal>();
      for(const history of histories.values()){
        history.sort((a,b)=>Number(a.raw.revision)-Number(b.raw.revision));let state:Chain='complete';
        if(!bounded(history.map(p=>p.raw)))state='over_runtime_capacity';else if(history.some(p=>!p.row))state='invalid_record';
        else try{
          const first=history[0];
          if(first.source===policyName)validateRoutineApprovedAccountHistory(history.map(p=>p.row as RoutineApprovedJournal),first.kind as 'account'|'query',String(first.subject));
          else if(first.kind==='refund')validateRoutineRefundAccountHistory(history.map(p=>p.row as RoutineRefundAccountJournal),String(first.subject));
          else if(first.kind==='shipping')validateRoutineShippingAccountHistory(history.map(p=>p.row as RoutineShippingAccountJournal),String(first.subject));
          else validateRoutineSubscriptionAccountHistory(history.map(p=>p.row as RoutineSubscriptionAccountJournal),String(first.subject));
        }catch{state='broken';}
        for(const p of history)p.chain=state;if(state==='complete')latest.add(history.at(-1)!.row!);
      }
      const policyById=group(policies.filter(p=>p.source===policyName),p=>String(p.raw.record_id));
      const accountRevisions=group(policies.filter(p=>p.source===policyName&&p.kind==='account'),p=>JSON.stringify([p.subject,p.raw.revision]));
      const useResults=storage[useName].map(raw=>{
        const matches=byEvidence.get(String(raw.evidence_id)),original=matches?.length===1?matches[0].row:null;
        const base={recordDigest:digest('use-record',raw),originalDigest:original?digest('original-record',matches![0].raw):null};
        const empty=(authenticity:'invalid'|'original_missing'|'original_invalid'|'policy_source_missing')=>({...base,authenticity,scopeMatches:null,savedJournals:'not_evaluated' as const,policyChains:'not_evaluated' as const});
        if(!matches?.length)return empty('original_missing');if(!original)return empty('original_invalid');
        const scope=scopeFor(policyName);if(!scope)return empty('policy_source_missing');
        try{
          const use=parseRoutineApprovedUse(env,raw,scope,original),journals=[use.payload.authorization.account,use.payload.authorization.query].filter((p):p is RoutineApprovedJournal=>p!==null);
          let saved:Saved='matched',chains=true;
          for(const p of journals){const rows=policyById.get(p.record_id);
            if(!rows?.length){saved='missing';chains=false;continue;}
            if(rows.length!==1||!rows[0].row){saved='invalid';chains=false;continue;}
            if(!same(rows[0].row,p))saved='mismatch';if(rows[0].chain!=='complete')chains=false;
          }
          return{...base,authenticity:'authenticated' as const,scopeMatches:use.payload.scopeMatches,savedJournals:saved,policyChains:chains?'complete' as const:'unresolved' as const};
        }catch{return empty('invalid');}
      });
      const useByOriginal=group(storage[useName].map((raw,i)=>({raw,result:useResults[i]})),u=>String(u.raw.evidence_id));
      const relatedState=(o:RoutineOriginalEvidence):Related=>{
        if(byEvidence.get(o.evidence_id)?.length!==1)return'conflict';
        const related=Array.from(new Set([...(byNumber.get(o.order_no)??[]),...(byTransaction.get(o.transaction_id)??[])]));
        if(!bounded(related.map(r=>r.raw)))return'over_runtime_capacity';if(related.some(r=>!r.row))return'invalid_evidence';
        const b=o.payload.binding,facts=o.payload.observation.facts;
        if(b.state!=='bound')return'conflict';
        return related.some(({row})=>{const binding=row!.payload.binding,f=row!.payload.observation.facts;
          return!same(f,facts)||binding.state!=='bound'||binding.local.domain!==b.local.domain||binding.local.orderId!==b.local.orderId
            ||binding.local.buyerUid!==b.local.buyerUid||binding.local.orderNo!==f.orderNo||binding.local.amountCents!==f.amountCents
            ||binding.local.tradeNo!==''&&binding.local.tradeNo!==f.transactionId||binding.local.paid===1&&binding.local.payType!=='weixin';})?'conflict':'consistent';
      };
      const matchLocal=(o:RoutineOriginalEvidence):{state:LocalMatch;inactive:boolean|null}=>{
        const b=o.payload.binding;if(b.state!=='bound')return{state:'unresolved_binding',inactive:null};
        if(!selected.has(b.local.domain==='recharge'?'user_recharge':b.local.domain==='membership'?'other_order':'store_order'))return{state:'source_missing',inactive:null};
        const exact=localById.get(JSON.stringify([b.local.domain,b.local.orderId])),candidates=localByNumber.get(o.order_no)??[];
        if(!exact?.length)return{state:'missing',inactive:null};
        if(exact.length!==1||candidates.length!==1)return{state:'ambiguous',inactive:null};
        const current=exact[0].row;if(!current)return{state:'invalid_physical',inactive:null};
        if(!current.root)return{state:'unsupported_child_or_type',inactive:current.inactive};
        const f=o.payload.observation.facts;
        if(current.uid!==b.local.buyerUid||current.number!==o.order_no||current.cents!==f.amountCents
          ||b.local.orderNo!==o.order_no||b.local.amountCents!==f.amountCents)return{state:'identity_or_amount_changed',inactive:current.inactive};
        if(current.tradeNo!==''&&current.tradeNo!==o.transaction_id||current.paid===1&&(current.payType!=='weixin'||current.tradeNo!==o.transaction_id))return{state:'payment_changed',inactive:current.inactive};
        return{state:current.paid===1?'paid_match':'unpaid_match',inactive:current.inactive};
      };
      const originalResults=originals.map(({raw,row})=>{
        const b=row?.payload.binding,physical=row?matchLocal(row):{state:'invalid_original' as const,inactive:null};
        const uses=useByOriginal.get(String(raw.evidence_id))??[];
        const approvedUse=!uses.length?'none_recorded' as const:!bounded(uses.map(u=>u.raw))||uses.some(u=>u.result.authenticity!=='authenticated'||u.result.savedJournals!=='matched'||u.result.policyChains!=='complete')?'unresolved' as const
          :uses.some(u=>u.result.scopeMatches===false)?'non_authorizing_scope_mismatch' as const:'authenticated_scope_match' as const;
        return{recordDigest:digest('original-record',raw),accountDigest:row?digest('merchant-account',[row.payload.observation.facts.appId,row.payload.observation.facts.merchantId]):null,
          orderDigest:row?digest('order-number',row.order_no):null,buyerDigest:b?.state==='bound'?digest('buyer',b.local.buyerUid):null,
          authenticity:row?'verified_success' as const:'invalid' as const,binding:b?.state??'invalid' as const,local:physical.state,related:row?relatedState(row):'invalid_original' as const,
          approvedUse,source:row?.source??null,inactivePhysical:physical.inactive};
      });
      const policyResults=policies.map(p=>{
        const data=p.row?.payload.data,appId=data&&'appId'in data?data.appId:null;
        const merchant=data&&'merchantId'in data?data.merchantId:null;
        let accountRevisionReference:Saved|'not_applicable'='not_applicable';
        if(p.kind==='query'){
          if(!data||!('accountRevision'in data))accountRevisionReference='invalid';
          else{const rows=accountRevisions.get(JSON.stringify([data.accountId,data.accountRevision]));
            accountRevisionReference=!rows?.length?'missing':rows.length!==1||!rows[0].row?'invalid':'matched';}
        }
        return{recordDigest:digest('policy-record',[p.source,p.raw]),kind:p.kind,accountDigest:appId?digest(merchant?'merchant-account':'app-account',merchant?[appId,merchant]:[appId]):null,
          credentialDigest:data&&'credentialRef'in data?digest('credential-reference',[p.kind,data.credentialRef,data.credentialVersion,data.credentialStamp]):null,
          authenticity:p.row?'authenticated' as const:'invalid' as const,chain:p.chain,latest:p.row&&p.chain==='complete'?latest.has(p.row):null,
          state:data?.state??null,interval:data?(observedAt<data.validFrom?'not_started' as const:observedAt>=data.validUntil?'expired' as const:'valid_at_snapshot' as const):null,
          purposes:data&&'purposes'in data?[...data.purposes]:[],templateCount:data&&'templates'in data?data.templates.length:null,accountRevisionReference};
      });
      const localResults=physical.map(({raw,row,domain})=>({recordDigest:digest('local-order',[domain,raw]),domain,orderDigest:row?digest('order-number',row.number):null,
        state:!row?'invalid' as const:!row.root?'unsupported_child_or_type' as const:(localByNumber.get(row.number)?.length??0)>1?'duplicate_number' as const
          :byNumber.get(row.number)?.some(o=>o.row)?'has_authenticated_original' as const:'no_authenticated_original' as const,
        paid:row?row.paid===1:null,inactive:row?.inactive??null}));
      const sorted=<T>(rows:T[])=>rows.sort((a,b)=>{const x=routineEvidenceCanonical(a),y=routineEvidenceCanonical(b);return x<y?-1:x>y?1:0;});
      const body={version:1 as const,purpose:'routine_payment_continuation_draft' as const,scope:'only_nine_named_public_heap_roots' as const,
        activationAllowed:false as const,permitIssued:false as const,switchCommissioned:false as const,refundRequestAuthorized:false as const,
        shippingUploadAuthorized:false as const,subscriptionSendAuthorized:false as const,catalogCommissioning:'not_evaluated' as const,
        credentials:'not_evaluated' as const,providerCurrentState:'not_evaluated' as const,dispatchAndResults:'not_evaluated' as const,
        identityAttribution:'not_evaluated' as const,externalSourcesIncluded:false as const,inventorySourceDigest,
        missingSources:Object.keys(layouts).filter(n=>!selected.has(n)).sort(),unclassifiedRelationCount:relations.length-selected.size,
        sources:sorted(relations.filter(r=>r.schema==='public'&&selected.get(r.name)?.oid===r.oid).map(r=>({name:r.name,oid:r.oid,
          owner:selected.get(r.name)!.owner,ownerOid:selected.get(r.name)!.ownerOid,rowCount:r.rowCount,digest:r.digest}))),
        counts:{originals:originals.length,verifiedSuccesses:originals.filter(o=>o.row).length,invalidOriginals:originals.filter(o=>!o.row).length,
          uses:useResults.length,authenticatedUses:useResults.filter(u=>u.authenticity==='authenticated').length,invalidUses:useResults.filter(u=>u.authenticity!=='authenticated').length,
          policies:policies.length,invalidPolicies:policies.filter(p=>!p.row).length,localOrders:physical.length},
        originals:sorted(originalResults),uses:sorted(useResults),policies:sorted(policyResults),localOrders:sorted(localResults)};
      return{...body,classificationDigest:digest('classification',body)};
    },
  };
}
