import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../src/lib/di';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '../src/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import { pricingIdentifier } from '../src/migrations/checkoutPricingLockCatalog';
import { cashierRuntimeConditionalDefinitions, CASHIER_RUNTIME_CONDITIONAL_TABLES,
  inspectCashierRuntimeConditionalBoundary } from '../src/migrations/cashierRuntimeConditionalBoundary';
import { CASHIER_RUNTIME_CONDITIONAL_GATES, upgradeCashierRuntimeConditionalBoundary,
  upgradeCashierRuntimeConditionalBoundaryInTransaction } from '../src/migrations/upgradeCashierRuntimeConditionalBoundary';
import type { RuntimeGiftPeerDeclarations } from '../src/migrations/customerRuntimeGiftPeers';
import { assertAdminPlatformMenuWriteReady, inspectAdminPlatformMenuWriteCapability,
  installAdminPlatformMenuWriteCapabilityInTransaction } from '../src/migrations/adminPlatformMenuWriteCapability';
import { customerOriginalPaymentRuntimeFixture } from './helpers/customerOriginalPaymentRuntimeFixture';

// Real full LOGINs, real rows, and rolled-back authority probes. These seeds
// are catalog inputs; no order, payment receipt or paid-consumer result is made.
const LOCK_ROWS = [
  ['agent_level', 'id'], ['city_area', 'id'], ['luck_lottery', 'id'], ['luck_prize', 'id'],
  ['member_ship', 'id'], ['store_brand', 'id'], ['store_coupon_product', 'coupon_id'],
  ['store_newcomer', 'id'], ['store_order_status', 'id'], ['store_product_cate', 'id'],
  ['store_product_category_brand', 'id'], ['store_product_ensure', 'id'], ['store_product_specs', 'id'],
  ['store_promotions', 'id'], ['store_promotions_auxiliary', 'id'], ['store_user', 'id'],
  ['supplier_transactions', 'id'], ['system_form', 'id'], ['system_store', 'id'], ['user_friends', 'id'],
  ['work_client', 'id'], ['work_department_leader_current', 'sort_order'], ['work_group_chat', 'id'],
  ['work_member_relation_current', 'sort_order'],
] as const;
const GUARDS = [
  ['cinashop_runtime_admin_boundary_v1', 'system_admin'],
  ['cinashop_runtime_lock_only_v1', 'city_area'],
  ['cinashop_runtime_seckill_schedule_lock_only_v1', 'store_activity'],
  ['cinashop_runtime_agent_level_catalog_fence_v1', 'agent_level_task_record'],
  ['cinashop_runtime_agent_level_row_guard_v1', 'agent_level'],
] as const;
const ID = 915001;
const ident = pricingIdentifier;
type Query = Pick<DbClient, 'execute'>;

