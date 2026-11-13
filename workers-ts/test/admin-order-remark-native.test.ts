import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { storeOrder, storeOrderStatus, systemAdmin } from '@/models/schema';
import { withRemarkScenario, type RemarkScenario } from './helpers/adminOrderRemark';

const endpoints = [
  { name: 'desktop-number', method: 'POST', path: '/adminapi/order/remark/owned-remark-order' },
  { name: 'legacy-primary', method: 'PUT', path: '/adminapi/order/remark/820001' },
  { name: 'mobile-body', method: 'POST', path: '/api/admin/order/remark' },
  { name: 'mobile-number', method: 'POST', path: '/api/admin/order/remark/owned-remark-order' },
] as const;
const read = async (s: RemarkScenario, id = 820001) => (await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
const audits = (s: RemarkScenario) => s.f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, 820001));
const sequence = (s: RemarkScenario) => s.f.exec('SELECT last_value,is_called FROM store_order_status_id_seq');
const call = (s: RemarkScenario, e: typeof endpoints[number], remark: unknown, token = s.token()) =>
  s.request(e.method, e.path, { order_id: 'owned-remark-order', remark, admin_id: 999, paid: 1, pay_price: '999.00', uid: 22 }, token);
function privateResponse(result: Awaited<ReturnType<RemarkScenario['request']>>) {
  expect(result.headers.get('cache-control')).toContain('private'); expect(result.headers.get('cache-control')).toContain('no-store');
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin order remark through actual JWT and commissioned native LOGINs', () => {
  it.each([
    { method: 'POST', path: '/adminapi/order/remark/owned-remark-order' },
    { method: 'PUT', path: '/adminapi/order/remark/820001' },
  ])('updates the actual order through $method $path and writes one canonical audit', async ({ method, path }) => withRemarkScenario(async s => {
    await s.seed(); const result = await s.request(method, path, { remark: '  桌面订单备注  ' });
    expect(result.status, result.msg).toBe(200);
    expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, 820001)))[0].remark).toBe('桌面订单备注');
    const logs = await s.f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, 820001));
    expect(logs).toHaveLength(1); expect(logs[0]).toMatchObject({ changeType: 'admin_order_remark', changeMessage: '管理员 101 更新订单备注' });
  }), 120000);

  it.each(endpoints.slice(2))('preserves the existing $name order-number contract', async e => withRemarkScenario(async s => {
    await s.seed(); const result = await call(s, e, '移动管理备注'); expect(result.status, result.msg).toBe(200); privateResponse(result);
    expect((await read(s)).remark).toBe('移动管理备注'); expect(await audits(s)).toHaveLength(1);
  }), 120000);

  it('permits the actual order manager and makes exact no-op retries write no extra row or audit sequence', async () => withRemarkScenario(async s => {
    await s.seed(); const original = await read(s);
    for (const e of endpoints) {
      const remark = '管理备注 ' + e.name, result = await call(s, e, remark, s.token('manager'));
      expect(result.status, result.msg).toBe(200); privateResponse(result);
      expect(await read(s)).toEqual({ ...original, remark });
      const logs = await audits(s); expect(logs.at(-1)).toMatchObject({ changeType: 'admin_order_remark', changeMessage: '管理员 102 更新订单备注' });
      expect(JSON.stringify(logs)).not.toContain(remark);
      const before = await s.snapshot(), seq = await sequence(s), retry = await call(s, e, remark, s.token('manager'));
      expect(retry.status, retry.msg).toBe(200); expect(await s.snapshot()).toEqual(before); expect(await sequence(s)).toEqual(seq);
    }
  }), 120000);

  it('keeps numeric order numbers distinct from legacy primary IDs and ignores forged body targets', async () => withRemarkScenario(async s => {
    await s.seed(820001, '820002'); await s.seed(820002, 'different-number');
    const modern = await s.request('POST', '/adminapi/order/remark/820002', { order_id: 'different-number', id: 820002, remark: '按订单号写入' });
    expect(modern.status, modern.msg).toBe(200); expect((await read(s, 820001)).remark).toBe('按订单号写入'); expect((await read(s, 820002)).remark).toBe('原备注');
    const legacy = await s.request('PUT', '/adminapi/order/remark/820002', { order_id: '820002', id: 820001, remark: '按主键写入' });
    expect(legacy.status, legacy.msg).toBe(200); expect((await read(s, 820001)).remark).toBe('按订单号写入'); expect((await read(s, 820002)).remark).toBe('按主键写入');
  }), 120000);

  it('denies anonymous read-only disabled and Supplier identities on all four private entry points without writes', async () => withRemarkScenario(async s => {
    await s.seed(); const before = await s.snapshot(), seq = await sequence(s);
    for (const e of endpoints) for (const token of [null, s.token('viewer'), s.token('disabled'), s.token('supplier')]) {
      const result = await s.request(e.method, e.path, { order_id: 'owned-remark-order', remark: '不能写入', admin_id: 101 }, token);
      expect(result.status, result.msg).not.toBe(200); expect(result.status).not.toBe(500); privateResponse(result);
      expect(await s.snapshot()).toEqual(before); expect(await sequence(s)).toEqual(seq);
    }
  }), 120000);

  it('rejects malformed empty oversized and invalid-Unicode bodies before business or audit sequence writes', async () => withRemarkScenario(async s => {
    await s.seed(); const before = await s.snapshot(), seq = await sequence(s);
    for (const e of endpoints) {
      for (const remark of ['', ' ', '0', null, false, [], {}, '\u0000', '\ud800', 'x'.repeat(513), '🛍'.repeat(513)]) {
        const result = await call(s, e, remark); expect(result.status, result.msg).toBe(400); privateResponse(result);
      }
      for (const body of ['{broken', '[]', JSON.stringify({ remark: 'x'.repeat(9000) })]) {
        const result = await s.request(e.method, e.path, body); expect(result.status, result.msg).toBe(400); privateResponse(result);
      }
      expect(await s.snapshot()).toEqual(before); expect(await sequence(s)).toEqual(seq);
    }
  }), 120000);

  it.each(endpoints.slice(0, 2))('refuses missing user-deleted and system-deleted orders through $name', async e => withRemarkScenario(async s => {
    const missing = await call(s, e, 'missing'); expect(missing.status, missing.msg).toBe(404); await s.seed();
    for (const flags of [{ isDel: 1, isSystemDel: 0 }, { isDel: 0, isSystemDel: 1 }]) {
      await s.f.db.update(storeOrder).set(flags).where(eq(storeOrder.id, 820001));
      const before = await s.snapshot(), seq = await sequence(s), result = await call(s, e, 'deleted');
      expect(result.status, result.msg).toBe(404); expect(await s.snapshot()).toEqual(before); expect(await sequence(s)).toEqual(seq);
    }
  }), 120000);

  it('stores all 512 Unicode characters and reads the committed remark through the actual desktop detail route', async () => withRemarkScenario(async s => {
    await s.seed(); const remark = '🛍'.repeat(510) + '\n好';
    const saved = await call(s, endpoints[0], remark); expect(saved.status, saved.msg).toBe(200); expect((await read(s)).remark).toBe(remark);
    const detail = await s.request('GET', '/adminapi/order/detail/owned-remark-order'); expect(detail.status, detail.msg).toBe(200);
    expect(detail.data.remark).toBe(remark); privateResponse(detail);
  }), 120000);

  it.each(endpoints.flatMap(e => (['order', 'audit', 'deferred'] as const).map(target => ({ ...e, target }))))
  ('rolls back $name on $target tampering and permits the identical request after trigger removal', async ({ target, ...e }) => withRemarkScenario(async s => {
    await s.seed(); const rewrite = target === 'order'
      ? "UPDATE public.store_order SET pay_price='999.00',uid=22 WHERE id=NEW.oid; RETURN NEW;"
      : target === 'audit' ? "NEW.change_message:='rewritten audit'; RETURN NEW;"
      : 'DELETE FROM public.store_order_status WHERE id=NEW.id; RETURN NEW;';
    await s.f.exec(`CREATE FUNCTION owned_remark_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN ${rewrite} END $$;
      ${target === 'deferred' ? 'CREATE CONSTRAINT TRIGGER' : 'CREATE TRIGGER'} owned_remark_tamper ${target === 'audit' ? 'BEFORE' : 'AFTER'} INSERT ON store_order_status
      ${target === 'deferred' ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW EXECUTE FUNCTION owned_remark_tamper()`);
    const before = await s.snapshot(), result = await call(s, e, '必须整笔回滚');
    expect(result.status, result.msg).toBe(409); expect(result.msg).toContain('订单备注'); expect(await s.snapshot()).toEqual(before);
    await s.f.exec('DROP TRIGGER owned_remark_tamper ON store_order_status');
    const retry = await call(s, e, '必须整笔回滚'); expect(retry.status, retry.msg).toBe(200); expect(await audits(s)).toHaveLength(1);
  }), 120000);

  it('rechecks live manager role and password after the audit author on every entry point', async () => withRemarkScenario(async s => {
    await s.seed();
    for (const mode of ['role', 'password'] as const) {
      const rewrite = mode === 'role' ? "UPDATE public.system_role SET rules='order.view' WHERE id=820001;"
        : "UPDATE public.system_admin SET pwd='owned-rotated-password' WHERE id=102;";
      await s.f.exec(`CREATE OR REPLACE FUNCTION owned_remark_revoke() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN ${rewrite} RETURN NEW; END $$;
        CREATE TRIGGER owned_remark_revoke AFTER INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION owned_remark_revoke()`);
      for (const e of endpoints) {
        const before = await s.snapshot(), result = await call(s, e, '不能绕过迟到权限变更', s.token('manager'));
        expect(result.status, result.msg).not.toBe(200); expect(result.status).not.toBe(500); expect(await s.snapshot()).toEqual(before);
      }
      await s.f.exec('DROP TRIGGER owned_remark_revoke ON store_order_status');
    }
    const result = await call(s, endpoints[0], '权限恢复后的有效写入', s.token('manager')); expect(result.status, result.msg).toBe(200);
    await s.f.db.update(systemAdmin).set({ pwd: 'owned-rotated-password' }).where(eq(systemAdmin.id, 102));
    const before = await s.snapshot(), denied = await call(s, endpoints[0], '旧令牌', s.token('manager'));
    expect(denied.status).not.toBe(200); expect(denied.status).not.toBe(500); expect(await s.snapshot()).toEqual(before);
  }), 120000);

  it('rolls back a real audit insertion error and then accepts the same valid request', async () => withRemarkScenario(async s => {
    await s.seed(); await s.f.exec(`CREATE FUNCTION owned_remark_audit_error() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned audit failure'; END $$;
      CREATE TRIGGER owned_remark_audit_error BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION owned_remark_audit_error()`);
    const before = await s.snapshot(), failed = await call(s, endpoints[0], '审计失败不能留下备注'); expect(failed.status).toBe(500); expect(await s.snapshot()).toEqual(before);
    await s.f.exec('DROP TRIGGER owned_remark_audit_error ON store_order_status');
    const retry = await call(s, endpoints[0], '审计失败不能留下备注'); expect(retry.status, retry.msg).toBe(200);
  }), 120000);

  it.each(['order', 'authority'] as const)('refuses a real concurrent %s writer before audit allocation', async target => withRemarkScenario(async s => {
    await s.seed(); if (!s.f.withPeer) throw Error('Independent peer required');
    await s.f.withPeer(async peer => {
      let signal!: () => void, release!: () => void;
      const held = new Promise<void>(r => { signal = r; }), done = new Promise<void>(r => { release = r; });
      const holding = peer.db.transaction(async tx => {
        if (target === 'order') await tx.execute(sql`SELECT id FROM store_order WHERE id=820001 FOR UPDATE`);
        else await tx.execute(sql`LOCK TABLE ONLY system_role IN ROW EXCLUSIVE MODE`);
        signal(); await done;
      });
      try {
        await held; const before = await s.snapshot(), seq = await sequence(s), result = await call(s, endpoints[0], '并发写入');
        expect(result.status, result.msg).toBe(409); expect(await s.snapshot()).toEqual(before); expect(await sequence(s)).toEqual(seq);
      } finally { release(); await holding; }
    });
    const retry = await call(s, endpoints[0], '并发写入'); expect(retry.status, retry.msg).toBe(200);
  }), 120000);

  it('preserves large historical text using database fingerprints and rolls back a late text rewrite', async () => withRemarkScenario(async s => {
    await s.seed(); const original = await read(s), content = 'x'.repeat(262145);
    await s.f.db.update(storeOrder).set({ virtualInfo: content }).where(eq(storeOrder.id, 820001));
    for (const e of endpoints) {
      const remark = '保留大历史正文 ' + e.name, result = await call(s, e, remark);
      expect(result.status, result.msg).toBe(200); expect(await read(s)).toEqual({ ...original, virtualInfo: content, remark });
    }
    await s.f.exec(`CREATE FUNCTION owned_remark_text_growth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      BEGIN UPDATE public.store_order SET virtual_info=repeat('y',262145) WHERE id=NEW.oid; RETURN NEW; END $$;
      CREATE TRIGGER owned_remark_text_growth AFTER INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION owned_remark_text_growth()`);
    for (const e of endpoints) {
      const before = await s.snapshot(), result = await call(s, e, '迟到正文改写必须回滚');
      expect(result.status, result.msg).toBe(409); expect(await s.snapshot()).toEqual(before);
    }
    await s.f.exec('DROP TRIGGER owned_remark_text_growth ON store_order_status');
    const retry = await call(s, endpoints[0], '迟到正文改写必须回滚'); expect(retry.status, retry.msg).toBe(200);
    expect((await read(s)).virtualInfo).toBe(content);
    await s.f.db.update(storeOrder).set({ virtualInfo: null }).where(eq(storeOrder.id, 820001));
    await s.f.exec(`CREATE OR REPLACE FUNCTION owned_remark_text_growth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      BEGIN UPDATE public.store_order SET virtual_info='' WHERE id=NEW.oid; RETURN NEW; END $$;
      CREATE TRIGGER owned_remark_text_growth AFTER INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION owned_remark_text_growth()`);
    const before = await s.snapshot(), changedNull = await call(s, endpoints[0], 'NULL不能变成空字符串');
    expect(changedNull.status, changedNull.msg).toBe(409); expect(await s.snapshot()).toEqual(before);
    await s.f.exec('DROP TRIGGER owned_remark_text_growth ON store_order_status');
    const final = await call(s, endpoints[0], 'NULL不能变成空字符串'); expect(final.status, final.msg).toBe(200);
    expect((await read(s)).virtualInfo).toBeNull();
  }), 120000);
});
