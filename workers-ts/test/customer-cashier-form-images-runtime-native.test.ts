import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../src/lib/di';
import { auditRuntimeBusinessPrivileges, inspectRuntimeBusinessProfileInTransaction } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges, inspectCustomerCashierSecondCardRuntimePrivileges } from '../src/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '../src/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '../src/migrations/auditManagerRuntimePrivileges';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from '../src/migrations/customerRuntimeGiftPeers';
import { pricingIdentifier } from '../src/migrations/checkoutPricingLockCatalog';
import { inspectCashierRuntimeConditionalBoundary } from '../src/migrations/cashierRuntimeConditionalBoundary';
import { upgradeCashierRuntimeConditionalBoundary, upgradeCashierRuntimeConditionalBoundaryInTransaction } from '../src/migrations/upgradeCashierRuntimeConditionalBoundary';
import { cashierSecondCardFormImagesReadiness, inspectCashierSecondCardFormImages, runCashierSecondCardFormImages } from '../src/migrations/runCashierSecondCardFormImages';
import { CASHIER_SECOND_CARD_FORM_IMAGE_TABLES, CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS,
  CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS, CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS,
  cashierSecondCardFormImagesRuntimeAddonGrantSql, inspectCashierSecondCardFormImagesRuntimeCatalog } from '../src/migrations/cashierSecondCardFormImagesRuntimePlan';
import { CASHIER_SECOND_CARD_FORM_IMAGES_RUNTIME_GATES, upgradeCashierSecondCardFormImagesRuntime,
  upgradeCashierSecondCardFormImagesRuntimeInTransaction } from '../src/migrations/upgradeCashierSecondCardFormImagesRuntime';
import { customerOriginalPaymentRuntimeFixture } from './helpers/customerOriginalPaymentRuntimeFixture';

type Query = Pick<DbClient, 'execute'>;
const ident = pricingIdentifier;
const SESSION = CASHIER_SECOND_CARD_FORM_IMAGE_TABLES[0], UPLOAD = CASHIER_SECOND_CARD_FORM_IMAGE_TABLES[1];
const SESSION_KEY = '00000000-0000-4000-8000-000000000016', UPLOAD_KEY = '00000000-0000-4000-8000-000000000017';
const ACTOR = 916001, SERVICE = 916002, SCOPE_DIGEST = 'A'.repeat(43);
const SQL_HASH = "encode(sha256(convert_to('{}','UTF8')),'hex')";
const SESSION_IMMUTABLE = ['actor_uid', 'service_id', 'scope_key', 'request_key', 'request_hash', 'intent_json',
  'system_form_id', 'template_json', 'scope_digest', 'created_at'] as const;
const UPLOAD_IMMUTABLE = ['actor_uid', 'service_id', 'session_key', 'request_key', 'request_hash', 'intent_json', 'field_id',
  'sha256', 'size', 'mime', 'scope_digest', 'object_key', 'created_at'] as const;

function sqlStates(error: unknown, visited = new Set<unknown>()): string[] {
  if (!error || typeof error !== 'object' || visited.has(error)) return [];
  visited.add(error);
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown };
  return [...(typeof value.code === 'string' ? [value.code] : []), ...sqlStates(value.cause, visited),
    ...(Array.isArray(value.errors) ? value.errors.flatMap(item => sqlStates(item, visited)) : [])];
}
async function denied(action: Promise<unknown>) {
  let rejected = false;
  try { await action; }
  catch (error) { rejected = true; expect(sqlStates(error)).toContain('42501'); }
  expect(rejected, 'The actual statement must reject with its original PostgreSQL permission SQLSTATE').toBe(true);
}

