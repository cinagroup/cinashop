import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_WECHAT_ROUTINE_OPERATION_GATE,
  ADMIN_WECHAT_ROUTINE_OPERATION_RUNTIME_PRIVILEGES,
  ADMIN_WECHAT_ROUTINE_OPERATION_SQL,
  assertAdminWechatRoutineOperationReady,
  inspectAdminWechatRoutineOperation,
} from '@/migrations/adminWechatRoutineOperation';
import { financeMemoryPostgres } from './helpers/financePostgres';

type Receipt = {
  operation_id: string; actor_id: number | null; operation: string; format_version: number;
  payload_hash: string; revision: string; state: string; result: unknown; created_at: number;
};
const receipt = (changes: Partial<Receipt> = {}): Receipt => ({
  operation_id: randomUUID(), actor_id: 17, operation: 'save', format_version: 1,
  payload_hash: 'a'.repeat(64), revision: 'b'.repeat(64), state: 'committed',
  result: { cache_status: 'not_needed' }, created_at: 1, ...changes,
});

/** Exact addon DDL and catalog/constraint/trigger SQL run in one owned PGlite
 * fixture. This does not establish independently authenticated PG16 LOGINs,
 * effective native ACLs or cross-session maintenance-lock exclusion. */
describe('WechatRoutine independent immutable operation addon in owned memory', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async () => {
    f = await financeMemoryPostgres([], { namespace: 'public' });
    if (!f.isMemory) throw Error('Routine operation tests require owned memory');
    await f.exec(ADMIN_WECHAT_ROUTINE_OPERATION_SQL);
  }, 30_000);
  afterAll(async () => { await f?.close(); }, 30_000);

  const facts = async () => Array.from(await f.db.execute(sql`
    SELECT * FROM public.admin_wechat_routine_operation ORDER BY operation_id`), row => ({ ...row }));
  const insert = (value: Receipt) => f.db.execute(sql`
    INSERT INTO public.admin_wechat_routine_operation
      (operation_id,actor_id,operation,format_version,payload_hash,revision,state,result,created_at)
    VALUES (${value.operation_id}::uuid,${value.actor_id},${value.operation},${value.format_version},
      ${value.payload_hash},${value.revision},${value.state},${JSON.stringify(value.result)}::jsonb,${value.created_at})`);

  // Real transactional DDL is rolled back even after a failed assertion; the
  // original catalog and all receipts must survive each independent example.
  async function refusesDrift(change: string | readonly string[]) {
    const before = await facts(), rollback = Error('owned routine catalog counterexample rollback');
    await expect(f.db.transaction(async tx => {
      for (const statement of typeof change === 'string' ? [change] : change) await tx.execute(sql.raw(statement));
      expect(await inspectAdminWechatRoutineOperation(tx)).toBe(false);
      await expect(assertAdminWechatRoutineOperationReady(tx)).rejects.toMatchObject({
        code: 503, cause: { message: 'WechatRoutine operation catalog is absent or drifted' },
      });
      expect(await inspectAdminWechatRoutineOperation(tx)).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await inspectAdminWechatRoutineOperation(f.db)).toBe(true);
    expect(await facts()).toEqual(before);
  }

  it('recognizes its independent exact catalog without installing an App table or consuming a sequence', async () => {
    expect(ADMIN_WECHAT_ROUTINE_OPERATION_GATE).toEqual([731667, 0]);
    expect(ADMIN_WECHAT_ROUTINE_OPERATION_RUNTIME_PRIVILEGES).toEqual({ app: [], admin: ['SELECT'] });
    const before = await facts();
    expect(await inspectAdminWechatRoutineOperation(f.db)).toBe(true);
    const [row] = await f.db.execute(sql`SELECT
      to_regclass('public.admin_wechat_app_operation') IS NULL AS app_absent,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relkind='S' AND relnamespace='public'::regnamespace) AS no_sequences`);
    expect(row).toMatchObject({ app_absent: true, no_sequences: true });
    expect(await facts()).toEqual(before);
  });

  it('persists both save/committed and resolve/not_applied receipts with the actual SQL values', async () => {
    const saved = receipt(), resolved = receipt({ operation: 'resolve', state: 'not_applied', result: {} });
    await insert(saved); await insert(resolved);
    const rows = await facts();
    for (const value of [saved, resolved]) {
      const actual = rows.find(row => row.operation_id === value.operation_id);
      expect(actual).toBeDefined();
      const { created_at, ...stored } = actual!, { created_at: timestamp, ...expected } = value;
      expect(stored).toEqual(expected);
      expect(String(created_at)).toBe(String(timestamp));
    }
  });

  it.each([
    ['non-v4 operation id', { operation_id: '00000000-0000-1000-8000-000000000001' }, '23514', 'awro_id_ck'],
    ['non-RFC variant operation id', { operation_id: '00000000-0000-4000-7000-000000000001' }, '23514', 'awro_id_ck'],
    ['null actor', { actor_id: null }, '23502', undefined],
    ['zero actor', { actor_id: 0 }, '23514', 'awro_actor_ck'],
    ['negative actor', { actor_id: -1 }, '23514', 'awro_actor_ck'],
    ['unknown operation', { operation: 'delete' }, '23514', 'awro_operation_ck'],
    ['future format', { format_version: 2 }, '23514', 'awro_format_ck'],
    ['short payload hash', { payload_hash: 'a'.repeat(63) }, '23514', 'awro_payload_hash_ck'],
    ['uppercase payload hash', { payload_hash: 'A'.repeat(64) }, '23514', 'awro_payload_hash_ck'],
    ['non-hex revision', { revision: 'g'.repeat(64) }, '23514', 'awro_revision_ck'],
    ['unknown state', { state: 'pending' }, '23514', 'awro_state_ck'],
    ['array result', { result: [] }, '23514', 'awro_result_ck'],
    ['JSON null result', { result: null }, '23514', 'awro_result_ck'],
    ['zero timestamp', { created_at: 0 }, '23514', 'awro_created_ck'],
  ] satisfies [string, Partial<Receipt>, string, string | undefined][])(
    'rejects %s in the database without leaving a partial receipt', async (_name, changes, code, constraint) => {
      const before = await facts();
      // Drizzle retains the original PostgreSQL error as cause; this verifies
      // actual server enforcement rather than a JavaScript pre-validation.
      await expect(insert(receipt(changes))).rejects.toMatchObject({ cause: { code, ...(constraint ? { constraint } : {}) } });
      expect(await facts()).toEqual(before);
    });

  it('enforces one immutable identity even if a duplicate carries different actor and payload bytes', async () => {
    const value = receipt(); await insert(value);
    const before = await facts();
    await expect(insert({ ...value, actor_id: 18, payload_hash: 'c'.repeat(64) }))
      .rejects.toMatchObject({ cause: { code: '23505', constraint: 'awro_pk' } });
    expect(await facts()).toEqual(before);
  });

  it.each([
    'UPDATE public.admin_wechat_routine_operation SET actor_id=18',
    'DELETE FROM public.admin_wechat_routine_operation',
    'TRUNCATE public.admin_wechat_routine_operation',
  ])('enforces the installed immutable trigger for %s', async command => {
    await insert(receipt());
    const before = await facts();
    await expect(f.exec(command)).rejects.toMatchObject({ code: '42501', message: 'WechatRoutine operation evidence is immutable' });
    expect(await facts()).toEqual(before);
  });

  it('rolls back a real receipt insert with the caller business transaction', async () => {
    const value = receipt(), before = await facts(), rollback = Error('owned routine business rollback');
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql`INSERT INTO public.admin_wechat_routine_operation VALUES
        (${value.operation_id}::uuid,${value.actor_id},${value.operation},${value.format_version},
        ${value.payload_hash},${value.revision},${value.state},${JSON.stringify(value.result)}::jsonb,${value.created_at})`);
      const [row] = await tx.execute(sql`SELECT count(*)::int AS count FROM public.admin_wechat_routine_operation WHERE operation_id=${value.operation_id}::uuid`);
      expect(row.count).toBe(1);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await facts()).toEqual(before);
  });

  it.each([
    ['missing table', 'ALTER TABLE public.admin_wechat_routine_operation RENAME TO routine_operation_missing_fixture'],
    ['weakened same-name check', ['ALTER TABLE public.admin_wechat_routine_operation DROP CONSTRAINT awro_actor_ck', 'ALTER TABLE public.admin_wechat_routine_operation ADD CONSTRAINT awro_actor_ck CHECK(actor_id >= 0)']],
    ['added column', 'ALTER TABLE public.admin_wechat_routine_operation ADD COLUMN unreviewed text'],
    ['extra index', 'CREATE INDEX routine_operation_extra ON public.admin_wechat_routine_operation(actor_id)'],
    ['disabled immutable trigger', 'ALTER TABLE public.admin_wechat_routine_operation DISABLE TRIGGER awro_immutable_rows'],
    ['changed immutable body', 'CREATE OR REPLACE FUNCTION public.admin_wechat_routine_operation_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN RETURN NEW; END $$'],
    ['PUBLIC table grant', 'GRANT SELECT ON public.admin_wechat_routine_operation TO PUBLIC'],
    ['PUBLIC function grant', 'GRANT EXECUTE ON FUNCTION public.admin_wechat_routine_operation_immutable_v1() TO PUBLIC'],
  ] satisfies [string, string | readonly string[]][])(
    'refuses %s by inspecting actual catalog SQL without repairing it', async (_name, change) => refusesDrift(change));

  it('refuses the owner connection and owner transaction without installing or repairing anything', async () => {
    const before = await facts();
    await expect(assertAdminWechatRoutineOperationReady(f.db)).rejects.toMatchObject({
      code: 503, cause: { message: 'WechatRoutine readiness requires a caller-owned transaction' },
    });
    await expect(f.db.transaction(tx => assertAdminWechatRoutineOperationReady(tx))).rejects.toMatchObject({
      code: 503, cause: { message: 'WechatRoutine operation catalog is absent or drifted' },
    });
    expect(await inspectAdminWechatRoutineOperation(f.db)).toBe(true);
    expect(await facts()).toEqual(before);
  });
});