function sqlStates(error: unknown, visited = new Set<unknown>()): string[] {
  if (!error || typeof error !== 'object' || visited.has(error)) return [];
  visited.add(error);
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown };
  return [...(typeof value.code === 'string' ? [value.code] : []), ...sqlStates(value.cause, visited),
    ...(Array.isArray(value.errors) ? value.errors.flatMap(item => sqlStates(item, visited)) : [])];
}
async function denied(action: Promise<unknown>, code = '42501') {
  let rejected = false;
  try { await action; }
  catch (error) { rejected = true; expect(sqlStates(error)).toContain(code); }
  expect(rejected, 'The actual SQL operation must reject with its original SQLSTATE').toBe(true);
}

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).sequential('full Cashier inherited conditional runtime boundaries on owned PG16', { timeout: 30000 }, () => {
  let f: Awaited<ReturnType<typeof customerOriginalPaymentRuntimeFixture>>;
  let peers: RuntimeGiftPeerDeclarations;
  const where = (table: string) => table === 'work_department_leader_current'
    ? "corp_id='conditional15' AND department_id=915001 AND userid='guard15'"
    : table === 'work_member_relation_current' ? "corp_id='conditional15' AND department_id=915001"
      : table === 'store_coupon_product' ? 'coupon_id=915001 AND product_id=915001' : 'id=915001';
  const state = () => inspectCashierRuntimeConditionalBoundary(f.maintenanceDb, f.target, f.cashierRuntime.role);
  const cashierAudit = () => auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db,
    f.cashierRuntime.role, f.target, { abandon: true, conditionalGuards: true });
  const forward = () => upgradeCashierRuntimeConditionalBoundary(f.maintenanceDb, f.target, peers, f.appReaders);
  const readRow = async (table: string, predicate = where(table)) => {
    const rows = await f.maintenanceDb.execute<{ row: unknown }>(sql.raw(`SELECT to_jsonb(t) AS row FROM public.${ident(table)} t WHERE ${predicate}`));
    expect(rows).toHaveLength(1); return rows[0].row;
  };
  const rollbackProbe = async (db: DbClient, callback: (tx: Query) => Promise<void>) => {
    const rollback = Error('Deliberate conditional native probe rollback');
    await expect(db.transaction(async tx => { await callback(tx); throw rollback; },
      { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(rollback);
  };
  const snapshot = async () => {
    const [authority] = await f.maintenanceDb.execute(sql`SELECT jsonb_build_object(
      'relations',(SELECT jsonb_agg(jsonb_build_array(oid::text,relname,relowner::text,relacl::text) ORDER BY oid)
        FROM pg_class WHERE relnamespace='public'::regnamespace),
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attrelid::text,a.attnum,a.attacl::text) ORDER BY a.attrelid,a.attnum)
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL),
      'roles',(SELECT jsonb_agg(jsonb_build_array(oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,
        rolinherit,rolreplication,rolbypassrls,rolconnlimit,md5(rolpassword)) ORDER BY oid) FROM pg_authid
        WHERE rolname IN(${f.appRuntime.role},${f.adminRuntime.role},${f.cashierRuntime.role},${f.financialRuntime.role},${f.managerRuntime.role})),
      'other_routines',(SELECT jsonb_agg(jsonb_build_array(oid::text,proname,proowner::text,proacl::text,
        CASE WHEN prokind IN('f','p') THEN md5(pg_get_functiondef(oid)) ELSE NULL END) ORDER BY oid)
        FROM pg_proc WHERE pronamespace='public'::regnamespace
        AND proname NOT IN(SELECT jsonb_array_elements_text(${JSON.stringify(GUARDS.map(([name]) => name))}::jsonb)))) AS value`);
    const functions = await f.maintenanceDb.execute(sql`SELECT oid::text AS oid,proname,proowner::text AS owner,proacl::text AS acl,
      prosrc AS body,prosecdef,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace
      AND proname IN(SELECT jsonb_array_elements_text(${JSON.stringify(GUARDS.map(([name]) => name))}::jsonb)) ORDER BY proname,oid`);
    const triggers = await f.maintenanceDb.execute(sql`SELECT t.oid::text AS oid,t.tgrelid::text AS relation,t.tgname,t.tgfoid::text AS function,
      t.tgenabled,t.tgtype FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE p.pronamespace='public'::regnamespace
      AND p.proname IN(SELECT jsonb_array_elements_text(${JSON.stringify(GUARDS.map(([name]) => name))}::jsonb)) ORDER BY t.oid`);
    const rows: Record<string, unknown> = {};
    for (const table of [...CASHIER_RUNTIME_CONDITIONAL_TABLES, 'store_order', 'cashier_second_card_cart_v1',
      'cashier_second_card_origin_v1', 'cashier_second_card_payment_v1', 'admin_platform_menu_operation']) {
      const [r] = await f.maintenanceDb.execute(sql.raw(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM public.${ident(table)} t`));
      rows[table] = r.value;
    }
    return { authority: authority.value, functions, triggers, rows };
  };
  beforeAll(async () => {
    f = await customerOriginalPaymentRuntimeFixture();
    peers = { ...f.peers, cashierSecondCard: { ...f.peers.cashierSecondCard!, conditionalGuards: true } };
    const menuOwner = await f.createOwnedRole('conditional_menu');
    await f.maintenanceDb.transaction(async tx => {
      expect(await installAdminPlatformMenuWriteCapabilityInTransaction(tx, { database: f.database,
        maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin, owner: menuOwner.role }))
        .toMatchObject({ applied: true, ready: true });
    }, { isolationLevel: 'read committed', accessMode: 'read write' });
    for (const [table] of LOCK_ROWS) {
      if (['work_department_leader_current', 'work_member_relation_current', 'store_coupon_product'].includes(table)) continue;
      const extra = table === 'supplier_transactions' ? ",order_id" : '';
      const value = table === 'supplier_transactions' ? ",'conditional15-authority-probe'" : '';
      await f.exec(`INSERT INTO public.${ident(table)}(id${extra}) VALUES(${ID}${value})`);
    }
    await f.exec(`INSERT INTO public.store_coupon_issue(id) VALUES(${ID});
      INSERT INTO public.store_coupon_product(coupon_id,product_id) VALUES(${ID},${ID});
      INSERT INTO public.work_department_current(corp_id,department_id) VALUES('conditional15',${ID});
      INSERT INTO public.work_department_leader_current(corp_id,department_id,userid,sort_order) VALUES('conditional15',${ID},'guard15',0);
      INSERT INTO public.work_member_current(corp_id,userid,canonical_userid) VALUES('conditional15','guard15','guard15');
      INSERT INTO public.work_member_relation_current(corp_id,member_id,department_id)
        SELECT corp_id,id,${ID} FROM public.work_member_current WHERE corp_id='conditional15' AND userid='guard15';
      INSERT INTO public.system_admin(id,account,admin_type) VALUES(${ID},'conditional15-platform',1);
      INSERT INTO public.system_admin(id,account,admin_type,relation_id) VALUES(${ID + 10},'conditional15-supplier-seed',4,915001);
      INSERT INTO public.system_role(id,type,role_name) VALUES(${ID},1,'conditional15-platform');
      INSERT INTO public.system_role(id,type,relation_id,role_name) VALUES(${ID + 10},4,915001,'conditional15-supplier-seed');
      INSERT INTO public.system_menus(id,type,menu_name) VALUES(${ID},1,'conditional15-platform');
      INSERT INTO public.store_activity(id) VALUES(${ID});
      INSERT INTO public.store_seckill_time(id) VALUES(${ID});
      INSERT INTO public.store_order_promotions(id,promotions_id) VALUES(${ID},${ID});`);
    for (const [table] of LOCK_ROWS) await readRow(table);
  }, 180000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external request in Cashier conditional boundary acceptance')); });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

  it('requires an explicit successor while the complete original profiles remain ready', async () => {
    expect(await state()).toMatchObject({ ready: false, conditionalWriteSemanticsVerified: false, completeServiceCoverageVerified: false });
    expect(await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db,
      f.cashierRuntime.role, f.target, { abandon: true })).toMatchObject({ ready: true, realLogin: true });
    expect((await cashierAudit()).ready).toBe(false);
    expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers, f.appReaders)).ready).toBe(true);
    expect((await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, f.peers)).ready).toBe(true);
    expect((await inspectAdminPlatformMenuWriteCapability(f.adminRuntime.db, f.adminRuntime.role)).ready).toBe(true);
    const [login] = await f.cashierRuntime.db.execute(sql`SELECT current_user AS role,session_user AS session,
      (SELECT usesysid::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_oid`);
    expect(login.role).toBe(f.cashierRuntime.role); expect(login.session).toBe(login.role);
    expect(login.backend_oid).toBe((await state()).binding?.roleOid);
    const defaults = cashierRuntimeConditionalDefinitions(f.target);
    const saved = await snapshot();
    for (const [name, body] of defaults) expect(saved.functions.find(r => r.proname === name)?.body).toBe(body);
  });

  it('rolls back all five replacements without changing OIDs, ACLs, rows or credential fingerprints', async () => {
    const before = await snapshot();
    await rollbackProbe(f.maintenanceDb, async tx => {
      expect(await upgradeCashierRuntimeConditionalBoundaryInTransaction(tx, f.target, peers, f.appReaders)).toMatchObject({ changed: true,
        privilegesChanged: false, credentialChanged: false, historicalRowsReassigned: false });
      expect((await inspectCashierRuntimeConditionalBoundary(tx, f.target, f.cashierRuntime.role)).ready).toBe(true);
    });
    expect(await snapshot()).toEqual(before); expect((await state()).ready).toBe(false);
  });

  it.each(CASHIER_RUNTIME_CONDITIONAL_GATES)('refuses an actual competing maintenance gate %i/%i', async (key, subkey) => {
    const before = await snapshot();
    await f.withMaintenancePeer(async peer => peer.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},${subkey})`);
      await expect(forward()).rejects.toThrow();
    }));
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a conflicting real catalog table lock without partial replacement', async () => {
    const before = await snapshot();
    await f.withMaintenancePeer(async peer => peer.transaction(async tx => {
      await tx.execute(sql`LOCK TABLE ONLY public.city_area IN ACCESS SHARE MODE`);
      await expect(forward()).rejects.toThrow();
    }));
    expect(await snapshot()).toEqual(before);
  });

  it('preserves tighter caller deadlines during a rolled-back actual forward', async () => {
    await rollbackProbe(f.maintenanceDb, async tx => {
      await tx.execute(sql`SELECT set_config('statement_timeout','4000ms',true),set_config('lock_timeout','250ms',true),
        set_config('idle_in_transaction_session_timeout','4000ms',true)`);
      expect((await upgradeCashierRuntimeConditionalBoundaryInTransaction(tx, f.target, peers, f.appReaders)).changed).toBe(true);
      const [settings] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
      expect(settings).toEqual({ statement: '4s', lock: '250ms', idle: '4s' });
    });
  });

  it('refuses maintenance from the actual App LOGIN', async () => {
    const before = await snapshot();
    await expect(upgradeCashierRuntimeConditionalBoundary(f.appRuntime.db, f.target, peers, f.appReaders)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('commissions the exact five functions while retaining every trigger, ACL, row and credential', async () => {
    const before = await snapshot(), result = await forward(), after = await snapshot();
    expect(result).toMatchObject({ changed: true, privilegesChanged: false, credentialChanged: false, historicalRowsReassigned: false,
      completeServiceCoverageVerified: false });
    expect(after.authority).toEqual(before.authority); expect(after.triggers).toEqual(before.triggers); expect(after.rows).toEqual(before.rows);
    expect(after.functions.map(({ body: _body, ...metadata }) => metadata)).toEqual(before.functions.map(({ body: _body, ...metadata }) => metadata));
    expect(after.functions.every((row, i) => row.body !== before.functions[i].body)).toBe(true);
    expect(await state()).toMatchObject({ ready: true, inheritedAppConditionalGuardsReady: true,
      conditionalWriteSemanticsVerified: false, completeServiceCoverageVerified: false });
    expect(await cashierAudit()).toMatchObject({ ready: true, realLogin: true, failures: [], conditionalWriteSemanticsVerified: false });
    expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, peers, f.appReaders)).ready).toBe(true);
    expect((await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, peers)).ready).toBe(true);
    expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers, f.appReaders)).ready).toBe(false);
    expect((await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, f.peers)).ready).toBe(false);
  });

  it('replays the ready forward without assigning an XID or changing catalogs', async () => {
    const before = await snapshot();
    await f.maintenanceDb.transaction(async tx => {
      expect((await tx.execute(sql`SELECT pg_current_xact_id_if_assigned()::text AS xid`))[0].xid).toBeNull();
      expect((await upgradeCashierRuntimeConditionalBoundaryInTransaction(tx, f.target, peers, f.appReaders)).changed).toBe(false);
      expect((await tx.execute(sql`SELECT pg_current_xact_id_if_assigned()::text AS xid`))[0].xid).toBeNull();
    });
    expect(await snapshot()).toEqual(before);
  });

  it('keeps the installed actual Admin menu port ready through exact successor source proof', async () => {
    const binding = (await state()).binding!;
    expect(await inspectAdminPlatformMenuWriteCapability(f.adminRuntime.db, f.adminRuntime.role,
      { app: f.target.app, maintenance: f.target.maintenance, cashier: binding })).toMatchObject({ ready: true, absent: false });
    // The existing Admin port may discover a source candidate, but accepts it
    // only through live binding and exact staff catalog proof. It does not
    // authorize an undeclared whole Cashier/App/Admin successor profile.
    expect((await inspectAdminPlatformMenuWriteCapability(f.adminRuntime.db, f.adminRuntime.role)).ready).toBe(true);
    await f.adminRuntime.db.transaction(tx => assertAdminPlatformMenuWriteReady(tx));
    expect((await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, peers)).ready).toBe(true);
  });

  it('rejects undeclared successor maintenance and a wrong database without repair', async () => {
    const before = await snapshot();
    await expect(upgradeCashierRuntimeConditionalBoundary(f.maintenanceDb, f.target, f.peers, f.appReaders)).rejects.toThrow();
    const wrong = { ...f.target, database: 'conditional_wrong_database15' };
    expect((await inspectCashierRuntimeConditionalBoundary(f.maintenanceDb, wrong, f.cashierRuntime.role)).ready).toBe(false);
    await expect(upgradeCashierRuntimeConditionalBoundary(f.maintenanceDb, wrong, { ...peers, target: wrong }, f.appReaders)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it.each(['app', 'admin', 'financial', 'manager', 'maintenance'] as const)
    ('refuses an aliased %s principal instead of inferring a Cashier binding', async kind => {
      const role = kind === 'app' ? f.appRuntime.role : kind === 'admin' ? f.adminRuntime.role
        : kind === 'financial' ? f.financialRuntime.role : kind === 'manager' ? f.managerRuntime.role : f.target.maintenance;
      await expect(inspectCashierRuntimeConditionalBoundary(f.maintenanceDb, f.target, role)).rejects.toThrow();
      expect((await state()).ready).toBe(true);
    });

  it('rejects SET ROLE on a maintenance backend instead of treating it as the actual Cashier LOGIN', async () => {
    const before = await snapshot();
    await denied(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${ident(f.cashierRuntime.role)}`));
      await tx.execute(sql`UPDATE public.city_area SET id=id WHERE id=${ID}`);
    }));
    expect(await snapshot()).toEqual(before);
  });

  it.each(LOCK_ROWS)('constrains the actual granted %s.%s on a real seeded row and retains no-op locks', async (table, column) => {
    const before = await readRow(table), target = `public.${ident(table)}`, predicate = where(table), col = ident(column);
    const [authority] = await f.cashierRuntime.db.execute(sql`SELECT has_column_privilege(current_user,${'public.' + table},${column},'UPDATE') AS allowed`);
    expect(authority.allowed).toBe(true);
    await denied(f.cashierRuntime.db.execute(sql.raw(`UPDATE ${target} SET ${col}=${col}+1 WHERE ${predicate} RETURNING *`)));
    expect(await readRow(table)).toEqual(before);
    expect(await f.cashierRuntime.db.execute(sql.raw(`UPDATE ${target} SET ${col}=${col} WHERE ${predicate} RETURNING *`))).toHaveLength(1);
    expect(await readRow(table)).toEqual(before);
  });

  it.each([['luck_prize', 'total'], ['store_promotions_auxiliary', 'surplus_num']] as const)
    ('permits only the approved %s.%s counter delta', async (table, column) => {
      const before = await readRow(table);
      await rollbackProbe(f.cashierRuntime.db, async tx => {
        const rows = await tx.execute(sql.raw(`UPDATE public.${ident(table)} SET ${ident(column)}=${ident(column)}+1 WHERE id=${ID} RETURNING ${ident(column)} AS value`));
        expect(rows).toHaveLength(1); expect(Number(rows[0].value)).toBe(Number((before as Record<string, unknown>)[column]) + 1);
      });
      expect(await readRow(table)).toEqual(before);
    });

  it.each(['store_activity', 'store_seckill_time'] as const)('keeps the %s row-lock id immutable on a real row', async table => {
    const before = await readRow(table);
    await denied(f.cashierRuntime.db.execute(sql.raw(`UPDATE public.${ident(table)} SET id=id+1 WHERE id=${ID}`)));
    await rollbackProbe(f.cashierRuntime.db, async tx => {
      expect(await tx.execute(sql.raw(`SELECT id FROM public.${ident(table)} WHERE id=${ID} FOR SHARE NOWAIT`))).toHaveLength(1);
      expect(await tx.execute(sql.raw(`UPDATE public.${ident(table)} SET id=id WHERE id=${ID} RETURNING id`))).toHaveLength(1);
    });
    expect(await readRow(table)).toEqual(before);
  });

  it('retains the stricter append promotion ledger denial even for id=id', async () => {
    const before = await readRow('store_order_promotions');
    await denied(f.cashierRuntime.db.execute(sql`UPDATE public.store_order_promotions SET id=id WHERE id=${ID}`));
    expect(await readRow('store_order_promotions')).toEqual(before);
  });

  it('rejects platform staff creation and semantic rewrites on all three staff tables', async () => {
    await denied(f.cashierRuntime.db.execute(sql`INSERT INTO public.system_admin(account,admin_type) VALUES('conditional15-forbidden',1)`));
    await denied(f.cashierRuntime.db.execute(sql`INSERT INTO public.system_role(type,role_name) VALUES(1,'conditional15-forbidden')`));
    for (const [table, change] of [['system_admin', "pwd='forbidden'"], ['system_role', "rules='915001'"], ['system_menus', 'id=id+1']] as const) {
      const before = await readRow(table);
      await denied(f.cashierRuntime.db.execute(sql.raw(`UPDATE public.${ident(table)} SET ${change} WHERE id=${ID}`)));
      expect(await readRow(table)).toEqual(before);
    }
  });

  it('preserves supplier staff and role operations plus platform login metadata without authority rewrites', async () => {
    await rollbackProbe(f.cashierRuntime.db, async tx => {
      const [staff] = await tx.execute<{ id: number }>(sql`INSERT INTO public.system_admin(account,admin_type,relation_id)
        VALUES('conditional15-supplier',4,915001) RETURNING id`);
      expect(await tx.execute(sql`UPDATE public.system_admin SET real_name='supplier' WHERE id=${staff.id} RETURNING id`)).toHaveLength(1);
      const [role] = await tx.execute<{ id: number }>(sql`INSERT INTO public.system_role(type,relation_id,role_name)
        VALUES(4,915001,'conditional15-supplier') RETURNING id`);
      expect(await tx.execute(sql`UPDATE public.system_role SET rules='915001' WHERE id=${role.id} RETURNING id`)).toHaveLength(1);
      expect(await tx.execute(sql`UPDATE public.system_admin SET last_ip='127.0.0.1',last_time=last_time+1,login_count=login_count+1
        WHERE id=${ID} RETURNING id`)).toHaveLength(1);
      for (const table of ['system_role', 'system_menus'])
        expect(await tx.execute(sql.raw(`UPDATE public.${ident(table)} SET id=id WHERE id=${ID} RETURNING id`))).toHaveLength(1);
    });
  });

  it.each([
    ['system_admin', 'admin_type=1'], ['system_admin', 'relation_id=relation_id+1'], ['system_admin', 'id=id+1'],
    ['system_role', 'type=1'], ['system_role', 'relation_id=relation_id+1'], ['system_role', 'id=id+1'],
  ] as const)('keeps supplier identity immutable for %s change %s', async (table, change) => {
    const before = await readRow(table, `id=${ID + 10}`);
    await denied(f.cashierRuntime.db.execute(sql.raw(`UPDATE public.${ident(table)} SET ${change} WHERE id=${ID + 10}`)));
    expect(await readRow(table, `id=${ID + 10}`)).toEqual(before);
  });

  it.each([false, true])('takes the agent task-record shared statement fence for zero-row=%s INSERT', async zeroRows => {
    const before = await f.maintenanceDb.execute(sql`SELECT count(*)::integer AS count FROM public.agent_level_task_record`);
    await f.withMaintenancePeer(async peer => peer.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(731624,0)`);
      await denied(f.cashierRuntime.db.execute(sql.raw(`INSERT INTO public.agent_level_task_record(uid,level_id,task_id)
        SELECT 11,${ID},915001${zeroRows ? ' WHERE false' : ''}`)), '55P03');
    }));
    expect(await f.maintenanceDb.execute(sql`SELECT count(*)::integer AS count FROM public.agent_level_task_record`)).toEqual(before);
    await rollbackProbe(f.cashierRuntime.db, async tx => {
      const rows = await tx.execute(sql`INSERT INTO public.agent_level_task_record(uid,level_id,task_id) VALUES(11,${ID},915001) RETURNING id`);
      expect(rows).toHaveLength(1);
    });
  });

  it('takes the exclusive agent catalog fence even for a real no-op UPDATE', async () => {
    const before = await readRow('agent_level');
    await f.withMaintenancePeer(async peer => peer.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(731624,0)`);
      await denied(f.cashierRuntime.db.execute(sql`UPDATE public.agent_level SET id=id WHERE id=${ID}`), '55P03');
    }));
    expect(await readRow('agent_level')).toEqual(before);
  });

  it('rejects the original Cashier OID after a role rename on its established real backend', async () => {
    const original = f.cashierRuntime.role, renamed = original + '_moved15', before = await snapshot();
    await f.cashierRuntime.verify(); await f.exec(`ALTER ROLE ${ident(original)} RENAME TO ${ident(renamed)}`);
    try {
      const [identity] = await f.cashierRuntime.db.execute(sql`SELECT current_user AS role,session_user AS session`);
      expect(identity).toEqual({ role: renamed, session: renamed });
      await denied(f.cashierRuntime.db.execute(sql`UPDATE public.city_area SET id=id WHERE id=${ID}`));
      expect((await state()).ready).toBe(false);
    } finally { await f.exec(`ALTER ROLE ${ident(renamed)} RENAME TO ${ident(original)}`); }
    expect(await snapshot()).toEqual(before); expect(await cashierAudit()).toMatchObject({ ready: true });
  });

  it('rejects the original Cashier OID after a quoted mixed-case rename on the same real backend', async () => {
    const original = f.cashierRuntime.role, renamed = 'ConditionalCashierMixed15';
    const before = await snapshot(), oldOid = (await state()).binding!.roleOid;
    expect(await f.maintenanceDb.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${renamed}`)).toHaveLength(0);
    const pid = await f.cashierRuntime.verify();
    await f.exec(`ALTER ROLE ${ident(original)} RENAME TO "ConditionalCashierMixed15"`);
    try {
      const [identity] = await f.cashierRuntime.db.execute(sql`SELECT current_user AS role,session_user AS session,
        pg_backend_pid() AS pid,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,
        (SELECT usesysid::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_oid`);
      expect(identity).toEqual({ role: renamed, session: renamed, pid, role_oid: oldOid, backend_oid: oldOid });
      await denied(f.cashierRuntime.db.execute(sql`UPDATE public.city_area SET id=id WHERE id=${ID}`));
      expect((await state()).ready).toBe(false);
    } finally { await f.exec(`ALTER ROLE "ConditionalCashierMixed15" RENAME TO ${ident(original)}`); }
    expect(await snapshot()).toEqual(before); await f.cashierRuntime.verify();
    expect(await cashierAudit()).toMatchObject({ ready: true });
  });

  it('rejects a same-name replacement OID through an actual newly authenticated LOGIN', async () => {
    const original = f.cashierRuntime.role, renamed = original + '_held15';
    const password = Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('');
    const before = await snapshot(), oldOid = (await state()).binding!.roleOid;
    let replacement: ReturnType<typeof f.connect> | undefined, created = false;
    await f.exec(`ALTER ROLE ${ident(original)} RENAME TO ${ident(renamed)}`);
    try {
      await f.exec(`CREATE ROLE ${ident(original)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 15`);
      created = true;
      await f.exec(`GRANT CONNECT ON DATABASE ${ident(f.database)} TO ${ident(original)}; GRANT USAGE ON SCHEMA public TO ${ident(original)};
        GRANT SELECT,UPDATE(id) ON public.city_area TO ${ident(original)}`);
      replacement = f.connect(original, password); await replacement.verify();
      const [identity] = await replacement.db.execute(sql`SELECT current_user AS role,session_user AS session,
        (SELECT usesysid::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS oid`);
      expect(identity.role).toBe(original); expect(identity.session).toBe(original); expect(identity.oid).not.toBe(oldOid);
      await denied(replacement.db.execute(sql`UPDATE public.city_area SET id=id WHERE id=${ID}`));
      expect((await state()).ready).toBe(false);
    } finally {
      await replacement?.db.$client.end({ timeout: 5 });
      if (created) await f.exec(`DROP OWNED BY ${ident(original)}; DROP ROLE ${ident(original)}`);
      await f.exec(`ALTER ROLE ${ident(renamed)} RENAME TO ${ident(original)}`);
    }
    expect(await snapshot()).toEqual(before); await f.cashierRuntime.verify(); expect((await state()).ready).toBe(true);
  });

  const drift = async (change: (tx: Query) => Promise<void>) => {
    const before = await snapshot();
    await rollbackProbe(f.maintenanceDb, async tx => {
      await change(tx);
      expect((await inspectCashierRuntimeConditionalBoundary(tx, f.target, f.cashierRuntime.role)).ready).toBe(false);
      await expect(upgradeCashierRuntimeConditionalBoundaryInTransaction(tx, f.target, peers, f.appReaders)).rejects.toThrow();
      expect((await inspectCashierRuntimeConditionalBoundary(tx, f.target, f.cashierRuntime.role)).ready).toBe(false);
    });
    expect(await snapshot()).toEqual(before); expect((await state()).ready).toBe(true);
  };
  it.each(GUARDS)('rejects %s body drift and restores the exact original catalog', async (name) => {
    await drift(async tx => { await tx.execute(sql.raw(`CREATE OR REPLACE FUNCTION public.${ident(name)}() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN NEW; END'`)); });
  });
  it.each(GUARDS)('rejects %s owner drift without accepting the App as maintainer', async (name) => {
    await drift(async tx => { await tx.execute(sql.raw(`ALTER FUNCTION public.${ident(name)}() OWNER TO ${ident(f.appRuntime.role)}`)); });
  });
  it.each(GUARDS)('rejects %s trigger function ACL delegation', async (name) => {
    await drift(async tx => { await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION public.${ident(name)}() TO ${ident(f.cashierRuntime.role)}`)); });
  });
  it.each(GUARDS)('rejects %s extra function overload', async (name) => {
    await drift(async tx => { await tx.execute(sql.raw(`CREATE FUNCTION public.${ident(name)}(integer) RETURNS integer
      LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT 1'`)); });
  });
  it.each(GUARDS)('rejects %s SECURITY DEFINER drift', async (name) => {
    await drift(async tx => { await tx.execute(sql.raw(`ALTER FUNCTION public.${ident(name)}() SECURITY DEFINER`)); });
  });
  it.each(GUARDS)('rejects %s search_path drift', async (name) => {
    await drift(async tx => { await tx.execute(sql.raw(`ALTER FUNCTION public.${ident(name)}() SET search_path=public,pg_temp`)); });
  });
  it.each(GUARDS)('rejects the disabled %s trigger on %s', async (name, table) => {
    await drift(async tx => { await tx.execute(sql.raw(`ALTER TABLE public.${ident(table)} DISABLE TRIGGER ${ident(name)}`)); });
  });
  it.each(GUARDS)('rejects %s attached to an unrelated table', async (name) => {
    await drift(async tx => {
      await tx.execute(sql`CREATE TABLE public.conditional_foreign15(id integer)`);
      await tx.execute(sql.raw(`CREATE TRIGGER conditional_foreign15 BEFORE UPDATE ON public.conditional_foreign15
        FOR EACH ${name.includes('catalog_fence') ? 'STATEMENT' : 'ROW'} EXECUTE FUNCTION public.${ident(name)}()`));
    });
  });
  it.each(['city_area', 'luck_prize'] as const)('rejects an unknown later UPDATE sibling on %s', async table => {
    await drift(async tx => {
      await tx.execute(sql`CREATE FUNCTION public.conditional_tail15() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
        SET search_path=pg_catalog AS 'BEGIN NEW.id:=NEW.id+1; RETURN NEW; END'`);
      await tx.execute(sql`REVOKE ALL ON FUNCTION public.conditional_tail15() FROM PUBLIC`);
      await tx.execute(sql.raw(`CREATE TRIGGER zz_conditional_tail15 BEFORE UPDATE ON public.${ident(table)} FOR EACH ROW EXECUTE FUNCTION public.conditional_tail15()`));
    });
  });

  it('finishes with explicit successor profiles ready and broad business coverage still false', async () => {
    expect(await cashierAudit()).toMatchObject({ ready: true, realLogin: true, inheritedAppConditionalGuardsReady: true,
      conditionalWriteSemanticsVerified: false, completeServiceCoverageVerified: false });
    expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, peers, f.appReaders)).ready).toBe(true);
    expect((await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, peers)).ready).toBe(true);
    expect((await state()).ready).toBe(true);
  });
});
