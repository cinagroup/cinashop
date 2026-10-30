import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectCustomerCashierSecondCardRuntimePrivileges } from './auditCustomerCashierSecondCardRuntimePrivileges';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { inspectRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { captureCashierConditionalTarget, CASHIER_RUNTIME_CONDITIONAL_TABLES, inspectCashierRuntimeConditionalBoundary } from './cashierRuntimeConditionalBoundary';
import { CASHIER_SECOND_CARD_FORM_IMAGES_RUNTIME_OPERATION, inspectCashierSecondCardFormImagesRuntimeCatalog,
  CASHIER_SECOND_CARD_FORM_IMAGE_TABLES, cashierSecondCardFormImagesRuntimeAddonGrantSql } from './cashierSecondCardFormImagesRuntimePlan';

type Query = Pick<DbClient,'execute'>;
export const CASHIER_SECOND_CARD_FORM_IMAGES_RUNTIME_GATES = [[731669,0],[731670,0],[731625,2],[731624,0],[731685,0],[731698,0]] as const;
function key(t:RoutinePaymentRuntimeTarget) {
  return JSON.stringify([t.database,t.maintenance,t.app,t.admin,[...(t.local??[])].sort(),
    t.caseLock ? [t.caseLock.owner,[...t.caseLock.runtimeRoles].sort()] : null]);
}
function capture(declared:RoutinePaymentRuntimeTarget,value:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon) {
  const peers=captureRuntimeGiftPeerDeclarations(value),cashier=peers.cashierSecondCard;
  if (!cashier || cashier.formImages!==true || cashier.conditionalGuards!==true
    || !peers.financial?.manualRefund || !peers.financial.originalPaymentReaders || peers.manager!==true || !reader)
    throw Error('Complete explicit conditional Cashier image successor, Financial, Manager and App reader required');
  const target=captureCashierConditionalTarget(declared,cashier.role),appReader=captureRuntimeAppCashierOriginReader(reader);
  if(key(target)!==key(peers.target))throw Error('Cashier image peers must bind the complete same routine target');
  const previous=captureRuntimeGiftPeerDeclarations({...peers,cashierSecondCard:{role:cashier.role,abandon:true,conditionalGuards:true}});
  return{target,peers,previous,appReader,role:cashier.role};
}

/** Exact grant-only successor for a fully commissioned conditional Cashier.
 * The image catalog must already have been installed by explicit owner DDL.
 * No role creation, password change, catalog installation or drift repair.
 * The returned binding is the trusted deployment identity for HTTP sessions. */
export async function upgradeCashierSecondCardFormImagesRuntimeInTransaction(tx:Query,declared:RoutinePaymentRuntimeTarget,
  declaration:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon) {
  if(Object.hasOwn(tx,'$client'))throw Error('Cashier image forward requires a caller-owned transaction');
  const{target,peers,previous,appReader,role}=capture(declared,declaration,reader);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const[identity]=await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND current_user=session_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off'
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready`);
  if(identity?.ready!==true)throw Error('Cashier image maintenance identity refused');
  for(const[key,subkey]of CASHIER_SECOND_CARD_FORM_IMAGES_RUNTIME_GATES){
    const[gate]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if(gate?.locked!==true)throw Error('Cashier image maintenance is busy');
  }
  const complete=async(declaration:RuntimeGiftPeerDeclarations)=>{
    const app=await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,'current',declaration,appReader);
    const admin=await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,'current',declaration);
    const cashier=await inspectCustomerCashierSecondCardRuntimePrivileges(tx,{role,requireLogin:true,
      routine:{target,stage:'ready'},abandon:true,conditionalGuards:true,
      ...(declaration.cashierSecondCard?.formImages ? {formImages:true}: {})});
    return{ready:app.ready&&admin.ready&&cashier.ready,app,admin,cashier};
  };
  const source=await inspectCashierSecondCardFormImagesRuntimeCatalog(tx,target.maintenance);
  const conditional=await inspectCashierRuntimeConditionalBoundary(tx,target,role);
  if(!source.ready || !conditional.ready || !conditional.binding || !(await inspectRoutinePaymentRuntime(tx,target)).ready)
    throw Error('Exact installed image catalog and commissioned conditional Cashier required');
  const current=await complete(peers);
  if(current.ready)return{operation:CASHIER_SECOND_CARD_FORM_IMAGES_RUNTIME_OPERATION,changed:false as const,target,role,
    binding:conditional.binding,audit:current,privilegesChanged:false as const,credentialChanged:false as const,
    historicalRowsReassigned:false as const,completeServiceCoverageVerified:false as const};
  if(!(await complete(previous)).ready)throw Error('Exact complete prior Cashier profile required; image grant drift is not repaired');
  const lockedTables=[...new Set([...CASHIER_RUNTIME_CONDITIONAL_TABLES,...CASHIER_SECOND_CARD_FORM_IMAGE_TABLES,
    'routine_identity_witness','routine_payment_attempt','payment_reconciliation_action','payment_reconciliation_case',
    'cashier_second_card_cart_v1','cashier_second_card_origin_v1','cashier_second_card_payment_v1',
    'system_attachment','system_form','system_form_data'])].sort();
  await tx.execute(sql.raw('LOCK TABLE '+lockedTables.map(t=>'ONLY public.'+pricingIdentifier(t)).join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT'));
  const lockedSource=await inspectCashierSecondCardFormImagesRuntimeCatalog(tx,target.maintenance);
  const lockedConditional=await inspectCashierRuntimeConditionalBoundary(tx,target,role);
  const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  if(!lockedSource.ready || !lockedConditional.ready || !same(lockedSource.tables,source.tables)
    || !same(lockedSource.functions,source.functions) || !same(lockedConditional.binding,conditional.binding)
    || !same(lockedConditional.functions,conditional.functions) || !same(lockedConditional.triggers,conditional.triggers)
    || !(await complete(previous)).ready || !(await inspectRoutinePaymentRuntime(tx,target)).ready)
    throw Error('Complete Cashier image prior changed while locking');
  for(const grant of cashierSecondCardFormImagesRuntimeAddonGrantSql(role))await tx.execute(sql.raw(grant));
  const post=await inspectCashierSecondCardFormImagesRuntimeCatalog(tx,target.maintenance);
  const postConditional=await inspectCashierRuntimeConditionalBoundary(tx,target,role),audit=await complete(peers);
  if(!post.ready || !postConditional.ready || !audit.ready || !same(post.tables,source.tables) || !same(post.functions,source.functions)
    || !same(postConditional.binding,conditional.binding) || !same(postConditional.functions,conditional.functions)
    || !same(postConditional.triggers,conditional.triggers) || !(await inspectRoutinePaymentRuntime(tx,target)).ready)
    throw Error('Complete Cashier image successor verification failed');
  return{operation:CASHIER_SECOND_CARD_FORM_IMAGES_RUNTIME_OPERATION,changed:true as const,target,role,
    binding:conditional.binding,audit,privilegesChanged:true as const,credentialChanged:false as const,
    historicalRowsReassigned:false as const,completeServiceCoverageVerified:false as const};
}

export async function upgradeCashierSecondCardFormImagesRuntime(db:DbClient,declared:RoutinePaymentRuntimeTarget,
  declaration:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon){
  if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Root Cashier image maintenance connection required');
  const c=capture(declared,declaration,reader);
  try{return await db.transaction(tx=>upgradeCashierSecondCardFormImagesRuntimeInTransaction(tx,c.target,c.peers,c.appReader),
    {isolationLevel:'read committed',accessMode:'read write'});}
  catch{throw Error('Cashier image forward outcome not confirmed; inspect exact profiles before further action');}
}
