/** Complete legacy city-delivery screen. Secrets are never response DTO values. */
export const CITY_DELIVERY_FLAG_KEYS = ['city_delivery_status', 'self_delivery_status', 'dada_delivery_status', 'uu_delivery_status'] as const;
export const CITY_DELIVERY_CREDENTIAL_KEYS = ['dada_app_key', 'dada_app_sercret', 'dada_source_id', 'uupt_appkey', 'uupt_app_id', 'uupt_open_id'] as const;
export const CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS = { dada_app_key: 128, dada_app_sercret: 256, dada_source_id: 128, uupt_appkey: 256, uupt_app_id: 128, uupt_open_id: 64 } as const;
export const CITY_DELIVERY_INTENT_TTL_SECONDS = 1800;
export const CITY_DELIVERY_INTENT_ACTIVE_QUOTA = 5;
export type CityDeliveryFlagKey = typeof CITY_DELIVERY_FLAG_KEYS[number];
export type CityDeliveryCredentialKey = typeof CITY_DELIVERY_CREDENTIAL_KEYS[number];
export type CityDeliveryFlags = Record<CityDeliveryFlagKey, 0 | 1>;
export type CityDeliveryCredentialAction = 'keep' | 'replace' | 'clear';
export type CityDeliveryCredentialInput = { action: 'keep' | 'clear' } | { action: 'replace'; value: string };
export type CityDeliveryCredentialActions = Record<CityDeliveryCredentialKey, CityDeliveryCredentialAction>;
export interface CityDeliveryPrepareInput {
  request_id: string;
  client_nonce: string;
  revision: string;
  flags: CityDeliveryFlags;
  credentials: Record<CityDeliveryCredentialKey, CityDeliveryCredentialInput>;
}
export interface CityDeliveryConfirmInput { request_id: string; client_nonce: string; payload_hash: string }
export interface CityDeliveryCredentialState {
  configured: boolean;
  source: 'encrypted' | 'env' | 'cleared' | 'none' | 'invalid';
  issues: string[];
}
export interface CityDeliverySettingsSnapshot {
  revision: string;
  editable: boolean;
  flags: Record<CityDeliveryFlagKey, 0 | 1 | null>;
  credentials: Record<CityDeliveryCredentialKey, CityDeliveryCredentialState>;
  readiness: { cipher_ready: boolean; dada_client_id: boolean; dada_callback_token: boolean; uu_callback_token: boolean; uu_timestamp_unit: boolean };
  issues: string[];
}
export interface CityDeliverySettingsReceipt {
  version: 1;
  operation: 'update';
  request_id: string;
  client_nonce: string;
  revision: string;
  payload_hash: string;
  flags: CityDeliveryFlags;
  actions: CityDeliveryCredentialActions;
}
export interface CityDeliveryPreparedIntent extends CityDeliverySettingsReceipt {
  intent_id: string;
  expires_at: number;
  state: 'prepared' | 'expired' | 'applied';
  receipt: CityDeliverySettingsReceipt | null;
}
export interface CityDeliverySettingsFailureProof {
  code: 'CITY_DELIVERY_SETTINGS_STALE_VERSION' | 'CITY_DELIVERY_SETTINGS_REJECTED';
  operation: 'update';
  request_id: string;
  client_nonce: string;
  payload_hash: string;
}
