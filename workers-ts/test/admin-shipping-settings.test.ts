import { describe, expect, it } from 'vitest';
import { readShippingSettingsBody, shippingCoordinate, shippingMoney, shippingSettingsCanonical, shippingSettingsHash } from '../src/services/admin/AdminShippingSettingsInput';
import { shippingSaveInput } from './helpers/shippingSettingsFixture';

describe('shipping settings fixed request and receipt intent', () => {
  it('uses exact decimal text and a stable cross-client canonical key order', async () => {
    const raw = shippingSaveInput('a'.repeat(64)), { canonical } = shippingSettingsCanonical(raw);
    expect(canonical).toEqual({ operation: 'save', revision: raw.revision, whole_free_shipping: 1, store_free_postage: '100.10',
      offline_postage: 0, store_self_mention: 1, pickup: { name: '城北提货点', phone: '13800138000', address_ids: [10, 11, 12, 13],
        detailed_address: '新路 1/2 号', day_time: ['22:00', '06:00'], latitude: '0', longitude: '121.23' } });
    expect(await shippingSettingsHash(canonical)).toMatch(/^[a-f0-9]{64}$/);
    expect(shippingSettingsCanonical({ ...raw, request_id: crypto.randomUUID() }).canonical).toEqual(canonical);
    const sharedVector = { ...raw, store_free_postage: '99.9', pickup: { name: '  提货点 🌤  ', phone: '13800138000',
      address_ids: [1, 2, 3, 4], detailed_address: '  A座 / 2 楼  ', day_time: ['22:30', '05:15'], latitude: '-0.000000', longitude: '113.920000' } };
    expect(await shippingSettingsHash(shippingSettingsCanonical(sharedVector).canonical)).toBe('8224985a003da6096ab7e75e91624588cffd22df70460d9061e4e8f5fa9e7500');
  });
  it('retains money down to one cent without binary rounding and rejects coercions', () => {
    for (const [input, output] of [['0', '0.00'], ['0.1', '0.10'], ['0.01', '0.01'], ['99999999.99', '99999999.99']]) expect(shippingMoney(input)).toBe(output);
    for (const input of [0, null, true, '', '01', '-1', '0.001', ' 1', '1e2', '100000000', 'NaN', 'Infinity']) expect(() => shippingMoney(input)).toThrow();
  });
  it('bounds coordinates and normalizes negative zero without permissive numeric parsing', () => {
    expect(shippingCoordinate('-90.000000', 90)).toBe('-90'); expect(shippingCoordinate('-0', 180)).toBe('0');
    for (const value of ['+1', '01', '1e1', '90.000001', ' 0', '1.1234567']) expect(() => shippingCoordinate(value, 90)).toThrow();
  });
  it('requires numeric flags, full city chain and valid phone/time inputs', () => {
    const input = shippingSaveInput('a'.repeat(64));
    for (const field of ['whole_free_shipping', 'offline_postage', 'store_self_mention']) for (const value of ['1', true, 2, null]) expect(() => shippingSettingsCanonical({ ...input, [field]: value })).toThrow();
    for (const change of [{ address_ids: [10, 11] }, { address_ids: [10, 11, 11] }, { address_ids: ['10', 11, 12] },
      { phone: '12345678901' }, { day_time: ['24:00', '06:00'] }, { day_time: ['8:00', '10:00'] }, { detailed_address: '' },
      { name: '\u0000bad' }, { day_time: ['08:00'] }]) expect(() => shippingSettingsCanonical({ ...input, pickup: { ...input.pickup, ...change } })).toThrow();
  });
  it('accepts overnight/all-day hours and disabled pickup only with explicit null', () => {
    const input = shippingSaveInput('a'.repeat(64));
    expect(shippingSettingsCanonical({ ...input, pickup: { ...input.pickup, day_time: ['00:00', '00:00'] } }).canonical.pickup?.day_time).toEqual(['00:00', '00:00']);
    expect(shippingSettingsCanonical({ ...input, store_self_mention: 0, pickup: null }).canonical.pickup).toBeNull();
    expect(() => shippingSettingsCanonical({ ...input, store_self_mention: 0 })).toThrow();
  });
  it('rejects arbitrary fields, credentials, missing intent and invalid identifiers', () => {
    const input = shippingSaveInput('a'.repeat(64));
    for (const value of [{ ...input, arbitrary: 1 }, { ...input, pickup: { ...input.pickup, bank_code: 'attempt' } },
      { ...input, request_id: 'not-a-uuid' }, { ...input, revision: '' }, { ...input, pickup: null }]) expect(() => shippingSettingsCanonical(value)).toThrow();
  });
  it('rejects duplicate JSON keys, nested duplicates, nonobjects, over-limit UTF8 and malformed data', async () => {
    for (const source of ['{"request_id":"a","request_id":"b"}', '{"pickup":{"name":"a","name":"b"}}', '[]', 'null', '{bad', `{"x":"${'中'.repeat(3000)}"}`]) {
      await expect(readShippingSettingsBody(new Request('https://local.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: source }))).rejects.toThrow();
    }
  });
});
