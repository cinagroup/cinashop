/** Synthetic fixed v1 wire vectors and pure rejection cases only. These do
 * not create provider observations, database rows or native acceptance proof. */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException, ValidateException } from '../src/utils/errors';
import { parseRoutineIdentityOwnership, parseRoutineIdentityWitness,
  type RoutineIdentityOwnershipRow, type RoutineIdentityWitnessRow } from '../src/services/wechat/RoutineIdentityEvidenceCodec';
import { verifyRoutineIdentityObservation, type RoutineIdentityObservation } from '../src/services/wechat/RoutineIdentityObservation';

const env = { APP_KEY: 'synthetic-codec-compatibility-key' };
const NOW = 1800000000, OBSERVED = 1799996400;
const UUID = '11111111-2222-4333-8444-555555555555';
const observation: RoutineIdentityObservation = {
  version: 1, purpose: 'routine_code2session', observationId: UUID,
  appId: 'wx_codec_historical_a', openid: 'codec_original_subject', unionid: 'codec_union',
  sourceStamp: 'a'.repeat(64), observedAt: OBSERVED,
  signature: '798413f016032e4b64554988fe835ce4d92e8068398f8c3297bc63fe76efd66e',
};
const ownerVector: RoutineIdentityOwnershipRow = {
  ownership_id: '1562937dd918ee4654e78df1d04b12909fffd903c40b0edacdfee6507e98703d',
  app_id: observation.appId, openid: observation.openid, uid: 11, binding_id: 701, observation_id: UUID,
  format_version: 1, observed_at: OBSERVED, created_at: OBSERVED + 1,
  signature: '387671cd7f166ae5b43139833d55b5d9e5445614c54c1d0e1baa8942220b402a',
};
const witnessVector: RoutineIdentityWitnessRow = {
  observation_id: UUID, uid: 11, binding_id: 701, format_version: 1, observation,
  created_at: OBSERVED + 1,
  signature: '74ec7c1a7eeeed4e7925bbd57a762f38242326fc26779738a06f1ae374e555e9',
};

// The four fixed hex vectors above were calculated independently with the
// pre-extraction v1 byte recipes. Helpers below vary those legacy recipes to
// exercise authenticated time/tuple counterexamples, not runtime signing APIs.
function legacyMac(domain: string, value: unknown): string {
  return createHmac('sha256', env.APP_KEY).update(domain + '\0').update(JSON.stringify(value)).digest('hex');
}
function legacyObservation(observedAt = OBSERVED, observationId = UUID): RoutineIdentityObservation {
  const row = { version: 1 as const, purpose: 'routine_code2session' as const, observationId,
    appId: observation.appId, openid: observation.openid, unionid: observation.unionid,
    sourceStamp: observation.sourceStamp, observedAt };
  return { ...row, signature: legacyMac('cinashop.routine.identity-observation.v1', row) };
}
function legacyOwner(createdAt = OBSERVED + 1, observedAt = OBSERVED): RoutineIdentityOwnershipRow {
  const row = { ...ownerVector, observed_at: observedAt, created_at: createdAt };
  row.signature = legacyMac('cinashop.routine-identity-ownership.record.v1', [
    row.ownership_id, row.app_id, row.openid, row.uid, row.binding_id, row.observation_id,
    row.format_version, Number(row.observed_at), Number(row.created_at),
  ]);
  return row;
}
function legacyWitness(createdAt = OBSERVED + 1, observedAt = OBSERVED, observationId = UUID): RoutineIdentityWitnessRow {
  const o = legacyObservation(observedAt, observationId);
  const row = { ...witnessVector, observation_id: observationId, observation: o, created_at: createdAt };
  row.signature = legacyMac('cinashop.routine-identity-witness.record.v1', [
    row.observation_id, row.uid, row.binding_id, row.format_version,
    [o.version, o.purpose, o.observationId, o.appId, o.openid, o.unionid, o.sourceStamp, o.observedAt, o.signature],
    Number(row.created_at),
  ]);
  return row;
}

const parsers = [
  { kind: 'ownership', parse: parseRoutineIdentityOwnership, row: () => structuredClone(ownerVector) },
  { kind: 'witness', parse: parseRoutineIdentityWitness, row: () => structuredClone(witnessVector) },
];

