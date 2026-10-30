import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '@/lib/di';
import { inspectAdminDeliveryOperation, assertAdminDeliveryOperationReady } from '@/migrations/adminDeliveryOperation';
import { createAdminDeliveryFixture } from './helpers/adminDeliveryFixture';

// Real PGlite catalog/constraints/triggers/roles. Neither catalog inspection nor
// SQL is mocked. Native LOGIN, timing and locks are separate PG16 evidence.
describe('Delivery operation immutable addon exact catalog and runtime safety', () => {
  let f: Awaited<ReturnType<typeof createAdminDeliveryFixture>>;
  const stored = crypto.randomUUID(), hex = 'a'.repeat(64);
  beforeAll(async () => {
    f = await createAdminDeliveryFixture();
    await f.db.execute(sql`INSERT INTO public.admin_delivery_operation VALUES
      (${stored}::uuid,1,'create',0,${hex},${hex},'committed','{"id":1}'::jsonb,1)`);
  });
  afterAll(async () => { await f?.close(); });
  async function rolledBack(run: (tx: DbClient) => Promise<void>) {
    const marker = Error('Owned catalog mutation rolled back');
    await expect(f.db.transaction(async tx => { await run(tx as unknown as DbClient); throw marker; })).rejects.toBe(marker);
    expect(await inspectAdminDeliveryOperation(f.db, f.names)).toBe(true);
  }
  it('has the exact nine columns, sole Admin append grant and original maintenance ownership', async () => {
    expect(await inspectAdminDeliveryOperation(f.db, f.names)).toBe(true);
    const columns = await f.db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='admin_delivery_operation' ORDER BY ordinal_position`);
    expect(Array.from(columns, r => r.column_name)).toEqual(['operation_id','actor_id','operation','target_id','payload_hash','revision','state','result','created_at']);
    const [receipts] = await f.db.execute(sql`SELECT count(*)::integer AS count FROM public.admin_delivery_operation`);
    expect(receipts.count).toBe(1);
  });
  it('requires the restricted Admin session and caller-owned transaction', async () => {
    await f.asAdmin(async () => {
      const [role] = await f.db.execute(sql`SELECT current_user AS current,session_user AS session`);
      expect(role).toEqual({ current: f.names.admin, session: f.names.admin });
      await expect(f.db.transaction(tx => assertAdminDeliveryOperationReady(tx))).resolves.toBeUndefined();
      await expect(assertAdminDeliveryOperationReady(f.db)).rejects.toMatchObject({ code: 503 });
    });
    await expect(f.db.transaction(tx => assertAdminDeliveryOperationReady(tx))).rejects.toMatchObject({ code: 503 });
  });
  it('App can read its existing delivery identity catalog but cannot read or append receipts', async () => {
    await f.asApp(async () => {
      await expect(f.exec('SELECT * FROM public.delivery_service LIMIT 0')).resolves.toBeDefined();
      await expect(f.exec('SELECT * FROM public.admin_delivery_operation')).rejects.toMatchObject({ code: '42501' });
      await expect(f.exec('INSERT INTO public.admin_delivery_operation DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
      await expect(f.db.transaction(tx => assertAdminDeliveryOperationReady(tx))).rejects.toMatchObject({ code: 503 });
    });
  });
  it('Admin has only append/read receipt authority and cannot invoke its trigger as a routine', async () => {
    await f.asAdmin(async () => {
      for (const query of ['UPDATE public.admin_delivery_operation SET actor_id=2', 'DELETE FROM public.admin_delivery_operation',
        'TRUNCATE public.admin_delivery_operation', 'ALTER TABLE public.admin_delivery_operation ADD COLUMN forbidden integer',
        'SELECT public.admin_delivery_operation_immutable_v1()']) {
        await expect(f.exec(query)).rejects.toMatchObject({ code: '42501' });
      }
    });
  });
  it('immutable rows and truncate also refuse maintenance SQL without deleting evidence', async () => {
    for (const query of ['UPDATE public.admin_delivery_operation SET actor_id=2', 'DELETE FROM public.admin_delivery_operation', 'TRUNCATE public.admin_delivery_operation']) {
      await expect(f.exec(query)).rejects.toMatchObject({ code: '42501' });
    }
    const [row] = await f.db.execute(sql`SELECT operation_id::text AS id,actor_id FROM public.admin_delivery_operation WHERE operation_id=${stored}::uuid`);
    expect(row).toEqual({ id: stored, actor_id: 1 });
  });
  it('accepts explicit not-applied evidence and rejects operation UUID reuse', async () => {
    const id = crypto.randomUUID();
    await f.asAdmin(() => f.db.execute(sql`INSERT INTO public.admin_delivery_operation VALUES
      (${id}::uuid,2,'delete',0,${hex},${hex},'not_applied','{"count":0}'::jsonb,2)`));
    await expect(f.db.execute(sql`INSERT INTO public.admin_delivery_operation VALUES
      (${id}::uuid,2,'delete',0,${hex},${hex},'committed','{}'::jsonb,3)`)).rejects.toMatchObject({ cause: { code: '23505' } });
    const [row] = await f.db.execute(sql`SELECT state FROM public.admin_delivery_operation WHERE operation_id=${id}::uuid`);
    expect(row.state).toBe('not_applied');
  });
  it.each([
    ['extra column', 'ALTER TABLE public.admin_delivery_operation ADD COLUMN leaked_secret text'],
    ['column default', 'ALTER TABLE public.admin_delivery_operation ALTER COLUMN target_id SET DEFAULT 0'],
    ['relaxed target', 'ALTER TABLE public.admin_delivery_operation DROP CONSTRAINT adlo_target_ck'],
    ['extra index', 'CREATE INDEX owned_adlo_actor_idx ON public.admin_delivery_operation(actor_id)'],
    ['disabled immutable trigger', 'ALTER TABLE public.admin_delivery_operation DISABLE TRIGGER adlo_immutable_rows'],
    ['RLS', 'ALTER TABLE public.admin_delivery_operation ENABLE ROW LEVEL SECURITY'],
    ['renamed column', 'ALTER TABLE public.admin_delivery_operation RENAME COLUMN payload_hash TO request_hash'],
    ['function search path', "ALTER FUNCTION public.admin_delivery_operation_immutable_v1() SET search_path=public"],
    ['unexpected foreign key', 'ALTER TABLE public.admin_delivery_operation ADD CONSTRAINT owned_adlo_actor_fk FOREIGN KEY(actor_id) REFERENCES public.system_admin(id) NOT VALID'],
    ['function overload', "CREATE FUNCTION public.admin_delivery_operation_immutable_v1(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1'"],
  ])('rejects drift rather than repairing it: %s', async (_name, mutation) => {
    await rolledBack(async tx => { await tx.execute(sql.raw(mutation)); expect(await inspectAdminDeliveryOperation(tx, f.names)).toBe(false); });
  });
  it.each(['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])('does not accept an extra Admin %s receipt grant', async privilege => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw(`GRANT ${privilege} ON public.admin_delivery_operation TO ${f.names.admin}`));
      expect(await inspectAdminDeliveryOperation(tx, f.names)).toBe(false);
    });
  });
  it('rejects public, second-role and grant-option delegation', async () => {
    for (const grant of [
      'GRANT SELECT ON public.admin_delivery_operation TO PUBLIC',
      `GRANT SELECT ON public.admin_delivery_operation TO ${f.names.app}`,
      `GRANT SELECT ON public.admin_delivery_operation TO ${f.names.admin} WITH GRANT OPTION`,
    ]) await rolledBack(async tx => { await tx.execute(sql.raw(grant)); expect(await inspectAdminDeliveryOperation(tx, f.names)).toBe(false); });
  });
  it('does not treat a changed function body or extra trigger as reviewed', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw("CREATE OR REPLACE FUNCTION public.admin_delivery_operation_immutable_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN RETURN NEW; END$$"));
      expect(await inspectAdminDeliveryOperation(tx, f.names)).toBe(false);
    });
    await rolledBack(async tx => {
      await tx.execute(sql.raw('CREATE TRIGGER owned_extra_adlo BEFORE INSERT ON public.admin_delivery_operation FOR EACH ROW EXECUTE FUNCTION public.admin_delivery_operation_immutable_v1()'));
      expect(await inspectAdminDeliveryOperation(tx, f.names)).toBe(false);
    });
  });
  it.each([
    ['non-v4 UUID', '00000000-0000-0000-0000-000000000000', 1, 'create', 0, 'a'.repeat(64), 'a'.repeat(64), 'committed', '{}', 1],
    ['actor', crypto.randomUUID(), 0, 'create', 0, 'a'.repeat(64), 'a'.repeat(64), 'committed', '{}', 1],
    ['operation', crypto.randomUUID(), 1, 'issue', 0, 'a'.repeat(64), 'a'.repeat(64), 'committed', '{}', 1],
    ['negative target', crypto.randomUUID(), 1, 'delete', -1, 'a'.repeat(64), 'a'.repeat(64), 'committed', '{}', 1],
    ['payload_hash', crypto.randomUUID(), 1, 'update', 1, 'secret', 'a'.repeat(64), 'committed', '{}', 1],
    ['revision', crypto.randomUUID(), 1, 'status', 1, 'a'.repeat(64), 'A'.repeat(64), 'committed', '{}', 1],
    ['state', crypto.randomUUID(), 1, 'delete', 0, 'a'.repeat(64), 'a'.repeat(64), 'pending', '{}', 1],
    ['result array', crypto.randomUUID(), 1, 'delete', 0, 'a'.repeat(64), 'a'.repeat(64), 'committed', '[]', 1],
    ['created at', crypto.randomUUID(), 1, 'delete', 0, 'a'.repeat(64), 'a'.repeat(64), 'committed', '{}', 0],
  ])('actual SQL rejects invalid %s evidence', async (_name, id, actor, operation, target, payload_hash, revision, state, result, created) => {
    await expect(f.db.execute(sql`INSERT INTO public.admin_delivery_operation VALUES
      (${id}::uuid,${actor},${operation},${target},${payload_hash},${revision},${state},${result}::jsonb,${created})`)).rejects.toMatchObject({ cause: { code: '23514' } });
  });
  it('rejects absent table and partial immutable-function catalogs without creating or repairing either', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw('DROP TABLE public.admin_delivery_operation'));
      expect(await inspectAdminDeliveryOperation(tx, f.names)).toBe(false);
    });
    await rolledBack(async tx => {
      await tx.execute(sql.raw('DROP FUNCTION public.admin_delivery_operation_immutable_v1() CASCADE'));
      expect(await inspectAdminDeliveryOperation(tx, f.names)).toBe(false);
    });
  });
  it('preserves the four explicit operation values, including soft delete, with no unrelated dispatch state', async () => {
    const before = await f.db.execute(sql`SELECT count(*)::integer AS count FROM public.admin_delivery_operation`);
    await f.asAdmin(async () => {
      for (const operation of ['create','update','status','delete']) await f.db.execute(sql`INSERT INTO public.admin_delivery_operation VALUES
        (${crypto.randomUUID()}::uuid,1,${operation},0,${hex},${hex},'not_applied','{}'::jsonb,1)`);
    });
    const after = await f.db.execute(sql`SELECT count(*)::integer AS count FROM public.admin_delivery_operation`);
    expect(after[0].count).toBe(Number(before[0].count) + 4);
  });

});
