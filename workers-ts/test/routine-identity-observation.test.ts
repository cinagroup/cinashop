import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidateException } from '@/utils/errors';
import { hasRoutineIdentityObservationShape, issueRoutineIdentityObservation, verifyRoutineIdentityObservation,
  type RoutineIdentityObservation } from '@/services/wechat/RoutineIdentityObservation';

const NOW = 1800000000, env = { APP_KEY: 'owned-observation-signing-key' };
const DOMAIN = 'cinashop.routine.identity-observation.v1\0';
const FIELDS = ['version', 'purpose', 'observationId', 'appId', 'openid', 'unionid', 'sourceStamp', 'observedAt', 'signature'];
const input = () => ({ appId: 'wx_owned_mini', openid: 'owned-openid', unionid: 'owned-unionid', sourceStamp: 'a'.repeat(64) });
type Input = Parameters<typeof issueRoutineIdentityObservation>[1];
type Expected = NonNullable<Parameters<typeof verifyRoutineIdentityObservation>[2]>;
const expected = (value: Input = input()): Expected => ({ openid: value.openid, unionid: value.unionid, sourceStamp: value.sourceStamp });

// Independently compute the real HMAC bytes; no signer/verifier implementation
// or crypto result is mocked. Deliberately malformed signed envelopes exercise
// validation independently from tamper detection.
function mac(value: Record<string, unknown>, domain = DOMAIN, secret = env.APP_KEY): string {
  return createHmac('sha256', secret).update(domain).update(JSON.stringify({ version: value.version, purpose: value.purpose,
    observationId: value.observationId, appId: value.appId, openid: value.openid, unionid: value.unionid,
    sourceStamp: value.sourceStamp, observedAt: value.observedAt })).digest('hex');
}
function signed(value: Readonly<RoutineIdentityObservation>, change: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value, ...change }; return { ...result, signature: mac(result) };
}

