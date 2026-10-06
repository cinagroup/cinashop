import { and, eq, inArray, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import type { Env } from '@/env';
import { normalizeConfigScalar } from '@/utils/config';
import { ValidateException } from '@/utils/errors';
import { DISE_TEMPLATE_TRIM_CHARACTERS, themeDeadlines, themeHash } from '@/services/content/ThemeReadService';
import { cityCredential } from '@/services/admin/AdminCityDeliverySettingsInput';
import { CITY_DELIVERY_CREDENTIAL_KEYS, CITY_DELIVERY_FLAG_KEYS, type CityDeliveryCredentialKey, type CityDeliveryCredentialState, type CityDeliveryFlags, type CityDeliverySettingsSnapshot } from '../../../../view/common/cityDeliverySettings';
import { CityDeliverySecretCodec, cityCipherReady, isCitySealedValue } from './CityDeliverySecretCodec';
import { validateDadaCallbackToken } from './DadaCityDeliveryCallback';

export const CITY_DELIVERY_CONFIG_KEYS = [...CITY_DELIVERY_FLAG_KEYS, ...CITY_DELIVERY_CREDENTIAL_KEYS];
export const CITY_DELIVERY_SECRET_ENV_KEYS = { dada_app_key: 'DADA_APP_KEY', dada_app_sercret: 'DADA_APP_SECRET', dada_source_id: 'DADA_SOURCE_ID', uupt_appkey: 'UU_APP_KEY', uupt_app_id: 'UU_APP_ID', uupt_open_id: 'UU_OPEN_ID' } as const;
export const CITY_DELIVERY_SETTINGS_LOCK_NAMESPACE = 731720;
export const CITY_DELIVERY_INTENT_TYPE = 'city_delivery_intent';
export const CITY_DELIVERY_INTENT_PART_TYPE = 'city_delivery_intent_part';
export const CITY_DELIVERY_RECEIPT_TYPE = 'city_delivery_settings';
export const CITY_DELIVERY_PRIVATE_LOG_TYPES = [CITY_DELIVERY_INTENT_TYPE, CITY_DELIVERY_INTENT_PART_TYPE] as const;
export type CityDeliverySettingsEnv = Pick<Env, 'CITY_DELIVERY_CONFIG_KEY' | 'DADA_APP_KEY' | 'DADA_APP_SECRET' | 'DADA_SOURCE_ID' | 'DADA_CLIENT_ID' | 'DADA_CALLBACK_TOKEN' | 'UU_APP_KEY' | 'UU_APP_ID' | 'UU_OPEN_ID' | 'UU_CALLBACK_TOKEN' | 'UU_API_TIMESTAMP_UNIT'>;
export const citySettingsDeadlines = themeDeadlines;
export const normalizeCityConfigKey = (name: string) => name.trim().toLowerCase();
export const isCityCredentialKey = (name: string) => (CITY_DELIVERY_CREDENTIAL_KEYS as readonly string[]).includes(normalizeCityConfigKey(name));
export const isCityConfigKey = (name: string) => CITY_DELIVERY_CONFIG_KEYS.includes(normalizeCityConfigKey(name) as typeof CITY_DELIVERY_CONFIG_KEYS[number]);
export const cityCredentialAad = (key: CityDeliveryCredentialKey) => `city-delivery-credential:v1:${key}`;
function validDeployment(value: unknown, max: number, min = 1): boolean {
  return typeof value === 'string' && value.trim().length >= min && new TextEncoder().encode(value.trim()).byteLength <= max && !/[\u0000-\u001f\u007f]/.test(value.trim());
}
export function cityDeploymentReadiness(env: CityDeliverySettingsEnv) {
  const tokenReady = (value: string | undefined) => { try { validateDadaCallbackToken(value); return true; } catch { return false; } };
  return { cipher_ready: cityCipherReady(env), dada_client_id: validDeployment(env.DADA_CLIENT_ID, 64),
    dada_callback_token: tokenReady(env.DADA_CALLBACK_TOKEN), uu_callback_token: tokenReady(env.UU_CALLBACK_TOKEN),
    uu_timestamp_unit: env.UU_API_TIMESTAMP_UNIT === 'seconds' || env.UU_API_TIMESTAMP_UNIT === 'milliseconds' };
}
export async function lockCityConfigForMutation(tx: DbClient) { await tx.execute(sql`LOCK TABLE ${systemConfig} IN SHARE ROW EXCLUSIVE MODE`); }
// App is SELECT-only on system_config. This shared domain advisory fence
// coordinates the dedicated Admin writer, without granting table-wide writes.
// Non-cooperating maintenance writers must coordinate/stop traffic explicitly.
export async function lockCityConfigForRead(tx: DbClient) { await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${CITY_DELIVERY_SETTINGS_LOCK_NAMESPACE},0)`); }

/** SQL winners match SystemConfigDao sort DESC/id DESC; every candidate/xmin
 * contributes to CAS, including hidden/offpage duplicates and normalized aliases. */
export async function readCityDeliverySettingsInTx(tx: DbClient, env: CityDeliverySettingsEnv) {
  const rows = await tx.select({ id: systemConfig.id, isStore: systemConfig.isStore, menuName: systemConfig.menuName, value: systemConfig.value,
    sort: systemConfig.sort, xmin: sql<string>`xmin::text` }).from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), inArray(sql<string>`lower(btrim(${systemConfig.menuName},${DISE_TEMPLATE_TRIM_CHARACTERS}))`, CITY_DELIVERY_CONFIG_KEYS)))
    .orderBy(systemConfig.menuName, sql`${systemConfig.sort} DESC`, sql`${systemConfig.id} DESC`).limit(1001);
  if (rows.length > 1000) throw new ValidateException('同城配送历史配置超出读取上限');
  const codec = cityCipherReady(env) ? new CityDeliverySecretCodec(env) : null;
  const issues: string[] = [], flags = {} as CityDeliverySettingsSnapshot['flags'];
  const credentials = {} as CityDeliverySettingsSnapshot['credentials'], values = {} as Record<CityDeliveryCredentialKey, string>;
  const winners = new Map<string, typeof rows[number]>();
  let editable = true;
  for (const key of CITY_DELIVERY_CONFIG_KEYS) {
    const matching = rows.filter(row => normalizeCityConfigKey(row.menuName) === key);
    if (matching.some(row => row.menuName !== key)) { issues.push(`config_alias:${key}`); editable = false; }
    const exact = matching.filter(row => row.menuName === key).sort((a, b) => b.sort - a.sort || b.id - a.id);
    if (exact[0]) winners.set(key, exact[0]);
    if (exact.length > 1) issues.push(`config_duplicate:${key}`);
    if (!exact.length) issues.push(`config_missing:${key}`);
    if ((CITY_DELIVERY_FLAG_KEYS as readonly string[]).includes(key)) {
      const raw = normalizeConfigScalar(exact[0]?.value);
      flags[key as keyof CityDeliveryFlags] = raw === '0' ? 0 : raw === '1' ? 1 : null;
      if (raw !== '0' && raw !== '1') issues.push(`flag_invalid:${key}`);
      continue;
    }
    const secretKey = key as CityDeliveryCredentialKey, winner = exact[0], state: CityDeliveryCredentialState = { configured: false, source: 'none', issues: [] };
    values[secretKey] = '';
    if (winner && isCitySealedValue(winner.value)) {
      if (!codec) { state.source = 'invalid'; state.issues.push('cipher_key_unavailable'); }
      else try {
        const payload: unknown = JSON.parse(await codec.open(winner.value, cityCredentialAad(secretKey)));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('invalid');
        const parsed = payload as Record<string, unknown>;
        if (parsed.version !== 1 || (parsed.state !== 'value' && parsed.state !== 'cleared') || Object.keys(parsed).length !== (parsed.state === 'value' ? 3 : 2)) throw Error('invalid');
        if (parsed.state === 'cleared') state.source = 'cleared';
        else { values[secretKey] = cityCredential(parsed.value, secretKey); state.source = 'encrypted'; state.configured = true; }
      } catch { state.source = 'invalid'; state.issues.push('credential_cipher_invalid'); }
    } else if (exact.some(row => isCitySealedValue(row.value))) {
      // A higher-priority legacy row cannot resurrect Env after explicit clear.
      state.source = 'invalid'; state.issues.push('credential_authority_shadowed');
    } else {
      if (winner && normalizeConfigScalar(winner.value)) state.issues.push('legacy_plaintext_not_adopted');
      const deployed = env[CITY_DELIVERY_SECRET_ENV_KEYS[secretKey]];
      if (deployed) try { values[secretKey] = cityCredential(deployed, secretKey); state.source = 'env'; state.configured = true; }
      catch { state.source = 'invalid'; state.issues.push('credential_env_invalid'); }
    }
    credentials[secretKey] = state;
  }
  const readiness = cityDeploymentReadiness(env);
  if (!readiness.cipher_ready) issues.push('cipher_key_unavailable');
  // Raw/hashless public shape is used when the deployment key is absent: never
  // expose a SHA-256 of low-entropy historical plaintext or Env credentials.
  const revisionMaterial = JSON.stringify({ rows: rows.map(row => codec ? row : { id: row.id, isStore: row.isStore, menuName: row.menuName, sort: row.sort, xmin: row.xmin }),
    values: codec ? values : credentials, readiness, managed: credentials });
  const revision = codec ? await codec.digest(`snapshot:v1:${revisionMaterial}`) : await themeHash(JSON.parse(revisionMaterial));
  return { rows, winners, values, snapshot: { revision, editable, flags, credentials, readiness, issues } satisfies CityDeliverySettingsSnapshot };
}
export interface DadaCityCredentials { appKey: string; appSecret: string; sourceId: string; clientId: string }
export interface UuCityCredentials { appId: string; appKey: string; openId: string; timestampUnit: 'seconds' | 'milliseconds' }
export class CityDeliverySettingsResolver {
  constructor(private readonly container: Container, private readonly env: CityDeliverySettingsEnv) {}
  async resolved() { return withTx(this.container, async tx => { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await citySettingsDeadlines(tx); return readCityDeliverySettingsInTx(tx, this.env); }); }
  async read() { return (await this.resolved()).snapshot; }
  async flags() { const { snapshot } = await this.resolved(); return Object.fromEntries(CITY_DELIVERY_FLAG_KEYS.map(key => [key, snapshot.flags[key] === 1 ? 1 : 0])) as CityDeliveryFlags; }
  async dada(): Promise<DadaCityCredentials> {
    const { values } = await this.resolved();
    if (!validDeployment(this.env.DADA_CLIENT_ID, 64)) throw Error('dada_client_id_invalid');
    return { appKey: cityCredential(values.dada_app_key, 'dada_app_key'), appSecret: cityCredential(values.dada_app_sercret, 'dada_app_sercret'), sourceId: cityCredential(values.dada_source_id, 'dada_source_id'), clientId: this.env.DADA_CLIENT_ID!.trim() };
  }
  async uu(): Promise<UuCityCredentials> {
    const { values } = await this.resolved(), timestampUnit = this.env.UU_API_TIMESTAMP_UNIT;
    if (timestampUnit !== 'seconds' && timestampUnit !== 'milliseconds') throw Error('uu_timestamp_unit_unverified');
    return { appId: cityCredential(values.uupt_app_id, 'uupt_app_id'), appKey: cityCredential(values.uupt_appkey, 'uupt_appkey'), openId: cityCredential(values.uupt_open_id, 'uupt_open_id'), timestampUnit };
  }
  async uuOpenId() { return cityCredential((await this.resolved()).values.uupt_open_id, 'uupt_open_id'); }
}
