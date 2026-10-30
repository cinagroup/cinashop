import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '@/lib/di';
import type { Env } from '@/env';
import {AdminUserLabelAuthorService,labelDigest,type LabelEvent} from '@/services/admin/AdminUserLabelAuthorService';
import {labelCanonical,type LabelAction} from '../../view/common/labelAuthor';
import {systemAdmin} from '@/models/schema';
import {md5} from '@/utils/jwt';
import { inspectAdminLabelOperation, assertAdminLabelOperationReady } from '@/migrations/adminLabelOperation';
import { createAdminLabelFixture } from './helpers/adminLabelFixture';

// Real PGlite catalog/constraints/triggers/roles. Neither catalog inspection nor
// SQL is mocked. Native LOGIN, timing and locks are separate PG16 evidence.
describe('Label operation immutable addon exact catalog and runtime safety', () => {
  let f: Awaited<ReturnType<typeof createAdminLabelFixture>>;
  const stored = crypto.randomUUID(), hex = 'a'.repeat(64);
  beforeAll(async () => {
    f = await createAdminLabelFixture();
    await f.db.insert(systemAdmin).values({id:1,account:'owned-label-event-owner',pwd:'owned-label-event-password',level:0});
    await f.db.execute(sql`INSERT INTO public.admin_label_operation VALUES
      (${stored}::uuid,1,'label_create',0,${hex},${hex},'committed','{"id":1}'::jsonb,1)`);
  });
  afterAll(async () => { await f?.close(); });
  async function rolledBack(run: (tx: DbClient) => Promise<void>) {
    const marker = Error('Owned catalog mutation rolled back');
    await expect(f.db.transaction(async tx => { await run(tx as unknown as DbClient); throw marker; })).rejects.toBe(marker);
    expect(await inspectAdminLabelOperation(f.db, f.names)).toBe(true);
  }
  it('has the exact nine columns, sole Admin append grant and original maintenance ownership', async () => {
    expect(await inspectAdminLabelOperation(f.db, f.names)).toBe(true);
    const columns = await f.db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='admin_label_operation' ORDER BY ordinal_position`);
    expect(Array.from(columns, r => r.column_name)).toEqual(['operation_id','actor_id','operation','target_id','payload_hash','revision','state','result','created_at']);
    const [receipts] = await f.db.execute(sql`SELECT count(*)::integer AS count FROM public.admin_label_operation`);
    expect(receipts.count).toBe(1);
  });
  it('requires the restricted Admin session and caller-owned transaction', async () => {
    await f.asAdmin(async () => {
      const [role] = await f.db.execute(sql`SELECT current_user AS current,session_user AS session`);
      expect(role).toEqual({ current: f.names.admin, session: f.names.admin });
      await expect(f.db.transaction(tx => assertAdminLabelOperationReady(tx))).resolves.toBeUndefined();
      await expect(assertAdminLabelOperationReady(f.db)).rejects.toMatchObject({ code: 503 });
    });
    await expect(f.db.transaction(tx => assertAdminLabelOperationReady(tx))).rejects.toMatchObject({ code: 503 });
  });
  it('App can read its existing label catalog but cannot read or append receipts', async () => {
    await f.asApp(async () => {
      await expect(f.exec('SELECT * FROM public.user_label LIMIT 0')).resolves.toBeDefined();
      await expect(f.exec('SELECT * FROM public.admin_label_operation')).rejects.toMatchObject({ code: '42501' });
      await expect(f.exec('INSERT INTO public.admin_label_operation DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
      await expect(f.db.transaction(tx => assertAdminLabelOperationReady(tx))).rejects.toMatchObject({ code: 503 });
    });
  });
  it('Admin has only append/read receipt authority and cannot invoke its trigger as a routine', async () => {
    await f.asAdmin(async () => {
      for (const query of ['UPDATE public.admin_label_operation SET actor_id=2', 'DELETE FROM public.admin_label_operation',
        'TRUNCATE public.admin_label_operation', 'ALTER TABLE public.admin_label_operation ADD COLUMN forbidden integer',
        'SELECT public.admin_label_operation_immutable_v1()']) {
        await expect(f.exec(query)).rejects.toMatchObject({ code: '42501' });
      }
    });
  });
  it('immutable rows and truncate also refuse maintenance SQL without deleting evidence', async () => {
    for (const query of ['UPDATE public.admin_label_operation SET actor_id=2', 'DELETE FROM public.admin_label_operation', 'TRUNCATE public.admin_label_operation']) {
      await expect(f.exec(query)).rejects.toMatchObject({ code: '42501' });
    }
    const [row] = await f.db.execute(sql`SELECT operation_id::text AS id,actor_id FROM public.admin_label_operation WHERE operation_id=${stored}::uuid`);
    expect(row).toEqual({ id: stored, actor_id: 1 });
  });
  it('accepts explicit not-applied evidence and rejects operation UUID reuse', async () => {
    const id = crypto.randomUUID();
    await f.asAdmin(() => f.db.execute(sql`INSERT INTO public.admin_label_operation VALUES
      (${id}::uuid,2,'label_update',0,${hex},${hex},'not_applied','{"count":0}'::jsonb,2)`));
    await expect(f.db.execute(sql`INSERT INTO public.admin_label_operation VALUES
      (${id}::uuid,2,'label_update',0,${hex},${hex},'committed','{}'::jsonb,3)`)).rejects.toMatchObject({ cause: { code: '23505' } });
    const [row] = await f.db.execute(sql`SELECT state FROM public.admin_label_operation WHERE operation_id=${id}::uuid`);
    expect(row.state).toBe('not_applied');
  });
  it.each([
    ['extra column', 'ALTER TABLE public.admin_label_operation ADD COLUMN leaked_secret text'],
    ['column default', 'ALTER TABLE public.admin_label_operation ALTER COLUMN target_id SET DEFAULT 0'],
    ['relaxed target', 'ALTER TABLE public.admin_label_operation DROP CONSTRAINT aulo_target_ck'],
    ['extra index', 'CREATE INDEX owned_aulo_actor_idx ON public.admin_label_operation(actor_id)'],
    ['disabled immutable trigger', 'ALTER TABLE public.admin_label_operation DISABLE TRIGGER aulo_immutable_rows'],
    ['RLS', 'ALTER TABLE public.admin_label_operation ENABLE ROW LEVEL SECURITY'],
    ['renamed column', 'ALTER TABLE public.admin_label_operation RENAME COLUMN payload_hash TO request_hash'],
    ['function search path', "ALTER FUNCTION public.admin_label_operation_immutable_v1() SET search_path=public"],
    ['unexpected foreign key', 'ALTER TABLE public.admin_label_operation ADD CONSTRAINT owned_aulo_actor_fk FOREIGN KEY(actor_id) REFERENCES public.system_admin(id) NOT VALID'],
    ['function overload', "CREATE FUNCTION public.admin_label_operation_immutable_v1(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1'"],
  ])('rejects drift rather than repairing it: %s', async (_name, mutation) => {
    await rolledBack(async tx => { await tx.execute(sql.raw(mutation)); expect(await inspectAdminLabelOperation(tx, f.names)).toBe(false); });
  });
  it.each(['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])('does not accept an extra Admin %s receipt grant', async privilege => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw(`GRANT ${privilege} ON public.admin_label_operation TO ${f.names.admin}`));
      expect(await inspectAdminLabelOperation(tx, f.names)).toBe(false);
    });
  });
  it('rejects public, second-role and grant-option delegation', async () => {
    for (const grant of [
      'GRANT SELECT ON public.admin_label_operation TO PUBLIC',
      `GRANT SELECT ON public.admin_label_operation TO ${f.names.app}`,
      `GRANT SELECT ON public.admin_label_operation TO ${f.names.admin} WITH GRANT OPTION`,
    ]) await rolledBack(async tx => { await tx.execute(sql.raw(grant)); expect(await inspectAdminLabelOperation(tx, f.names)).toBe(false); });
  });
  it('does not treat a changed function body or extra trigger as reviewed', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw("CREATE OR REPLACE FUNCTION public.admin_label_operation_immutable_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN RETURN NEW; END$$"));
      expect(await inspectAdminLabelOperation(tx, f.names)).toBe(false);
    });
    await rolledBack(async tx => {
      await tx.execute(sql.raw('CREATE TRIGGER owned_extra_aeo BEFORE INSERT ON public.admin_label_operation FOR EACH ROW EXECUTE FUNCTION public.admin_label_operation_immutable_v1()'));
      expect(await inspectAdminLabelOperation(tx, f.names)).toBe(false);
    });
  });
  it.each([
    ['non-v4 UUID', '00000000-0000-0000-0000-000000000000', 1, 'label_create', 0, 'a'.repeat(64), 'a'.repeat(64), 'committed', '{}', 1],
    ['actor', crypto.randomUUID(), 0, 'label_create', 0, 'a'.repeat(64), 'a'.repeat(64), 'committed', '{}', 1],
    ['operation', crypto.randomUUID(), 1, 'issue', 0, 'a'.repeat(64), 'a'.repeat(64), 'committed', '{}', 1],
    ['negative target', crypto.randomUUID(), 1, 'label_delete', -1, 'a'.repeat(64), 'a'.repeat(64), 'committed', '{}', 1],
    ['payload_hash', crypto.randomUUID(), 1, 'label_update', 1, 'secret', 'a'.repeat(64), 'committed', '{}', 1],
    ['revision', crypto.randomUUID(), 1, 'label_update', 1, 'a'.repeat(64), 'A'.repeat(64), 'committed', '{}', 1],
    ['state', crypto.randomUUID(), 1, 'label_update', 0, 'a'.repeat(64), 'a'.repeat(64), 'pending', '{}', 1],
    ['result array', crypto.randomUUID(), 1, 'label_update', 0, 'a'.repeat(64), 'a'.repeat(64), 'committed', '[]', 1],
    ['created at', crypto.randomUUID(), 1, 'label_update', 0, 'a'.repeat(64), 'a'.repeat(64), 'committed', '{}', 0],
  ])('actual SQL rejects invalid %s evidence', async (_name, id, actor, operation, target, payload_hash, revision, state, result, created) => {
    await expect(f.db.execute(sql`INSERT INTO public.admin_label_operation VALUES
      (${id}::uuid,${actor},${operation},${target},${payload_hash},${revision},${state},${result}::jsonb,${created})`)).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  function intent(operation:LabelAction['operation']='sync'):LabelAction {
    const action:LabelAction={operation_id:crypto.randomUUID(),actor_id:1,operation,target_id:operation==='sync'?0:3,revision:hex,payload:{},payload_hash:''};
    action.payload_hash=labelDigest(labelCanonical(action));return action;
  }
  const service=()=>new AdminUserLabelAuthorService(f.container,{} as Env);
  async function append(a:LabelAction,state:'queued'|'planned'|'dispatch'|'confirmed'|'committed',step:number) {
    return f.asAdmin(()=>f.db.transaction(tx=>service().append(tx as unknown as DbClient,a,state,step,
      {id:a.target_id,created:0,updated:a.operation==='sync'?0:1,count:0,revision:a.revision,message:'Owned immutable event'},{stage:state})));
  }
  const events=(a:LabelAction)=>f.asAdmin(()=>f.db.transaction(tx=>service().events(tx as unknown as DbClient,a)));
  async function direct(a:LabelAction,step:number,patch:Record<string,unknown>={}) {
    const row={operation_id:crypto.randomUUID(),actor_id:a.actor_id,operation:a.operation,target_id:a.target_id,
      payload_hash:a.payload_hash,revision:a.revision,state:'planned',result:{command_id:a.operation_id,step,
        public:{id:a.target_id,created:0,updated:0,count:0,revision:a.revision,message:'Owned event'},data:{}},...patch};
    await f.asAdmin(()=>f.db.execute(sql`INSERT INTO public.admin_label_operation VALUES(${row.operation_id}::uuid,${row.actor_id},${row.operation},${row.target_id},${row.payload_hash},${row.revision},${row.state},${JSON.stringify(row.result)}::jsonb,1)`));
  }
  it('stores queued→planned→dispatch→confirmed as new UUID rows with one immutable command anchor',async()=>{
    const a=intent(),states=['queued','planned','dispatch','confirmed'] as const;const rows:LabelEvent[]=[];
    for(const [step,state]of states.entries())rows.push(await append(a,state,step));
    expect(rows[0]!.operation_id).toBe(a.operation_id);expect(new Set(rows.map(r=>r.operation_id)).size).toBe(4);
    expect(rows.every(r=>r.result.command_id===a.operation_id)).toBe(true);
    expect((await events(a)).map(r=>[r.result.step,r.state])).toEqual([[3,'confirmed'],[2,'dispatch'],[1,'planned'],[0,'queued']]);
    const stored=await f.db.execute(sql`SELECT operation_id::text AS id,state,result FROM public.admin_label_operation WHERE result->>'command_id'=${a.operation_id} ORDER BY (result->>'step')::integer`);
    expect(Array.from(stored,r=>r.state)).toEqual([...states]);expect(stored[0]!.id).toBe(a.operation_id);
  });
  it.each(['duplicate','gap'] as const)('refuses an immutable %s event sequence instead of choosing one head',async kind=>{
    const a=intent();await append(a,'queued',0);await direct(a,kind==='duplicate'?0:2);await expect(events(a)).rejects.toThrow(/不连续|首记录|损坏/);
  });
  it('requires the step-zero operation UUID to be the exact command anchor',async()=>{
    const a=intent();await direct(a,0,{state:'queued'});await expect(events(a)).rejects.toThrow();
  });
  it('keeps local CRUD to a single step-zero terminal receipt',async()=>{
    const a=intent('label_delete');await append(a,'committed',0);await direct(a,1,{state:'committed',result:{command_id:a.operation_id,step:1,public:{id:3,created:0,updated:1,count:0,revision:a.revision,message:'Invalid second local terminal'},data:{}}});await expect(events(a)).rejects.toThrow();
  });
  it.each(['actor','hash'] as const)('rejects a different %s inside an otherwise consecutive command',async change=>{
    const a=intent();await append(a,'queued',0);await direct(a,1,change==='actor'?{actor_id:2}:{payload_hash:'b'.repeat(64)});await expect(events(a)).rejects.toThrow(/不同操作|损坏/);
  });
  it('never seals a later planned batch as not-applied after a prior confirmed remote creation',async()=>{
    const a=intent(),states=['queued','planned','dispatch','confirmed','planned'] as const;
    for(const[step,state]of states.entries())await append(a,state,step);
    const actor={id:1,authVersion:md5('owned-label-event-password'),expiresAt:Math.floor(Date.now()/1000)+3600};
    const receipt=await f.asAdmin(()=>service().resolve(a,actor));
    expect(receipt.state).not.toBe('not_applied');
    const chain=[...await events(a)].reverse();expect(chain.slice(0,5).map(r=>r.state)).toEqual([...states]);
  });
});
