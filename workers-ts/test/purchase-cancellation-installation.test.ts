import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { createContainerFromDb } from '@/lib/di';
import { MigrationService } from '@/services/MigrationService';
import { catalogKinds, readCatalog } from '../scripts/data-migration/postgres-catalog-audit';
import { storeOrder, storeOrderCartInfo, userBill } from '@/models/schema/order';
import { storeOrderStatus } from '@/models/schema/order_refund';
import { storeOrderPurchaseCancellation } from '@/models/schema/purchase_cancellation_evidence';
import { completePurchaseOriginEvidenceOrm, inspectPurchaseOriginEvidence, runPurchaseOriginEvidenceSchema } from '@/migrations/runPurchaseOriginEvidence';
import { PURCHASE_CANCELLATION_DEFINITION_SQL } from '@/migrations/purchaseCancellationEvidence';
import { PURCHASE_CANCELLATION_CATALOG_SQL, PURCHASE_CANCELLATION_FINGERPRINTS, PURCHASE_CANCELLATION_ORM_FINGERPRINT } from '@/migrations/purchaseCancellationEvidenceCatalog';
import { PURCHASE_CANCELLATION_INSTALLATION_SQL, PURCHASE_CANCELLATION_SOURCE_SQL, PURCHASE_CANCELLATION_ORM_INSTALLATION_SQL } from '@/migrations/purchaseCancellationEvidenceInstallation';
import { completePurchaseCancellationEvidenceOrm, inspectPurchaseCancellationEvidence, runPurchaseCancellationEvidenceSchema, runPurchaseCancellationEvidence } from '@/migrations/runPurchaseCancellationEvidence';
import { recordPurchaseOriginEvidence } from '@/services/order/PurchaseOriginEvidence';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('cancellation controlled PG16 installation', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),
      api.generateDrizzleJson({ storeOrder,storeOrderCartInfo,userBill,storeOrderStatus }))).join('\n'));
    await runPurchaseOriginEvidenceSchema(f.db);
  },30000);
  afterEach(async () => { await f?.close(); },45000);
  const catalog = () => f.db.execute(sql.raw(PURCHASE_CANCELLATION_CATALOG_SQL));
  const identities = () => f.db.execute(sql.raw(`SELECT 'relation' AS kind,oid::text,relfilenode::text,relacl::text AS acl FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,NULL,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',oid::text,NULL,NULL FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    ORDER BY kind,oid`));
  const sources = (role: string) => f.exec(`GRANT SELECT,UPDATE(id) ON public.store_order,public.store_order_cart_info TO "${role}";
    GRANT SELECT ON public.store_order_purchase_origin,public.store_order_status,public.user_bill TO "${role}"`);
  const orm = async () => {
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson({ storeOrderPurchaseCancellation }))).join('\n'));
  };
  // Deliberately unauthenticated synthetic receipt: completion must never adopt it.
  const unprotectedRow = `INSERT INTO public.store_order_purchase_cancellation
    (order_id,buyer_id,version,order_type,total_num,restored_points,lines,origin_recorded_at,cancelled_at)
    VALUES(1,11,'purchase-cancellation-v1',0,1,0,'[{}]',now(),now())`;
  const seed = async () => {
    await f.db.insert(storeOrder).values({ id:1,uid:11,orderId:'LOCAL-CANCELLATION',totalNum:1,cartId:'1' });
    await f.db.insert(storeOrderCartInfo).values({ id:1,oid:1,uid:11,cartId:'1',productId:70,skuUnique:'sku70',cartNum:1,surplusNum:1,splitSurplusNum:1,
      cartInfo:JSON.stringify({ financial_version:'checkout-line-finance-v1',id:'1',cart_num:1,product:{id:70},sku:{id:1,unique:'sku70'},use_integral:'0' }) });
    await f.db.transaction(tx => recordPurchaseOriginEvidence(tx,{ orderId:1,buyerId:11 }));
  };
  it('matches all canonical native PG16 component fingerprints', async () => {
    expect(createHash('sha256').update(PURCHASE_CANCELLATION_DEFINITION_SQL).digest('hex'))
      .toBe('21b5bc4b97f56d2ce0b9d093807e8e60324b21ba403d73e7b7305a90f67c64d1');
    await f.db.transaction(tx => tx.execute(sql.raw(PURCHASE_CANCELLATION_DEFINITION_SQL)));
    const rows = await f.db.execute(sql.raw(PURCHASE_CANCELLATION_CATALOG_SQL));
    expect(rows).toHaveLength(6); expect(rows.every(row => row.owned && row.safe)).toBe(true);
    expect(Object.fromEntries(rows.map(row => [String(row.name),row.fingerprint]))).toEqual(PURCHASE_CANCELLATION_FINGERPRINTS);
    expect(await f.db.execute(sql.raw(PURCHASE_CANCELLATION_SOURCE_SQL))).toMatchObject([{ ready:true }]);
  });
  it('matches the exact generated empty-ORM table before any protection or grants', async () => {
    await orm();
    const rows = await catalog();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ name:'store_order_purchase_cancellation',owned:true,safe:true });
    expect(rows[0].fingerprint).toBe(PURCHASE_CANCELLATION_ORM_FINGERPRINT);
    expect(await inspectPurchaseCancellationEvidence(f.db)).toEqual({ state:'orm-pending',sourcesReady:true });
  });
  it('completes the exact empty ORM in place without history or grants, then commissions explicitly', async () => {
    await orm(); await seed();
    // Historical cancellation before activation is not backfilled.
    await f.db.insert(storeOrder).values({ id:2,uid:11,orderId:'LOCAL-PREACTIVATION',unique:'LOCAL-PREACTIVATION',status:-2,isDel:1 });
    await f.withRuntimeRole!(async peer => {
      await sources(peer.role); const before=await identities();
      await completePurchaseCancellationEvidenceOrm(f.db);
      expect((await identities()).filter(row => before.some(old => old.kind===row.kind && old.oid===row.oid))).toEqual(before);
      expect(await f.exec('TABLE public.store_order_purchase_cancellation')).toEqual([]);
      expect(await inspectPurchaseCancellationEvidence(f.db,peer.role)).toEqual({ state:'v1',sourcesReady:true,runtimeSafe:true,runtimeReady:false });
      await expect(peer.exec('TABLE public.store_order_purchase_cancellation')).rejects.toMatchObject({ code:'42501' });
      await runPurchaseCancellationEvidence(f.db,peer.role);
      await f.exec(`GRANT UPDATE(status,is_del) ON public.store_order TO "${peer.role}"; GRANT INSERT ON public.store_order_status TO "${peer.role}"`);
      await peer.exec(`BEGIN; UPDATE public.store_order SET status=-2,is_del=1 WHERE id=1;
        INSERT INTO public.store_order_status(id,oid,change_type) VALUES(1,1,'cancel'); COMMIT`);
      const rows=await f.exec('TABLE public.store_order_purchase_cancellation'),objects=await identities();
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ order_id:1 });
      await completePurchaseCancellationEvidenceOrm(f.db); await runPurchaseCancellationEvidenceSchema(f.db);
      expect(await identities()).toEqual(objects); expect(await f.exec('TABLE public.store_order_purchase_cancellation')).toEqual(rows);
      expect(Object.fromEntries((await catalog()).map(row => [String(row.name),row.fingerprint]))).toEqual(PURCHASE_CANCELLATION_FINGERPRINTS);
    });
  });
  it('constructs full registered ORM and completes origin before cancellation without replacing relations', async () => {
    const whole=await sequenceRunnerDatabase();
    try {
      const api=await import('drizzle-kit/api'),schema=await import('@/models/schema');
      expect(schema.storeOrderPurchaseCancellation).toBe(storeOrderPurchaseCancellation);
      expect(Object.keys(api.generateDrizzleJson(schema).tables)).toHaveLength(279);
      await whole.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(schema))).join('\n'));
      const relations=() => whole.exec("SELECT oid::text,relfilenode::text,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid");
      const before=await relations();
      expect(await whole.exec("SELECT count(*)::integer AS n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'")).toEqual([{ n:279 }]);
      expect(await inspectPurchaseOriginEvidence(whole.db)).toEqual({ state:'orm-pending',sourcesReady:true });
      expect(await inspectPurchaseCancellationEvidence(whole.db)).toEqual({ state:'orm-pending',sourcesReady:false });
      await expect(completePurchaseCancellationEvidenceOrm(whole.db)).rejects.toThrow(); expect(await relations()).toEqual(before);
      await completePurchaseOriginEvidenceOrm(whole.db); await completePurchaseCancellationEvidenceOrm(whole.db);
      expect(await relations()).toEqual(before);
      expect(await inspectPurchaseCancellationEvidence(whole.db)).toEqual({ state:'v1',sourcesReady:true });
      expect(Object.fromEntries((await whole.db.execute(sql.raw(PURCHASE_CANCELLATION_CATALOG_SQL))).map(row => [String(row.name),row.fingerprint])))
        .toEqual(PURCHASE_CANCELLATION_FINGERPRINTS);
    } finally { await whole.close(); }
  },60000);
  it('never implicitly adopts ORM through ordinary schema or runtime commissioning', async () => {
    await orm(); const shape=await catalog(),before=await identities();
    await expect(runPurchaseCancellationEvidenceSchema(f.db)).rejects.toThrow(); expect(await identities()).toEqual(before);
    await f.withRuntimeRole!(async peer => {
      await sources(peer.role); const granted=await identities();
      await expect(runPurchaseCancellationEvidence(f.db,peer.role)).rejects.toThrow();
      expect(await identities()).toEqual(granted);
      expect(await inspectPurchaseCancellationEvidence(f.db,peer.role)).toMatchObject({ state:'orm-pending',runtimeReady:false });
    });
    expect(await catalog()).toEqual(shape);
  });
  it.each(['external','runner'] as const)('upgrades the complete previous schema via %s without replay, replacement or historical receipts', async path => {
    const whole=await checkoutPricingMigrationDatabase();
    try {
      // Preserve this historical upgrade boundary as later forward indexes register.
      const files=readdirSync('migrations').filter(name => /^\d+.*\.sql$/.test(name)
        && name <= '0164_purchase_cancellation_evidence.sql').sort();
      expect(files.at(-1)).toBe('0164_purchase_cancellation_evidence.sql');
      expect(files.at(-2)).toBe('0163_purchase_origin_evidence.sql');
      const artifact=readFileSync(`migrations/${files.at(-1)}`,'utf8').replace(/\r\n/g,'\n');
      expect(artifact.trim()).toBe(PURCHASE_CANCELLATION_INSTALLATION_SQL.trim());
      for (const file of files.slice(0,-1)) await whole.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
        await tx.execute(sql.raw(readFileSync(`migrations/${file}`,'utf8')));
      });
      await whole.db.insert(storeOrder).values({ id:1,uid:11,orderId:'LOCAL-CANCELLATION-UPGRADE',totalNum:1,cartId:'1' });
      await whole.db.insert(storeOrderCartInfo).values({ id:1,oid:1,uid:11,cartId:'1',productId:70,skuUnique:'sku70',cartNum:1,surplusNum:1,splitSurplusNum:1,
        cartInfo:JSON.stringify({ financial_version:'checkout-line-finance-v1',id:'1',cart_num:1,product:{id:70},sku:{id:1,unique:'sku70'},use_integral:'0' }) });
      await whole.db.transaction(tx => recordPurchaseOriginEvidence(tx,{ orderId:1,buyerId:11 }));
      // Cancellation predates this protocol; even an origin-backed row cannot be backfilled.
      await whole.exec("UPDATE public.store_order SET status=-2,is_del=1 WHERE id=1; INSERT INTO public.store_order_status(oid,change_type) VALUES(1,'cancel')");
      const rows=() => Promise.all(['store_order','store_order_cart_info','store_order_purchase_origin','store_order_status','user_bill'].map(table => whole.exec(`TABLE public.${table}`)));
      const objects=() => whole.exec(`SELECT 'relation' AS kind,oid::text,relfilenode::text,relowner::text,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace
        UNION ALL SELECT 'function',oid::text,NULL,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
        UNION ALL SELECT 'constraint',oid::text,NULL,NULL,NULL FROM pg_constraint WHERE connamespace='public'::regnamespace
        UNION ALL SELECT 'trigger',oid::text,NULL,NULL,NULL FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY kind,oid`);
      const read=() => readCatalog(async query => (await whole.query(query)).rows.map(row => {
        if(typeof row.key!=='string' || typeof row.name!=='string') throw Error('Invalid catalog identity');
        return { ...row,key:row.key,name:row.name };
      }));
      const before=await read(),original=await objects(),originalRows=await rows();
      expect(before.tables).toHaveLength(278);
      expect(await inspectPurchaseCancellationEvidence(whole.db)).toEqual({ state:'fresh',sourcesReady:true });
      const service=new MigrationService(createContainerFromDb(whole.db));
      expect(service.purchaseCancellationEvidenceMigrationSqlForVerification()).toBe(PURCHASE_CANCELLATION_INSTALLATION_SQL);
      const refused={executed:[],errors:['Presale outbox already registered; use standalone forward upgrades, not runAll']};
      expect(await service.runAll()).toEqual(refused);
      expect(await read()).toEqual(before); expect(await objects()).toEqual(original); expect(await rows()).toEqual(originalRows);
      const apply=() => path==='external' ? whole.db.transaction(tx => tx.execute(sql.raw(artifact))) : runPurchaseCancellationEvidenceSchema(whole.db);
      await apply(); const after=await read(),installed=await objects();
      // PG16 also registers the deferred constraint trigger in pg_constraint.
      expect(Object.fromEntries(catalogKinds.map(kind => [kind,after[kind].length]))).toEqual({ tables:279,columns:3885,constraints:668,indexes:1075,sequences:227 });
      expect(after.constraints.find(row => row.key==='store_order_purchase_cancellation.sopc_validate'))
        .toMatchObject({ type:'t',deferrable:true,deferred:true,validated:true });
      for(const kind of catalogKinds) expect(after[kind].filter(row => row.key!=='store_order_purchase_cancellation' && !row.key.startsWith('store_order_purchase_cancellation.'))).toEqual(before[kind]);
      expect(installed.filter(row => original.some(old => old.kind===row.kind && old.oid===row.oid))).toEqual(original);
      expect(await rows()).toEqual(originalRows); expect(await whole.exec('TABLE public.store_order_purchase_cancellation')).toEqual([]);
      expect(await inspectPurchaseCancellationEvidence(whole.db)).toEqual({ state:'v1',sourcesReady:true });
      await apply(); await apply();
      expect(await read()).toEqual(after); expect(await objects()).toEqual(installed); expect(await rows()).toEqual(originalRows);
      expect(await whole.exec('TABLE public.store_order_purchase_cancellation')).toEqual([]);
      expect(await service.runAll()).toEqual(refused); expect(await objects()).toEqual(installed);
    } finally { await whole.close(); }
  },120000);
  it('rejects and preserves even one existing unprotected ORM receipt', async () => {
    await orm(); await f.exec(unprotectedRow); const before=await identities(),rows=await f.exec('TABLE public.store_order_purchase_cancellation');
    await expect(completePurchaseCancellationEvidenceOrm(f.db)).rejects.toThrow();
    expect(await identities()).toEqual(before); expect(await f.exec('TABLE public.store_order_purchase_cancellation')).toEqual(rows);
    expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('orm-pending');
  });
  it.each([
    'ALTER TABLE public.store_order_purchase_cancellation ALTER COLUMN buyer_id DROP NOT NULL',
    "ALTER TABLE public.store_order_purchase_cancellation ALTER COLUMN lines SET DEFAULT '[]'::jsonb",
    'ALTER TABLE public.store_order_purchase_cancellation ADD COLUMN extra text',
    'ALTER TABLE public.store_order_purchase_cancellation ADD COLUMN extra text; ALTER TABLE public.store_order_purchase_cancellation DROP COLUMN extra',
    'ALTER TABLE public.store_order_purchase_cancellation ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.store_order_purchase_cancellation SET UNLOGGED',
    'DROP INDEX public.sopc_buyer_history',
    'ALTER INDEX public.sopc_buyer_history SET (fillfactor=80)',
    'ALTER TABLE public.store_order_purchase_cancellation DROP CONSTRAINT store_order_purchase_cancellation_lines_check',
    'CREATE FUNCTION public.begin_purchase_cancellation_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
    'CREATE TRIGGER sopc_order_transition AFTER UPDATE ON public.store_order FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_origin_v1()',
  ])('refuses a near-match ORM without repair: %s', async mutation => {
    await orm(); await f.exec(mutation); const before=await identities(),shape=await catalog();
    expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('drift');
    await expect(completePurchaseCancellationEvidenceOrm(f.db)).rejects.toThrow();
    expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
  });
  it.each(['SELECT','INSERT','INSERT(order_id)','SELECT WITH GRANT OPTION'])('rejects an ORM table exposed by an earlier %s grant', async privilege => {
    await orm(); await f.withRuntimeRole!(async peer => {
      await f.exec(`GRANT ${privilege.includes('WITH') ? 'SELECT' : privilege} ON public.store_order_purchase_cancellation TO "${peer.role}"${privilege.includes('WITH') ? ' WITH GRANT OPTION' : ''}`);
      const before=await identities(),shape=await catalog();
      expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('drift');
      await expect(completePurchaseCancellationEvidenceOrm(f.db)).rejects.toThrow();
      expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
    });
  });
  it('rolls back every new protection on unsafe function defaults, preserving the original ORM table', async () => {
    await orm(); await f.withRuntimeRole!(async peer => {
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "${peer.role}"`);
      const before=await identities(),shape=await catalog();
      try {
        await expect(completePurchaseCancellationEvidenceOrm(f.db)).rejects.toThrow();
        expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
        expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('orm-pending');
      } finally { await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM "${peer.role}"`); }
    });
  });
  it('requires the common fence and all six locks before ORM completion', async () => {
    await orm(); const before=await identities();
    for (const command of ['SELECT pg_advisory_xact_lock(731611,0)',
      'LOCK TABLE public.store_order_purchase_cancellation IN ACCESS SHARE MODE',...['store_order','store_order_cart_info','store_order_purchase_origin',
      'store_order_status','user_bill','store_order_purchase_cancellation'].map(table => `LOCK TABLE public.${table} IN ROW EXCLUSIVE MODE`)]) {
      await f.withPeer!(async peer => {
        await peer.exec(`BEGIN; ${command}`);
        try { await expect(completePurchaseCancellationEvidenceOrm(f.db)).rejects.toThrow(); }
        finally { await peer.exec('ROLLBACK'); }
      });
      expect(await identities()).toEqual(before); expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('orm-pending');
    }
  });
  it.each(['COMMIT','ROLLBACK'])('rechecks ORM emptiness after an independent insert %s', async outcome => {
    await orm(); const before=await identities();
    await f.withPeer!(async peer => {
      const [owner]=await f.db.execute(sql`SELECT pg_backend_pid() AS pid`); expect(peer.pid).not.toBe(owner.pid);
      await peer.exec(`BEGIN; ${unprotectedRow}`);
      try { await expect(completePurchaseCancellationEvidenceOrm(f.db)).rejects.toThrow(); }
      finally { await peer.exec(outcome); }
    });
    if (outcome==='COMMIT') {
      const rows=await f.exec('TABLE public.store_order_purchase_cancellation'); expect(rows).toHaveLength(1);
      await expect(completePurchaseCancellationEvidenceOrm(f.db)).rejects.toThrow();
      expect(await identities()).toEqual(before); expect(await f.exec('TABLE public.store_order_purchase_cancellation')).toEqual(rows);
    } else {
      await completePurchaseCancellationEvidenceOrm(f.db); expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('v1');
      expect(await f.exec('TABLE public.store_order_purchase_cancellation')).toEqual([]);
    }
  });
  it('requires root and atomically rolls back late ORM completion including source trigger', async () => {
    await orm(); const before=await identities(),shape=await catalog();
    await f.db.transaction(async tx => { await expect(completePurchaseCancellationEvidenceOrm(tx)).rejects.toThrow('root database'); });
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql.raw(PURCHASE_CANCELLATION_ORM_INSTALLATION_SQL)); throw Error('synthetic late failure');
    })).rejects.toThrow('synthetic late failure');
    expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
  });
  it.each(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ','SET TRANSACTION READ ONLY',"SET LOCAL session_replication_role='replica'"])
    ('rejects unsafe ORM completion transaction: %s', async command => {
      await orm(); const before=await identities();
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(command)); await tx.execute(sql.raw(PURCHASE_CANCELLATION_ORM_INSTALLATION_SQL)); })).rejects.toThrow();
      expect(await identities()).toEqual(before); expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('orm-pending');
    });
  it('installs and repeats without changing previous objects, grants or populated evidence', async () => {
    expect(await inspectPurchaseCancellationEvidence(f.db)).toEqual({ state:'fresh',sourcesReady:true });
    const before = await identities(); await runPurchaseCancellationEvidenceSchema(f.db);
    expect((await identities()).filter(row => before.some(old => old.kind===row.kind && old.oid===row.oid))).toEqual(before);
    await seed(); await f.exec(`BEGIN; UPDATE public.store_order SET status=-2,is_del=1 WHERE id=1;
      INSERT INTO public.store_order_status(oid,change_type) VALUES(1,'cancel'); COMMIT`);
    const after = await identities(), rows = await f.exec('TABLE public.store_order_purchase_cancellation');
    expect(rows).toHaveLength(1); await runPurchaseCancellationEvidenceSchema(f.db); await runPurchaseCancellationEvidenceSchema(f.db);
    expect(await identities()).toEqual(after); expect(await f.exec('TABLE public.store_order_purchase_cancellation')).toEqual(rows);
    expect(await inspectPurchaseCancellationEvidence(f.db)).toEqual({ state:'v1',sourcesReady:true });
  });
  it.each([
    'ALTER TABLE public.store_order_purchase_cancellation ALTER COLUMN buyer_id DROP NOT NULL',
    "ALTER TABLE public.store_order_purchase_cancellation ALTER COLUMN lines SET DEFAULT '[]'::jsonb",
    'ALTER TABLE public.store_order_purchase_cancellation ADD COLUMN extra text',
    'ALTER TABLE public.store_order_purchase_cancellation ADD COLUMN extra text; ALTER TABLE public.store_order_purchase_cancellation DROP COLUMN extra',
    'ALTER TABLE public.store_order_purchase_cancellation ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.store_order_purchase_cancellation SET UNLOGGED',
    'ALTER TABLE public.store_order_purchase_cancellation DISABLE TRIGGER sopc_validate',
    'ALTER TABLE public.store_order_purchase_cancellation ENABLE REPLICA TRIGGER sopc_capture',
    'ALTER TABLE public.store_order DISABLE TRIGGER sopc_order_transition',
    'ALTER TABLE public.store_order ENABLE ALWAYS TRIGGER sopc_order_transition',
    'DROP TRIGGER sopc_order_transition ON public.store_order',
    'DROP TRIGGER sopc_validate ON public.store_order_purchase_cancellation; CREATE CONSTRAINT TRIGGER sopc_validate AFTER INSERT ON public.store_order_purchase_cancellation NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION public.validate_purchase_cancellation_v1()',
    'DROP INDEX public.sopc_buyer_history',
    'ALTER INDEX public.sopc_buyer_history SET (fillfactor=80)',
    'ALTER TABLE public.store_order_purchase_cancellation CLUSTER ON sopc_buyer_history',
    'ALTER FUNCTION public.begin_purchase_cancellation_v1() SECURITY DEFINER',
    'ALTER FUNCTION public.validate_purchase_cancellation_v1() RESET search_path',
    'CREATE OR REPLACE FUNCTION public.protect_purchase_cancellation_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RETURN NEW; END $$',
    'CREATE FUNCTION public.protect_purchase_cancellation_v1(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    'CREATE TRIGGER extra_attachment BEFORE UPDATE ON public.store_order FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_cancellation_v1()',
    'GRANT SELECT ON public.store_order_purchase_cancellation TO PUBLIC',
    'GRANT INSERT(order_id) ON public.store_order_purchase_cancellation TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION public.capture_purchase_cancellation_v1() TO PUBLIC',
    'CREATE RULE unexpected AS ON DELETE TO public.store_order_purchase_cancellation DO INSTEAD NOTHING',
    'ALTER TABLE public.store_order_purchase_cancellation DROP CONSTRAINT store_order_purchase_cancellation_lines_check',
  ])('refuses component drift without repairs: %s', async mutation => {
    await runPurchaseCancellationEvidenceSchema(f.db); await f.exec(mutation);
    const before = await identities(), shape = await catalog();
    expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('drift');
    await expect(runPurchaseCancellationEvidenceSchema(f.db)).rejects.toThrow();
    expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
  });
  it.each([
    'CREATE TABLE public.store_order_purchase_cancellation(order_id integer)',
    'CREATE TABLE public.sopc_buyer_history(id integer)',
    'CREATE TABLE public.store_order_purchase_cancellation_pkey(id integer)',
    'CREATE FUNCTION public.begin_purchase_cancellation_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
    'CREATE TRIGGER sopc_order_transition AFTER UPDATE ON public.store_order FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_origin_v1()',
  ])('refuses partial objects and collisions: %s', async mutation => {
    await f.exec(mutation); const before = await identities();
    expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('drift');
    await expect(runPurchaseCancellationEvidenceSchema(f.db)).rejects.toThrow(); expect(await identities()).toEqual(before);
  });
  it.each([
    'ALTER TABLE public.store_order ALTER COLUMN total_num DROP NOT NULL',
    'ALTER TABLE public.store_order_cart_info ALTER COLUMN cart_num TYPE bigint',
    'ALTER TABLE public.store_order_purchase_origin DISABLE TRIGGER sopo_no_rewrite',
    'ALTER TABLE public.store_order_status ALTER COLUMN change_type TYPE text',
    'ALTER TABLE public.user_bill ALTER COLUMN number DROP NOT NULL',
    'ALTER TABLE public.user_bill ENABLE ROW LEVEL SECURITY',
    'DROP INDEX public.ub_cat_type_link_idx',
    'DROP INDEX public.sos_oid_idx; DROP INDEX public.sos_oid_change_time',
    'DROP INDEX public.ub_cat_type_link_idx; CREATE INDEX alternate_partial ON public.user_bill(category,type,link_id) WHERE uid=11',
  ])('refuses origin or required source/index drift: %s', async mutation => {
    await f.exec(mutation); const before = await identities();
    expect(await inspectPurchaseCancellationEvidence(f.db)).toEqual({ state:'fresh',sourcesReady:false });
    await expect(runPurchaseCancellationEvidenceSchema(f.db)).rejects.toThrow(); expect(await identities()).toEqual(before);
  });
  it('commissions an independent LOGIN without granting source writes or private-function execution', async () => {
    await f.withRuntimeRole!(async peer => {
      await sources(peer.role); const before = await peer.exec(`SELECT has_column_privilege(current_user,'public.store_order','status','UPDATE') AS update_status,
        has_table_privilege(current_user,'public.store_order_status','INSERT') AS insert_log`);
      expect(before).toEqual([{ update_status:false,insert_log:false }]);
      expect(await runPurchaseCancellationEvidence(f.db,peer.role)).toEqual({ state:'v1',sourcesReady:true,runtimeSafe:true,runtimeReady:true });
      expect(await peer.exec(`SELECT has_column_privilege(current_user,'public.store_order','status','UPDATE') AS update_status,
        has_table_privilege(current_user,'public.store_order_status','INSERT') AS insert_log`)).toEqual(before);
      await seed();
      // Separately reviewed synthetic business authority, never granted by installer.
      await f.exec(`GRANT UPDATE(status,is_del) ON public.store_order TO "${peer.role}";
        GRANT INSERT ON public.store_order_status TO "${peer.role}"`);
      await peer.exec(`BEGIN; UPDATE public.store_order SET status=-2,is_del=1 WHERE id=1;
        INSERT INTO public.store_order_status(id,oid,change_type) VALUES(1,1,'cancel'); COMMIT`);
      expect(await peer.exec('SELECT order_id,total_num,restored_points FROM public.store_order_purchase_cancellation'))
        .toEqual([{ order_id:1,total_num:1,restored_points:'0' }]);
      for (const command of ['UPDATE public.store_order_purchase_cancellation SET total_num=2','DELETE FROM public.store_order_purchase_cancellation',
        'TRUNCATE public.store_order_purchase_cancellation','ALTER TABLE public.store_order DISABLE TRIGGER sopc_order_transition',
        'DROP TABLE public.store_order_purchase_cancellation','SELECT public.capture_purchase_cancellation_v1()',
        "SET session_replication_role='replica'",'SET ROLE finance_test'])
        await expect(peer.exec(command)).rejects.toMatchObject({ code:'42501' });
      await expect(runPurchaseCancellationEvidence(peer.db,peer.role)).rejects.toThrow();
      await peer.exec('RESET ROLE'); expect(await peer.exec('SELECT current_user=session_user AS same')).toEqual([{ same:true }]);
      const objects = await identities(); await runPurchaseCancellationEvidence(f.db,peer.role); expect(await identities()).toEqual(objects);
    });
  });
  it('rejects missing privileges, unknown/non-LOGIN targets and invalid names before granting anything', async () => {
    const before = await identities();
    for (const role of ['missing_local_role','bad"; DROP TABLE user_bill; --','pg_read_all_data'])
      await expect(runPurchaseCancellationEvidence(f.db,role)).rejects.toThrow();
    expect(await identities()).toEqual(before);
    await f.withRuntimeRole!(async peer => {
      const withoutSources = await identities();
      await expect(runPurchaseCancellationEvidence(f.db,peer.role)).rejects.toThrow();
      expect(await identities()).toEqual(withoutSources);
      await sources(peer.role); await f.exec(`REVOKE SELECT ON public.user_bill FROM "${peer.role}"`);
      // This explicit fixture GRANT/REVOKE changes NULL ACL to the owner ACL.
      // Compare across the installer, not across our own privilege preparation.
      const missingBillRead = await identities();
      await expect(runPurchaseCancellationEvidence(f.db,peer.role)).rejects.toThrow();
      expect(await identities()).toEqual(missingBillRead);
      expect(await inspectPurchaseCancellationEvidence(f.db,peer.role)).toMatchObject({ runtimeReady:false });
    });
    expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('fresh');
  });
  it.each(['CREATE','REPLICATION','TRIGGER','OWNER'] as const)('rejects dangerous reachable role authority: %s', async danger => {
    await f.withRuntimeRole!(async peer => f.withRuntimeRole!(async parent => {
      await sources(peer.role);
      if (danger==='CREATE') await f.exec(`GRANT CREATE ON SCHEMA public TO "${parent.role}"`);
      if (danger==='REPLICATION') await f.exec(`GRANT SET ON PARAMETER session_replication_role TO "${parent.role}"`);
      if (danger==='TRIGGER') await f.exec(`GRANT TRIGGER ON public.store_order TO "${parent.role}"`);
      if (danger==='OWNER') await f.exec(`ALTER TABLE public.store_order_status OWNER TO "${parent.role}"`);
      await f.exec(`GRANT "${parent.role}" TO "${peer.role}" WITH INHERIT FALSE,SET TRUE`);
      try {
        expect(await inspectPurchaseCancellationEvidence(f.db,peer.role)).toMatchObject({ runtimeSafe:false,runtimeReady:false });
        await expect(runPurchaseCancellationEvidence(f.db,peer.role)).rejects.toThrow();
      } finally {
        await f.exec(`REVOKE "${parent.role}" FROM "${peer.role}"`);
        if (danger==='REPLICATION') await f.exec(`REVOKE SET ON PARAMETER session_replication_role FROM "${parent.role}"`);
        if (danger==='OWNER') await f.exec('ALTER TABLE public.store_order_status OWNER TO finance_test');
      }
    }));
    expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('fresh');
  });
  it.each(['UPDATE','INSERT(order_id)','SELECT WITH GRANT OPTION'])('refuses unsafe existing receipt grant %s', async privilege => {
    await f.withRuntimeRole!(async peer => {
      await sources(peer.role); await runPurchaseCancellationEvidence(f.db,peer.role);
      await f.exec(`GRANT ${privilege.includes('WITH') ? 'SELECT' : privilege} ON public.store_order_purchase_cancellation TO "${peer.role}"${privilege.includes('WITH') ? ' WITH GRANT OPTION' : ''}`);
      const before = await identities(), shape = await catalog();
      await expect(runPurchaseCancellationEvidence(f.db,peer.role)).rejects.toThrow();
      expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
    });
  });
  it.each(['TABLES SELECT','TABLES UPDATE','FUNCTIONS EXECUTE'])('rolls back unsafe default %s privileges', async profile => {
    const [kind,privilege] = profile.split(' ');
    await f.withRuntimeRole!(async peer => {
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${privilege} ON ${kind} TO "${peer.role}"`);
      const before = await identities();
      try { await expect(runPurchaseCancellationEvidenceSchema(f.db)).rejects.toThrow(); expect(await identities()).toEqual(before); }
      finally { await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ${privilege} ON ${kind} FROM "${peer.role}"`); }
    });
  });
  it('takes the common fence and every source/evidence lock before any installation', async () => {
    await runPurchaseCancellationEvidenceSchema(f.db); const before = await identities();
    for (const command of ['SELECT pg_advisory_xact_lock(731611,0)',...['store_order','store_order_cart_info','store_order_purchase_origin',
      'store_order_status','user_bill','store_order_purchase_cancellation'].map(table => `LOCK TABLE public.${table} IN ROW EXCLUSIVE MODE`)]) {
      await f.withPeer!(async peer => {
        await peer.exec(`BEGIN; ${command}`);
        try { await expect(runPurchaseCancellationEvidenceSchema(f.db)).rejects.toThrow(); }
        finally { await peer.exec('ROLLBACK'); }
      });
      expect(await identities()).toEqual(before); expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('v1');
    }
  });
  it.each(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ','SET TRANSACTION READ ONLY',"SET LOCAL session_replication_role='replica'"])
    ('rejects incompatible transaction context: %s', async command => {
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(command)); await tx.execute(sql.raw(PURCHASE_CANCELLATION_INSTALLATION_SQL)); })).rejects.toThrow();
      expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('fresh');
    });
  it('requires a root transaction, preserves stricter settings, and rolls back late installation failure', async () => {
    await f.db.transaction(async tx => { await expect(runPurchaseCancellationEvidenceSchema(tx)).rejects.toThrow('root database'); });
    const before = await identities();
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql.raw(PURCHASE_CANCELLATION_INSTALLATION_SQL)); throw Error('synthetic late failure');
    })).rejects.toThrow('synthetic late failure');
    expect(await identities()).toEqual(before);
    await f.exec('SET statement_timeout=5000; SET lock_timeout=100; SET idle_in_transaction_session_timeout=500; SET search_path=public,pg_temp');
    const settings = () => f.exec("SELECT name,setting FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout','search_path','row_security','default_tablespace') ORDER BY name");
    await f.exec('CREATE TEMP TABLE store_order_purchase_cancellation(marker integer); INSERT INTO pg_temp.store_order_purchase_cancellation VALUES(23)');
    const original = await settings(); await runPurchaseCancellationEvidenceSchema(f.db); expect(await settings()).toEqual(original);
    expect(await f.exec('TABLE pg_temp.store_order_purchase_cancellation')).toEqual([{ marker:23 }]);
  });
  it('refuses enabled event triggers before DDL', async () => {
    await f.exec('CREATE FUNCTION public.local_ddl_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$; CREATE EVENT TRIGGER local_ddl_hook ON ddl_command_start EXECUTE FUNCTION public.local_ddl_hook()');
    try { await expect(runPurchaseCancellationEvidenceSchema(f.db)).rejects.toThrow(); }
    finally { await f.exec('DROP EVENT TRIGGER local_ddl_hook'); }
    expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('fresh');
  });
  it('requires exact CLI target/confirmation, discloses no credentials, and refuses drift', async () => {
    const [identity] = await f.db.execute(sql`SELECT current_database() AS database`);
    if (typeof identity.database!=='string' || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database)) throw Error('Not owned fixture');
    const database=identity.database,target=new URL(process.env.TEST_FINANCE_POSTGRES_URL!); target.pathname=`/${database}`;
    await f.withRuntimeRole!(async peer => {
      await sources(peer.role);
      const run = (args:string[],url=target.href) => spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/purchase-cancellation-maintenance.ts',...args],
        { encoding:'utf8',windowsHide:true,timeout:45000,env:{ ...process.env,PURCHASE_CANCELLATION_MAINTENANCE_DATABASE_URL:url } });
      const inspected=run(['inspect',database,peer.role]),missing=run(['install',database,peer.role]);
      expect(inspected.status).toBe(2); expect(JSON.parse(inspected.stdout)).toMatchObject({ state:'fresh',runtimeReady:false });
      expect(missing.status).toBe(1); expect((await inspectPurchaseCancellationEvidence(f.db)).state).toBe('fresh');
      await orm(); const before=await identities();
      const pending=run(['inspect',database,peer.role]),noImplicitCompletion=run(['install',database,peer.role,'--confirm-install']);
      expect(pending.status).toBe(2); expect(JSON.parse(pending.stdout)).toMatchObject({ state:'orm-pending',runtimeReady:false });
      expect(noImplicitCompletion.status).toBe(1); expect(await identities()).toEqual(before);
      await completePurchaseCancellationEvidenceOrm(f.db);
      const installed=run(['install',database,peer.role,'--confirm-install']); expect(installed.status).toBe(0);
      expect(JSON.parse(installed.stdout)).toMatchObject({ state:'v1',runtimeReady:true });
      const wrong=run(['inspect','wrong',peer.role]),absent=run(['inspect',database,peer.role],''),injection=run(['install',database,'bad"; SELECT 1; --','--confirm-install']);
      const query=run(['inspect',database,peer.role],target.href+'?sslmode=disable');
      for (const result of [wrong,absent,injection,query]) expect(result.status).toBe(1);
      await f.exec('ALTER TABLE public.store_order DISABLE TRIGGER sopc_order_transition');
      const drift=run(['install',database,peer.role,'--confirm-install']); expect(drift.status).toBe(1); expect(drift.stdout).toBe('');
      for (const result of [inspected,missing,pending,noImplicitCompletion,installed,wrong,absent,injection,query,drift]) {
        expect(result.error).toBeUndefined(); expect(result.stdout+result.stderr).not.toContain(target.href);
        expect(result.stdout+result.stderr).not.toContain(target.password);
      }
    });
  },90000);
});
