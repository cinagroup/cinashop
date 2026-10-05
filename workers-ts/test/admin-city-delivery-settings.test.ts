import { describe, expect, it } from 'vitest';
import { CITY_DELIVERY_CREDENTIAL_KEYS, CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS } from '../../view/common/cityDeliverySettings';
import { cityCanonical, cityConfirmInput, cityPrepareInput, readCitySettingsBody } from '../src/services/admin/AdminCityDeliverySettingsInput';
import { cityCipherReady, CityDeliverySecretCodec } from '../src/services/delivery/CityDeliverySecretCodec';
import { normalizeAdminConfigBatch } from '../src/services/system/AdminConfigBatchService';
import { citySettingsBindings, citySettingsInput } from './helpers/cityDeliverySettingsFixture';

describe('complete city-delivery secret-intent input and authenticated codec', () => {
  it('retains all disabled nested flags and normalizes only explicit replacements', () => {
    const input = citySettingsInput('a'.repeat(64)); input.credentials.dada_app_sercret = { action: 'replace', value: ' secret replacement ' };
    const normalized = cityPrepareInput(input), canonical = cityCanonical(normalized);
    expect(canonical).toMatchObject({ operation: 'update', flags: { city_delivery_status: 0, self_delivery_status: 1, dada_delivery_status: 1, uu_delivery_status: 1 }, credentials: { dada_app_sercret: { action: 'replace', value: 'secret replacement' } } });
    expect(Object.keys(canonical.credentials)).toEqual([...CITY_DELIVERY_CREDENTIAL_KEYS]); expect(Object.keys(canonical)).toEqual(['operation', 'revision', 'flags', 'credentials']);
  });
  it('rejects unknown fields, implicit empty clear, controls before trim and malformed nonce', () => {
    const input = citySettingsInput('a'.repeat(64));
    for (const body of [{ ...input, extra: 1 }, { ...input, client_nonce: 'f'.repeat(64) }, { ...input, flags: { ...input.flags, city_delivery_status: '1' } },
      { ...input, credentials: { ...input.credentials, dada_app_key: { action: 'keep', value: 'secret' } } },
      { ...input, credentials: { ...input.credentials, dada_app_key: { action: 'replace', value: '\nsecret' } } },
      { ...input, credentials: { ...input.credentials, dada_app_key: { action: 'replace', value: '' } } }]) expect(() => cityPrepareInput(body)).toThrow();
    expect(() => cityConfirmInput({ request_id: input.request_id, client_nonce: input.client_nonce, payload_hash: 'a'.repeat(64), revision: input.revision })).toThrow();
  });
  it('supports all six exact runtime UTF8 limits without persisting an over-budget body', async () => {
    const input = citySettingsInput('a'.repeat(64));
    for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) input.credentials[key] = { action: 'replace', value: 'x'.repeat(CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS[key]) };
    expect(cityPrepareInput(await readCitySettingsBody(new Request('https://local.test', { method: 'POST', body: JSON.stringify(input) })))).toEqual(input);
    const codec = new CityDeliverySecretCodec(citySettingsBindings), sealed = await codec.seal(JSON.stringify({ input, expires_at: 2140000000 }), 'bounded-intent'); expect(sealed.length).toBeLessThan(32 * 200);
    input.credentials.uupt_open_id = { action: 'replace', value: '😀'.repeat(17) }; expect(() => cityPrepareInput(input)).toThrow();
  });
  it('encrypts nondeterministically and authenticates key, actor/nonce/AAD and ciphertext', async () => {
    const codec = new CityDeliverySecretCodec(citySettingsBindings), first = await codec.seal('synthetic replacement', 'actor:7:nonce:one'), second = await codec.seal('synthetic replacement', 'actor:7:nonce:one');
    expect(first).not.toBe(second); expect(first).not.toContain('synthetic replacement'); expect(await codec.open(first, 'actor:7:nonce:one')).toBe('synthetic replacement');
    await expect(codec.open(first, 'actor:8:nonce:one')).rejects.toThrow(); await expect(new CityDeliverySecretCodec({ CITY_DELIVERY_CONFIG_KEY: Buffer.alloc(32, 30).toString('base64url') }).open(first, 'actor:7:nonce:one')).rejects.toThrow();
    await expect(codec.open(`${first.slice(0, -1)}${first.endsWith('A') ? 'B' : 'A'}`, 'actor:7:nonce:one')).rejects.toThrow();
  });
  it('uses server-keyed digests instead of public hashes and fails readiness closed for invalid keys', async () => {
    const value = 'low-entropy synthetic secret', codec = new CityDeliverySecretCodec(citySettingsBindings);
    expect(await codec.digest(value)).toMatch(/^[a-f0-9]{64}$/); expect(await codec.digest(value)).not.toBe(await new CityDeliverySecretCodec({ CITY_DELIVERY_CONFIG_KEY: Buffer.alloc(32, 31).toString('base64url') }).digest(value));
    for (const key of [undefined, '', 'A'.repeat(42) + 'B', 'x'.repeat(32)]) expect(cityCipherReady({ CITY_DELIVERY_CONFIG_KEY: key })).toBe(false);
  });
  it('rejects duplicate JSON keys and the complete controlled domain in generic batches', async () => {
    await expect(readCitySettingsBody(new Request('https://local.test', { method: 'POST', body: '{"request_id":"one","request_id":"two"}' }))).rejects.toThrow();
    for (const key of [...CITY_DELIVERY_CREDENTIAL_KEYS, 'city_delivery_status', 'self_delivery_status', 'dada_delivery_status', 'uu_delivery_status', 'DADA_APP_SERCret', '\u00a0uupt_appkey\u00a0']) expect(() => normalizeAdminConfigBatch({ ordinary: 'safe', [key]: 'forbidden' })).toThrow();
  });
});
