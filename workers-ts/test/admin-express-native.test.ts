import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { AdminExpressService } from '@/services/admin/AdminExpressService';
import { runAdminExpressUpgrade } from '@/migrations/runAdminExpressUpgrade';
import { assertAdminExpressOperationReady, inspectAdminExpressOperation } from '@/migrations/adminExpressOperation';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectAdminAuthorityMaintenanceSnapshot } from '@/migrations/adminAuthorityOperationMaintenance';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome } from './helpers/financePeers';

/** Execute real DDL/GRANT before interrupting the caller-owned transaction.
 * Does not mock SQL results, PostgreSQL roles, inspector or rollback. */
function interrupted(db: DbClient, trace: { reached: boolean }): DbClient {
  const dialect = new PgDialect();
  return new Proxy(db, { get(target, key) {
    const method: unknown = Reflect.get(target, key); if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (callback: (tx: Pick<DbClient, 'execute'>) => Promise<unknown>, options: unknown) => target.transaction(async tx => {
      const port = new Proxy(tx, { get(current, property) {
        const member: unknown = Reflect.get(current, property); if (typeof member !== 'function') return member;
        if (property !== 'execute') return member.bind(current);
        return async (query: Parameters<typeof tx.execute>[0]) => {
          const text = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
          const result = await tx.execute(query);
          if (text.startsWith('GRANT SELECT, INSERT ON TABLE public.admin_express_operation TO ')) {
            trace.reached = true; throw Error('Owned Express interruption after real receipt grant');
          }
          return result;
        };
      } });
      return callback(port);
    }, options as Parameters<typeof target.transaction>[1]);
  } });
}

/** A second independently authenticated connection of an already owned
 * fixture LOGIN. Never SET ROLE, accept a remote target or print credentials. */