describe('durable Routine identity evidence v1 codecs', () => {
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('decodes the fixed pre-extraction ownership identity and record signatures', () => {
    const owner = parseRoutineIdentityOwnership(env, ownerVector);
    expect(owner).toEqual({ ownershipId: ownerVector.ownership_id, appId: observation.appId,
      openid: observation.openid, uid: 11, bindingId: 701, observationId: UUID,
      observedAt: OBSERVED, createdAt: OBSERVED + 1 });
    expect(Object.isFrozen(owner)).toBe(true);
  });

  it('decodes both fixed observation and witness signatures without changing their byte domains', () => {
    const witness = parseRoutineIdentityWitness(env, witnessVector);
    expect(witness).toEqual({ observationId: UUID, uid: 11, bindingId: 701,
      observation, createdAt: OBSERVED + 1 });
    expect(Object.isFrozen(witness)).toBe(true);
    expect(Object.isFrozen(witness.observation)).toBe(true);
  });

  it('accepts actual SQL decimal-string timestamps and null-prototype projections', () => {
    const owner = Object.assign(Object.create(null), ownerVector,
      { observed_at: String(OBSERVED), created_at: String(OBSERVED + 1) });
    const witness = Object.assign(Object.create(null), witnessVector, { created_at: String(OBSERVED + 1) });
    expect(parseRoutineIdentityOwnership(env, owner)).toEqual(parseRoutineIdentityOwnership(env, ownerVector));
    expect(parseRoutineIdentityWitness(env, witness)).toEqual(parseRoutineIdentityWitness(env, witnessVector));
  });

  it('keeps an expired durable anchor while the same observation refuses fresh login admission', () => {
    expect(() => verifyRoutineIdentityObservation(env, observation)).toThrow(ValidateException);
    expect(parseRoutineIdentityWitness(env, witnessVector).observation.observedAt).toBe(OBSERVED);
    expect(parseRoutineIdentityOwnership(env, ownerVector).observedAt).toBe(OBSERVED);
  });

  it('preserves the distinct witness and ownership creation windows beyond observedAt+900', () => {
    expect(parseRoutineIdentityWitness(env, legacyWitness(OBSERVED + 901)).createdAt).toBe(OBSERVED + 901);
    expect(() => parseRoutineIdentityOwnership(env, legacyOwner(OBSERVED + 901))).toThrow(ServiceUnavailableException);
  });

  it.each([-60, 900])('accepts the ownership creation boundary offset %i', offset => {
    expect(parseRoutineIdentityOwnership(env, legacyOwner(OBSERVED + offset)).createdAt).toBe(OBSERVED + offset);
  });
  it.each([-61, 901])('rejects an authenticated ownership creation outside the window: %i', offset => {
    expect(() => parseRoutineIdentityOwnership(env, legacyOwner(OBSERVED + offset))).toThrow(ServiceUnavailableException);
  });
  it('rejects too-future stored ownership or witness creation without adding a past TTL', () => {
    expect(() => parseRoutineIdentityOwnership(env, legacyOwner(NOW + 61, NOW))).toThrow(ServiceUnavailableException);
    expect(() => parseRoutineIdentityWitness(env, legacyWitness(NOW + 61, NOW))).toThrow(ServiceUnavailableException);
  });
  it('still rejects a future observation when durable expiry is allowed', () => {
    expect(() => parseRoutineIdentityWitness(env, legacyWitness(NOW + 61, NOW + 61))).toThrow(ValidateException);
  });
  it('retains the witness lower creation bound without imposing the owner upper bound', () => {
    expect(parseRoutineIdentityWitness(env, legacyWitness(OBSERVED - 60)).createdAt).toBe(OBSERVED - 60);
    expect(() => parseRoutineIdentityWitness(env, legacyWitness(OBSERVED - 61))).toThrow(ServiceUnavailableException);
  });

  it('copies its authenticated values without retargeting an original owner to a newer witness', () => {
    const raw = structuredClone(witnessVector), owner = parseRoutineIdentityOwnership(env, ownerVector);
    const first = parseRoutineIdentityWitness(env, raw);
    const newer = parseRoutineIdentityWitness(env, legacyWitness(NOW, NOW, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'));
    (raw.observation as RoutineIdentityObservation).openid = 'changed_after_parse';
    expect(first.observation.openid).toBe(observation.openid);
    expect(owner.observationId).toBe(first.observationId);
    expect(newer.observationId).not.toBe(owner.observationId);
  });

  it.each([
    ['uid', 0], ['binding_id', 0], ['uid', 2147483648], ['format_version', 2],
    ['app_id', 'invalid app'], ['openid', 'invalid subject'], ['observed_at', 0],
    ['ownership_id', '0'.repeat(64)], ['observation_id', '11111111-2222-3333-8444-555555555555'],
    ['signature', '0'.repeat(64)],
  ])('refuses altered ownership field %s', (field, value) => {
    expect(() => parseRoutineIdentityOwnership(env, { ...ownerVector, [field as string]: value })).toThrow(ServiceUnavailableException);
  });
  it.each([
    ['uid', 0], ['binding_id', 0], ['format_version', 2],
    ['observation_id', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    ['created_at', Number.NaN], ['signature', '0'.repeat(64)],
  ])('refuses altered witness field %s', (field, value) => {
    expect(() => parseRoutineIdentityWitness(env, { ...witnessVector, [field as string]: value })).toThrow(ServiceUnavailableException);
  });
  it.each(['openid', 'appId', 'sourceStamp', 'signature'])('refuses altered nested observation %s', field => {
    const changed = { ...observation, [field]: field === 'sourceStamp' || field === 'signature' ? '0'.repeat(64) : 'other_subject' };
    expect(() => parseRoutineIdentityWitness(env, { ...witnessVector, observation: changed })).toThrow(ValidateException);
  });

  it('authenticates the ownership identity key as well as a valid record MAC', () => {
    const row = { ...ownerVector, ownership_id: '0'.repeat(64) };
    row.signature = legacyMac('cinashop.routine-identity-ownership.record.v1', [
      row.ownership_id, row.app_id, row.openid, row.uid, row.binding_id, row.observation_id,
      row.format_version, row.observed_at, row.created_at,
    ]);
    expect(() => parseRoutineIdentityOwnership(env, row)).toThrow(ServiceUnavailableException);
  });
  it('keeps the old observation-error versus record-error exception distinction', () => {
    expect(() => parseRoutineIdentityWitness({ APP_KEY: 'wrong-synthetic-key' }, witnessVector)).toThrow(ValidateException);
    expect(() => parseRoutineIdentityOwnership({ APP_KEY: 'wrong-synthetic-key' }, ownerVector)).toThrow(ServiceUnavailableException);
    expect(() => parseRoutineIdentityWitness(env, { ...witnessVector, signature: '0'.repeat(64) }))
      .toThrow('小程序身份观察记录无效，请重新授权或维护');
    expect(() => parseRoutineIdentityOwnership(env, { ...ownerVector, signature: '0'.repeat(64) }))
      .toThrow('小程序账号归属记录未完整就绪，请维护后重试');
  });

  for (const parser of parsers) {
    it.each([[null], [[]], ['row'], [1], [true]])('rejects non-row ' + parser.kind + ' input %j', value => {
      expect(() => parser.parse(env, value)).toThrow(ServiceUnavailableException);
    });
    it('rejects extra, missing, symbolic, hidden and foreign-prototype ' + parser.kind + ' fields', () => {
      const row = parser.row();
      const missing = { ...row } as Record<string, unknown>; delete missing.uid;
      const hidden = { ...row }; Object.defineProperty(hidden, 'signature', { value: row.signature, enumerable: false });
      for (const changed of [{ ...row, extra: true }, missing, { ...row, [Symbol('unexpected')]: true },
        hidden, Object.assign(Object.create({ foreign: true }), row)]) {
        expect(() => parser.parse(env, changed)).toThrow(ServiceUnavailableException);
      }
    });
    it('never invokes a supplied ' + parser.kind + ' field accessor or timestamp coercion', () => {
      const getter = vi.fn(() => { throw Error('Accessor must remain inert'); });
      const valueOf = vi.fn(() => NOW);
      const accessor = { ...parser.row() };
      Object.defineProperty(accessor, 'signature', { get: getter, enumerable: true });
      expect(() => parser.parse(env, accessor)).toThrow(ServiceUnavailableException);
      expect(() => parser.parse(env, { ...parser.row(), created_at: { valueOf } })).toThrow(ServiceUnavailableException);
      expect(getter).not.toHaveBeenCalled(); expect(valueOf).not.toHaveBeenCalled();
    });
    it('replaces a hostile ' + parser.kind + ' descriptor trap with the existing record error', () => {
      const hostile = new Proxy(parser.row(), { ownKeys() { throw Error('Opaque descriptor trap'); } });
      expect(() => parser.parse(env, hostile)).toThrow(ServiceUnavailableException);
    });
  }
  it('does not invoke an accessor inside the nested observation', () => {
    const getter = vi.fn(() => { throw Error('Nested getter must remain inert'); });
    const hostile = { ...observation }; Object.defineProperty(hostile, 'openid', { get: getter, enumerable: true });
    expect(() => parseRoutineIdentityWitness(env, { ...witnessVector, observation: hostile })).toThrow(ValidateException);
    expect(getter).not.toHaveBeenCalled();
  });
});