// Canonical full five-LOGIN fixture and explicit owner DDL. The small SQL rows
// below live only in rolled-back authority probes; they are not form-service,
// object-upload, order, payment or paid-consumer success evidence.
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).sequential('full Cashier form-image runtime forward on owned PG16', { timeout: 30000 }, () => {
  let f: Awaited<ReturnType<typeof customerOriginalPaymentRuntimeFixture>>;
  let peers: RuntimeGiftPeerDeclarations, conditionalPeers: RuntimeGiftPeerDeclarations;
  let alternateOwner: string;
  const audit = () => auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role,
    f.target, { abandon: true, conditionalGuards: true, formImages: true });
  const forward = () => upgradeCashierSecondCardFormImagesRuntime(f.maintenanceDb, f.target, peers, f.appReaders);
  const rollback = async (db: DbClient, work: (tx: Query) => Promise<void>) => {
    const marker = Error('Deliberate image-runtime authority rollback');
    await expect(db.transaction(async tx => { await work(tx); throw marker; },
      { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(marker);
  };
  const snapshot = async () => {
    const [value] = await f.maintenanceDb.execute(sql`SELECT jsonb_build_object(
      'relations',(SELECT jsonb_agg(jsonb_build_array(oid::text,relname,relowner::text,relacl::text) ORDER BY oid)
        FROM pg_class WHERE relnamespace='public'::regnamespace),
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attrelid::text,a.attnum,a.attacl::text) ORDER BY a.attrelid,a.attnum)
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL),
      'roles',(SELECT jsonb_agg(jsonb_build_array(oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,
        rolinherit,rolreplication,rolbypassrls,rolconnlimit,md5(rolpassword)) ORDER BY oid) FROM pg_authid
        WHERE rolname IN(${f.appRuntime.role},${f.adminRuntime.role},${f.cashierRuntime.role},${f.financialRuntime.role},${f.managerRuntime.role})),
      'routines',(SELECT jsonb_agg(jsonb_build_array(oid::text,proname,proowner::text,proacl::text,
        CASE WHEN prokind IN('f','p') THEN md5(pg_get_functiondef(oid)) ELSE NULL END) ORDER BY oid)
        FROM pg_proc WHERE pronamespace='public'::regnamespace),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.oid::text,t.tgrelid::text,t.tgname,t.tgfoid::text,t.tgenabled,t.tgtype) ORDER BY t.oid)
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace)) AS value`);
    const rows: Record<string, unknown> = {};
    for (const table of [...CASHIER_SECOND_CARD_FORM_IMAGE_TABLES, 'cashier_second_card_cart_v1', 'cashier_second_card_origin_v1',
      'cashier_second_card_payment_v1', 'cashier_second_card_abandon_v1', 'store_order', 'store_order_cart_info', 'store_order_status',
      'store_order_outbox', 'system_attachment', 'system_form_data']) {
      const [row] = await f.maintenanceDb.execute(sql.raw(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM public.${ident(table)} t`));
      rows[table] = row.value;
    }
    return { authority: value.value, rows };
  };
  const insertSession = (tx: Query) => tx.execute(sql.raw(`INSERT INTO public.${ident(SESSION)}
    (actor_uid,service_id,scope_key,request_key,request_hash,intent_json,system_form_id,template_json,scope_digest)
    VALUES(${ACTOR},${SERVICE},'${'0'.repeat(64)}','${SESSION_KEY}',${SQL_HASH},'{}',916003,'{}','${SCOPE_DIGEST}')`));
  const insertUpload = (tx: Query) => tx.execute(sql.raw(`INSERT INTO public.${ident(UPLOAD)}
    (actor_uid,service_id,session_key,request_key,request_hash,intent_json,field_id,sha256,size,mime,scope_digest,object_key)
    VALUES(${ACTOR},${SERVICE},'${SESSION_KEY}','${UPLOAD_KEY}',${SQL_HASH},'{}','field16','${'b'.repeat(64)}',4,'image/png',
    '${SCOPE_DIGEST}','attachments/cc/${SCOPE_DIGEST}/${UPLOAD_KEY.replaceAll('-', '')}.png')`));
  beforeAll(async () => {
    f = await customerOriginalPaymentRuntimeFixture();
    await runCashierSecondCardFormImages(f.maintenanceDb);
    alternateOwner = (await f.createOwnedRole('image_owner')).role;
    conditionalPeers = { ...f.peers, cashierSecondCard: { ...f.peers.cashierSecondCard!, conditionalGuards: true } };
    peers = { ...conditionalPeers, cashierSecondCard: { ...conditionalPeers.cashierSecondCard!, formImages: true } };
  }, 180000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external I/O in image-runtime authority acceptance')); });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

  it('requires explicit maintenance after complete catalog installation without inferring image authority', async () => {
    expect(await inspectCashierSecondCardFormImages(f.maintenanceDb)).toMatchObject({ present: true, complete: true });
    expect((await inspectCashierSecondCardFormImagesRuntimeCatalog(f.cashierRuntime.db, f.target.maintenance)).ready).toBe(true);
    expect((await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role,
      f.target, { abandon: true })).ready).toBe(true);
    expect((await cashierSecondCardFormImagesReadiness(f.cashierRuntime.db)).ready).toBe(false);
    const before = await snapshot(); await expect(forward()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });

  it('preserves an explicitly installed image profile when a caller-owned rollback upgrades guards second', async () => {
    const before = await snapshot();
    await rollback(f.maintenanceDb, async tx => {
      // Explicit compiler is used only in this rolled-back order probe. The
      // production commissioning forward below always requires guards first.
      for (const grant of cashierSecondCardFormImagesRuntimeAddonGrantSql(f.cashierRuntime.role)) await tx.execute(sql.raw(grant));
      const beforeGuard = { ...f.peers, cashierSecondCard: { ...f.peers.cashierSecondCard!, formImages: true as const } };
      expect((await inspectCustomerCashierSecondCardRuntimePrivileges(tx, { role: f.cashierRuntime.role, requireLogin: true,
        routine: { target: f.target, stage: 'ready' }, abandon: true, formImages: true })).ready).toBe(true);
      expect((await inspectRuntimeBusinessProfileInTransaction(tx, 'app', f.target, 'current', beforeGuard, f.appReaders)).ready).toBe(true);
      const result = await upgradeCashierRuntimeConditionalBoundaryInTransaction(tx, f.target, peers, f.appReaders);
      expect(result).toMatchObject({ changed: true, privilegesChanged: false, credentialChanged: false });
      expect(result.audit.app.ready).toBe(true); expect(result.audit.admin.ready).toBe(true); expect(result.audit.cashier.ready).toBe(true);
      expect((await inspectCustomerCashierSecondCardRuntimePrivileges(tx, { role: f.cashierRuntime.role, requireLogin: true,
        routine: { target: f.target, stage: 'ready' }, abandon: true, conditionalGuards: true, formImages: true })).ready).toBe(true);
    });
    expect(await snapshot()).toEqual(before);
  });

  it('first commissions the real conditional Cashier while installed image grants remain absent', async () => {
    expect(await upgradeCashierRuntimeConditionalBoundary(f.maintenanceDb, f.target, conditionalPeers, f.appReaders))
      .toMatchObject({ changed: true, privilegesChanged: false });
    expect((await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role,
      f.target, { abandon: true, conditionalGuards: true })).ready).toBe(true);
    expect((await audit()).ready).toBe(false); expect((await cashierSecondCardFormImagesReadiness(f.cashierRuntime.db)).ready).toBe(false);
  });

  it('rolls back all image grants without changing catalogs, rows, LOGINs or credentials', async () => {
    const before = await snapshot();
    await rollback(f.maintenanceDb, async tx => {
      const result = await upgradeCashierSecondCardFormImagesRuntimeInTransaction(tx, f.target, peers, f.appReaders);
      expect(result).toMatchObject({ changed: true, privilegesChanged: true, credentialChanged: false,
        historicalRowsReassigned: false, completeServiceCoverageVerified: false });
      expect(result.audit.app.ready).toBe(true); expect(result.audit.admin.ready).toBe(true); expect(result.audit.cashier.ready).toBe(true);
    });
    expect(await snapshot()).toEqual(before); expect((await audit()).ready).toBe(false);
  });

  it.each(CASHIER_SECOND_CARD_FORM_IMAGES_RUNTIME_GATES)('refuses competing maintenance gate %i/%i without partial grants', async (key, subkey) => {
    const before = await snapshot();
    await f.withMaintenancePeer(peer => peer.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},${subkey})`); await expect(forward()).rejects.toThrow();
    }));
    expect(await snapshot()).toEqual(before);
  });
  it('refuses a conflicting image-table lock without partial grants', async () => {
    const before = await snapshot();
    await f.withMaintenancePeer(peer => peer.transaction(async tx => {
      await tx.execute(sql.raw(`LOCK TABLE ONLY public.${ident(SESSION)} IN ACCESS SHARE MODE`));
      await expect(forward()).rejects.toThrow();
    }));
    expect(await snapshot()).toEqual(before);
  });
  it('keeps tighter caller deadlines during an actual rolled-back forward', async () => {
    await rollback(f.maintenanceDb, async tx => {
      await tx.execute(sql`SELECT set_config('statement_timeout','4000ms',true),set_config('lock_timeout','250ms',true),
        set_config('idle_in_transaction_session_timeout','4000ms',true)`);
      expect((await upgradeCashierSecondCardFormImagesRuntimeInTransaction(tx, f.target, peers, f.appReaders)).changed).toBe(true);
      const [settings] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
      expect(settings).toEqual({ statement: '4s', lock: '250ms', idle: '4s' });
    });
  });
  it('refuses maintenance by the actual App LOGIN', async () => {
    const before = await snapshot();
    await expect(upgradeCashierSecondCardFormImagesRuntime(f.appRuntime.db, f.target, peers, f.appReaders)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it.each(['read-only', 'repeatable-read'] as const)('refuses an incompatible %s maintenance transaction', async mode => {
    const before = await snapshot();
    await expect(f.maintenanceDb.transaction(tx => upgradeCashierSecondCardFormImagesRuntimeInTransaction(tx, f.target, peers, f.appReaders),
      { isolationLevel: mode === 'repeatable-read' ? 'repeatable read' : 'read committed',
        accessMode: mode === 'read-only' ? 'read only' : 'read write' })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('refuses a wrong database and direct root passed as a transaction without making grants', async () => {
    const before = await snapshot(), target = { ...f.target, database: 'wrong_cashier_image_database16' };
    await expect(upgradeCashierSecondCardFormImagesRuntime(f.maintenanceDb, target, { ...peers, target }, f.appReaders)).rejects.toThrow();
    await expect(upgradeCashierSecondCardFormImagesRuntimeInTransaction(f.maintenanceDb, f.target, peers, f.appReaders)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it.each(['images', 'guards', 'financial', 'manager', 'reader'] as const)('requires the complete explicit %s declaration', async missing => {
    const value = { ...peers, cashierSecondCard: { ...peers.cashierSecondCard! } };
    if (missing === 'images') delete value.cashierSecondCard.formImages;
    if (missing === 'guards') delete value.cashierSecondCard.conditionalGuards;
    if (missing === 'financial') delete value.financial;
    if (missing === 'manager') delete value.manager;
    const before = await snapshot();
    await expect(upgradeCashierSecondCardFormImagesRuntime(f.maintenanceDb, f.target, value,
      missing === 'reader' ? undefined : f.appReaders)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('captures the explicit image flag and rejects false or unknown peer fields', async () => {
    const declaration = { ...peers, cashierSecondCard: { ...peers.cashierSecondCard! } };
    const captured = captureRuntimeGiftPeerDeclarations(declaration);
    delete declaration.cashierSecondCard.formImages;
    expect(captured.cashierSecondCard?.formImages).toBe(true);
    for (const drift of [{ formImages: false }, { formImages: true, unknownImageFlag: true }, { formImages: true, [Symbol('extra')]: true }]) {
      expect(() => captureRuntimeGiftPeerDeclarations({ ...peers, cashierSecondCard: { ...peers.cashierSecondCard!, ...drift } } as unknown as RuntimeGiftPeerDeclarations)).toThrow();
    }
    await expect(auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role, f.target,
      { abandon: true, conditionalGuards: true, formImages: false } as unknown as { abandon: true; conditionalGuards: true; formImages: true })).rejects.toThrow();
  });

  it.each(['partial-select', 'partial-column', 'table-update', 'unapproved-column', 'table-owner', 'function-owner', 'public-execute',
    'delegation', 'overload', 'body', 'disabled-trigger', 'reverse-hook', 'extra-column', 'default', 'row-security',
    'owned-sequence', 'default-acl', 'unknown-definer'] as const)('refuses %s drift instead of installing or repairing the catalog', async kind => {
    const before = await snapshot();
    await rollback(f.maintenanceDb, async tx => {
      const principal = ident(f.cashierRuntime.role);
      const commands: Record<typeof kind, string> = {
        'partial-select': `GRANT SELECT ON public.${ident(SESSION)} TO ${principal}`,
        'partial-column': `GRANT UPDATE(state) ON public.${ident(SESSION)} TO ${principal}`,
        'table-update': `GRANT UPDATE ON public.${ident(SESSION)} TO ${principal}`,
        'unapproved-column': `GRANT UPDATE(actor_uid) ON public.${ident(SESSION)} TO ${principal}`,
        'table-owner': `ALTER TABLE public.${ident(SESSION)} OWNER TO ${ident(alternateOwner)}`,
        'function-owner': `ALTER FUNCTION public.cashier_second_card_form_json_valid_v1(text,integer,text) OWNER TO ${ident(alternateOwner)}`,
        'public-execute': `GRANT EXECUTE ON FUNCTION public.cashier_second_card_form_json_valid_v1(text,integer,text) TO PUBLIC`,
        delegation: `GRANT SELECT ON public.${ident(SESSION)} TO ${principal} WITH GRANT OPTION`,
        overload: `CREATE FUNCTION public.cashier_second_card_form_json_valid_v1(integer) RETURNS boolean LANGUAGE sql AS 'SELECT true'`,
        body: `CREATE OR REPLACE FUNCTION public.cashier_second_card_form_session_guard_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN NEW; END'`,
        'disabled-trigger': `ALTER TABLE public.${ident(SESSION)} DISABLE TRIGGER cashier_second_card_form_session_guard_v1`,
        'reverse-hook': `CREATE TRIGGER image16_extra BEFORE INSERT ON public.city_area FOR EACH ROW EXECUTE FUNCTION public.cashier_second_card_form_session_guard_v1()`,
        'extra-column': `ALTER TABLE public.${ident(SESSION)} ADD COLUMN image16_extra text`,
        default: `ALTER TABLE public.${ident(SESSION)} ALTER COLUMN state SET DEFAULT 'cancelled'`,
        'row-security': `ALTER TABLE public.${ident(SESSION)} ENABLE ROW LEVEL SECURITY`,
        'owned-sequence': `CREATE SEQUENCE public.image16_extra_seq OWNED BY public.${ident(SESSION)}.actor_uid`,
        'default-acl': `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(f.target.maintenance)} IN SCHEMA public GRANT SELECT ON TABLES TO ${principal}`,
        'unknown-definer': `CREATE FUNCTION public.image16_unknown_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION public.image16_unknown_definer() TO ${principal}`,
      };
      await tx.execute(sql.raw(commands[kind]));
      await expect(upgradeCashierSecondCardFormImagesRuntimeInTransaction(tx, f.target, peers, f.appReaders)).rejects.toThrow();
    });
    expect(await snapshot()).toEqual(before);
  });

  it('commissions only the declared two ledgers, thirteen update columns and three functions', async () => {
    const before = await snapshot(), source = await inspectCashierSecondCardFormImagesRuntimeCatalog(f.maintenanceDb, f.target.maintenance);
    const conditional = await inspectCashierRuntimeConditionalBoundary(f.maintenanceDb, f.target, f.cashierRuntime.role);
    const result = await forward(), after = await snapshot();
    expect(result).toMatchObject({ changed: true, privilegesChanged: true, credentialChanged: false,
      historicalRowsReassigned: false, completeServiceCoverageVerified: false, binding: conditional.binding });
    expect(result.binding).toEqual({ database: f.database, databaseOid: expect.stringMatching(/^[1-9][0-9]*$/u),
      role: f.cashierRuntime.role, roleOid: expect.stringMatching(/^[1-9][0-9]*$/u) });
    expect(after.rows).toEqual(before.rows);
    const stripAcl = (authority: unknown) => {
      const value = authority as { roles: unknown; triggers: unknown; relations: unknown[][]; routines: unknown[][] };
      return { roles: value.roles, triggers: value.triggers,
        relations: value.relations.map(([oid, name, owner]) => [oid, name, owner]),
        routines: value.routines.map(([oid, name, owner, _acl, body]) => [oid, name, owner, body]) };
    };
    expect(stripAcl(after.authority)).toEqual(stripAcl(before.authority));
    const post = await inspectCashierSecondCardFormImagesRuntimeCatalog(f.cashierRuntime.db, f.target.maintenance);
    expect(post).toMatchObject({ ready: true, tables: source.tables, functions: source.functions });
    expect(await audit()).toMatchObject({ ready: true, realLogin: true, inheritedAppConditionalGuardsReady: true,
      formImagesCatalogReady: true, conditionalWriteSemanticsVerified: false, completeServiceCoverageVerified: false, failures: [] });
    expect(await cashierSecondCardFormImagesReadiness(f.cashierRuntime.db)).toMatchObject({ ready: true, available: true });
    expect(CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS.length + CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS.length).toBe(13);
    for (const [table, columns] of [[SESSION, CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS], [UPLOAD, CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS]] as const) {
      const [actual] = await f.cashierRuntime.db.execute(sql`SELECT has_table_privilege(current_user,${'public.' + table},'SELECT') AS read,
        has_table_privilege(current_user,${'public.' + table},'INSERT') AS append,
        has_table_privilege(current_user,${'public.' + table},'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS broad,
        ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid=${'public.' + table}::regclass AND attnum>0 AND NOT attisdropped
          AND has_column_privilege(current_user,attrelid,attnum,'UPDATE') ORDER BY attname) AS updates`);
      expect(actual).toEqual({ read: true, append: true, broad: false, updates: [...columns].sort() });
    }
    for (const signature of CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS)
      expect((await f.cashierRuntime.db.execute(sql`SELECT has_function_privilege(current_user,${'public.' + signature},'EXECUTE') AS ready`))[0].ready).toBe(true);
  });
  it('keeps all five actual full LOGIN profiles ready only with the explicitly declared image peer', async () => {
    expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, peers, f.appReaders)).ready).toBe(true);
    expect((await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, peers)).ready).toBe(true);
    expect((await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db, f.target, f.manual, f.readers)).ready).toBe(true);
    expect((await auditManagerRuntimePrivileges(f.managerRuntime.db, f.target)).ready).toBe(true);
    expect((await audit()).ready).toBe(true);
    expect((await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role,
      f.target, { abandon: true, conditionalGuards: true })).ready).toBe(false);
    expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, conditionalPeers, f.appReaders)).ready).toBe(false);
    expect((await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, conditionalPeers)).ready).toBe(false);
  });
  it('replays the exact ready forward without assigning an XID or changing catalogs', async () => {
    const before = await snapshot();
    await f.maintenanceDb.transaction(async tx => {
      expect((await tx.execute(sql`SELECT pg_current_xact_id_if_assigned()::text AS xid`))[0].xid).toBeNull();
      expect(await upgradeCashierSecondCardFormImagesRuntimeInTransaction(tx, f.target, peers, f.appReaders))
        .toMatchObject({ changed: false, privilegesChanged: false });
      expect((await tx.execute(sql`SELECT pg_current_xact_id_if_assigned()::text AS xid`))[0].xid).toBeNull();
    });
    expect(await snapshot()).toEqual(before);
  });
  it('allows real Cashier inserts and no-op writes only to all thirteen declared columns in a rolled-back probe', async () => {
    const before = await snapshot();
    await rollback(f.cashierRuntime.db, async tx => {
      await insertSession(tx); await insertUpload(tx);
      for (const [table, columns] of [[SESSION, CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS], [UPLOAD, CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS]] as const)
        for (const column of columns) await tx.execute(sql.raw(`UPDATE public.${ident(table)} SET ${ident(column)}=${ident(column)} WHERE actor_uid=${ACTOR}`));
      const rows = await tx.execute(sql.raw(`SELECT state FROM public.${ident(SESSION)} WHERE actor_uid=${ACTOR}`));
      expect(rows).toEqual([{ state: 'active' }]);
    });
    expect(await snapshot()).toEqual(before);
  });
  it.each(SESSION_IMMUTABLE)('rejects actual Cashier UPDATE of immutable session column %s with SQLSTATE42501', async column => {
    await denied(f.cashierRuntime.db.transaction(async tx => {
      await insertSession(tx); await tx.execute(sql.raw(`UPDATE public.${ident(SESSION)} SET ${ident(column)}=${ident(column)} WHERE actor_uid=${ACTOR}`));
    }));
  });
  it.each(UPLOAD_IMMUTABLE)('rejects actual Cashier UPDATE of immutable upload column %s with SQLSTATE42501', async column => {
    await denied(f.cashierRuntime.db.transaction(async tx => {
      await insertSession(tx); await insertUpload(tx);
      await tx.execute(sql.raw(`UPDATE public.${ident(UPLOAD)} SET ${ident(column)}=${ident(column)} WHERE actor_uid=${ACTOR}`));
    }));
  });
  it.each([SESSION, UPLOAD])('rejects actual Cashier delete and truncate of %s', async table => {
    await denied(f.cashierRuntime.db.execute(sql.raw(`DELETE FROM public.${ident(table)} WHERE actor_uid=${ACTOR}`)));
    await denied(f.cashierRuntime.db.execute(sql.raw(`TRUNCATE TABLE public.${ident(table)}`)));
  });
  it.each([SESSION, UPLOAD])('retains immutable identity trigger enforcement on %s even through owner SQL authority', async table => {
    await denied(f.maintenanceDb.transaction(async tx => {
      await insertSession(tx); if (table === UPLOAD) await insertUpload(tx);
      await tx.execute(sql.raw(`UPDATE public.${ident(table)} SET service_id=service_id+1 WHERE actor_uid=${ACTOR}`));
    }));
  });
  it('permits active cancellation but refuses invalid mutable state transitions and keeps authority probe rows rolled back', async () => {
    const before = await snapshot();
    await rollback(f.cashierRuntime.db, async tx => {
      await insertSession(tx);
      await tx.execute(sql.raw(`UPDATE public.${ident(SESSION)} SET state='cancelled',cancelled_at=clock_timestamp() WHERE actor_uid=${ACTOR}`));
      expect((await tx.execute(sql.raw(`SELECT state FROM public.${ident(SESSION)} WHERE actor_uid=${ACTOR}`)))[0].state).toBe('cancelled');
    });
    await denied(f.cashierRuntime.db.transaction(async tx => {
      await insertSession(tx); await tx.execute(sql.raw(`UPDATE public.${ident(SESSION)} SET state='consumed' WHERE actor_uid=${ACTOR}`));
    }));
    await denied(f.cashierRuntime.db.transaction(async tx => {
      await insertSession(tx); await insertUpload(tx);
      await tx.execute(sql.raw(`UPDATE public.${ident(UPLOAD)} SET size=size+1 WHERE actor_uid=${ACTOR}`));
    }));
    expect(await snapshot()).toEqual(before);
  });
});
