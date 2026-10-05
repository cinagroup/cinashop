import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { systemConfig, systemLog } from '../src/models/schema';
import { CityDeliverySettingsRejected, CityDeliverySettingsStaleVersion } from '../src/services/admin/AdminCityDeliverySettingsInput';
import { CITY_DELIVERY_PRIVATE_LOG_TYPES, CITY_DELIVERY_RECEIPT_TYPE } from '../src/services/delivery/CityDeliverySettingsResolver';
import { CITY_DELIVERY_CREDENTIAL_KEYS } from '../../view/common/cityDeliverySettings';
import { ValidateException } from '../src/utils/errors';
import { cityDeliverySettingsFixture, citySettingsActor, citySettingsBindings, citySettingsInput, observeCitySettingsDb } from './helpers/cityDeliverySettingsFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('city settings encrypted immutable intents on actual non-owner production ACL intersection', () => {
  let f: Awaited<ReturnType<typeof cityDeliverySettingsFixture>>, tripwire: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => { f = await cityDeliverySettingsFixture(); tripwire = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider call in settings')); }, 30_000);
  afterEach(async () => { if (tripwire) expect(tripwire).not.toHaveBeenCalled(); vi.restoreAllMocks(); await f?.close(); }, 30_000);
  type Peer = Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
  const profiles = (run: (app: Peer, admin: Peer) => Promise<void>) => f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
    await f.installSlice(app, admin); for (const peer of [app, admin]) expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: peer.role, session_user: peer.role });
    expect(app.pid).not.toBe(admin.pid); await run(app, admin);
  }));
  const proof = (p: { request_id: string; client_nonce: string; payload_hash: string }) => ({ request_id: p.request_id, client_nonce: p.client_nonce, payload_hash: p.payload_hash });
  const replacing = (revision: string) => citySettingsInput(revision, { credentials: Object.fromEntries(CITY_DELIVERY_CREDENTIAL_KEYS.map(key => [key, { action: 'replace', value: `owned-new-${key}` }])) as ReturnType<typeof citySettingsInput>['credentials'] });

  it('prepares without effective DML, restores without secret projection, and atomically confirms all six SQL credentials', async () => profiles(async (app, admin) => {
    const service = f.serviceFor(admin.db), before = await f.snapshot(), input = replacing((await service.read()).revision);
    const prepared = await service.prepare(input, citySettingsActor), stored = await f.snapshot();
    expect(stored.configs).toEqual(before.configs); expect(stored.logs.filter(row => CITY_DELIVERY_PRIVATE_LOG_TYPES.includes(row.type as typeof CITY_DELIVERY_PRIVATE_LOG_TYPES[number])).length).toBeGreaterThan(1);
    for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) { expect(JSON.stringify(stored.logs)).not.toContain(`owned-new-${key}`); expect(JSON.stringify(prepared)).not.toContain(`owned-new-${key}`); }
    expect(await service.intent(input.request_id, citySettingsActor)).toEqual(prepared); expect(await service.prepare(input, citySettingsActor)).toEqual(prepared);
    const receipt = await service.confirm(proof(prepared), citySettingsActor), after = await f.snapshot();
    expect(receipt).toEqual(prepared.receipt ?? { version: 1, operation: 'update', request_id: input.request_id, client_nonce: input.client_nonce, revision: input.revision, payload_hash: prepared.payload_hash, flags: input.flags, actions: prepared.actions });
    expect(after.logs.filter(row => row.type === CITY_DELIVERY_RECEIPT_TYPE)).toHaveLength(1);
    for (const row of after.configs) { const original = before.configs.find(value => value.id === row.id)!; expect({ ...row, value: original.value }).toEqual(original); }
    const resolved = await f.resolverFor(app.db).resolved(); for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) { expect(resolved.values[key]).toBe(`owned-new-${key}`); expect(resolved.snapshot.credentials[key].source).toBe('encrypted'); }
    expect(await service.confirm(proof(prepared), citySettingsActor)).toEqual(receipt); expect(await service.receipt(input.request_id, citySettingsActor)).toEqual(receipt); expect(await f.snapshot()).toEqual(after);
  }));
  it('keeps Env authority over legacy SQL, clears with sealed tombstones, and closing master preserves child flags and credentials', async () => profiles(async (app, admin) => {
    await f.db.update(systemConfig).set({ value: '"ignored-legacy-key"' }).where(eq(systemConfig.menuName, 'uupt_appkey'));
    const service = f.serviceFor(admin.db), initial = await service.read(); expect(initial.credentials.uupt_appkey).toMatchObject({ source: 'env', issues: ['legacy_plaintext_not_adopted'] });
    const input = citySettingsInput(initial.revision); input.credentials.uupt_appkey = { action: 'clear' };
    const prepared = await service.prepare(input, citySettingsActor); await service.confirm(proof(prepared), citySettingsActor);
    const resolved = await f.resolverFor(app.db).resolved(); expect(resolved.values.uupt_appkey).toBe(''); expect(resolved.snapshot.credentials.uupt_appkey.source).toBe('cleared');
    expect(resolved.snapshot.flags).toEqual(input.flags); expect(resolved.values.dada_app_key).toBe(citySettingsBindings.DADA_APP_KEY);
    await f.db.insert(systemConfig).values({ menuName: 'uupt_appkey', value: '"shadow"', sort: 999 });
    const shadowed = await f.resolverFor(app.db).resolved(); expect(shadowed.values.uupt_appkey).toBe(''); expect(shadowed.snapshot.credentials.uupt_appkey).toMatchObject({ source: 'invalid', issues: ['credential_authority_shadowed'] });
  }));
  it('covers hidden lower-priority rows and metadata/xmin in CAS while alias identities are diagnosed and rejected before writes', async () => profiles(async (_app, admin) => {
    await f.db.insert(systemConfig).values({ menuName: 'dada_app_key', value: '"hidden"', sort: -100, status: 0 });
    const service = f.serviceFor(admin.db), input = replacing((await service.read()).revision), prepared = await service.prepare(input, citySettingsActor);
    await f.db.update(systemConfig).set({ info: 'offpage changed' }).where(eq(systemConfig.value, '"hidden"')); let before = await f.snapshot();
    await expect(service.confirm(proof(prepared), citySettingsActor)).rejects.toMatchObject({ name: 'CityDeliverySettingsStaleVersion', request_id: input.request_id, client_nonce: input.client_nonce, payload_hash: prepared.payload_hash }); expect(await f.snapshot()).toEqual(before);
    await f.db.insert(systemConfig).values({ menuName: '\tUUpt_appkey\u00a0', value: '"alias-secret"' }); const alias = await service.read(); expect(alias.editable).toBe(false); expect(alias.issues).toContain('config_alias:uupt_appkey');
    before = await f.snapshot(); await expect(service.prepare(citySettingsInput(alias.revision), citySettingsActor)).rejects.toBeInstanceOf(CityDeliverySettingsRejected); expect(await f.snapshot()).toEqual(before);
  }));
  it('does not initialize on GET and explicitly initializes missing keys only at confirmation', async () => profiles(async (_app, admin) => {
    await f.db.delete(systemConfig); const service = f.serviceFor(admin.db), before = await f.snapshot(), snapshot = await service.read();
    expect(snapshot.flags.city_delivery_status).toBeNull(); expect(await f.snapshot()).toEqual(before);
    const prepared = await service.prepare(citySettingsInput(snapshot.revision), citySettingsActor); expect((await f.snapshot()).configs).toEqual([]);
    await service.confirm(proof(prepared), citySettingsActor); expect((await f.snapshot()).configs.map(row => row.menuName).sort()).toEqual(['city_delivery_status', 'dada_delivery_status', 'self_delivery_status', 'uu_delivery_status']);
    expect((await service.read()).credentials.uupt_open_id.source).toBe('env');
  }));
  it('enforces global UUID/actor/nonce identity and immutable content without a deterministic rejection proof', async () => profiles(async (_app, admin) => {
    const service = f.serviceFor(admin.db), input = replacing((await service.read()).revision), prepared = await service.prepare(input, citySettingsActor), before = await f.snapshot();
    for (const operation of [() => service.prepare(input, { id: 8 }), () => service.intent(input.request_id, { id: 8 }),
      () => service.prepare({ ...input, credentials: { ...input.credentials, dada_app_key: { action: 'replace', value: 'another' } } }, citySettingsActor),
      () => service.confirm({ ...proof(prepared), client_nonce: crypto.randomUUID() }, citySettingsActor)]) {
      try { await operation(); throw Error('Expected immutable intent failure'); } catch (error) { expect(error).toBeInstanceOf(ValidateException); expect(error).not.toBeInstanceOf(CityDeliverySettingsRejected); expect(error).not.toBeInstanceOf(CityDeliverySettingsStaleVersion); }
    }
    expect(await f.snapshot()).toEqual(before);
  }));
  it('allows success replay before TTL and missing-key checks but proves expiry only for an uncommitted intent', async () => profiles(async (_app, admin) => {
    const service = f.serviceFor(admin.db), clock = Date.now();
    const committed = await service.prepare(citySettingsInput((await service.read()).revision), citySettingsActor); const receipt = await service.confirm(proof(committed), citySettingsActor);
    const pending = await service.prepare(citySettingsInput((await service.read()).revision), citySettingsActor); const before = await f.snapshot(); vi.spyOn(Date, 'now').mockReturnValue(clock + 1801_000);
    await expect(service.confirm(proof(pending), citySettingsActor)).rejects.toMatchObject({ name: 'CityDeliverySettingsRejected', request_id: pending.request_id, client_nonce: pending.client_nonce, payload_hash: pending.payload_hash }); expect(await f.snapshot()).toEqual(before);
    expect((await service.intent(pending.request_id, citySettingsActor)).state).toBe('expired');
    const missingKey = f.serviceFor(admin.db, { ...citySettingsBindings, CITY_DELIVERY_CONFIG_KEY: undefined });
    expect(await missingKey.confirm(proof(committed), citySettingsActor)).toEqual(receipt); expect((await missingKey.intent(committed.request_id, citySettingsActor)).state).toBe('applied');
  }));
  it('fails closed on missing, extra and modified encrypted parts without changing any effective row', async () => profiles(async (_app, admin) => {
    const service = f.serviceFor(admin.db);
    for (const fault of ['missing', 'extra', 'cipher'] as const) {
      const prepared = await service.prepare(replacing((await service.read()).revision), citySettingsActor), path = `/config/city-delivery/intent/${prepared.request_id}`;
      const parts = (await f.snapshot()).logs.filter(row => row.path === path && row.type === 'city_delivery_intent_part');
      if (fault === 'missing') await f.db.delete(systemLog).where(eq(systemLog.id, parts[0].id));
      else if (fault === 'extra') await f.db.insert(systemLog).values({ adminId: citySettingsActor.id, type: 'city_delivery_intent_part', path, method: '00', action: parts[0].action });
      else await f.db.update(systemLog).set({ action: parts[0].action.slice(0, -1) + (parts[0].action.endsWith('A') ? 'B' : 'A') }).where(eq(systemLog.id, parts[0].id));
      const before = await f.snapshot(); try { await service.confirm(proof(prepared), citySettingsActor); throw Error('Expected corrupt intent failure'); } catch (error) { expect(error).toBeInstanceOf(ValidateException); expect(error).not.toBeInstanceOf(CityDeliverySettingsRejected); } expect(await f.snapshot()).toEqual(before);
    }
  }));
  it('bounds active preparations, excludes applied intents from quota, and treats expired retained logs as inactive', async () => profiles(async (_app, admin) => {
    const service = f.serviceFor(admin.db), revision = (await service.read()).revision, active = [];
    for (let index = 0; index < 5; index++) active.push(await service.prepare(citySettingsInput(revision), citySettingsActor));
    const before = await f.snapshot(); await expect(service.prepare(citySettingsInput(revision), citySettingsActor)).rejects.toBeInstanceOf(CityDeliverySettingsRejected); expect(await f.snapshot()).toEqual(before);
    await service.confirm(proof(active[0]), citySettingsActor); await service.prepare(citySettingsInput((await service.read()).revision), citySettingsActor);
    const oldLogs = (await f.snapshot()).logs.length; vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1801_000);
    await service.prepare(citySettingsInput((await service.read()).revision), citySettingsActor); expect((await f.snapshot()).logs.length).toBeGreaterThan(oldLogs);
  }));
  it('rolls back encrypted credential writes if the real final journal INSERT fails, without pretending SQL failure is a proven rejection', async () => profiles(async (_app, admin) => {
    const service = f.serviceFor(admin.db), prepared = await service.prepare(replacing((await service.read()).revision), citySettingsActor), before = await f.snapshot();
    await f.exec("CREATE FUNCTION owned_city_journal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='city_delivery_settings' THEN RAISE EXCEPTION 'owned final journal failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_city_journal_failure BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION owned_city_journal_failure()");
    await expect(service.confirm(proof(prepared), citySettingsActor)).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
  }));
  it('uses actual current app/Admin grants without runtime ownership, config write, journal mutation or DDL escalation', async () => profiles(async (app, admin) => {
    expect((await app.exec("SELECT has_table_privilege(current_user,'system_config','UPDATE') AS write,has_schema_privilege(current_user,'public','CREATE') AS ddl"))[0]).toEqual({ write: false, ddl: false });
    await expect(app.exec("UPDATE system_config SET value='1'")).rejects.toMatchObject({ code: '42501' });
    await expect(admin.exec("UPDATE system_log SET action='forged'")).rejects.toMatchObject({ code: '42501' });
    await expect(admin.exec('CREATE TABLE forbidden_city_settings(id int)')).rejects.toMatchObject({ code: '42501' });
    await admin.exec("SET statement_timeout='2000ms'; SET lock_timeout='400ms'; SET idle_in_transaction_session_timeout='2000ms'"); let observed = false;
    const db = observeCitySettingsDb(admin.db, async (tx, command) => { if (!observed && command.includes("set_config('statement_timeout'")) { observed = true; const [limits] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`); expect(limits).toEqual({ statement: '2s', lock: '400ms', idle: '2s' }); } });
    await f.serviceFor(db).read(); expect(observed).toBe(true);
    const snapshot = await f.serviceFor(admin.db, { ...citySettingsBindings, CITY_DELIVERY_CONFIG_KEY: undefined }).read(); expect(snapshot.readiness.cipher_ready).toBe(false);
    await expect(f.serviceFor(admin.db, { ...citySettingsBindings, CITY_DELIVERY_CONFIG_KEY: undefined }).prepare(citySettingsInput(snapshot.revision), citySettingsActor)).rejects.toThrow();
  }));
  it('serializes two independent Admin sessions confirming one UUID and commits exactly one credential write set and receipt', async () => profiles(async (app, admin) => {
    await f.withRuntimeRole(async second => { await f.installSlice(app, second); const service = f.serviceFor(admin.db), prepared = await service.prepare(replacing((await service.read()).revision), citySettingsActor);
      let entered!: () => void, release!: () => void, gated = false; const inside = new Promise<void>(resolve => { entered = resolve; }), pause = new Promise<void>(resolve => { release = resolve; });
      const db = observeCitySettingsDb(admin.db, async (_tx, command) => { if (!gated && command.includes('pg_advisory_xact_lock(')) { gated = true; entered(); await pause; } });
      const first = outcome(f.serviceFor(db).confirm(proof(prepared), citySettingsActor)); await inside;
      const retry = outcome(f.serviceFor(second.db).confirm(proof(prepared), citySettingsActor));
      try { await waitForFinanceBlock(f.db, second.pid, admin.pid); } finally { release(); }
      const one = await first, two = await retry; expect(one.ok).toBe(true); expect(two).toEqual(one); expect((await f.snapshot()).logs.filter(row => row.type === CITY_DELIVERY_RECEIPT_TYPE)).toHaveLength(1);
    });
  }));
});