describe('Mini code2Session exact authenticated identity observations', () => {
  let observation: Readonly<RoutineIdentityObservation>;
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000); observation = issueRoutineIdentityObservation(env, input()); });
  afterEach(() => vi.restoreAllMocks());

  it('signs actual canonical bytes with a fresh UUIDv4 and second timestamp', () => {
    expect(Object.keys(observation)).toEqual(FIELDS);
    expect(observation).toMatchObject({ version: 1, purpose: 'routine_code2session', ...input(), observedAt: NOW });
    expect(observation.observationId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(observation.signature).toBe(mac({ ...observation }));
    expect(issueRoutineIdentityObservation(env, input()).observationId).not.toBe(observation.observationId);
    expect(verifyRoutineIdentityObservation(env, observation, expected())).toEqual(observation);
  });

  it('canonicalizes field order without accepting an alternate wire envelope', () => {
    const reordered = Object.fromEntries(Object.entries(observation).reverse());
    expect(verifyRoutineIdentityObservation(env, reordered)).toEqual(observation);
    expect(() => verifyRoutineIdentityObservation(env, JSON.stringify(observation))).toThrow(ValidateException);
  });

  it('returns frozen detached observations and does not retain the input object', () => {
    const source = input(), issued = issueRoutineIdentityObservation(env, source); source.appId = 'changed-input';
    expect(issued.appId).toBe('wx_owned_mini'); expect(Object.isFrozen(issued)).toBe(true);
    const wire = { ...issued }, verified = verifyRoutineIdentityObservation(env, wire);
    expect(verified).not.toBe(wire); expect(verified).not.toBe(issued); expect(Object.isFrozen(verified)).toBe(true);
    wire.openid = 'changed-wire'; expect(verified.openid).toBe('owned-openid');
    expect(Reflect.set(verified, 'openid', 'changed-result')).toBe(false);
  });

  it('normalizes only an omitted unionid to the explicit empty proof field', () => {
    const { unionid: _unionid, ...withoutUnion } = input();
    const empty = issueRoutineIdentityObservation(env, withoutUnion);
    expect(empty.unionid).toBe(''); expect(verifyRoutineIdentityObservation(env, empty, expected(withoutUnion))).toEqual(empty);
    expect(() => verifyRoutineIdentityObservation(env, observation, expected(withoutUnion))).toThrow('重新授权');
  });

  it.each([
    ['version', 2], ['purpose', 'routine_phone'], ['observationId', 'b1ba9549-9c31-4f98-a901-e36880263014'],
    ['appId', 'other-app'], ['openid', 'other-openid'], ['unionid', 'other-unionid'],
    ['sourceStamp', 'b'.repeat(64)], ['observedAt', NOW - 1], ['signature', '0'.repeat(64)],
  ] as const)('rejects unsigned tampering of %s', (field, value) => {
    expect(() => verifyRoutineIdentityObservation(env, { ...observation, [field]: value })).toThrow(ValidateException);
  });

  it('rejects coordinated identity/source substitutions and MAC corruption at either end', () => {
    expect(() => verifyRoutineIdentityObservation(env, { ...observation, appId: 'other', openid: 'other', sourceStamp: 'b'.repeat(64) })).toThrow();
    for (const index of [0, 63]) {
      const chars = [...observation.signature]; chars[index] = chars[index] === '0' ? '1' : '0';
      expect(() => verifyRoutineIdentityObservation(env, { ...observation, signature: chars.join('') })).toThrow();
    }
  });

  it.each(FIELDS)('rejects a missing exact proof field %s', field => {
    const wire: Record<string, unknown> = { ...observation }; delete wire[field];
    expect(hasRoutineIdentityObservationShape(wire)).toBe(false);
    expect(() => verifyRoutineIdentityObservation(env, wire)).toThrow('重新授权');
  });

  it.each(['code', 'Secret', 'sessionKey', 'extra'])('rejects additional sensitive/unknown field %s without echoing it', field => {
    const privateValue = 'private-value-never-in-error';
    for (const value of [{ ...input(), [field]: privateValue }, { ...observation, [field]: privateValue }]) {
      try {
        if ('signature' in value) verifyRoutineIdentityObservation(env, value);
        else issueRoutineIdentityObservation(env, value as Input);
        throw Error('Invalid input accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidateException); expect(String(error)).not.toContain(privateValue);
      }
    }
    expect(JSON.stringify(observation)).not.toContain(env.APP_KEY);
    expect(Object.keys(observation)).toEqual(FIELDS);
  });

  it.each([
    ['appId', 'empty', ''], ['appId', 'overflow', 'a'.repeat(33)], ['appId', 'number', 123],
    ['appId', 'space', ' app'], ['appId', 'newline', 'app\n'], ['appId', 'unicode', '微信'],
    ['openid', 'empty', ''], ['openid', 'overflow', 'a'.repeat(101)], ['openid', 'object', {}],
    ['openid', 'null', null], ['openid', 'newline', 'openid\n'], ['openid', 'unicode', 'openid🧭'],
    ['unionid', 'overflow', 'a'.repeat(31)], ['unionid', 'boolean', false], ['unionid', 'null', null],
    ['unionid', 'control', 'id\0'], ['sourceStamp', 'uppercase', 'A'.repeat(64)],
    ['sourceStamp', 'short', 'a'.repeat(63)], ['sourceStamp', 'newline', 'a'.repeat(64) + '\n'], ['sourceStamp', 'array', []],
  ] as const)('rejects signed malformed identity %s/%s and never signs it on issue', (field, _label, value) => {
    const wire = signed(observation, { [field]: value });
    expect(hasRoutineIdentityObservationShape(wire)).toBe(false);
    expect(() => verifyRoutineIdentityObservation(env, wire)).toThrow(ValidateException);
    expect(() => issueRoutineIdentityObservation(env, { ...input(), [field]: value } as Input)).toThrow(ValidateException);
  });

  it('accepts exact ASCII capacities without trimming or truncating', () => {
    const boundary = { appId: 'a'.repeat(32), openid: '_'.repeat(100), unionid: '-'.repeat(30), sourceStamp: 'f'.repeat(64) };
    expect(verifyRoutineIdentityObservation(env, issueRoutineIdentityObservation(env, boundary), expected(boundary))).toMatchObject(boundary);
    expect(issueRoutineIdentityObservation(env, { ...boundary, appId: 'a', openid: 'x', unionid: '' })).toMatchObject({ appId: 'a', openid: 'x', unionid: '' });
  });

  it.each([
    ['version/string', { version: '1' }], ['purpose/type', { purpose: 1 }],
    ['UUID/v1', { observationId: 'c1ba9549-9c31-1f98-a901-e36880263014' }],
    ['UUID/variant', { observationId: 'c1ba9549-9c31-4f98-7901-e36880263014' }],
    ['UUID/uppercase', { observationId: 'C1BA9549-9C31-4F98-A901-E36880263014' }],
    ['UUID/newline', { observationId: 'c1ba9549-9c31-4f98-a901-e36880263014\n' }],
    ['UUID/type', { observationId: 42 }],
    ['time/string', { observedAt: String(NOW) }], ['time/fraction', { observedAt: NOW + 0.1 }],
    ['time/zero', { observedAt: 0 }], ['time/negative', { observedAt: -1 }],
    ['time/NaN', { observedAt: NaN }], ['time/Infinity', { observedAt: Infinity }],
    ['time/unsafe', { observedAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['signature/uppercase', { signature: 'A'.repeat(64) }], ['signature/newline', { signature: 'a'.repeat(64) + '\n' }],
    ['signature/short', { signature: 'a'.repeat(63) }], ['signature/type', { signature: null }],
  ] as const)('rejects malformed proof scalar %s', (_label, patch) => {
    const wire = { ...observation, ...patch };
    expect(hasRoutineIdentityObservationShape(wire)).toBe(false);
    expect(() => verifyRoutineIdentityObservation(env, wire, undefined, { allowExpired: true })).toThrow(ValidateException);
  });

  it('treats structural acceptance as neither authentication nor freshness', () => {
    const forged = { ...observation, signature: '0'.repeat(64) }, old = signed(observation, { observedAt: NOW - 901 });
    expect(hasRoutineIdentityObservationShape(forged)).toBe(true); expect(hasRoutineIdentityObservationShape(old)).toBe(true);
    expect(() => verifyRoutineIdentityObservation(env, forged)).toThrow(); expect(() => verifyRoutineIdentityObservation(env, old)).toThrow();
  });

  it('enforces the original 900-second age and 60-second future boundaries', () => {
    expect(verifyRoutineIdentityObservation(env, signed(observation, { observedAt: NOW - 900 })).observedAt).toBe(NOW - 900);
    expect(() => verifyRoutineIdentityObservation(env, signed(observation, { observedAt: NOW - 901 }))).toThrow('重新授权');
    expect(verifyRoutineIdentityObservation(env, signed(observation, { observedAt: NOW + 60 })).observedAt).toBe(NOW + 60);
    for (const allowExpired of [false, true])
      expect(() => verifyRoutineIdentityObservation(env, signed(observation, { observedAt: NOW + 61 }), undefined, { allowExpired })).toThrow();
  });

  it('allows old durable proof reads without bypassing signature or expected identity', () => {
    const old = signed(observation, { observedAt: NOW - 86400 });
    expect(verifyRoutineIdentityObservation(env, old, expected(), { allowExpired: true }).observedAt).toBe(NOW - 86400);
    expect(() => verifyRoutineIdentityObservation(env, { ...old, signature: '0'.repeat(64) }, undefined, { allowExpired: true })).toThrow();
    expect(() => verifyRoutineIdentityObservation(env, old, { ...expected(), openid: 'other' }, { allowExpired: true })).toThrow();
  });

  it.each(['openid', 'unionid', 'sourceStamp'] as const)('binds expected %s exactly', field => {
    const value = field === 'sourceStamp' ? 'b'.repeat(64) : 'other';
    expect(() => verifyRoutineIdentityObservation(env, observation, { ...expected(), [field]: value })).toThrow();
  });

  it('rejects malformed expected identity or expiry options without coercion', () => {
    for (const value of [{ openid: input().openid }, { ...expected(), extra: true }, { ...expected(), openid: 1 }])
      expect(() => verifyRoutineIdentityObservation(env, observation, value as Expected)).toThrow();
    for (const value of [null, true, { allowExpired: 'true' }, { allowExpired: true, extra: 1 }])
      expect(() => verifyRoutineIdentityObservation(env, observation, undefined, value as { allowExpired?: boolean })).toThrow();
  });

  it('requires the actual signing key and never reuses another signature domain', () => {
    for (const APP_KEY of ['', undefined, null, 123]) {
      const invalidEnv = { APP_KEY } as typeof env;
      expect(() => issueRoutineIdentityObservation(invalidEnv, input())).toThrow('重新授权');
      expect(() => verifyRoutineIdentityObservation(invalidEnv, observation)).toThrow('重新授权');
    }
    expect(() => verifyRoutineIdentityObservation({ APP_KEY: 'other-key' }, observation)).toThrow();
    for (const domain of ['cinashop.routine.credentials.v1\0', 'cinashop.routine.identity-observation.v2\0', DOMAIN.slice(0, -1)])
      expect(() => verifyRoutineIdentityObservation(env, { ...observation, signature: mac({ ...observation }, domain) })).toThrow();
  });

  it('rejects inherited, hidden, symbolic and accessor fields without running a getter', () => {
    let calls = 0;
    const accessor = { ...observation };
    Object.defineProperty(accessor, 'openid', { enumerable: true, get() { calls++; return 'owned-openid'; } });
    const hidden = { ...observation }; Object.defineProperty(hidden, 'extra', { value: 'private' });
    const nonenumerable = { ...observation }; Object.defineProperty(nonenumerable, 'openid', { enumerable: false });
    for (const value of [Object.create(observation), Object.assign(new Date(), observation), accessor, hidden, nonenumerable,
      { ...observation, [Symbol('extra')]: 'private' }, null, [], 1, undefined]) {
      expect(hasRoutineIdentityObservationShape(value)).toBe(false);
      expect(() => verifyRoutineIdentityObservation(env, value)).toThrow(ValidateException);
    }
    expect(calls).toBe(0);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(hasRoutineIdentityObservationShape(revoked.proxy)).toBe(false);
    expect(() => verifyRoutineIdentityObservation(env, revoked.proxy)).toThrow(ValidateException);
  });
});
