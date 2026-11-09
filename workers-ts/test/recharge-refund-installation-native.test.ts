/** PG16 storage specimens only. No paid author, provider, refund transport,
 * current user balance mutation or business admission is established here. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { userRecharge } from '@/models/schema';
import { inspectRechargeRefundCatalog, RECHARGE_REFUND_CATALOG_SQL, runRechargeRefundInstallation } from '@/migrations/rechargeRefund';
import { financePostgres } from './helpers/financePostgres';

type Fixture = Awaited<ReturnType<typeof financePostgres>>;
const namespace = () => sql`SELECT c.relname,c.oid::text,c.relowner::text,c.relacl::text,pg_catalog.obj_description(c.oid,'pg_class') AS comment
  FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
  AND (starts_with(c.relname,'recharge_refund_') OR starts_with(c.relname,'rcro_') OR starts_with(c.relname,'rcra_')
    OR starts_with(c.relname,'rcrr_') OR starts_with(c.relname,'rcrs_')) ORDER BY c.relname`;
async function fixture(run: (f: Fixture) => Promise<void>) {
  const f = await financePostgres([userRecharge], { namespace: 'public' });
  try {
    await f.exec('ALTER TABLE public.user_recharge ALTER COLUMN refund_price TYPE numeric(10,2)');
    await run(f);
  } finally { await f.close(); }
}
async function source(f: Fixture) {
  const [r] = await f.db.execute<Record<string, unknown>>(sql`SELECT c.oid::text AS oid,c.relowner::text AS owner,c.relacl::text AS acl,
    pg_catalog.obj_description(c.oid,'pg_class') AS comment,a.attnum,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
    a.attacl::text AS column_acl,pg_catalog.col_description(c.oid,a.attnum) AS column_comment,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='refund_price'
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE c.oid='public.user_recharge'::regclass`);
  return r;
}
const stateCodes = (error: unknown) => {
  const codes: unknown[] = [];
  for (let i = 0; i < 8 && error && typeof error === 'object'; i++) {
    const value = error as { code?: unknown; cause?: unknown }; codes.push(value.code); error = value.cause;
  }
  return codes;
};
async function denied(run: Promise<unknown>, code: string) {
  let error: unknown;
  try { await run; } catch (caught) { error = caught; }
  expect(stateCodes(error)).toContain(code);
}
async function reservedSpecimen(f: Fixture) {
  const id = randomUUID(), key = randomUUID();
  await f.db.execute(sql`INSERT INTO public.recharge_refund_operation
    (operation_id,admin_id,request_key,request_hash,recharge_id,buyer_uid,order_no,provider,payment_profile,transaction_id,
    payment_source,payment_signature,principal_cents,gift_cents,reclaim_gift,debit_cents,wallet_before,wallet_after,admission,out_refund_no,created_at,signature)
    VALUES(${id}::uuid,7,${key}::uuid,${'a'.repeat(64)},31,51,'czCatalogSpecimen','wechat','routine','structural-only',
    '{}'::jsonb,${'b'.repeat(64)},10000,2000,true,12000,12000,0,'reserved',${'CNSCR' + id.replaceAll('-', '')},1793876000,${'c'.repeat(64)})`);
  return id;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('recharge refund PG16 explicit storage installation', () => {
  it('widens only refund_price and preserves existing rows, identities, comments and replay catalog', async () => fixture(async f => {
    await f.db.insert(userRecharge).values({ uid: 11, orderId: 'czRetainedHistory', price: '100.00', givePrice: '20.00', refundPrice: '1.99', paid: 1 });
    await f.exec("COMMENT ON TABLE public.user_recharge IS 'retained source table';COMMENT ON COLUMN public.user_recharge.refund_price IS 'retained source column'");
    const before = await source(f), rows = await f.db.select().from(userRecharge);
    const [absent] = await f.db.execute<Record<string, unknown>>(sql.raw(RECHARGE_REFUND_CATALOG_SQL));
    expect(absent.present).toBe(false); expect(absent.source_safe).toBe(true);
    await runRechargeRefundInstallation(f.db);
    const after = await source(f);
    expect(after).toEqual({ ...before, type: 'numeric(12,2)' });
    expect(await f.db.select().from(userRecharge)).toEqual(rows);
    expect(await inspectRechargeRefundCatalog(f.db)).toEqual({ present: true, installed: true, commissioned: false, binding: null, failures: [] });
    const catalog = await f.db.execute(namespace());
    await runRechargeRefundInstallation(f.db);
    expect(await f.db.execute(namespace())).toEqual(catalog);
    expect(await source(f)).toEqual(after); expect(await f.db.select().from(userRecharge)).toEqual(rows);
    await f.db.insert(userRecharge).values({ orderId: 'czFullCapacity', refundPrice: '9999999999.99' });
  }));

  it('rejects partial namespace without widening or repairing it', async () => fixture(async f => {
    await f.exec('CREATE TABLE public.recharge_refund_partial (id integer)');
    const before = await source(f), objects = await f.db.execute(namespace());
    await expect(runRechargeRefundInstallation(f.db)).rejects.toThrow();
    expect(await source(f)).toEqual(before); expect(await f.db.execute(namespace())).toEqual(objects);
  }));

  it('rolls back both capacity change and all new objects when default table ACL would leak rows', async () => fixture(async f => {
    await f.exec('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC');
    const before = await source(f);
    await expect(runRechargeRefundInstallation(f.db)).rejects.toThrow();
    expect(await source(f)).toEqual(before); expect(await f.db.execute(namespace())).toEqual([]);
  }));

  it('does not adopt or repair drift on a replay', async () => fixture(async f => {
    await runRechargeRefundInstallation(f.db);
    await f.exec('ALTER TABLE public.recharge_refund_operation ALTER COLUMN request_hash DROP NOT NULL');
    const before = await source(f), objects = await f.db.execute(namespace());
    expect(await inspectRechargeRefundCatalog(f.db)).toMatchObject({ present: true, installed: false, commissioned: false });
    await expect(runRechargeRefundInstallation(f.db)).rejects.toThrow();
    expect(await source(f)).toEqual(before); expect(await f.db.execute(namespace())).toEqual(objects);
  }));

  it('rejects a disabled internal foreign-key trigger without silently repairing it', async () => fixture(async f => {
    await runRechargeRefundInstallation(f.db);
    const rows = await f.db.execute<{ tgname: string }>(sql`SELECT g.tgname FROM pg_catalog.pg_trigger g
      JOIN pg_catalog.pg_constraint k ON k.oid=g.tgconstraint WHERE g.tgrelid='public.recharge_refund_result'::regclass
      AND g.tgisinternal AND k.conname='rcrr_attempt_fk'
      AND g.tgfoid='pg_catalog."RI_FKey_check_ins"()'::regprocedure`);
    expect(rows).toHaveLength(1);
    const name = rows[0].tgname;
    await f.db.execute(sql`ALTER TABLE public.recharge_refund_result DISABLE TRIGGER ${sql.identifier(name)}`);
    expect(await inspectRechargeRefundCatalog(f.db)).toMatchObject({ present: true, installed: false, commissioned: false });
    await expect(runRechargeRefundInstallation(f.db)).rejects.toThrow();
    expect((await f.db.execute(sql`SELECT tgenabled FROM pg_catalog.pg_trigger
      WHERE tgrelid='public.recharge_refund_result'::regclass AND tgname=${name}`))[0].tgenabled).toBe('D');
    await f.db.execute(sql`ALTER TABLE public.recharge_refund_result ENABLE TRIGGER ${sql.identifier(name)}`);
    expect(await inspectRechargeRefundCatalog(f.db)).toMatchObject({ installed: true, commissioned: false });
  }));

  it('keeps immutable receipts append-only even for the maintenance table owner', async () => fixture(async f => {
    await runRechargeRefundInstallation(f.db); const id = await reservedSpecimen(f);
    await denied(f.db.execute(sql`UPDATE public.recharge_refund_operation SET signature=${'d'.repeat(64)} WHERE operation_id=${id}::uuid`), '42501');
    await denied(f.db.execute(sql`DELETE FROM public.recharge_refund_operation WHERE operation_id=${id}::uuid`), '42501');
    await denied(f.exec('TRUNCATE public.recharge_refund_state,public.recharge_refund_result,public.recharge_refund_attempt,public.recharge_refund_operation'), '42501');
    expect(await f.db.execute(sql`SELECT operation_id FROM public.recharge_refund_operation`)).toEqual([{ operation_id: id }]);
  }));

  it('enforces a single POST while allowing a distinct query attempt', async () => fixture(async f => {
    await runRechargeRefundInstallation(f.db); const id = await reservedSpecimen(f), lease = randomUUID();
    const attempt = (ordinal: number, kind: string) => f.db.execute(sql`INSERT INTO public.recharge_refund_attempt
      (attempt_id,operation_id,ordinal,kind,lease_id,request_hash,payload,created_at,signature)
      VALUES(${randomUUID()}::uuid,${id}::uuid,${ordinal},${kind},${lease}::uuid,${'a'.repeat(64)},'{}'::jsonb,1793876000,${'b'.repeat(64)})`);
    await attempt(1, 'request'); await denied(attempt(1, 'request'), '23505');
    await denied(attempt(2, 'request'), '23514'); await attempt(2, 'query');
    expect((await f.db.execute(sql`SELECT kind FROM public.recharge_refund_attempt ORDER BY ordinal`)).map(r => r.kind)).toEqual(['request','query']);
  }));

  it('rejects a result attached to another operation request attempt', async () => fixture(async f => {
    await runRechargeRefundInstallation(f.db); const first = await reservedSpecimen(f), second = await reservedSpecimen(f), attempt = randomUUID();
    await f.db.execute(sql`INSERT INTO public.recharge_refund_attempt VALUES(${attempt}::uuid,${first}::uuid,1,'request',${randomUUID()}::uuid,
      ${'a'.repeat(64)},'{}'::jsonb,1793876000,${'b'.repeat(64)})`);
    await denied(f.db.execute(sql`INSERT INTO public.recharge_refund_result VALUES(${randomUUID()}::uuid,${second}::uuid,${attempt}::uuid,
      'request','cross-operation-specimen','SUCCESS','{}'::jsonb,${'c'.repeat(64)},1793876000,NULL)`), '23503');
  }));
});
