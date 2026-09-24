import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { createContainerFromDb } from '@/lib/di';
import { MigrationService } from '@/services/MigrationService';
import { catalogKinds, readCatalog } from '../scripts/data-migration/postgres-catalog-audit';
import { storeOrder, storeOrderCartInfo } from '@/models/schema/order';
import { storeOrderPurchaseOrigin } from '@/models/schema/purchase_origin_evidence';
import { PURCHASE_ORIGIN_DEFINITION_SQL } from '@/migrations/purchaseOriginEvidence';
import { PURCHASE_ORIGIN_CATALOG_SQL, PURCHASE_ORIGIN_FINGERPRINTS, PURCHASE_ORIGIN_ORM_FINGERPRINT } from '@/migrations/purchaseOriginEvidenceCatalog';
import { PURCHASE_ORIGIN_SOURCE_SQL, PURCHASE_ORIGIN_INSTALLATION_SQL, PURCHASE_ORIGIN_ORM_INSTALLATION_SQL } from '@/migrations/purchaseOriginEvidenceInstallation';
import { inspectPurchaseOriginEvidence, runPurchaseOriginEvidenceSchema, runPurchaseOriginEvidence, completePurchaseOriginEvidenceOrm } from '@/migrations/runPurchaseOriginEvidence';
import { recordPurchaseOriginEvidence } from '@/services/order/PurchaseOriginEvidence';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('purchase origin controlled PG16 installation', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson({ storeOrder, storeOrderCartInfo }))).join('\n'));
  }, 30000);
  afterEach(async () => { await f?.close(); }, 45000);
  const catalog = () => f.db.execute(sql.raw(PURCHASE_ORIGIN_CATALOG_SQL));
  const identities = () => f.db.execute(sql`SELECT 'relation' AS kind,oid::text,relfilenode::text FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,NULL FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY kind,oid`);
  const sources = (role: string) => f.exec(`GRANT SELECT,UPDATE(id) ON public.store_order,public.store_order_cart_info TO "${role}"`);
  const orm = async () => {
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson({ storeOrderPurchaseOrigin }))).join('\n'));
  };
  const unprotectedRow = `INSERT INTO public.store_order_purchase_origin
    (order_id,buyer_id,version,order_type,total_num,used_points,lines,recorded_at)
    VALUES(987,11,'purchase-origin-v1',0,1,0,'[{}]',CURRENT_TIMESTAMP)`;
  const seed = async () => {
    await f.db.insert(storeOrder).values({ id:1,uid:11,orderId:'LOCAL-ORIGIN',totalNum:1,cartId:'1' });
    await f.db.insert(storeOrderCartInfo).values({ id:1,oid:1,uid:11,cartId:'1',productId:70,skuUnique:'sku70',cartNum:1,surplusNum:1,splitSurplusNum:1,
      cartInfo: JSON.stringify({ financial_version:'checkout-line-finance-v1',id:'1',cart_num:1,product:{id:70},sku:{id:1,unique:'sku70'},use_integral:'0' }) });
  };
  it('probes canonical native definitions and pending-source parity', async () => {
    expect(readFileSync('src/migrations/pending/purchase_origin_evidence.sql', 'utf8').replace(/\r\n/g,'\n').trim())
      .toBe(PURCHASE_ORIGIN_DEFINITION_SQL.trim());
    await f.db.transaction(tx => tx.execute(sql.raw(PURCHASE_ORIGIN_DEFINITION_SQL)));
    const rows = await f.db.execute(sql.raw(PURCHASE_ORIGIN_CATALOG_SQL));
    expect(rows).toHaveLength(3); expect(rows.every(row => row.owned && row.safe)).toBe(true);
    expect(Object.fromEntries(rows.map(row => [String(row.name),row.fingerprint]))).toEqual(PURCHASE_ORIGIN_FINGERPRINTS);
    expect(await f.db.execute(sql.raw(PURCHASE_ORIGIN_SOURCE_SQL))).toMatchObject([{ ready: true }]);
  });
  it('matches the native generated ORM catalog exactly before protection', async () => {
    await orm(); const rows = await catalog();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ name:'store_order_purchase_origin',owned:true,safe:true });
    expect(rows[0].fingerprint).toBe(PURCHASE_ORIGIN_ORM_FINGERPRINT);
    expect(await inspectPurchaseOriginEvidence(f.db)).toEqual({ state:'orm-pending',sourcesReady:true });
  });
  it('constructs the entire registered ORM and preserves every existing relation during completion', async () => {
    const whole=await sequenceRunnerDatabase();
    try {
      const api=await import('drizzle-kit/api'), registered=await import('@/models/schema');
      const proposed=api.generateDrizzleJson(registered);
      expect(registered.storeOrderPurchaseOrigin).toBe(storeOrderPurchaseOrigin);
      expect(Object.keys(proposed.tables)).toHaveLength(279);
      await whole.exec((await api.generateMigration(api.generateDrizzleJson({}),proposed)).join('\n'));
      const objects=() => whole.exec("SELECT oid::text,relfilenode::text,relname FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid");
      const before=await objects();
      expect(await inspectPurchaseOriginEvidence(whole.db)).toEqual({ state:'orm-pending',sourcesReady:true });
      await completePurchaseOriginEvidenceOrm(whole.db);
      expect(await objects()).toEqual(before);
      const completed=await whole.db.execute(sql.raw(PURCHASE_ORIGIN_CATALOG_SQL));
      expect(Object.fromEntries(completed.map(row => [String(row.name),row.fingerprint]))).toEqual(PURCHASE_ORIGIN_FINGERPRINTS);
      expect(await whole.exec("SELECT count(*)::integer AS n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'")).toEqual([{ n:279 }]);
      expect(await whole.exec('TABLE public.store_order_purchase_origin')).toEqual([]);
      await runPurchaseOriginEvidenceSchema(whole.db); expect(await objects()).toEqual(before);
    } finally { await whole.close(); }
  }, 60000);
  it('completes exact empty ORM in place, without backfill or automatic grants, then commissions explicitly', async () => {
    await orm(); await seed(); const before = await identities();
    await f.withRuntimeRole!(async peer => {
      await sources(peer.role); await completePurchaseOriginEvidenceOrm(f.db);
      expect((await identities()).filter(row => before.some(old => old.kind===row.kind && old.oid===row.oid))).toEqual(before);
      expect(Object.fromEntries((await catalog()).map(row => [String(row.name),row.fingerprint]))).toEqual(PURCHASE_ORIGIN_FINGERPRINTS);
      expect(await f.exec('TABLE public.store_order_purchase_origin')).toEqual([]);
      expect(await inspectPurchaseOriginEvidence(f.db,peer.role)).toEqual({ state:'v1',sourcesReady:true,runtimeSafe:true,runtimeReady:false });
      await expect(peer.exec('TABLE public.store_order_purchase_origin')).rejects.toMatchObject({ code:'42501' });
      await runPurchaseOriginEvidence(f.db,peer.role);
      await peer.db.transaction(tx => recordPurchaseOriginEvidence(tx,{ orderId:1,buyerId:11 }));
      const rows=await f.exec('TABLE public.store_order_purchase_origin'), protectedIds=await identities();
      await completePurchaseOriginEvidenceOrm(f.db); await runPurchaseOriginEvidenceSchema(f.db);
      expect(await identities()).toEqual(protectedIds); expect(await f.exec('TABLE public.store_order_purchase_origin')).toEqual(rows);
      for (const command of ['UPDATE public.store_order_purchase_origin SET total_num=2','DELETE FROM public.store_order_purchase_origin','TRUNCATE public.store_order_purchase_origin'])
        await expect(f.exec(command)).rejects.toMatchObject({ code:'42501' });
    });
  });
  it.each(['external','runner'] as const)('upgrades the previous full catalog through %s without bootstrap replay or historical backfill', async path => {
    const whole=await checkoutPricingMigrationDatabase();
    try {
      // Pin the origin protocol's historical upgrade boundary, not the latest tail.
      const files=readdirSync('migrations').filter(name => /^\d+.*\.sql$/.test(name) && name<='0163_purchase_origin_evidence.sql').sort();
      expect(files.at(-1)).toBe('0163_purchase_origin_evidence.sql');
      expect(files.at(-2)).toBe('0162_supplier_refund_lookup_indexes.sql');
      const artifact=readFileSync(`migrations/${files.at(-1)}`,'utf8');
      expect(artifact.trim()).toBe(PURCHASE_ORIGIN_INSTALLATION_SQL.trim());
      for (const file of files.slice(0,-1)) await whole.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
        await tx.execute(sql.raw(readFileSync(`migrations/${file}`,'utf8')));
      });
      await whole.db.insert(storeOrder).values({ id:1,uid:11,orderId:'LOCAL-UPGRADE',totalNum:1,cartId:'1' });
      await whole.db.insert(storeOrderCartInfo).values({ id:1,oid:1,uid:11,cartId:'1',productId:70,skuUnique:'sku70',cartNum:1,surplusNum:1,splitSurplusNum:1,
        cartInfo:JSON.stringify({ financial_version:'checkout-line-finance-v1',id:'1',cart_num:1,product:{id:70},sku:{id:1,unique:'sku70'},use_integral:'0' }) });
      const rows=() => Promise.all(['store_order','store_order_cart_info'].map(table => whole.exec(`TABLE public.${table}`)));
      const objects=() => whole.exec(`SELECT 'relation' AS kind,oid::text,relfilenode::text,relowner::text,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace
        UNION ALL SELECT 'function',oid::text,NULL,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
        UNION ALL SELECT 'constraint',oid::text,NULL,NULL,NULL FROM pg_constraint WHERE connamespace='public'::regnamespace
        UNION ALL SELECT 'trigger',oid::text,NULL,NULL,NULL FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY kind,oid`);
      const catalog=() => readCatalog(async query => (await whole.query(query)).rows.map(row => {
        if(typeof row.key!=='string' || typeof row.name!=='string') throw Error('Invalid catalog identity');
        return { ...row,key:row.key,name:row.name };
      }));
      const before=await catalog(), original=await objects(), originalRows=await rows();
      expect(before.tables).toHaveLength(277);
      expect(await inspectPurchaseOriginEvidence(whole.db)).toEqual({ state:'fresh',sourcesReady:true });
      const service=new MigrationService(createContainerFromDb(whole.db));
      expect(service.purchaseOriginEvidenceMigrationSqlForVerification()).toBe(PURCHASE_ORIGIN_INSTALLATION_SQL);
      const refused={executed:[],errors:['Presale outbox already registered; use standalone forward upgrades, not runAll']};
      expect(await service.runAll()).toEqual(refused);
      expect(await catalog()).toEqual(before); expect(await objects()).toEqual(original); expect(await rows()).toEqual(originalRows);
      const apply=() => path==='external' ? whole.db.transaction(tx => tx.execute(sql.raw(artifact))) : runPurchaseOriginEvidenceSchema(whole.db);
      await apply(); const after=await catalog(), installed=await objects();
      expect(Object.fromEntries(catalogKinds.map(kind => [kind,after[kind].length]))).toEqual({ tables:278,columns:3876,constraints:659,indexes:1073,sequences:227 });
      for(const kind of catalogKinds) expect(after[kind].filter(row => row.key!=='store_order_purchase_origin' && !row.key.startsWith('store_order_purchase_origin.'))).toEqual(before[kind]);
      expect(installed.filter(row => original.some(old => old.kind===row.kind && old.oid===row.oid))).toEqual(original);
      expect(await rows()).toEqual(originalRows); expect(await whole.exec('TABLE public.store_order_purchase_origin')).toEqual([]);
      expect(await inspectPurchaseOriginEvidence(whole.db)).toEqual({ state:'v1',sourcesReady:true });
      await apply(); await apply();
      expect(await catalog()).toEqual(after); expect(await objects()).toEqual(installed); expect(await rows()).toEqual(originalRows);
      expect(await whole.exec('TABLE public.store_order_purchase_origin')).toEqual([]);
      expect(await service.runAll()).toEqual(refused);
      expect(await objects()).toEqual(installed); expect(await rows()).toEqual(originalRows);
    } finally { await whole.close(); }
  },120000);
  it('never completes unprotected ORM through ordinary schema or runtime commissioning', async () => {
    await orm(); const before=await identities(), shape=await catalog();
    await expect(runPurchaseOriginEvidenceSchema(f.db)).rejects.toThrow();
    await f.withRuntimeRole!(async peer => {
      await sources(peer.role); await expect(runPurchaseOriginEvidence(f.db,peer.role)).rejects.toThrow();
      expect(await inspectPurchaseOriginEvidence(f.db,peer.role)).toMatchObject({ state:'orm-pending',runtimeReady:false });
    });
    expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
  });
  it('refuses existing unprotected rows without deleting or attesting them', async () => {
    await orm(); await f.exec(unprotectedRow);
    const rows=await f.exec('TABLE public.store_order_purchase_origin'), before=await identities();
    // A catalog-only pending state is deliberately not an emptiness certificate.
    expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('orm-pending');
    await expect(completePurchaseOriginEvidenceOrm(f.db)).rejects.toThrow();
    expect(await identities()).toEqual(before); expect(await f.exec('TABLE public.store_order_purchase_origin')).toEqual(rows);
  });
  it.each([
    'ALTER TABLE public.store_order_purchase_origin ALTER COLUMN buyer_id DROP NOT NULL',
    'ALTER TABLE public.store_order_purchase_origin ALTER COLUMN lines SET DEFAULT \'[]\'::jsonb',
    'ALTER TABLE public.store_order_purchase_origin ADD COLUMN extra text',
    'ALTER TABLE public.store_order_purchase_origin ADD COLUMN extra text; ALTER TABLE public.store_order_purchase_origin DROP COLUMN extra',
    'ALTER TABLE public.store_order_purchase_origin ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.store_order_purchase_origin SET UNLOGGED',
    'DROP INDEX public.sopo_buyer_history',
    'ALTER TABLE public.store_order_purchase_origin DROP CONSTRAINT store_order_purchase_origin_lines_check',
    'CREATE FUNCTION public.capture_purchase_origin_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
    'CREATE RULE unexpected AS ON DELETE TO public.store_order_purchase_origin DO INSTEAD NOTHING',
  ])('refuses ORM drift rather than completing a near match: %s', async mutation => {
    await orm(); await f.exec(mutation); const before=await identities(), shape=await catalog();
    expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('drift');
    await expect(completePurchaseOriginEvidenceOrm(f.db)).rejects.toThrow();
    expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
  });
  it.each(['SELECT','INSERT','INSERT(order_id)','SELECT WITH GRANT OPTION'])('refuses ORM exposed by an earlier %s grant', async privilege => {
    await orm(); await f.withRuntimeRole!(async peer => {
      await f.exec(privilege.includes('WITH') ? `GRANT SELECT ON public.store_order_purchase_origin TO "${peer.role}" WITH GRANT OPTION`
        : `GRANT ${privilege} ON public.store_order_purchase_origin TO "${peer.role}"`);
      const before=await identities(), shape=await catalog();
      expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('drift');
      await expect(completePurchaseOriginEvidenceOrm(f.db)).rejects.toThrow();
      expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
    });
  });
  it('rolls back only new protection objects on unsafe default function privileges', async () => {
    await orm(); const before=await identities(), shape=await catalog();
    await f.withRuntimeRole!(async peer => {
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "${peer.role}"`);
      try { await expect(completePurchaseOriginEvidenceOrm(f.db)).rejects.toThrow(); }
      finally { await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM "${peer.role}"`); }
      expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
      await completePurchaseOriginEvidenceOrm(f.db);
      expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('v1');
    });
  });
  it('requires the common fence and every table lock for ORM completion', async () => {
    await orm(); const before=await identities();
    for (const command of ['SELECT pg_advisory_xact_lock(731611,0)',...['store_order','store_order_cart_info','store_order_purchase_origin']
      .map(table => `LOCK TABLE public.${table} IN ROW EXCLUSIVE MODE`)]) {
      await f.withPeer!(async peer => {
        await peer.exec(`BEGIN; ${command}`);
        try { await expect(completePurchaseOriginEvidenceOrm(f.db)).rejects.toThrow(); }
        finally { await peer.exec('ROLLBACK'); }
      });
      expect(await identities()).toEqual(before); expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('orm-pending');
    }
  });
  it.each(['COMMIT','ROLLBACK'])('checks emptiness under the lock after a concurrent insert ends with %s', async finish => {
    await orm(); const before=await identities();
    await f.withPeer!(async peer => {
      await peer.exec(`BEGIN; ${unprotectedRow}`);
      try { await expect(completePurchaseOriginEvidenceOrm(f.db)).rejects.toThrow(); }
      finally { await peer.exec(finish); }
    });
    expect(await identities()).toEqual(before);
    if (finish==='COMMIT') {
      await expect(completePurchaseOriginEvidenceOrm(f.db)).rejects.toThrow();
      expect(await f.exec('SELECT order_id FROM public.store_order_purchase_origin')).toEqual([{ order_id:987 }]);
      expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('orm-pending');
    } else {
      await completePurchaseOriginEvidenceOrm(f.db); expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('v1');
    }
  });
  it('requires a root transaction and atomically rolls back late ORM completion failure', async () => {
    await orm(); const before=await identities(), shape=await catalog();
    await f.db.transaction(async tx => { await expect(completePurchaseOriginEvidenceOrm(tx)).rejects.toThrow('root database'); });
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql.raw(PURCHASE_ORIGIN_ORM_INSTALLATION_SQL)); throw Error('synthetic late failure');
    })).rejects.toThrow('synthetic late failure');
    expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
    await completePurchaseOriginEvidenceOrm(f.db); expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('v1');
  });
  it.each(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ','SET TRANSACTION READ ONLY',"SET LOCAL session_replication_role='replica'"])
    ('rejects unsafe ORM completion transaction: %s', async command => {
      await orm(); const before=await identities();
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(command)); await tx.execute(sql.raw(PURCHASE_ORIGIN_ORM_INSTALLATION_SQL)); })).rejects.toThrow();
      expect(await identities()).toEqual(before); expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('orm-pending');
    });
  it('installs and repeats without rewriting objects, grants, or populated evidence', async () => {
    expect(await inspectPurchaseOriginEvidence(f.db)).toEqual({ state:'fresh',sourcesReady:true });
    const before = await identities(); await runPurchaseOriginEvidenceSchema(f.db);
    expect((await identities()).filter(row => before.some(old => old.kind === row.kind && old.oid === row.oid))).toEqual(before);
    await seed(); await f.db.transaction(tx => recordPurchaseOriginEvidence(tx,{ orderId:1,buyerId:11 }));
    const after = await identities(), rows = await f.exec('TABLE public.store_order_purchase_origin');
    await runPurchaseOriginEvidenceSchema(f.db); await runPurchaseOriginEvidenceSchema(f.db);
    expect(await identities()).toEqual(after); expect(await f.exec('TABLE public.store_order_purchase_origin')).toEqual(rows);
    expect(await inspectPurchaseOriginEvidence(f.db)).toEqual({ state:'v1',sourcesReady:true });
  });
  it('rejects a NULL root cart list instead of accepting SQL UNKNOWN', async () => {
    await runPurchaseOriginEvidenceSchema(f.db); await seed();
    await f.exec('UPDATE public.store_order SET cart_id=NULL WHERE id=1');
    await expect(f.db.transaction(tx => recordPurchaseOriginEvidence(tx,{ orderId:1,buyerId:11 }))).rejects.toMatchObject({ cause:{ code:'23514' } });
    expect(await f.exec('TABLE public.store_order_purchase_origin')).toEqual([]);
  });
  it.each([
    'ALTER TABLE public.store_order_purchase_origin ALTER COLUMN buyer_id DROP NOT NULL',
    'ALTER TABLE public.store_order_purchase_origin ALTER COLUMN lines SET DEFAULT \'[]\'::jsonb',
    'ALTER TABLE public.store_order_purchase_origin ADD COLUMN extra text',
    'ALTER TABLE public.store_order_purchase_origin ADD COLUMN extra text; ALTER TABLE public.store_order_purchase_origin DROP COLUMN extra',
    'ALTER TABLE public.store_order_purchase_origin ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.store_order_purchase_origin SET UNLOGGED',
    'ALTER TABLE public.store_order_purchase_origin DISABLE TRIGGER sopo_no_rewrite',
    'ALTER TABLE public.store_order_purchase_origin ENABLE REPLICA TRIGGER sopo_capture',
    'DROP INDEX public.sopo_buyer_history',
    'ALTER INDEX public.sopo_buyer_history SET (fillfactor=80)',
    'ALTER TABLE public.store_order_purchase_origin CLUSTER ON sopo_buyer_history',
    'ALTER FUNCTION public.capture_purchase_origin_v1() SECURITY DEFINER',
    'ALTER FUNCTION public.capture_purchase_origin_v1() RESET search_path',
    'CREATE OR REPLACE FUNCTION public.protect_purchase_origin_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RETURN NEW; END $$',
    'CREATE FUNCTION public.protect_purchase_origin_v1(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    'GRANT SELECT ON public.store_order_purchase_origin TO PUBLIC',
    'GRANT INSERT(order_id) ON public.store_order_purchase_origin TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION public.capture_purchase_origin_v1() TO PUBLIC',
    'CREATE RULE unexpected AS ON DELETE TO public.store_order_purchase_origin DO INSTEAD NOTHING',
    'ALTER TABLE public.store_order_purchase_origin DROP CONSTRAINT store_order_purchase_origin_lines_check',
  ])('refuses directory drift without repairing it: %s', async mutation => {
    await runPurchaseOriginEvidenceSchema(f.db); await f.exec(mutation);
    const before = await identities(), shape = await catalog();
    expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('drift');
    await expect(runPurchaseOriginEvidenceSchema(f.db)).rejects.toThrow();
    expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
  });
  it.each([
    'CREATE TABLE public.store_order_purchase_origin(order_id integer)',
    'CREATE TABLE public.sopo_buyer_history(id integer)',
    'CREATE FUNCTION public.capture_purchase_origin_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
  ])('refuses partial/colliding objects before installing anything: %s', async mutation => {
    await f.exec(mutation); const before = await identities();
    expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('drift');
    await expect(runPurchaseOriginEvidenceSchema(f.db)).rejects.toThrow(); expect(await identities()).toEqual(before);
  });
  it.each([
    'ALTER TABLE public.store_order ALTER COLUMN total_num DROP NOT NULL',
    'ALTER TABLE public.store_order_cart_info ALTER COLUMN cart_num TYPE bigint',
    'ALTER TABLE public.store_order ENABLE ROW LEVEL SECURITY',
    'DROP INDEX public.so_split_pending',
  ])('refuses source contract drift: %s', async mutation => {
    await f.exec(mutation); const before = await identities();
    expect(await inspectPurchaseOriginEvidence(f.db)).toEqual({ state:'fresh',sourcesReady:false });
    await expect(runPurchaseOriginEvidenceSchema(f.db)).rejects.toThrow(); expect(await identities()).toEqual(before);
  });
  it('commissions an independently authenticated LOGIN for SELECT/INSERT only', async () => {
    await f.withRuntimeRole!(async peer => {
      await sources(peer.role); expect(await runPurchaseOriginEvidence(f.db,peer.role)).toEqual({ state:'v1',sourcesReady:true,runtimeSafe:true,runtimeReady:true });
      await seed(); await peer.db.transaction(tx => recordPurchaseOriginEvidence(tx,{ orderId:1,buyerId:11 }));
      for (const command of ['UPDATE public.store_order_purchase_origin SET total_num=2','DELETE FROM public.store_order_purchase_origin',
        'TRUNCATE public.store_order_purchase_origin','ALTER TABLE public.store_order_purchase_origin DISABLE TRIGGER ALL',
        'DROP TABLE public.store_order_purchase_origin','SELECT public.capture_purchase_origin_v1()',"SET session_replication_role='replica'",'SET ROLE finance_test'])
        await expect(peer.exec(command)).rejects.toMatchObject({ code:'42501' });
      await expect(runPurchaseOriginEvidence(peer.db,peer.role)).rejects.toThrow();
      await peer.exec('RESET ROLE'); expect(await peer.exec('SELECT current_user=session_user AS same')).toEqual([{ same:true }]);
      const before = await catalog(); await runPurchaseOriginEvidence(f.db,peer.role); expect(await catalog()).toEqual(before);
    });
  });
  it('does not create schema or grant authority with missing source privileges or unsafe role inheritance', async () => {
    await f.withRuntimeRole!(async peer => {
      await expect(runPurchaseOriginEvidence(f.db,peer.role)).rejects.toThrow();
      await sources(peer.role);
      await f.withRuntimeRole!(async parent => {
        await f.exec(`GRANT SET ON PARAMETER session_replication_role TO "${parent.role}"; GRANT "${parent.role}" TO "${peer.role}" WITH INHERIT FALSE, SET TRUE`);
        try { expect(await inspectPurchaseOriginEvidence(f.db,peer.role)).toMatchObject({ runtimeSafe:false,runtimeReady:false });
          await expect(runPurchaseOriginEvidence(f.db,peer.role)).rejects.toThrow(); }
        finally { await f.exec(`REVOKE "${parent.role}" FROM "${peer.role}"; REVOKE SET ON PARAMETER session_replication_role FROM "${parent.role}"`); }
      });
      expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('fresh');
    });
  });
  it.each(['UPDATE','SELECT WITH GRANT OPTION'])('refuses unsafe existing privileges: %s', async privilege => {
    await f.withRuntimeRole!(async peer => {
      await sources(peer.role); await runPurchaseOriginEvidence(f.db,peer.role);
      await f.exec(privilege.includes('WITH') ? `GRANT SELECT ON public.store_order_purchase_origin TO "${peer.role}" WITH GRANT OPTION`
        : `GRANT UPDATE ON public.store_order_purchase_origin TO "${peer.role}"`);
      const before = await catalog(); await expect(runPurchaseOriginEvidence(f.db,peer.role)).rejects.toThrow(); expect(await catalog()).toEqual(before);
    });
  });
  it.each(['TABLES','FUNCTIONS'])('rolls back fresh objects when default %s rights are unsafe', async kind => {
    await f.withRuntimeRole!(async peer => {
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${kind === 'TABLES' ? 'UPDATE' : 'EXECUTE'} ON ${kind} TO "${peer.role}"`);
      const before = await identities();
      try { await expect(runPurchaseOriginEvidenceSchema(f.db)).rejects.toThrow(); expect(await identities()).toEqual(before); }
      finally { await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ${kind === 'TABLES' ? 'UPDATE' : 'EXECUTE'} ON ${kind} FROM "${peer.role}"`); }
    });
  });
  it('requires the common installation fence and each dependency/table lock', async () => {
    await runPurchaseOriginEvidenceSchema(f.db);
    for (const command of ['SELECT pg_advisory_xact_lock(731611,0)',...['store_order','store_order_cart_info','store_order_purchase_origin']
      .map(table => `LOCK TABLE public.${table} IN ROW EXCLUSIVE MODE`)]) {
      await f.withPeer!(async peer => {
        await peer.exec(`BEGIN; ${command}`);
        try { await expect(runPurchaseOriginEvidenceSchema(f.db)).rejects.toThrow(); }
        finally { await peer.exec('ROLLBACK'); }
      });
      expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('v1');
    }
  });
  it.each(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ','SET TRANSACTION READ ONLY',"SET LOCAL session_replication_role='replica'"])
    ('rejects incompatible transaction context: %s', async command => {
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(command)); await tx.execute(sql.raw(PURCHASE_ORIGIN_INSTALLATION_SQL)); })).rejects.toThrow();
      expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('fresh');
    });
  it('preserves stricter timeout settings, refuses nested installer calls, and ignores temporary shadows', async () => {
    await f.db.transaction(async tx => { await expect(runPurchaseOriginEvidenceSchema(tx)).rejects.toThrow('root database'); });
    await f.exec('SET statement_timeout=5000; SET lock_timeout=100; SET idle_in_transaction_session_timeout=500; SET search_path=public,pg_temp');
    await f.exec('CREATE TEMP TABLE store_order_purchase_origin(marker integer); INSERT INTO pg_temp.store_order_purchase_origin VALUES(23)');
    const settings = () => f.exec("SELECT name,setting FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout','search_path','row_security','default_tablespace') ORDER BY name");
    const before = await settings(); await runPurchaseOriginEvidenceSchema(f.db); expect(await settings()).toEqual(before);
    expect(await f.exec('TABLE pg_temp.store_order_purchase_origin')).toEqual([{ marker:23 }]);
  });
  it('rejects active event triggers before issuing DDL', async () => {
    await f.exec('CREATE FUNCTION public.local_ddl_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$; CREATE EVENT TRIGGER local_ddl_hook ON ddl_command_start EXECUTE FUNCTION public.local_ddl_hook()');
    try { await expect(runPurchaseOriginEvidenceSchema(f.db)).rejects.toThrow(); }
    finally { await f.exec('DROP EVENT TRIGGER local_ddl_hook'); }
    expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('fresh');
  });
  it('requires an exact CLI target and confirmation, emits no secrets, and never repairs drift', async () => {
    const [identity] = await f.db.execute(sql`SELECT current_database() AS database`);
    if (typeof identity.database !== 'string' || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database)) throw Error('Not owned fixture');
    const database = identity.database, target = new URL(process.env.TEST_FINANCE_POSTGRES_URL!); target.pathname=`/${database}`;
    await f.withRuntimeRole!(async peer => {
      await sources(peer.role);
      const run = (args: string[], url=target.href) => spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/purchase-origin-maintenance.ts',...args],
        { encoding:'utf8',windowsHide:true,timeout:45000,env:{ ...process.env,PURCHASE_ORIGIN_MAINTENANCE_DATABASE_URL:url } });
      const inspected=run(['inspect',database,peer.role]), missing=run(['install',database,peer.role]);
      expect(inspected.status).toBe(2); expect(JSON.parse(inspected.stdout)).toMatchObject({ state:'fresh',runtimeReady:false });
      expect(missing.status).toBe(1); expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('fresh');
      await orm();
      const pending=run(['inspect',database,peer.role]), noImplicitCompletion=run(['install',database,peer.role,'--confirm-install']);
      expect(pending.status).toBe(2); expect(JSON.parse(pending.stdout)).toMatchObject({ state:'orm-pending',runtimeReady:false });
      expect(noImplicitCompletion.status).toBe(1); expect((await inspectPurchaseOriginEvidence(f.db)).state).toBe('orm-pending');
      await completePurchaseOriginEvidenceOrm(f.db);
      const installed=run(['install',database,peer.role,'--confirm-install']); expect(installed.status).toBe(0);
      expect(JSON.parse(installed.stdout)).toMatchObject({ state:'v1',runtimeReady:true });
      const wrong=run(['inspect','wrong',peer.role]), absent=run(['inspect',database,peer.role],''), injection=run(['install',database,'bad"; SELECT 1; --','--confirm-install']);
      for (const result of [wrong,absent,injection]) expect(result.status).toBe(1);
      await f.exec('ALTER TABLE public.store_order_purchase_origin DISABLE TRIGGER sopo_no_rewrite');
      const drift=run(['install',database,peer.role,'--confirm-install']); expect(drift.status).toBe(1); expect(drift.stdout).toBe('');
      for (const result of [inspected,missing,pending,noImplicitCompletion,installed,wrong,absent,injection,drift]) {
        expect(result.error).toBeUndefined(); expect(result.stdout+result.stderr).not.toContain(target.href);
        expect(result.stdout+result.stderr).not.toContain(target.password);
      }
    });
  }, 90000);
});