async function withReader<T>(peer: { role: string; connectionString: string; pid: number }, database: string,
  run: (reader: { pid: number; exec: (text: string) => Promise<unknown> }) => Promise<T>) {
  const url = new URL(peer.connectionString);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(database)
    || url.pathname !== `/${database}` || decodeURIComponent(url.username) !== peer.role || url.search || url.hash) throw Error('Unexpected owned Express reader target');
  const client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
    connection: { options: '-c search_path=public -c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000' } });
  try {
    const [identity] = await client`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num')::integer/10000 AS major`;
    if (identity.database !== database || identity.role !== peer.role || identity.session !== peer.role || identity.pid === peer.pid || identity.major !== 16) throw Error('Reader is not an independent owned PG16 LOGIN');
    return await run({ pid: Number(identity.pid), exec: text => client.unsafe(text) });
  } finally { await client.end({ timeout: 2 }); }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Express explicit addon and independently authenticated PG16 catalog writers/readers', () => {
  afterEach(() => vi.restoreAllMocks());
  it('rolls back commissioning, preserves grants, executes service/receipt, and refuses carrier read→job insertion races without provider I/O', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned Express native acceptance forbids provider I/O'));
    const whole = await refundRuntimeFixture();
    try {
      if (!whole.withRuntimeRole || !whole.withPeer) throw Error('Independent native LOGIN and lock peers required');
      await whole.withRuntimeRole(async app => whole.withRuntimeRole!(async admin => {
        const [identity] = await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance,current_setting('server_version_num')::integer/10000 AS major`);
        expect(identity.major).toBe(16);
        const target = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role, admin: admin.role };
        await runRuntimeBusinessCommissioning(whole.db, { ...target, pricingOwner: whole.pricingOwner });
        const password = 'owned-express-native-credential';
        await whole.db.insert(systemAdmin).values({ id: 900, account: 'owned_express', pwd: password, realName: 'Owned root', roles: '', level: 0, status: 1, isDel: 0, adminType: 1, relationId: 0 });
        const audit = async () => ({ app: await auditRuntimeBusinessPrivileges(app.db, 'app', target), admin: await auditRuntimeBusinessPrivileges(admin.db, 'admin', target) });
        const snapshot = async () => ({
          whole: await whole.db.transaction(tx => inspectAdminAuthorityMaintenanceSnapshot(tx, { wholeData: true }), { isolationLevel: 'repeatable read', accessMode: 'read only' }),
          sequences: Array.from(await whole.db.execute(sql`SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`), r => ({ ...r })),
        });
        expect(await audit()).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
        await expect(admin.db.transaction(tx => assertAdminExpressOperationReady(tx))).rejects.toMatchObject({ code: 503 });
        const before = await snapshot(), trace = { reached: false };
        await expect(runAdminExpressUpgrade(interrupted(whole.db, trace), target)).rejects.toThrow('Owned Express interruption');
        expect(trace.reached).toBe(true); expect(await snapshot()).toEqual(before);
        expect(await inspectAdminExpressOperation(whole.db, target)).toBe(false);
        expect(await audit()).toMatchObject({ app: { ready: true }, admin: { ready: true } });
        expect(await runAdminExpressUpgrade(whole.db, target)).toEqual({ operation: 'admin-express-operation-v1', applied: true });
        expect(await inspectAdminExpressOperation(whole.db, target)).toBe(true);
        await expect(admin.db.transaction(tx => assertAdminExpressOperationReady(tx))).resolves.toBeUndefined();
        const installed = await snapshot(), old = new Set(before.whole.data.map(r => r.name));
        expect(installed.whole.tableCount).toBe(before.whole.tableCount + 1);
        expect(installed.whole.data.filter(r => old.has(r.name))).toEqual(before.whole.data);
        expect(installed.whole.data.filter(r => !old.has(r.name))).toEqual([expect.objectContaining({ name: 'admin_express_operation', rows: '0' })]);
        expect(installed.sequences).toEqual(before.sequences);
        for (const peer of [app, admin]) {
          const [role] = await peer.db.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super`);
          expect(role).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid, super: false });
          await peer.exec('RESET ROLE'); expect((await peer.db.execute(sql`SELECT current_user AS role`))[0]?.role).toBe(peer.role);
        }
        await expect(app.exec('SELECT * FROM public.admin_express_operation')).rejects.toMatchObject({ code: '42501' });
        await expect(app.exec("INSERT INTO public.express_company(code,name) VALUES('FORBIDDEN','forbidden')")).rejects.toMatchObject({ code: '42501' });
        for (const statement of ['UPDATE public.admin_express_operation SET actor_id=1', 'DELETE FROM public.admin_express_operation',
          'TRUNCATE public.admin_express_operation', 'ALTER TABLE public.admin_express_operation ADD COLUMN forbidden integer',
          'SELECT public.admin_express_operation_immutable_v1()']) await expect(admin.exec(statement)).rejects.toMatchObject({ code: '42501' });
        await expect(app.db.transaction(tx => assertAdminExpressOperationReady(tx))).rejects.toMatchObject({ code: 503 });
        await expect(whole.db.transaction(tx => assertAdminExpressOperationReady(tx))).rejects.toMatchObject({ code: 503 });
        const actor = { id: 900, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 };
        const service = new AdminExpressService(createContainerFromDb(admin.db), { APP_KEY: 'owned-express-native-hmac' } as Env);
        const query = new URLSearchParams(), accounts = { account: { mode: 'keep' }, key: { mode: 'keep' }, netName: { mode: 'keep' }, courierName: { mode: 'keep' }, customerName: { mode: 'keep' }, codeName: { mode: 'keep' } };
        const values = { name: 'Native carrier', code: 'OWNED_EXPRESS', sort: 7, isShow: 1, accounts };
        const prepare = async (operation: 'create' | 'update' | 'show' | 'delete', target_id: number, payload: Record<string, unknown>) => service.prepare({ operation_id: crypto.randomUUID(), operation, target_id, revision: (await service.catalog(query, actor)).revision, payload }, actor);
        const made = await prepare('create', 0, values), created = await service.commit({ seal: made.ticket.seal, payload: values }, actor);
        expect(created).toMatchObject({ state: 'committed', operation: 'create', actor_id: 900, result: { created: 1 } });
        const id = created.result.id;
        const updatedValues = { ...values, accounts: { ...accounts, key: { mode: 'replace', value: 'owned-monthly-secret' } } };
        const edit = await prepare('update', id, updatedValues), updated = await service.commit({ seal: edit.ticket.seal, payload: updatedValues }, actor);
        const hide = await prepare('show', id, { isShow: 0 }), hidden = await service.commit({ seal: hide.ticket.seal, payload: { isShow: 0 } }, actor);
        const del = await prepare('delete', id, {}), deleted = await service.commit({ seal: del.ticket.seal, payload: {} }, actor);
        expect(deleted).toMatchObject({ state: 'committed', operation: 'delete', result: { id, updated: 1 } });
        const committed = await snapshot();
        for (const [prepared, payload, receipt] of [[made, values, created], [edit, updatedValues, updated], [hide, { isShow: 0 }, hidden], [del, {}, deleted]] as const) {
          expect(await service.commit({ seal: prepared.ticket.seal, payload }, actor)).toEqual(receipt);
          expect(await service.receipt(prepared.ticket.operation_id, query, actor)).toEqual(receipt);
          expect(JSON.stringify(receipt)).not.toContain('owned-monthly-secret');
        }
        expect(await snapshot()).toEqual(committed);
        const cancelled = await prepare('create', 0, { ...values, code: 'CANCELLED_EXPRESS' });
        const negative = await service.resolve({ seal: cancelled.ticket.seal }, actor);
        expect(negative).toMatchObject({ state: 'not_applied', operation: 'create' });
        const resolved = await snapshot();
        await expect(service.commit({ seal: cancelled.ticket.seal, payload: { ...values, code: 'CANCELLED_EXPRESS' } }, actor)).rejects.toMatchObject({ httpStatus: 409 });
        expect(await service.resolve({ seal: cancelled.ticket.seal }, actor)).toEqual(negative); expect(await snapshot()).toEqual(resolved);
        // Both use actual LOGINs and the existing profile's real job INSERT.
        // These are SQL-level consumer race fixtures, not a claim that a
        // provider has issued these synthetic historical jobs.
        for (const [index, consumer] of [app, admin].entries()) {
          const raceValues = { ...values, code: `RACE_${index}` }, race = await prepare('create', 0, raceValues);
          const carrier = await service.commit({ seal: race.ticket.seal, payload: raceValues }, actor), carrierId = carrier.result.id;
          const removal = await prepare('delete', carrierId, {});
          await withReader(consumer, target.database, async reader => {
            await reader.exec('BEGIN');
            try {
              await reader.exec(`SELECT id,account,key FROM public.express_company WHERE id=${carrierId}`);
              const [lock] = await whole.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${reader.pid}
                AND relation='public.express_company'::regclass AND mode='AccessShareLock' AND granted) AS held`);
              expect(lock.held).toBe(true);
              const frozen = await snapshot(), refused = await outcome(service.commit({ seal: removal.ticket.seal, payload: {} }, actor));
              if (refused.ok) throw Error('Carrier writer ignored an existing consumer read transaction');
              expect(refused.error).toMatchObject({ httpStatus: 409 }); expect(await snapshot()).toEqual(frozen);
              const request = crypto.randomUUID(), root = 990000 + index;
              await reader.exec(`INSERT INTO public.order_waybill_job(event_key,request_key,request_hash,root_order_id,order_id,order_no,supplier_id,actor_type,actor_id,fulfillment_mode,carrier_id,carrier_code,carrier_name,template_id,sender_name,sender_phone,sender_address,status,add_time,update_time)
                VALUES('owned.express:${request}','${request}','${'a'.repeat(64)}',${root},${root},'OWNED-RACE-${index}',0,'${index === 0 ? 'supplier' : 'admin'}',900,'whole',${carrierId},'RACE_${index}','Native carrier','FIXTURE','Sender','13800000000','Fixture address','SENT',1,1)`);
              await reader.exec('COMMIT');
            } catch (error) { await reader.exec('ROLLBACK'); throw error; }
          });
          const withHistory = await snapshot();
          await expect(service.commit({ seal: removal.ticket.seal, payload: {} }, actor)).rejects.toThrow('面单历史');
          expect(await snapshot()).toEqual(withHistory);
          const sealed = await service.resolve({ seal: removal.ticket.seal }, actor); expect(sealed.state).toBe('not_applied');
        }
        for (const statement of ['UPDATE public.admin_express_operation SET actor_id=1', 'DELETE FROM public.admin_express_operation', 'TRUNCATE public.admin_express_operation']) await expect(whole.exec(statement)).rejects.toMatchObject({ code: '42501' });
        for (const lock of ['LOCK TABLE ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE', 'LOCK TABLE ONLY public.admin_express_operation IN ACCESS SHARE MODE']) {
          await whole.withPeer!(async peer => { await peer.exec('BEGIN');
            try { await peer.exec(lock); await expect(runAdminExpressUpgrade(whole.db, target)).rejects.toThrow(); }
            finally { await peer.exec('ROLLBACK'); }
          });
        }
        await whole.withPeer!(async peer => { await peer.exec('BEGIN');
          try { await peer.exec('SELECT pg_advisory_xact_lock(731626,15)'); await expect(runAdminExpressUpgrade(whole.db, target)).rejects.toThrow('busy');
            await expect(admin.db.transaction(tx => assertAdminExpressOperationReady(tx))).rejects.toMatchObject({ code: 503 }); }
          finally { await peer.exec('ROLLBACK'); }
        });
        await whole.exec(`GRANT SELECT ON public.admin_express_operation TO PUBLIC`);
        try { expect((await audit()).admin.ready).toBe(false); await expect(runAdminExpressUpgrade(whole.db, target)).rejects.toThrow('exact existing runtime profiles'); }
        finally { await whole.exec('REVOKE SELECT ON public.admin_express_operation FROM PUBLIC'); }
        const final = await snapshot();
        expect(await runAdminExpressUpgrade(whole.db, target)).toEqual({ operation: 'admin-express-operation-v1', applied: false });
        expect(await snapshot()).toEqual(final); expect(await audit()).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
      }));
      expect(fetch).not.toHaveBeenCalled();
    } finally { await whole.close(); }
  }, 180000);
});
