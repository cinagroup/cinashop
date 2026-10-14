import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProductReply, storeProductReplyComment, storeProduct, storeProductAttrValue,
  storeOrder, storeOrderCartInfo, userRelation, systemLog, systemRole, systemMenus } from '@/models/schema';
import { AdminProductReplyService } from '@/services/admin/AdminProductReplyService';
import { ReplyService } from '@/services/product/ReplyService';
import { SupplierProductReplyService } from '@/services/supplier/SupplierProductReplyService';
import { replyActor, replyBody, replySchema, seedReplies } from './helpers/adminProductReplies';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock, waitForFinanceClock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login = SequenceRunnerPeer & { role: string };
const query = () => new URLSearchParams();
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function hasCode(error: unknown, expected: string): boolean {
  for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
    if ('code' in error && String(error.code) === expected) return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin real review threads on independent PG16 LOGINs and public/Supplier parent-first writers', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(replySchema))).join('\n');
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native reply fixture forbids external I/O'));
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Independent PG16 LOGIN peers required');
    await f.exec(ddl); await seedReplies(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_reply_comment','id'),1000,false)");
    await f.exec("SELECT setval(pg_get_serial_sequence('user_relation','id'), (SELECT max(id) FROM user_relation), true)");
  }, 60000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  const admin = (db: DbClient) => new AdminProductReplyService(createContainerFromDb(db));
  const customer = (db: DbClient) => new ReplyService(createContainerFromDb(db));
  const supplier = (db: DbClient) => new SupplierProductReplyService(createContainerFromDb(db));
  const setReply = (peer: SequenceRunnerPeer, id = 10, actor = replyActor()) => admin(peer.db).setReply(id, replyBody('原生平台一级回复'), actor);
  const saveComment = (peer: SequenceRunnerPeer, actor = replyActor()) => admin(peer.db).saveComment(10, 101, replyBody('原生平台二级回复'), actor);
  const removeComment = (peer: SequenceRunnerPeer, id = 100, actor = replyActor()) => admin(peer.db).removeComment(id, query(), undefined, actor);
  const remove = (peer: SequenceRunnerPeer, id = 10, actor = replyActor()) => admin(peer.db).remove(id, query(), undefined, actor);
  async function login<T>(write: boolean, run: (peer: Login) => Promise<T>) {
    return f.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe owned LOGIN');
      await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}"`);
      if (write) await f.exec(`GRANT INSERT,UPDATE,DELETE ON public.store_product_reply_comment TO "${peer.role}";
        GRANT UPDATE ON public.store_product_reply TO "${peer.role}";
        GRANT INSERT ON public.system_log TO "${peer.role}";
        GRANT UPDATE ON public.system_admin,public.system_role TO "${peer.role}";
        GRANT UPDATE(id) ON public.store_product TO "${peer.role}";
        GRANT UPDATE(id) ON public.system_menus TO "${peer.role}";
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${peer.role}"`);
      const [identity] = await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid });
      expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      return run(peer);
    });
  }
  async function snapshot() {
    return { replies: await f.db.select().from(storeProductReply).orderBy(storeProductReply.id),
      comments: await f.db.select().from(storeProductReplyComment).orderBy(storeProductReplyComment.id),
      relations: await f.db.select().from(userRelation).orderBy(userRelation.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      skus: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
      orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
      carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }
  async function assertParentWait(waiter: number, blocker: number) {
    await waitForFinanceBlock(f.db, waiter, blocker);
    const [activity] = await f.exec(`SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=${waiter}`) as unknown as Array<{ wait_event_type: string; query: string }>;
    expect(activity.wait_event_type).toBe('Lock');
    expect(activity.query).toContain('"store_product_reply"');
    expect(activity.query.toLowerCase()).toContain('for update');
  }
  async function holdAudit() {
    await f.exec(`CREATE FUNCTION hold_reply_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731750,0); RETURN NEW; END $$;
      CREATE TRIGGER hold_reply_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW
      WHEN (NEW.type='product_reply_moderation') EXECUTE FUNCTION hold_reply_audit_fixture()`);
  }
  async function probe(index: number, name = 'native_reply_probe') {
    const [row] = await f.exec(`SELECT last_value,is_called FROM ${name}`) as unknown as Array<{ last_value: string | number; is_called: boolean }>;
    expect(row.is_called).toBe(true); expect(Number(row.last_value)).toBe(1000 + index);
  }

  it('reads hidden, Supplier and orphan moderation with SELECT-only LOGIN while denying product-only, wildcard and unfunded SQL writes', async () => {
    await login(false, async reader => {
      for (const id of [102, 106, 107]) {
        expect((await admin(reader.db).list(query(), replyActor(id))).count).toBe(5);
        expect(await admin(reader.db).getReply(20, query(), replyActor(id))).toEqual({ content: '' });
        expect((await admin(reader.db).comments(10, query(), replyActor(id))).count).toBe(2);
      }
      for (const id of [103, 104, 108]) await expect(admin(reader.db).list(query(), replyActor(id))).rejects.toThrow('权限');
      const before = await snapshot();
      await expect(reader.exec('UPDATE public.store_product_reply SET is_del=1 WHERE id=10')).rejects.toMatchObject({ code: '42501' });
      const result = await outcome(setReply(reader));
      expect(result.ok).toBe(false); if (!result.ok) expect(hasCode(result.error, '42501')).toBe(true);
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('completes numeric-authority moderation with id-only product lock permission, comment DML, parent UPDATE, INSERT-only audit and no product content/order/like write privileges', async () => {
    await login(true, async writer => {
      const [acl] = await writer.exec(`SELECT has_table_privilege(current_user,'public.system_log','INSERT') AS audit_insert,
        has_table_privilege(current_user,'public.system_log','UPDATE') AS audit_update,
        has_table_privilege(current_user,'public.store_product','UPDATE') AS product_update,
        has_column_privilege(current_user,'public.store_product','id','UPDATE') AS product_lock,
        has_column_privilege(current_user,'public.store_product','star','UPDATE') AS product_star_update,
        has_column_privilege(current_user,'public.store_product','stock','UPDATE') AS product_stock_update,
        has_table_privilege(current_user,'public.store_order','UPDATE') AS order_update,
        has_table_privilege(current_user,'public.user_relation','DELETE') AS relation_delete,
        has_column_privilege(current_user,'public.system_menus','id','UPDATE') AS menu_lock,
        has_column_privilege(current_user,'public.system_menus','api_url','UPDATE') AS menu_rewrite`);
      expect(acl).toEqual({ audit_insert: true, audit_update: false, product_update: false,
        product_lock: true, product_star_update: false, product_stock_update: false,
        order_update: false, relation_delete: false, menu_lock: true, menu_rewrite: false });
      await expect(writer.exec('UPDATE public.system_log SET store_id=73 WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(writer.exec("UPDATE public.store_product SET store_name='forged' WHERE false")).rejects.toMatchObject({ code: '42501' });
      await expect(writer.exec('UPDATE public.store_product SET star=star WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(writer.exec('UPDATE public.store_product SET stock=stock WHERE false')).rejects.toMatchObject({ code: '42501' });
      const before = await snapshot(), actor = replyActor(105);
      await setReply(writer, 20, actor);
      expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 20)))[0].isReply).toBe(0);
      expect((await admin(writer.db).getReply(20, query(), actor)).content).toBe('原生平台一级回复');
      await saveComment(writer, actor);
      await removeComment(writer, 101, actor);
      await admin(writer.db).status(10, { status: 1 }, actor);
      await remove(writer, 10, actor);
      const after = await snapshot();
      for (const key of ['relations', 'products', 'skus', 'orders', 'carts'] as const) expect(after[key]).toEqual(before[key]);
      expect(after.replies.find(row => row.id === 10)).toEqual({ ...before.replies.find(row => row.id === 10)!, status: 1, isDel: 1 });
      expect(after.comments.find(row => row.id === 110)).toEqual(before.comments.find(row => row.id === 110));
      expect(after.logs.map(row => row.method)).toEqual(['PUT', 'POST', 'DELETE', 'POST', 'DELETE']);
      expect(after.logs.map(row => JSON.parse(row.action).operation)).toEqual(['set_reply', 'save_comment', 'delete_comment', 'status', 'delete_reply']);
      expect(after.logs.every(row => row.adminId === 105 && row.type === 'product_reply_moderation'
        && row.storeId === 0 && row.merchantId === 0 && row.adminName === '' && row.ip === '')).toBe(true);
    });
  }, 60000);

  it('orders actual public comment praise before Admin physical deletion on the parent lock and preserves like evidence', async () => {
    await login(true, deleting => f.withPeer!(async praising => {
      const ready = signal(), release = signal();
      const held = outcome(praising.db.transaction(async tx => {
        expect(await customer(tx as unknown as DbClient).praiseComment(2, 120)).toEqual({ praise: 1, isPraise: true });
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const deletion = outcome(removeComment(deleting, 120));
      try { await assertParentWait(deleting.pid, praising.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await deletion).ok).toBe(true);
      expect(await f.db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, 120))).toEqual([]);
      expect(await f.db.select().from(userRelation).where(eq(userRelation.relationId, 120)))
        .toMatchObject([{ uid: 2, relationId: 120, type: 'like', category: 'comment' }]);
      expect((await admin(deleting.db).comments(20, query(), replyActor())).count).toBe(0);
    }));
  }, 60000);

  it('holds late actual public praise behind audited Admin comment deletion and refuses its disappeared target', async () => {
    await holdAudit();
    await login(true, deleting => f.withPeer!(async blocker => f.withPeer!(async praising => {
      await blocker.exec('SELECT pg_advisory_lock(731750,0)');
      const deletion = outcome(removeComment(deleting, 120));
      let praise: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, deleting.pid, blocker.pid);
        praise = outcome(customer(praising.db).praiseComment(2, 120));
        await assertParentWait(praising.pid, deleting.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731750,0)'); }
      expect((await deletion).ok).toBe(true);
      const late = await praise!; expect(late.ok).toBe(false);
      if (!late.ok) expect(String(late.error)).toContain('不存在');
      expect(await f.db.select().from(userRelation).where(eq(userRelation.relationId, 120))).toEqual([]);
      expect((await customer(praising.db).commentList(20)).some(row => row.id === 120)).toBe(false);
      expect((await f.db.select().from(systemLog))).toHaveLength(1);
    })));
  }, 60000);

  it('orders actual customer replyComment before central review soft deletion and retains the committed customer evidence', async () => {
    await login(true, deleting => f.withPeer!(async posting => {
      const ready = signal(), release = signal();
      let createdId = 0;
      const held = outcome(posting.db.transaction(async tx => {
        createdId = (await customer(tx as unknown as DbClient).replyComment(2, 20, '并发提交的真实客户评论')).id;
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const deletion = outcome(remove(deleting, 20));
      try { await assertParentWait(deleting.pid, posting.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await deletion).ok).toBe(true);
      expect(createdId).toBe(1000);
      expect((await f.db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, createdId)))[0])
        .toMatchObject({ uid: 2, replyId: 20, type: 0, relationId: 0, content: '并发提交的真实客户评论' });
      expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 20)))[0].isDel).toBe(1);
      expect(await customer(posting.db).commentList(20)).toEqual([]);
    }));
  }, 60000);

  it('orders actual public review praise before central soft deletion and retains its committed counter and like relationship', async () => {
    await login(true, deleting => f.withPeer!(async praising => {
      const ready = signal(), release = signal();
      const held = outcome(praising.db.transaction(async tx => {
        expect(await customer(tx as unknown as DbClient).praise(2, 20)).toEqual({ praise: 1, isPraise: true });
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const deletion = outcome(remove(deleting, 20));
      try { await assertParentWait(deleting.pid, praising.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await deletion).ok).toBe(true);
      expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 20)))[0]).toMatchObject({ praise: 1, isDel: 1 });
      expect(await f.db.select().from(userRelation).where(eq(userRelation.relationId, 20)))
        .toMatchObject([{ uid: 2, relationId: 20, type: 'like', category: 'reply' }]);
      await expect(customer(praising.db).praise(1, 20)).rejects.toThrow('不存在');
      expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 20)))[0].praise).toBe(1);
    }));
  }, 60000);

  it('holds late actual customer replyComment behind Admin soft deletion and creates neither comment nor praise after the commit', async () => {
    await holdAudit(); const before = await snapshot();
    await login(true, deleting => f.withPeer!(async blocker => f.withPeer!(async posting => {
      await blocker.exec('SELECT pg_advisory_lock(731750,0)');
      const deletion = outcome(remove(deleting, 20));
      let comment: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, deleting.pid, blocker.pid);
        comment = outcome(customer(posting.db).replyComment(2, 20, '迟到客户评论不能复建线程'));
        await assertParentWait(posting.pid, deleting.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731750,0)'); }
      expect((await deletion).ok).toBe(true);
      const late = await comment!; expect(late.ok).toBe(false); if (!late.ok) expect(String(late.error)).toContain('不存在');
      const after = await snapshot(); expect(after.comments).toEqual(before.comments); expect(after.relations).toEqual(before.relations);
      await expect(customer(posting.db).praiseComment(2, 120)).rejects.toThrow('不存在');
      expect(await customer(posting.db).commentList(20)).toEqual([]);
    })));
  }, 60000);

  it('orders the actual Supplier reply before central Admin reply and retains two separate roots and the Supplier reply flag', async () => {
    await login(true, replying => f.withPeer!(async supplierPeer => {
      const ready = signal(), release = signal();
      const held = outcome(supplierPeer.db.transaction(async tx => {
        expect(await supplier(tx as unknown as DbClient).setReply(20, 20, '供应商先提交的真实回复')).toMatchObject({ id: 20, comment_id: 110, is_reply: 1 });
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const central = outcome(setReply(replying, 20));
      try { await assertParentWait(replying.pid, supplierPeer.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await central).ok).toBe(true);
      const parent = (await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 20)))[0];
      expect(parent.isReply).toBe(1);
      expect((await admin(replying.db).getReply(20, query(), replyActor())).content).toBe('原生平台一级回复');
      const preview = await supplier(supplierPeer.db).list(20, {});
      expect(preview.list[0].replyComment?.content).toBe('供应商先提交的真实回复');
      expect((await f.db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.replyId, 20))).filter(row => row.uid === 0))
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: 110, type: 2, relationId: 20 }), expect.objectContaining({ id: 1000, type: 0, relationId: 0 })]));
    }));
  }, 60000);

  it('holds actual Supplier reply behind an audited central Admin root while preserving each owner response', async () => {
    await holdAudit();
    await login(true, replying => f.withPeer!(async blocker => f.withPeer!(async supplierPeer => {
      await blocker.exec('SELECT pg_advisory_lock(731750,0)');
      const central = outcome(setReply(replying, 20));
      let own: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, replying.pid, blocker.pid);
        own = outcome(supplier(supplierPeer.db).setReply(20, 20, '平台回复提交后的供应商回复'));
        await assertParentWait(supplierPeer.pid, replying.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731750,0)'); }
      expect((await central).ok).toBe(true); expect((await own!).ok).toBe(true);
      const root = await admin(replying.db).getReply(20, query(), replyActor());
      expect(root).toMatchObject({ id: 1000, type: 0, relation_id: 0, content: '原生平台一级回复' });
      expect((await supplier(supplierPeer.db).list(20, {})).list[0].replyComment?.content).toBe('平台回复提交后的供应商回复');
      expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 20)))[0].isReply).toBe(1);
      expect(await f.db.select().from(systemLog)).toHaveLength(1);
    })));
  }, 60000);

  it('holds current-role revocation behind an authenticated write waiting on its parent and denies every subsequent action', async () => {
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async revoking => {
      const ready = signal(), release = signal();
      const held = outcome(blocker.db.transaction(async tx => {
        await tx.select().from(storeProductReply).where(eq(storeProductReply.id, 10)).for('update');
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const write = outcome(setReply(writer)); let revocation: ReturnType<typeof outcome> | undefined;
      try {
        await assertParentWait(writer.pid, blocker.pid);
        revocation = outcome(revoking.db.update(systemRole).set({ rules: 'reply.view' }).where(eq(systemRole.id, 1)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await write).ok).toBe(true); expect((await revocation!).ok).toBe(true);
      const before = await snapshot();
      for (const operation of [() => setReply(writer), () => saveComment(writer), () => removeComment(writer),
        () => remove(writer), () => admin(writer.db).status(10, { status: 1 }, replyActor())]) await expect(operation()).rejects.toThrow('权限');
      expect(await snapshot()).toEqual(before); expect(before.logs).toHaveLength(1);
    })));
  }, 60000);

  it('locks exact numeric reply API189 through a parent wait and commits before that menu revoke', async () => {
    await f.db.update(systemRole).set({ rules: '189' }).where(eq(systemRole.id, 5));
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async revoking => {
      const ready = signal(), release = signal();
      const held = outcome(blocker.db.transaction(async tx => {
        await tx.select().from(storeProductReply).where(eq(storeProductReply.id, 10)).for('update');
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const write = outcome(setReply(writer, 10, replyActor(105))); let revocation: ReturnType<typeof outcome> | undefined;
      try {
        await assertParentWait(writer.pid, blocker.pid);
        revocation = outcome(revoking.db.update(systemMenus).set({ access: 0 }).where(eq(systemMenus.id, 189)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await write).ok).toBe(true); expect((await revocation!).ok).toBe(true);
      const before = await snapshot();
      await expect(setReply(writer, 10, replyActor(105))).rejects.toThrow('权限');
      expect(await snapshot()).toEqual(before); expect(before.logs).toHaveLength(1);
    })));
  }, 60000);

  it('rolls back a pending parent-locked response when the original authenticated session expires during the proven wait', async () => {
    const before = await snapshot();
    await login(true, writer => f.withPeer!(async blocker => {
      const ready = signal(), release = signal();
      const held = outcome(blocker.db.transaction(async tx => {
        await tx.select().from(storeProductReply).where(eq(storeProductReply.id, 10)).for('update');
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const actor = { ...replyActor(), expiresAt: Math.ceil((Date.now() + 250) / 1000) };
      const write = outcome(setReply(writer, 10, actor));
      try { await assertParentWait(writer.pid, blocker.pid); await waitForFinanceClock(f.db, actor.expiresAt * 1000); }
      finally { release.resolve(); }
      expect((await held).ok).toBe(true);
      const late = await write; expect(late.ok).toBe(false); if (!late.ok) expect(String(late.error)).toContain('过期');
      expect(await snapshot()).toEqual(before);
    }));
  }, 60000);

  it('proves all 24 default audit identity mutations reach owned native triggers under INSERT-only audit privilege and roll back', async () => {
    await f.exec('CREATE SEQUENCE native_reply_probe START 1000');
    const before = await snapshot(); let reached = 0;
    await login(true, async writer => {
      const [acl] = await writer.exec("SELECT has_table_privilege(current_user,'public.system_log','INSERT') AS audit_insert,has_table_privilege(current_user,'public.system_log','UPDATE') AS audit_update");
      expect(acl).toEqual({ audit_insert: true, audit_update: false });
      await expect(writer.exec('UPDATE public.system_log SET store_id=73 WHERE false')).rejects.toMatchObject({ code: '42501' });
      for (const phase of ['BEFORE', 'AFTER'] as const) {
        for (const [column, value] of [['store_id', '73'], ['merchant_id', '91'], ['admin_name', "'forged actor'"], ['ip', "'203.0.113.91'"]]) {
          const effect = phase === 'BEFORE' ? `NEW.${column}=${value};` : `UPDATE public.system_log SET ${column}=${value} WHERE id=NEW.id;`;
          // Only this fixture-owned trigger can tamper with the audit. The
          // application connects as a true LOGIN which has no audit UPDATE.
          await f.exec(`CREATE OR REPLACE FUNCTION tamper_native_reply_identity() RETURNS trigger LANGUAGE plpgsql
            SECURITY DEFINER SET search_path=public,pg_catalog AS $$ BEGIN PERFORM nextval('public.native_reply_probe'); ${effect} RETURN NEW; END $$;
            CREATE TRIGGER tamper_native_reply_identity ${phase} INSERT ON public.system_log FOR EACH ROW
            WHEN (NEW.type='product_reply_moderation') EXECUTE FUNCTION tamper_native_reply_identity()`);
          try {
            for (const mutate of [() => setReply(writer), () => saveComment(writer), () => removeComment(writer)]) {
              await expect(mutate()).rejects.toThrow(phase === 'BEFORE' ? '审计回执不完整' : '审计回读不一致');
              await probe(reached++); expect(await snapshot()).toEqual(before);
            }
          } finally { await f.exec('DROP TRIGGER IF EXISTS tamper_native_reply_identity ON public.system_log'); }
        }
      }
    });
    expect(reached).toBe(24);
  }, 60000);

  it('proves real skipped comment INSERT UPDATE DELETE and parent UPDATE cannot produce a success or committed audit', async () => {
    await f.exec(`CREATE SEQUENCE native_reply_probe START 1000;
      CREATE FUNCTION skip_native_reply_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('native_reply_probe'); RETURN NULL; END $$;
      CREATE TRIGGER skip_native_reply_dml BEFORE UPDATE ON store_product_reply FOR EACH ROW EXECUTE FUNCTION skip_native_reply_dml();
      CREATE TRIGGER skip_native_comment_dml BEFORE INSERT OR UPDATE OR DELETE ON store_product_reply_comment FOR EACH ROW EXECUTE FUNCTION skip_native_reply_dml()`);
    const before = await snapshot(); let reached = 0;
    await login(true, async writer => {
      const operations: Array<{ mutate: () => Promise<unknown>; calls: number }> = [
        { mutate: () => setReply(writer), calls: 1 }, { mutate: () => setReply(writer, 11), calls: 1 },
        { mutate: () => saveComment(writer), calls: 1 }, { mutate: () => removeComment(writer), calls: 2 },
        { mutate: () => remove(writer), calls: 1 }, { mutate: () => admin(writer.db).status(10, { status: 1 }, replyActor()), calls: 1 },
      ];
      for (const operation of operations) {
        await expect(operation.mutate()).rejects.toThrow('回执');
        reached += operation.calls; await probe(reached - 1); expect(await snapshot()).toEqual(before);
      }
    });
    expect(reached).toBe(7);
  }, 60000);

  it('proves skipped native audit INSERT was reached for response creation child creation and physical deletion then rolls back', async () => {
    await f.exec(`CREATE SEQUENCE native_reply_probe START 1000;
      CREATE FUNCTION skip_native_reply_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('native_reply_probe'); RETURN NULL; END $$;
      CREATE TRIGGER skip_native_reply_audit BEFORE INSERT ON system_log FOR EACH ROW
      WHEN (NEW.type='product_reply_moderation') EXECUTE FUNCTION skip_native_reply_audit()`);
    const before = await snapshot();
    await login(true, async writer => {
      const operations = [() => setReply(writer), () => saveComment(writer), () => removeComment(writer)];
      for (let index = 0; index < operations.length; index++) {
        await expect(operations[index]()).rejects.toThrow('审计');
        await probe(index); expect(await snapshot()).toEqual(before);
      }
    });
  }, 60000);

  it('rolls back DML-side cross-parent response rewrites and exact-ID reconstruction after physical deletion', async () => {
    await f.exec(`CREATE SEQUENCE native_reply_probe START 1000;
      CREATE FUNCTION move_native_reply_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('native_reply_probe'); NEW.reply_id=11; RETURN NEW; END $$;
      CREATE TRIGGER move_native_reply_dml BEFORE INSERT OR UPDATE ON store_product_reply_comment FOR EACH ROW EXECUTE FUNCTION move_native_reply_dml()`);
    const before = await snapshot();
    await login(true, async writer => {
      for (const [index, mutate] of [() => setReply(writer), () => saveComment(writer)].entries()) {
        await expect(mutate()).rejects.toThrow('回执'); await probe(index); expect(await snapshot()).toEqual(before);
      }
      await f.exec('DROP TRIGGER move_native_reply_dml ON store_product_reply_comment');
      await f.exec(`CREATE FUNCTION resurrect_native_reply_dml() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path=public,pg_catalog AS $$ BEGIN PERFORM nextval('public.native_reply_probe');
        INSERT INTO public.store_product_reply_comment(id,reply_id,pid,uid,content) VALUES(OLD.id,11,0,1,'DML后另父线程重建目标'); RETURN OLD; END $$;
        CREATE TRIGGER resurrect_native_reply_dml AFTER DELETE ON public.store_product_reply_comment FOR EACH ROW
        WHEN (OLD.id=100) EXECUTE FUNCTION resurrect_native_reply_dml()`);
      await expect(removeComment(writer)).rejects.toThrow(/回读|回执|核验/);
      await probe(2); expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('rolls back AFTER-audit cross-parent response moves and deleted target or direct-child reconstruction using global absence proofs', async () => {
    await f.exec('CREATE SEQUENCE native_reply_probe START 1000');
    const before = await snapshot();
    await login(true, async writer => {
      const effects = [
        { mutate: () => setReply(writer), statement: "UPDATE public.store_product_reply_comment SET reply_id=11 WHERE id=(NEW.action::jsonb->>'commentId')::integer" },
        { mutate: () => removeComment(writer), statement: "INSERT INTO public.store_product_reply_comment(id,reply_id,pid,uid,content) VALUES(100,11,0,1,'别的父评价下重建目标')" },
        { mutate: () => removeComment(writer), statement: "INSERT INTO public.store_product_reply_comment(id,reply_id,pid,uid,content) VALUES(999,11,100,1,'别的父评价下重建直属孩子')" },
      ];
      for (const [index, effect] of effects.entries()) {
        await f.exec(`CREATE OR REPLACE FUNCTION tamper_native_reply_business() RETURNS trigger LANGUAGE plpgsql
          SECURITY DEFINER SET search_path=public,pg_catalog AS $$ BEGIN PERFORM nextval('public.native_reply_probe'); ${effect.statement}; RETURN NEW; END $$;
          CREATE TRIGGER tamper_native_reply_business AFTER INSERT ON public.system_log FOR EACH ROW
          WHEN (NEW.type='product_reply_moderation') EXECUTE FUNCTION tamper_native_reply_business()`);
        try {
          await expect(effect.mutate()).rejects.toThrow(/回执|核验/);
          await probe(index); expect(await snapshot()).toEqual(before);
        } finally { await f.exec('DROP TRIGGER IF EXISTS tamper_native_reply_business ON public.system_log'); }
      }
    });
  }, 60000);
});
