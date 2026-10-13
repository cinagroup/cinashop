import { bigint, integer, jsonb, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';

export interface ErpShopBinding { providerShopId:number; storeId:number; supplierId:number }
export type ErpConnectionState='enrolled'|'active'|'disabled'|'revoked';
export type ErpOperationKind='product-sync'|'stock'|'deliver'|'cancel'|'refund-receive';
export interface ErpOperationScope {
  providerShopId?:number;storeId?:number;supplierId?:number;customerUid?:number;rootOrderId?:number;activeOrderId?:number;
  refundId?:number;refundNo?:string;cartRows?:Array<{id:number;quantity:number;code:string}>;
  refundAmountCents?:number;refundedAmountCents?:number;skuRows?:Array<{id:number;productId:number;quantity:number;code:string}>;
}
export interface ErpBusinessResult { updated?:number;productIds?:number[];orderId?:number;remainingOrderId?:number|null;refundId?:number;completed?:boolean;providerStatus?:string }
const epoch=(name:string)=>bigint(name,{mode:'number'});

/** Candidate SQL principal state. Raw callback/state tokens are never stored;
 * application permission and SQL capability commissioning remain separate. */
export const erpConnection=pgTable('erp_connection',{
  id:uuid('id').primaryKey(),provider:varchar('provider',{length:16}).notNull(),name:varchar('name',{length:64}).notNull(),
  state:varchar('state',{length:16}).$type<ErpConnectionState>().notNull(),revision:integer('revision').notNull(),
  appKey:varchar('app_key',{length:128}).notNull(),credentialFingerprint:varchar('credential_fingerprint',{length:64}).notNull(),
  capabilityHash:varchar('capability_hash',{length:64}).notNull(),capabilityVersion:integer('capability_version').notNull(),rotatedAt:epoch('rotated_at').notNull(),
  bindings:jsonb('bindings').$type<ErpShopBinding[]>().notNull(),scopeRevision:integer('scope_revision').notNull(),shopObservationHash:varchar('shop_observation_hash',{length:64}),
  createdBy:integer('created_by').notNull(),updatedBy:integer('updated_by').notNull(),createdAt:epoch('created_at').notNull(),updatedAt:epoch('updated_at').notNull(),
  revokedAt:epoch('revoked_at'),revokeReason:varchar('revoke_reason',{length:255}),
});
export const erpAuthState=pgTable('erp_auth_state',{
  stateHash:varchar('state_hash',{length:64}).primaryKey(),connectionId:uuid('connection_id').notNull(),connectionRevision:integer('connection_revision').notNull(),
  capabilityVersion:integer('capability_version').notNull(),appKey:varchar('app_key',{length:128}).notNull(),credentialFingerprint:varchar('credential_fingerprint',{length:64}).notNull(),
  actorId:integer('actor_id').notNull(),actorAuthVersion:varchar('actor_auth_version',{length:32}).notNull(),actorExpiresAt:epoch('actor_expires_at').notNull(),
  requiredPermission:varchar('required_permission',{length:64}).notNull(),createdAt:epoch('created_at').notNull(),expiresAt:epoch('expires_at').notNull(),
  state:varchar('state',{length:16}).$type<'issued'|'exchanging'|'consumed'|'failed'>().notNull(),codeHash:varchar('code_hash',{length:64}),
  exchangeLeaseHash:varchar('exchange_lease_hash',{length:64}),leaseExpiresAt:epoch('lease_expires_at'),consumedAt:epoch('consumed_at'),errorCode:varchar('error_code',{length:64}),
});
export const erpCredential=pgTable('erp_credential',{
  connectionId:uuid('connection_id').primaryKey(),version:integer('version').notNull(),appKey:varchar('app_key',{length:128}).notNull(),
  credentialFingerprint:varchar('credential_fingerprint',{length:64}).notNull(),accessTokenSealed:text('access_token_sealed').notNull(),refreshTokenSealed:text('refresh_token_sealed').notNull(),
  issuedAt:epoch('issued_at').notNull(),expiresAt:epoch('expires_at').notNull(),refreshAfter:epoch('refresh_after').notNull(),authStateHash:varchar('auth_state_hash',{length:64}).notNull(),
  shopObservationHash:varchar('shop_observation_hash',{length:64}),refreshLeaseHash:varchar('refresh_lease_hash',{length:64}),refreshLeaseExpiresAt:epoch('refresh_lease_expires_at'),
  updatedAt:epoch('updated_at').notNull(),state:varchar('state',{length:16}).$type<'usable'|'expired'|'revoked'>().notNull(),errorCode:varchar('error_code',{length:64}),
});
export const erpOperation=pgTable('erp_operation',{
  id:uuid('id').primaryKey(),connectionId:uuid('connection_id').notNull(),kind:varchar('kind',{length:24}).$type<ErpOperationKind>().notNull(),
  businessKey:varchar('business_key',{length:255}).notNull(),providerEventId:varchar('provider_event_id',{length:128}),requestHash:varchar('request_hash',{length:64}).notNull(),
  sourceTs:epoch('source_ts').notNull(),receivedAt:epoch('received_at').notNull(),connectionRevision:integer('connection_revision').notNull(),capabilityVersion:integer('capability_version').notNull(),
  scopeRevision:integer('scope_revision').notNull(),credentialVersion:integer('credential_version').notNull(),
  state:varchar('state',{length:24}).$type<'admitted'|'observed'|'business_committed'|'provider_pending'|'rejected'|'failed'>().notNull(),
  leaseHash:varchar('lease_hash',{length:64}),leaseExpiresAt:epoch('lease_expires_at'),attemptCount:integer('attempt_count').notNull(),
  scope:jsonb('scope').$type<ErpOperationScope>(),observationHash:varchar('observation_hash',{length:64}),observedAt:epoch('observed_at'),
  providerFacts:jsonb('provider_facts').$type<Record<string,unknown>>(),businessResult:jsonb('business_result').$type<ErpBusinessResult>(),paymentAdmissionId:varchar('payment_admission_id',{length:128}),
  errorCode:varchar('error_code',{length:64}),createdAt:epoch('created_at').notNull(),updatedAt:epoch('updated_at').notNull(),completedAt:epoch('completed_at'),
});
