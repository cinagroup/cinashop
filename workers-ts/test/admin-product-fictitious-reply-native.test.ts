import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProductReply, storeProductReplyComment, storeProduct, storeProductAttrValue,
  storeOrder, storeOrderCartInfo, user, userRelation, systemLog, systemRole, systemMenus, systemAttachment } from '@/models/schema';
import { AdminProductFictitiousReplyService } from '@/services/admin/AdminProductFictitiousReplyService';
import { AdminProductReplyService } from '@/services/admin/AdminProductReplyService';
import { ReplyService } from '@/services/product/ReplyService';
import { SupplierProductReplyService } from '@/services/supplier/SupplierProductReplyService';
import { lockReviewProducts, refreshProductReviewStar } from '@/services/product/ProductReviewRatingService';
import { fictitiousSchema, seedFictitiousReplies, resetFictitiousSequences, fictitiousBody, fictitiousActor, fictitiousPrivateMediaBody } from './helpers/adminProductFictitiousReplies';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock, waitForFinanceClock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login = SequenceRunnerPeer & { role: string };
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
function hasCode(error: unknown, expected: string): boolean {
  for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
    if ('code' in error && String(error.code) === expected) return true;
    error = 'cause' in error ? error.cause : undefined;
  } return false;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('virtual review PG16 independent LOGIN receipts and real public/Supplier/product producer locks', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => { const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(fictitiousSchema))).join('\n'); });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native virtual-review fixture forbids remote I/O'));
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Independent owned PG16 LOGIN peers required');
    await f.exec(ddl); await seedFictitiousReplies(f.db); await resetFictitiousSequences(f.exec);
  }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const fake = (db: DbClient) => new AdminProductFictitiousReplyService(createContainerFromDb(db));
  const customer = (db: DbClient) => new ReplyService(createContainerFromDb(db));
  const moderator = (db: DbClient) => new AdminProductReplyService(createContainerFromDb(db));
  const supplier = (db: DbClient) => new SupplierProductReplyService(createContainerFromDb(db));
  const create = (peer: SequenceRunnerPeer, body: unknown = fictitiousBody(), actor = fictitiousActor(110)) => fake(peer.db).create(body, actor);
  async function login<T>(write: boolean, run: (peer: Login) => Promise<T>) {
    return f.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe runtime LOGIN');
      await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}"`);
      if (write) await f.exec(`GRANT INSERT ON public.store_product_reply,public.system_log TO "${peer.role}";
        GRANT UPDATE(star,id) ON public.store_product TO "${peer.role}";
        GRANT UPDATE(id) ON public.store_product_attr_value,public.system_menus TO "${peer.role}";
        GRANT UPDATE(att_id) ON public.system_attachment TO "${peer.role}";
        GRANT UPDATE ON public.system_admin,public.system_role TO "${peer.role}";
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${peer.role}"`);
      const [identity] = await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid });
      expect(Math.floor(Number(identity.version) / 10000)).toBe(16); return run(peer);
    });
  }
  async function snapshot() { return { reviews: await f.db.select().from(storeProductReply).orderBy(storeProductReply.id),
    comments: await f.db.select().from(storeProductReplyComment).orderBy(storeProductReplyComment.id),
    products: await f.db.select().from(storeProduct).orderBy(storeProduct.id), skus: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
    customers: await f.db.select().from(user).orderBy(user.uid), orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
    carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id), relations: await f.db.select().from(userRelation).orderBy(userRelation.id),
    logs: await f.db.select().from(systemLog).orderBy(systemLog.id), attachments: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId) }; }
  async function productWait(waiter: number, blocker: number) {
    await waitForFinanceBlock(f.db, waiter, blocker);
    const [activity] = await f.exec(`SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=${waiter}`) as unknown as Array<{ wait_event_type: string; query: string }>;
    expect(activity.wait_event_type).toBe('Lock');
    expect(String(activity.query)).toContain('pg_advisory_xact_lock');
    const locks = await f.exec(`SELECT classid,objsubid FROM pg_locks WHERE pid=${waiter} AND locktype='advisory' AND granted=false`);
    expect(locks).toEqual(expect.arrayContaining([expect.objectContaining({ classid: 731617, objsubid: 2 })]));
  }
  async function holdAudit(type = 'product_fictitious_reply') {
    await f.exec(`CREATE FUNCTION hold_fictitious_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731751,0); RETURN NEW; END $$;
      CREATE TRIGGER hold_fictitious_audit BEFORE INSERT ON system_log FOR EACH ROW
      WHEN (NEW.type='${type}') EXECUTE FUNCTION hold_fictitious_audit()`);
  }
  async function addRealOrder(multiple = false) {
    await f.db.insert(storeOrder).values({ id: 80, uid: 2, orderId: 'real-order-after-fake', paid: 1, status: 2 });
    await f.db.insert(storeOrderCartInfo).values(multiple ? [
      { id: 81, uid: 2, oid: 80, productId: 20, unique: 'real-cart-supplier', type: 2, relationId: 20, skuUnique: 'supplysk', isGift: 0 },
      { id: 82, uid: 2, oid: 80, productId: 10, unique: 'real-cart-platform', skuUnique: 'replysku', isGift: 0 },
    ] : [{ id: 81, uid: 2, oid: 80, productId: 10, unique: 'real-cart-platform', skuUnique: 'replysku', isGift: 0 }]);
  }
  const submit = (peer: SequenceRunnerPeer, productScore = 5) => customer(peer.db).submitReply(2, {
    unique: 'real-cart-platform', comment: '真实顾客订单正文', productScore, serviceScore: 4, logisticsScore: 3, pics: [],
  });

  it('reads source form/catalogue under SELECT-only LOGIN, preserves independent193 permission and refuses unfunded creation SQL', async () => {
    await login(false, async reader => {
      expect((await fake(reader.db).form(20, new URLSearchParams(), fictitiousActor(109))).rules[0]).toMatchObject({ field: 'product_id', value: 20 });
      expect((await fake(reader.db).products(new URLSearchParams(), fictitiousActor(114))).count).toBe(5);
      await expect(fake(reader.db).products(new URLSearchParams(), fictitiousActor(110))).rejects.toThrow('权限');
      const before = await snapshot();
      const result = await outcome(create(reader)); expect(result.ok).toBe(false);
      if (!result.ok) expect(hasCode(result.error, '42501')).toBe(true);
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('creates and refreshes exact truncated source star with INSERT-only audit, star-only catalogue DML and no real evidence write privileges', async () => {
    await login(true, async writer => {
      const [acl] = await writer.exec(`SELECT has_table_privilege(current_user,'public.system_log','INSERT') AS audit_insert,
        has_table_privilege(current_user,'public.system_log','UPDATE') AS audit_update,
        has_column_privilege(current_user,'public.store_product','star','UPDATE') AS star_update,
        has_column_privilege(current_user,'public.store_product','stock','UPDATE') AS stock_update,
        has_table_privilege(current_user,'public.store_product_reply','UPDATE') AS review_update,
        has_table_privilege(current_user,'public.store_order','UPDATE') AS order_update,
        has_table_privilege(current_user,'public.user','UPDATE') AS user_update`);
      expect(acl).toEqual({ audit_insert: true, audit_update: false, star_update: true, stock_update: false,
        review_update: false, order_update: false, user_update: false });
      await expect(writer.exec('UPDATE public.system_log SET ip=ip WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(writer.exec('UPDATE public.store_product SET stock=stock WHERE false')).rejects.toMatchObject({ code: '42501' });
      const before = await snapshot(); expect(await create(writer)).toEqual({ id: 1000 }); const after = await snapshot();
      expect(after.reviews.find(row => row.id === 1000)).toMatchObject({ uid: 0, oid: 0, orderCartInfoId: null, type: 0, relationId: 0, skuUnique: 'replysku', sku: '蓝' });
      expect(after.products).toEqual(before.products.map(row => row.id === 10 ? { ...row, star: '3.4' } : row));
      for (const key of ['skus', 'orders', 'carts', 'customers', 'relations', 'comments'] as const) expect(after[key]).toEqual(before[key]);
      expect(after.logs[0]).toEqual({ id: after.logs[0].id, storeId: 0, merchantId: 0, adminName: '', ip: '', adminId: 110,
        path: 'product/reply/save_fictitious_reply', page: '商品评价管理', method: 'POST', type: 'product_fictitious_reply',
        action: '{"operation":"create","id":1000,"productId":10,"skuId":72}', addTime: after.logs[0].addTime });
    });
  }, 60000);

  it('blocks actual real submitReply behind fake creation product lock then incorporates the committed fake and customer into source star', async () => {
    await addRealOrder(); await holdAudit();
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async posting => {
      await blocker.exec('SELECT pg_advisory_lock(731751,0)');
      const creation = outcome(create(writer)); let real: ReturnType<typeof outcome> | undefined;
      try { await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
        real = outcome(submit(posting)); await productWait(posting.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731751,0)'); }
      expect((await creation).ok).toBe(true); expect((await real!).ok).toBe(true);
      const after = await snapshot();
      expect(after.products.find(row => row.id === 10)!.star).toBe('3.6');
      expect(after.reviews.find(row => row.id === 1000)).toMatchObject({ uid: 0, oid: 0, orderCartInfoId: null });
      expect(after.reviews.find(row => row.id === 1001)).toMatchObject({ uid: 2, oid: 80, orderCartInfoId: 81, unique: 'real-cart-platform', comment: '真实顾客订单正文' });
      expect(after.orders.find(row => row.id === 80)!.status).toBe(3); expect(after.logs).toHaveLength(1);
    })));
  }, 60000);

  it('blocks fake creation behind an actual uncommitted customer producer and refreshes from both complete reviews after its commit', async () => {
    await addRealOrder();
    await login(true, writer => f.withPeer!(async posting => {
      const ready = signal(), release = signal();
      const held = outcome(posting.db.transaction(async tx => { await submit({ ...posting, db: tx as unknown as DbClient }, 1); ready.resolve(); await release.promise; }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const creation = outcome(create(writer));
      try { await productWait(writer.pid, posting.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await creation).ok).toBe(true);
      const after = await snapshot(); expect(after.products.find(row => row.id === 10)!.star).toBe('3.0');
      expect(after.reviews.find(row => row.id === 1000)).toMatchObject({ uid: 2, oid: 80, orderCartInfoId: 81 });
      expect(after.reviews.find(row => row.id === 1001)).toMatchObject({ uid: 0, oid: 0, orderCartInfoId: null });
    }));
  }, 60000);

  it('locks all autoCommentOrder products in ascending order before inserts even when cart order has Supplier20 before platform10', async () => {
    await addRealOrder(true);
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async automatic => {
      await blocker.exec('SELECT pg_advisory_lock(731617,10)');
      const auto = outcome(customer(automatic.db).autoCommentOrder(80));
      try {
        await productWait(automatic.pid, blocker.pid);
        // A reverse/cart-ordered producer would already hold product20 here.
        const [available] = await blocker.exec('SELECT pg_try_advisory_lock(731617,20) AS available');
        expect(available.available).toBe(true); await blocker.exec('SELECT pg_advisory_unlock(731617,20)');
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731617,10)'); }
      expect((await auto).ok).toBe(true);
      await create(writer); const after = await snapshot();
      expect(after.products.find(row => row.id === 10)!.star).toBe('3.6');
      expect(after.products.find(row => row.id === 20)!.star).toBe('5.0');
      const real = after.reviews.filter(row => row.oid === 80);
      expect(real.map(row => row.productId).sort((a, b) => a - b)).toEqual([10, 20]);
      expect(real.every(row => row.uid === 2 && row.orderCartInfoId !== null && row.comment === '此用户未作评价')).toBe(true);
      expect(after.orders.find(row => row.id === 80)!.status).toBe(3);
    })));
  }, 60000);

  it('serializes actual multi-product automatic reviews after an audited fake producer and incorporates every resulting member into the rating', async () => {
    await addRealOrder(true); await holdAudit();
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async automatic => {
      await blocker.exec('SELECT pg_advisory_lock(731751,0)'); const creation = outcome(create(writer));
      let auto: ReturnType<typeof outcome> | undefined;
      try { await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
        auto = outcome(customer(automatic.db).autoCommentOrder(80)); await productWait(automatic.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731751,0)'); }
      expect((await creation).ok).toBe(true); expect((await auto!).ok).toBe(true);
      const after = await snapshot(); expect(after.products.find(row => row.id === 10)!.star).toBe('3.6');
      expect(after.products.find(row => row.id === 20)!.star).toBe('5.0');
      expect(after.reviews.filter(row => row.oid === 80).map(row => row.orderCartInfoId).sort((a, b) => a! - b!)).toEqual([81, 82]);
      expect(after.reviews.find(row => row.id === 1000)).toMatchObject({ oid: 0, uid: 0, orderCartInfoId: null });
    })));
  }, 60000);

  it('orders the actual Supplier reply writer after fake product lock without broadening Supplier ownership or modifying fake evidence', async () => {
    await holdAudit();
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async responding => {
      await blocker.exec('SELECT pg_advisory_lock(731751,0)');
      const creation = outcome(create(writer, fictitiousBody({ image: { image: '', product_id: 20 }, unique: 'supplysk' })));
      let response: ReturnType<typeof outcome> | undefined;
      try { await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
        response = outcome(supplier(responding.db).setReply(20, 20, '供应商实际回复'));
        await productWait(responding.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731751,0)'); }
      expect((await creation).ok).toBe(true); expect((await response!).ok).toBe(true);
      const after = await snapshot(); expect(after.products.find(row => row.id === 20)!.star).toBe('3.5');
      expect(after.reviews.find(row => row.id === 1000)).toMatchObject({ type: 0, relationId: 0, uid: 0, isReply: 0, comment: '自评正文，不能绑定真实顾客或订单' });
      expect(after.comments.find(row => row.id === 110)).toMatchObject({ type: 2, relationId: 20, content: '供应商实际回复' });
      await expect(supplier(responding.db).setReply(20, 1000, '越权')).rejects.toThrow();
    })));
  }, 60000);

  it('holds source Admin soft-delete behind real producer product lock and deliberately leaves rating unchanged until the next creation event', async () => {
    await addRealOrder();
    await f.withPeer!(async posting => f.withPeer!(async deleting => {
      const ready = signal(), release = signal();
      const held = outcome(posting.db.transaction(async tx => { await submit({ ...posting, db: tx as unknown as DbClient }, 1); ready.resolve(); await release.promise; }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const removal = outcome(moderator(deleting.db).remove(10, new URLSearchParams(), undefined, fictitiousActor()));
      try { await productWait(deleting.pid, posting.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await removal).ok).toBe(true);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 10)))[0].star).toBe('3.2');
      expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 10)))[0].isDel).toBe(1);
      await fake(deleting.db).create(fictitiousBody(), fictitiousActor());
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 10)))[0].star).toBe('2.6');
    }));
  }, 60000);

  it('reports the actual Admin authority NOWAIT conflict while fake creation is in flight and permits a source no-rating-refresh delete on retry', async () => {
    await holdAudit();
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async deleting => {
      await blocker.exec('SELECT pg_advisory_lock(731751,0)'); const creation = outcome(create(writer));
      try {
        await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
        const conflict = await outcome(moderator(deleting.db).remove(10, new URLSearchParams(), undefined, fictitiousActor()));
        expect(conflict.ok).toBe(false); if (!conflict.ok) expect(String(conflict.error)).toMatch(/权限|变更|重试/);
        expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 10)))[0].isDel).toBe(0);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731751,0)'); }
      expect((await creation).ok).toBe(true);
      const before = await snapshot(); await moderator(deleting.db).remove(1000, new URLSearchParams(), undefined, fictitiousActor());
      const after = await snapshot(); expect(after.products).toEqual(before.products);
      expect(after.reviews.find(row => row.id === 1000)).toEqual({ ...before.reviews.find(row => row.id === 1000)!, isDel: 1 });
      expect(after.logs).toHaveLength(2); expect(after.products.find(row => row.id === 10)!.star).toBe('3.4');
    })));
  }, 60000);

  it('fails selected ordinary SKU row lock immediately with NOWAIT instead of deadlocking a reverse SKU→product maintenance writer', async () => {
    const before = await snapshot();
    await login(true, writer => f.withPeer!(async retiring => {
      const ready = signal(), release = signal();
      const held = outcome(retiring.db.transaction(async tx => {
        await tx.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 72)).for('update');
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const creation = outcome(create(writer));
      try { const result = await creation; expect(result.ok).toBe(false);
        if (!result.ok) expect(String(result.error)).toMatch(/变更|重试|锁|冲突/);
      } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect(await snapshot()).toEqual(before);
    }));
  }, 60000);

  it('rejects private-media publication on a proven native attachment row locker with SHARE NOWAIT and preserves all canonical and business evidence', async () => {
    const before = await snapshot();
    await login(true, writer => f.withPeer!(async changing => {
      const [acl] = await writer.exec("SELECT has_column_privilege(current_user,'public.system_attachment','att_id','UPDATE') AS media_lock,has_column_privilege(current_user,'public.system_attachment','real_name','UPDATE') AS media_rewrite");
      expect(acl).toEqual({ media_lock: true, media_rewrite: false });
      const ready = signal(), release = signal();
      const held = outcome(changing.db.transaction(async tx => {
        const rows = await tx.select().from(systemAttachment).where(eq(systemAttachment.attId, 31)).for('update');
        expect(rows).toHaveLength(1); expect(rows[0].attId).toBe(31);
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      try {
        const [lock] = await f.exec(`SELECT count(*)::integer AS locks FROM pg_locks WHERE pid=${changing.pid} AND relation='public.system_attachment'::regclass AND mode='RowShareLock' AND granted=true`) as unknown as Array<{ locks: number }>;
        expect(lock.locks).toBe(1);
        const creation = await outcome(create(writer, fictitiousPrivateMediaBody(), fictitiousActor(116)));
        expect(creation.ok).toBe(false); if (!creation.ok) {
          expect(String(creation.error)).toMatch(/变更|更新|重试|锁|冲突/); expect(hasCode(creation.error, '55P03')).toBe(true);
        }
        expect(await snapshot()).toEqual(before);
      } finally { release.resolve(); expect((await held).ok).toBe(true); }
      expect(await create(writer, fictitiousPrivateMediaBody(), fictitiousActor(116))).toEqual({ id: 1000 });
      expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 1000)))[0])
        .toMatchObject({ avatar: '/api/assets/31', pics: '["/api/assets/31"]', uid: 0, oid: 0 });
      expect((await snapshot()).attachments).toEqual(before.attachments);
    }));
  }, 60000);

  it('proves native audit owner triggers reach and roll back private attachment metadata rewrite/deletion under a gallery-authorized restricted LOGIN', async () => {
    await f.exec('CREATE SEQUENCE native_private_media_probe START 1000'); const before = await snapshot(); let reached = 0;
    await login(true, async writer => {
      await expect(writer.exec("UPDATE public.system_attachment SET real_name='forged' WHERE false")).rejects.toMatchObject({ code: '42501' });
      for (const mutation of ["UPDATE public.system_attachment SET real_name='hidden metadata rewrite' WHERE att_id=31;",
        'UPDATE public.system_attachment SET relation_id=20 WHERE att_id=31;', 'DELETE FROM public.system_attachment WHERE att_id=31;']) {
        await f.exec(`CREATE OR REPLACE FUNCTION tamper_native_private_media() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
          SET search_path=public,pg_catalog AS $$ BEGIN PERFORM nextval('public.native_private_media_probe'); ${mutation} RETURN NEW; END $$;
          CREATE TRIGGER tamper_native_private_media AFTER INSERT ON public.system_log FOR EACH ROW
          WHEN (NEW.type='product_fictitious_reply') EXECUTE FUNCTION tamper_native_private_media()`);
        try { await expect(create(writer, fictitiousPrivateMediaBody(), fictitiousActor(116))).rejects.toThrow();
          const [probe] = await f.exec('SELECT last_value,is_called FROM native_private_media_probe') as unknown as Array<{ is_called: boolean; last_value: string | number }>;
          expect(probe.is_called).toBe(true); expect(Number(probe.last_value)).toBe(1000 + reached++); expect(await snapshot()).toEqual(before);
        } finally { await f.exec('DROP TRIGGER IF EXISTS tamper_native_private_media ON public.system_log'); }
      }
    }); expect(reached).toBe(3);
  }, 60000);

  it('rolls back a complete inserted review/star/audit when the original JWT session expires during a proven audit wait', async () => {
    await holdAudit(); const before = await snapshot();
    await login(true, writer => f.withPeer!(async blocker => {
      await blocker.exec('SELECT pg_advisory_lock(731751,0)');
      const actor = { ...fictitiousActor(110), expiresAt: Math.ceil((Date.now() + 250) / 1000) };
      const creation = outcome(create(writer, fictitiousBody(), actor));
      try { await waitForFinanceBlock(f.db, writer.pid, blocker.pid); await waitForFinanceClock(f.db, actor.expiresAt * 1000); }
      finally { await blocker.exec('SELECT pg_advisory_unlock(731751,0)'); }
      const result = await creation; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('过期'); expect(await snapshot()).toEqual(before);
    }));
  }, 60000);

  it('orders concurrent real numeric-role revocation behind the live write barrier and refuses the subsequent fake creation', async () => {
    await holdAudit();
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async revoking => {
      await blocker.exec('SELECT pg_advisory_lock(731751,0)'); const creation = outcome(create(writer));
      let revoked: ReturnType<typeof outcome> | undefined;
      try { await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
        revoked = outcome(revoking.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 10)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731751,0)'); }
      expect((await creation).ok).toBe(true); expect((await revoked!).ok).toBe(true);
      const after = await snapshot(); await expect(create(writer)).rejects.toThrow('权限'); expect(await snapshot()).toEqual(after);
    })));
  }, 60000);

  it('orders genuine185 menu revocation behind the frozen numeric authority and rejects a later create using the same JWT', async () => {
    await holdAudit();
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async revoking => {
      await blocker.exec('SELECT pg_advisory_lock(731751,0)'); const creation = outcome(create(writer));
      let revoked: ReturnType<typeof outcome> | undefined;
      try { await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
        revoked = outcome(revoking.db.update(systemMenus).set({ access: 0 }).where(eq(systemMenus.id, 185)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731751,0)'); }
      expect((await creation).ok).toBe(true); expect((await revoked!).ok).toBe(true);
      const after = await snapshot(); await expect(create(writer)).rejects.toThrow('权限'); expect(await snapshot()).toEqual(after);
    })));
  }, 60000);

  it('proves all 24 audit identity/scope mutations execute native owner triggers under INSERT-only audit and roll back', async () => {
    await f.exec('CREATE SEQUENCE native_fictitious_probe START 1000'); const before = await snapshot(); let reached = 0;
    await login(true, async writer => {
      for (const phase of ['BEFORE', 'AFTER'] as const) {
        for (const [column, value] of [['id', '0'], ['store_id', '73'], ['merchant_id', '91'], ['admin_id', '100'],
          ['admin_name', "'forged actor'"], ['ip', "'203.0.113.91'"], ['path', "'wrong/path'"], ['page', "'wrong page'"],
          ['method', "'GET'"], ['action', "'{}'"], ['type', "'wrong'"], ['add_time', '1']] as const) {
          const effect = phase === 'BEFORE' ? `NEW.${column}=${value};` : `UPDATE public.system_log SET ${column}=${value} WHERE id=NEW.id;`;
          await f.exec(`CREATE OR REPLACE FUNCTION tamper_fictitious_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
            SET search_path=public,pg_catalog AS $$ BEGIN PERFORM nextval('public.native_fictitious_probe'); ${effect} RETURN NEW; END $$;
            CREATE TRIGGER tamper_fictitious_audit ${phase} INSERT ON public.system_log FOR EACH ROW
            WHEN (NEW.type='product_fictitious_reply') EXECUTE FUNCTION tamper_fictitious_audit()`);
          try { await expect(create(writer)).rejects.toThrow();
            const [probe] = await f.exec('SELECT last_value,is_called FROM native_fictitious_probe') as unknown as Array<{ is_called: boolean; last_value: string | number }>;
            expect(probe.is_called).toBe(true); expect(Number(probe.last_value)).toBe(1000 + reached++);
            expect(await snapshot()).toEqual(before);
          } finally { await f.exec('DROP TRIGGER IF EXISTS tamper_fictitious_audit ON public.system_log'); }
        }
      }
    }); expect(reached).toBe(24);
  }, 60000);

  it('proves suppressed/rewritten native review and star DML receipts roll back with no audit and no external evidence mutation', async () => {
    await f.exec('CREATE SEQUENCE native_fictitious_probe START 1000'); const before = await snapshot(); let reached = 0;
    await login(true, async writer => {
      for (const [table, event, rewrite] of [['store_product_reply', 'INSERT', 'NEW.oid=70;'],
        ['store_product', 'UPDATE', 'NEW.stock=NEW.stock+1;']] as const) {
        for (const code of ['RETURN NULL;', `${rewrite} RETURN NEW;`]) {
          await f.exec(`CREATE OR REPLACE FUNCTION tamper_fictitious_dml() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
            SET search_path=public,pg_catalog AS $$ BEGIN PERFORM nextval('public.native_fictitious_probe'); ${code} END $$;
            CREATE TRIGGER tamper_fictitious_dml BEFORE ${event} ON public.${table} FOR EACH ROW EXECUTE FUNCTION tamper_fictitious_dml()`);
          try { await expect(create(writer)).rejects.toThrow();
            const [probe] = await f.exec('SELECT last_value,is_called FROM native_fictitious_probe') as unknown as Array<{ is_called: boolean; last_value: string | number }>;
            expect(probe.is_called).toBe(true); expect(Number(probe.last_value)).toBe(1000 + reached++); expect(await snapshot()).toEqual(before);
          } finally { await f.exec(`DROP TRIGGER IF EXISTS tamper_fictitious_dml ON public.${table}`); }
        }
      }
    }); expect(reached).toBe(4);
  }, 60000);

  it('proves native skipped audit and successful audit-trigger tampering of new review, product and selected SKU are reached and fully rolled back', async () => {
    await f.exec('CREATE SEQUENCE native_fictitious_probe START 1000'); const before = await snapshot(); let reached = 0;
    await login(true, async writer => {
      for (const mutation of ['RETURN NULL;', "UPDATE public.store_product_reply SET uid=1 WHERE id=(NEW.action::jsonb->>'id')::integer; RETURN NEW;",
        "UPDATE public.store_product SET star=1 WHERE id=10; RETURN NEW;",
        "UPDATE public.store_product SET stock=stock+1 WHERE id=10; RETURN NEW;",
        "UPDATE public.store_product_attr_value SET suk='tampered snapshot' WHERE id=72; RETURN NEW;"]) {
        const phase = mutation === 'RETURN NULL;' ? 'BEFORE' : 'AFTER';
        // SECURITY DEFINER belongs to this owned fixture only; the runtime
        // LOGIN cannot UPDATE audit, existing reviews, inventory or SKU text.
        await f.exec(`CREATE OR REPLACE FUNCTION tamper_fictitious_final() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
          SET search_path=public,pg_catalog AS $$ BEGIN PERFORM nextval('public.native_fictitious_probe'); ${mutation} END $$;
          CREATE TRIGGER tamper_fictitious_final ${phase} INSERT ON public.system_log FOR EACH ROW
          WHEN (NEW.type='product_fictitious_reply') EXECUTE FUNCTION tamper_fictitious_final()`);
        try { await expect(create(writer)).rejects.toThrow();
          const [probe] = await f.exec('SELECT last_value,is_called FROM native_fictitious_probe') as unknown as Array<{ is_called: boolean; last_value: string | number }>;
          expect(probe.is_called).toBe(true); expect(Number(probe.last_value)).toBe(1000 + reached++); expect(await snapshot()).toEqual(before);
        } finally { await f.exec('DROP TRIGGER IF EXISTS tamper_fictitious_final ON public.system_log'); }
      }
    }); expect(reached).toBe(5);
  }, 60000);

  it('retains actual historical order/cart review creation when the current product is missing while refreshing the present products of the same order', async () => {
    await addRealOrder(true);
    await f.db.update(storeOrderCartInfo).set({ productId: 404 }).where(eq(storeOrderCartInfo.id, 81));
    const result = await customer(f.db).autoCommentOrder(80); expect(result).toEqual({ inserted: 2, completed: true });
    const after = await snapshot(); const real = after.reviews.filter(row => row.oid === 80);
    expect(real.find(row => row.orderCartInfoId === 81)).toMatchObject({ productId: 404, uid: 2, oid: 80, type: 2, relationId: 20 });
    expect(real.find(row => row.orderCartInfoId === 82)).toMatchObject({ productId: 10, uid: 2, oid: 80 });
    expect(after.products.find(row => row.id === 10)!.star).toBe('4.0');
    expect(after.products.find(row => row.id === 20)!.star).toBe('3.0'); expect(after.logs).toEqual([]);
  }, 60000);

  it('preserves a product existing star when the real source aggregate has no nondeleted members and computes exact tenths without float rounding', async () => {
    await f.db.delete(storeProductReply).where(eq(storeProductReply.productId, 30));
    await f.db.update(storeProduct).set({ star: '2.9' }).where(eq(storeProduct.id, 30));
    await f.db.transaction(async rawTx => { const tx = rawTx as unknown as DbClient;
      const products = await lockReviewProducts(tx, [30]); expect((await refreshProductReviewStar(tx, products.get(30)!)).star).toBe('2.9'); });
    await fake(f.db).create(fictitiousBody({ product_id: 30, image: '', unique: 'storesku', product_score: 4 }), fictitiousActor());
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 30)))[0].star).toBe('4.0');
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 10)))[0].star).toBe('3.0');
  }, 60000);
});
