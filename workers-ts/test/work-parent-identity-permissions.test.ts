import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../src/lib/di';
import { auditWorkParentIdentityPermissions } from '../src/migrations/auditWorkParentIdentityPermissions';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

it('rejects non-root or unsafe-schema permission audits before SQL', async () => {
  await expect(auditWorkParentIdentityPermissions({ transaction: (() => { throw new Error('SQL reached'); }) }))
    .rejects.toThrow('root database');
  for (const schema of ['public;drop schema public', 'public,pg_temp', 'pg_catalog', 'information_schema']) {
    await expect(auditWorkParentIdentityPermissions({ $client: {} } as DbClient, schema)).rejects.toThrow('Invalid work');
  }
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real PG16 parent identity permission envelope', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  type Runtime = SequenceRunnerPeer & { role: string; connectionString: string };
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    if (!f.withRuntimeRole) throw new Error('Dedicated PostgreSQL 16 login required');
    const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  const run = (callback: (peer: Runtime) => Promise<void>) => {
    if (!f.withRuntimeRole) throw new Error('Actual login required');
    return f.withRuntimeRole(async peer => {
      await f.exec(`GRANT SELECT,INSERT ON public.work_client_current,public.work_callback_event TO "${peer.role}";
        GRANT UPDATE(name,uid,lifecycle_state,update_time) ON public.work_client_current TO "${peer.role}";
        GRANT UPDATE(status,projection_status,payload,payload_retained_until,payload_redacted_time,update_time)
          ON public.work_callback_event TO "${peer.role}"`);
      await callback(peer);
    });
  };
  const snapshot = () => f.query(`SELECT jsonb_build_object(
    'clients',(SELECT jsonb_agg(to_jsonb(x)) FROM public.work_client_current x),
    'events',(SELECT jsonb_agg(to_jsonb(x)) FROM public.work_callback_event x),
    'acl',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'acl',relacl) ORDER BY oid) FROM pg_class
      WHERE oid IN ('public.work_client_current'::regclass,'public.work_callback_event'::regclass))) AS state`);

  it('does not mistake the maintenance identity for a least-privilege login', async () => {
    expect(await auditWorkParentIdentityPermissions(f.db)).toMatchObject({ ready: false,
      checks: { noOwnerControl: false, noReferencedKeyUpdate: false, noParentRemovalOrTriggerCreation: false } });
  });
  it('uses a read-only audit and permits non-key updates while actual key/delete statements are denied', async () => {
    await run(async peer => {
      const before = await snapshot();
      const settings = await peer.exec("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock");
      const observed = new Proxy(peer.db, { get(target, key, receiver) {
        if (key === 'transaction') return ((callback, config) => target.transaction(async tx => {
          expect(config).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
          const result = await callback(tx);
          expect(Array.from(await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
            current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`)))
            .toEqual([{ readonly: 'on', statement: '5s', lock: '1s' }]);
          return result;
        }, config)) satisfies DbClient['transaction'];
        return Reflect.get(target, key, receiver);
      } });
      expect(await auditWorkParentIdentityPermissions(observed)).toMatchObject({ ready: true, failures: [] });
      expect(await snapshot()).toEqual(before);
      expect(await peer.exec("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock")).toEqual(settings);
      await peer.exec("UPDATE public.work_client_current SET update_time=0; UPDATE public.work_callback_event SET update_time=0");
      for (const statement of ["DELETE FROM public.work_client_current", "DELETE FROM public.work_callback_event",
        "UPDATE public.work_client_current SET corp_id=corp_id", "UPDATE public.work_callback_event SET sequence_rank=sequence_rank"]) {
        await expect(peer.exec(statement)).rejects.toMatchObject({ code: '42501' });
      }
      expect(await snapshot()).toEqual(before);
    });
  });
  it.each([
    ['DELETE', 'work_client_current', 'noParentRemovalOrTriggerCreation'],
    ['TRUNCATE', 'work_callback_event', 'noParentRemovalOrTriggerCreation'],
    ['TRIGGER', 'work_client_current', 'noParentRemovalOrTriggerCreation'],
    ['UPDATE', 'work_client_current', 'noReferencedKeyUpdate'],
    ['UPDATE', 'work_callback_event', 'noReferencedKeyUpdate'],
    ['UPDATE(id)', 'work_client_current', 'noReferencedKeyUpdate'],
    ['UPDATE(corp_id)', 'work_client_current', 'noReferencedKeyUpdate'],
    ['UPDATE(id)', 'work_callback_event', 'noReferencedKeyUpdate'],
    ['UPDATE(corp_id)', 'work_callback_event', 'noReferencedKeyUpdate'],
    ['UPDATE(event_key)', 'work_callback_event', 'noReferencedKeyUpdate'],
    ['UPDATE(subject_key_hash)', 'work_callback_event', 'noReferencedKeyUpdate'],
    ['UPDATE(event_time)', 'work_callback_event', 'noReferencedKeyUpdate'],
    ['UPDATE(sequence_rank)', 'work_callback_event', 'noReferencedKeyUpdate'],
  ])('rejects %s privilege on %s', async (privilege, table, check) => {
    await run(async peer => {
      await f.exec(`GRANT ${privilege} ON public.${table} TO "${peer.role}"`);
      const result = await auditWorkParentIdentityPermissions(peer.db);
      expect(result.ready).toBe(false); expect(result.failures).toContain(check);
    });
  });
  it('fails closed for missing objects and lack of read access', async () => {
    await run(async peer => {
      expect(await auditWorkParentIdentityPermissions(peer.db, 'missing_fixture_schema')).toMatchObject({ ready: false,
        checks: { objectsAndKeysPresent: false, parentReadAccess: false } });
      await f.exec(`REVOKE SELECT ON public.work_callback_event FROM "${peer.role}"`);
      expect(await auditWorkParentIdentityPermissions(peer.db)).toMatchObject({ ready: false, checks: { parentReadAccess: false } });
    });
  });
  it.each(['ROLE', 'SESSION AUTHORIZATION'])('retains the connection identity behind SET %s', async setting => {
    await run(async runtime => {
      await f.withPeer!(async maintenance => {
        await maintenance.exec(`SET ${setting} "${runtime.role}"`);
        try {
          const result = await auditWorkParentIdentityPermissions(maintenance.db);
          expect(result.ready).toBe(false);
          expect(result.failures).toEqual(expect.arrayContaining(['unprivilegedReachableRoles', 'noOwnerControl']));
        } finally { await maintenance.exec(`RESET ${setting}`); }
      });
    });
  });
  it.each(['inherit', 'set', 'admin', 'inert'])('evaluates %s-only role membership', async mode => {
    await run(async runtime => f.withRuntimeRole!(async group => {
      await f.exec(`GRANT SELECT,UPDATE(sequence_rank) ON public.work_callback_event TO "${group.role}";
        GRANT "${group.role}" TO "${runtime.role}" WITH INHERIT ${mode === 'inherit' ? 'TRUE' : 'FALSE'};
        GRANT "${group.role}" TO "${runtime.role}" WITH SET ${mode === 'set' ? 'TRUE' : 'FALSE'};
        GRANT "${group.role}" TO "${runtime.role}" WITH ADMIN ${mode === 'admin' ? 'TRUE' : 'FALSE'}`);
      const result = await auditWorkParentIdentityPermissions(runtime.db);
      expect(result.ready).toBe(mode === 'inert');
      if (mode !== 'inert') expect(result.failures).toContain('noReferencedKeyUpdate');
      const update = 'UPDATE public.work_callback_event SET sequence_rank=sequence_rank';
      if (mode === 'inherit') await runtime.exec(update);
      else await expect(runtime.exec(update)).rejects.toMatchObject({ code: '42501' });
      if (mode === 'set') {
        await runtime.exec(`SET ROLE "${group.role}"`);
        try { await runtime.exec(update); } finally { await runtime.exec('RESET ROLE'); }
      }
    }));
  });
  it('detects PUBLIC key grants and passes again only after explicit revocation', async () => {
    await run(async runtime => {
      await f.exec('GRANT UPDATE(event_key) ON public.work_callback_event TO PUBLIC');
      try {
        expect((await auditWorkParentIdentityPermissions(runtime.db)).failures).toContain('noReferencedKeyUpdate');
        await runtime.exec('UPDATE public.work_callback_event SET event_key=event_key');
      } finally { await f.exec('REVOKE UPDATE(event_key) ON public.work_callback_event FROM PUBLIC'); }
      expect((await auditWorkParentIdentityPermissions(runtime.db)).ready).toBe(true);
    });
  });
  it('detects schema creation and replication parameter authority', async () => {
    await run(async runtime => {
      await f.exec(`GRANT CREATE ON SCHEMA public TO "${runtime.role}";
        GRANT SET ON PARAMETER session_replication_role TO "${runtime.role}"`);
      try {
        expect((await auditWorkParentIdentityPermissions(runtime.db)).failures)
          .toEqual(expect.arrayContaining(['noSchemaCreation', 'noReplicationBypass']));
        await runtime.exec("SET session_replication_role='replica'");
        expect((await auditWorkParentIdentityPermissions(runtime.db)).checks.noReplicationBypass).toBe(false);
      } finally {
        await runtime.exec("SET session_replication_role='origin'");
        await f.exec(`REVOKE SET ON PARAMETER session_replication_role FROM "${runtime.role}"`);
      }
    });
  });
  it('preserves stricter caller timeouts inside and after the read-only transaction', async () => {
    await run(async runtime => {
      await runtime.exec("SET statement_timeout='1500ms'; SET lock_timeout='250ms'; SET idle_in_transaction_session_timeout='2s'");
      const settingsSql = sql`SELECT current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`;
      const expected = [{ statement: '1500ms', lock: '250ms', idle: '2s' }];
      const observed = new Proxy(runtime.db, { get(target, key, receiver) {
        if (key === 'transaction') return ((callback, config) => target.transaction(async tx => {
          const result = await callback(tx);
          expect(Array.from(await tx.execute(settingsSql))).toEqual(expected);
          return result;
        }, config)) satisfies DbClient['transaction'];
        return Reflect.get(target, key, receiver);
      } });
      expect((await auditWorkParentIdentityPermissions(observed)).ready).toBe(true);
      expect(Array.from(await runtime.db.execute(settingsSql))).toEqual(expected);
    });
  });
  it('rejects a callable unreviewed SECURITY DEFINER routine', async () => {
    await f.exec("CREATE FUNCTION public.work_parent_permission_fixture() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");
    try {
      await run(async peer => {
        expect(await auditWorkParentIdentityPermissions(peer.db)).toMatchObject({ ready: false, checks: { noUnreviewedDefinerRoutine: false } });
        await f.exec('REVOKE EXECUTE ON FUNCTION public.work_parent_permission_fixture() FROM PUBLIC');
        expect((await auditWorkParentIdentityPermissions(peer.db)).ready).toBe(true);
      });
    } finally { await f.exec('DROP FUNCTION public.work_parent_permission_fixture()'); }
  });
});
