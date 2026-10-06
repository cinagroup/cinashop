import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDbFromConnectionString, type DbClient } from '../src/lib/di';
import { systemAttachment, systemGroup, systemGroupData } from '../src/models/schema';
import { PcBannerStaleVersion, pcBannerCanonical, pcBannerHash, parsePcBannerQuery, type PcBannerValues } from '../src/services/admin/AdminPcBannerInput';
import { PC_BANNER_LOCK_NAMESPACE } from '../src/services/admin/AdminPcBannerService';
import { observeCityDeliveryRecordDb } from './helpers/cityDeliveryRecordFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { pcBannerActor, pcBannerFixture, pcBannerStored, pcBannerValues } from './helpers/pcBannerFixture';

type Fixture = Awaited<ReturnType<typeof pcBannerFixture>>;
type RuntimePeer = Parameters<Parameters<Fixture['withRuntimeRole']>[0]>[0];
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const input = (revision: string, values: PcBannerValues = pcBannerValues()) => ({ request_id: crypto.randomUUID(), revision, values, sort: 80, status: 1 });
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native complete PC banner configuration with production ACL intersection', () => {
  let f: Fixture;
  beforeEach(async () => { f = await pcBannerFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  const profiles = (run: (admin: RuntimePeer, app: RuntimePeer) => Promise<void>) => f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
    await f.installSlice(app, admin);
    expect((await admin.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: admin.role, session_user: admin.role });
    expect((await app.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: app.role, session_user: app.role });
    expect(admin.pid).not.toBe(app.pid); await run(admin, app);
  }));

  it('reads named-group pages and filters in descending sort/ID order without seeding or changing any row', async () => {
    await profiles(async (admin, app) => {
      const before = await f.snapshot();
      const all = await f.serviceFor(admin.db).list();
      expect(all).toMatchObject({ group_present: true, count: 2, page: 1, limit: 20, group: { id: 66 } });
      expect(all.list.map(row => row.id)).toEqual([302, 301]);
      expect(all.list[0].values.image).toBe('/legacy/banner-2.png');
      expect(all.list[1].values.title).toBe('轮播一');
      const visible = await f.serviceFor(app.db).list(parsePcBannerQuery(new URLSearchParams('status=1&limit=1')));
      expect(visible.count).toBe(1); expect(visible.list.map(row => row.id)).toEqual([301]);
      expect((await f.serviceFor(admin.db).list(parsePcBannerQuery(new URLSearchParams('page=2&limit=1')))).list[0].id).toBe(301);
      await expect(f.serviceFor(admin.db).detail(900)).rejects.toThrow(/不存在/);
      expect(await f.snapshot()).toEqual(before);
    });
  });

  it('edits all seven metadata types and unknown fallback, preserving unmodeled root keys and wrapper properties', async () => {
    const definitions = [
      { name: '标题', title: 'title', type: 'input', param: '' }, { name: '说明', title: 'note', type: 'textarea', param: '原样\r\n提示' },
      { name: '单选', title: 'radio', type: 'radio', param: '1=>一\n2=>二' }, { name: '复选', title: 'checks', type: 'checkbox', param: '1=>一\n2=>二' },
      { name: '选择', title: 'choice', type: 'select', param: '1=>一\n2=>二' }, { name: '图片', title: 'image', type: 'upload', param: '' },
      { name: '多图', title: 'images', type: 'uploads', param: '' }, { name: '扩展', title: 'future', type: 'unrecognized', param: '' },
      { name: '跳转', title: 'url', type: 'input', param: '' },
    ];
    await f.db.update(systemGroup).set({ fields: JSON.stringify(definitions) }).where(eq(systemGroup.id, 66));
    const values = { title: ' 标题 🌿 ', note: ' 首行\r\n\t次行 ', radio: '2', checks: ['2', '1'], choice: '1',
      image: '/api/assets/41', images: ['/api/assets/41', '/api/assets/41', 'https://cdn.example/My%20Banner.png'], future: '额外可编辑字段', url: 'http://example.com/path' };
    const historical = JSON.parse(pcBannerStored({ ...values, title: '轮播一', image: ['/legacy/first.png', '/legacy/ignored.png'], images: '/legacy/single-upload.png' }));
    historical.extra_root = { future: true }; historical.title.legacy_tip = '保留';
    await f.db.update(systemGroupData).set({ value: JSON.stringify(historical) }).where(eq(systemGroupData.id, 301));
    await profiles(async admin => {
      const service = f.serviceFor(admin.db), detail = await service.detail(301), body = input(detail.info.revision, values);
      expect(detail.group.fields).toHaveLength(9); expect(detail.group.fields.find(field => field.key === 'future')?.type).toBe('input');
      expect(detail.info.values.image).toBe('/legacy/first.png'); expect(detail.info.values.images).toEqual(['/legacy/single-upload.png']);
      const receipt = await service.mutate('update', 301, body, pcBannerActor);
      expect(receipt.payload_hash).toBe(await pcBannerHash(pcBannerCanonical('update', 301, body).canonical));
      const saved = (await f.db.select().from(systemGroupData).where(eq(systemGroupData.id, 301)))[0];
      expect(JSON.parse(saved.value!)).toMatchObject({ extra_root: { future: true }, title: { legacy_tip: '保留', value: values.title },
        note: { type: 'textarea', value: values.note }, future: { type: 'input', value: values.future }, checks: { value: ['2', '1'] }, images: { value: values.images } });
      const current = await service.detail(301); expect(current.info.values).toEqual(values);
      expect(current.info.image_preview).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=[A-Za-z0-9_-]+$/);
      expect(current.info.image_previews.images).toHaveLength(3);
      expect(await service.receipt(body.request_id, pcBannerActor)).toEqual(receipt);
    });
  });

  it('enforces public title/image/link semantics regardless of dynamic metadata types and never journals an unusable core value', async () => {
    const original = (await f.db.select().from(systemGroup).where(eq(systemGroup.id, 66)))[0].fields!;
    await profiles(async admin => {
      for (const type of ['input', 'future']) {
        const metadata = JSON.parse(original); metadata.find((field: { title: string }) => field.title === 'image').type = type;
        await f.db.update(systemGroup).set({ fields: JSON.stringify(metadata) }).where(eq(systemGroup.id, 66));
        for (const image of ['/api/assets/42', '/api/assets/43']) {
          const before = await f.snapshot();
          await expect(f.serviceFor(admin.db).mutate('create', undefined, input((await f.serviceFor().list()).revision, { ...pcBannerValues(), image }), pcBannerActor)).rejects.toThrow(/素材不可用|不属于平台/);
          expect(await f.snapshot()).toEqual(before);
        }
        const good = await f.serviceFor(admin.db).mutate('create', undefined, input((await f.serviceFor().list()).revision, { ...pcBannerValues(), image: '/api/assets/41' }), pcBannerActor);
        expect((await f.serviceFor(admin.db).detail(good.id)).info.image_preview).toMatch(/^\/api\/assets\/41\?expires=/);
      }
      for (const [key, type, parameter, value] of [['url', 'select', 'javascript:alert(1)=>危险\n/goods=>正常', 'javascript:alert(1)'],
        ['title', 'textarea', '', '首行\n次行']] as const) {
        const metadata = JSON.parse(original), field = metadata.find((item: { title: string }) => item.title === key); field.type = type; field.param = parameter;
        await f.db.update(systemGroup).set({ fields: JSON.stringify(metadata) }).where(eq(systemGroup.id, 66));
        const before = await f.snapshot();
        await expect(f.serviceFor(admin.db).mutate('create', undefined, input((await f.serviceFor().list()).revision, { ...pcBannerValues(), [key]: value }), pcBannerActor)).rejects.toThrow();
        expect(await f.snapshot()).toEqual(before);
      }
      for (const key of ['title', 'image', 'url']) {
        const metadata = JSON.parse(original); metadata.find((item: { title: string }) => item.title === key).type = 'uploads';
        await f.db.update(systemGroup).set({ fields: JSON.stringify(metadata) }).where(eq(systemGroup.id, 66));
        const page = await f.serviceFor(admin.db).list(); expect(page.group?.fields).toEqual([]); expect(page.group?.issues.some(issue => issue.includes('单一文本'))).toBe(true);
        const before = await f.snapshot(); await expect(f.serviceFor(admin.db).mutate('create', undefined, input(page.revision), pcBannerActor)).rejects.toThrow(/元数据无效/);
        expect(await f.snapshot()).toEqual(before);
      }
    });
  });

  it('initializes a missing group only on explicit add, journals once and replays before checking later row or metadata changes', async () => {
    await f.db.delete(systemGroupData).where(eq(systemGroupData.gid, 66)); await f.db.delete(systemGroup).where(eq(systemGroup.id, 66));
    await profiles(async admin => {
      const service = f.serviceFor(admin.db), before = await f.snapshot(), list = await service.list();
      expect(list).toMatchObject({ group_present: false, group: null, count: 0, list: [] }); expect(list.default_fields).toHaveLength(3);
      expect(await f.snapshot()).toEqual(before);
      const body = input(list.revision), receipt = await service.mutate('create', undefined, body, pcBannerActor);
      expect(receipt.operation).toBe('create'); expect(receipt.id).toBeGreaterThan(0);
      const group = (await f.db.select().from(systemGroup).where(eq(systemGroup.configName, 'pc_home_banner')))[0];
      await f.db.update(systemGroup).set({ fields: '{malformed' }).where(eq(systemGroup.id, group.id));
      await f.db.delete(systemGroupData).where(eq(systemGroupData.id, receipt.id));
      const after = await f.snapshot();
      expect(await service.mutate('create', undefined, body, pcBannerActor)).toEqual(receipt);
      await expect(service.mutate('create', undefined, body, { id: 8 })).rejects.toThrow(/请求标识/);
      await expect(service.mutate('create', undefined, { ...body, sort: body.sort + 1 }, pcBannerActor)).rejects.toThrow(/请求标识/);
      await expect(service.receipt(body.request_id, { id: 8 })).rejects.toThrow(/不存在/);
      expect(await f.snapshot()).toEqual(after); expect(after.logs).toHaveLength(1);
    });
  });

  it('captures hidden and off-page changes in collection CAS and metadata-only/no-op xmin changes in row CAS', async () => {
    await profiles(async admin => {
      const service = f.serviceFor(admin.db), prior = await service.list(parsePcBannerQuery(new URLSearchParams('status=1&limit=1')));
      await f.db.update(systemGroupData).set({ sort: 101 }).where(eq(systemGroupData.id, 302));
      const before = await f.snapshot(), body = input(prior.revision);
      const stale = await outcome(service.mutate('create', undefined, body, pcBannerActor));
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error).toMatchObject({ name: 'PcBannerStaleVersion', operation: 'create', request_id: body.request_id,
        payload_hash: await pcBannerHash(pcBannerCanonical('create', undefined, body).canonical) });
      expect(await f.snapshot()).toEqual(before);
      for (const change of [async () => { await f.db.update(systemGroup).set({ info: '只有组描述变化' }).where(eq(systemGroup.id, 66)); },
        async () => { await f.db.update(systemGroupData).set({ status: 1 }).where(eq(systemGroupData.id, 301)); }]) {
        const row = (await service.detail(301)).info; await change(); const after = await f.snapshot();
        await expect(service.mutate('status', 301, { request_id: crypto.randomUUID(), revision: row.revision, status: 0 }, pcBannerActor)).rejects.toBeInstanceOf(PcBannerStaleVersion);
        expect(await f.snapshot()).toEqual(after);
      }
    });
  });

  it('allows explicit repair of mergeable fields but only hide/delete for malformed whole JSON; malformed metadata blocks all writes', async () => {
    await f.db.update(systemGroupData).set({ value: '{malformed' }).where(eq(systemGroupData.id, 301));
    await profiles(async admin => {
      const service = f.serviceFor(admin.db), detail = await service.detail(301);
      expect(detail.info.editable).toBe(false); const before = await f.snapshot();
      await expect(service.mutate('update', 301, input(detail.info.revision), pcBannerActor)).rejects.toThrow(/无法安全合并/);
      expect(await f.snapshot()).toEqual(before);
      await service.mutate('status', 301, { request_id: crypto.randomUUID(), revision: detail.info.revision, status: 0 }, pcBannerActor);
      const hidden = (await service.detail(301)).info;
      await expect(service.mutate('status', 301, { request_id: crypto.randomUUID(), revision: hidden.revision, status: 1 }, pcBannerActor)).rejects.toThrow(/内容无效/);
      await service.mutate('delete', 301, { request_id: crypto.randomUUID(), revision: hidden.revision }, pcBannerActor);
      const mergeable = (await service.detail(302)).info;
      expect(mergeable.editable).toBe(true);
      await service.mutate('update', 302, input(mergeable.revision), pcBannerActor);
      await f.db.update(systemGroup).set({ fields: '{malformed' }).where(eq(systemGroup.id, 66));
      const list = await service.list(), row = (await service.detail(302)).info, snapshot = await f.snapshot();
      expect(list.group?.fields).toEqual([]); expect(row.editable).toBe(false);
      for (const [operation, id, data] of [['create', undefined, input(list.revision)], ['update', 302, input(row.revision)],
        ['status', 302, { request_id: crypto.randomUUID(), revision: row.revision, status: 0 }],
        ['delete', 302, { request_id: crypto.randomUUID(), revision: row.revision }]] as const) await expect(service.mutate(operation, id, data, pcBannerActor)).rejects.toThrow(/元数据无效/);
      expect(await f.snapshot()).toEqual(snapshot);
    });
  });

  it('uses unchanged real app/Admin privileges and the actual lock-only guard, without granting metadata, identity or DDL writes', async () => {
    await profiles(async (admin, app) => {
      for (const statement of ['UPDATE system_group SET name=\'forbidden\' WHERE id=66', 'UPDATE system_group SET id=67 WHERE id=66',
        'UPDATE system_group_data SET gid=90 WHERE id=301', 'CREATE TABLE public.forbidden_pc_banner(id int)']) {
        const result = await outcome(admin.exec(statement)); expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toMatchObject({ code: '42501' });
      }
      for (const statement of ['INSERT INTO system_group(config_name) VALUES(\'forbidden\')', 'UPDATE system_group_data SET status=0 WHERE id=301', 'DELETE FROM system_group_data WHERE id=301']) {
        const result = await outcome(app.exec(statement)); expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toMatchObject({ code: '42501' });
      }
      const service = f.serviceFor(admin.db), created = await service.mutate('create', undefined, input((await service.list()).revision), pcBannerActor);
      expect(created.operation).toBe('create');
      const row = (await service.detail(created.id)).info;
      await service.mutate('delete', created.id, { request_id: crypto.randomUUID(), revision: row.revision }, pcBannerActor);
      expect((await service.list()).count).toBe(2);
      expect((await admin.exec(`SELECT has_table_privilege(current_user,'system_group','UPDATE') AS broad,
        has_column_privilege(current_user,'system_group','id','UPDATE') AS narrow`))[0]).toEqual({ broad: false, narrow: true });
    });
  });

  it('rolls back a missing-group insert, row and audit together when the final journal INSERT fails under the actual Admin role', async () => {
    await f.db.delete(systemGroupData).where(eq(systemGroupData.gid, 66)); await f.db.delete(systemGroup).where(eq(systemGroup.id, 66));
    await profiles(async admin => {
      const body = input((await f.serviceFor(admin.db).list()).revision), before = await f.snapshot();
      await f.exec(`CREATE FUNCTION reject_pc_banner_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.type='pc_home_banner' THEN RAISE EXCEPTION 'owned late PC receipt failure'; END IF; RETURN NEW; END $$`);
      await f.exec('CREATE TRIGGER reject_pc_banner_receipt BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_pc_banner_receipt()');
      const failure = await outcome(f.serviceFor(admin.db).mutate('create', undefined, body, pcBannerActor));
      expect(failure.ok).toBe(false);
      if (!failure.ok) expect(failure.error.cause ?? failure.error).toMatchObject({ code: 'P0001', message: 'owned late PC receipt failure' });
      expect(await f.snapshot()).toEqual(before);
      await f.exec('DROP TRIGGER reject_pc_banner_receipt ON system_log'); await f.exec('DROP FUNCTION reject_pc_banner_receipt()');
      expect((await f.serviceFor(admin.db).mutate('create', undefined, body, pcBannerActor)).operation).toBe('create');
    });
  });

  it('serializes identical UUIDs on two independent sessions of the actual Admin LOGIN and denies cross-actor reuse', async () => {
    await profiles(async admin => {
      const secondDb = createDbFromConnectionString(admin.connectionString, 1), [identity] = await secondDb.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role,session_user AS session`);
      expect(identity.role).toBe(admin.role); expect(identity.session).toBe(admin.role); expect(Number(identity.pid)).not.toBe(admin.pid);
      try {
        await f.withPeer(async sentinel => {
          async function race(actor: { id: number }) {
            const locked = gate(), release = gate(), body = input((await f.serviceFor().list()).revision);
            const hold = sentinel.db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock(${PC_BANNER_LOCK_NAMESPACE},1)`); locked.resolve(); await release.promise; });
            await locked.promise;
            const a = outcome(f.serviceFor(admin.db).mutate('create', undefined, body, pcBannerActor));
            const b = outcome(f.serviceFor(secondDb).mutate('create', undefined, body, actor));
            try { await Promise.all([waitForFinanceBlock(f.db, admin.pid, sentinel.pid), waitForFinanceBlock(f.db, Number(identity.pid), sentinel.pid)]); }
            finally { release.resolve(); }
            await hold; return { body, results: await Promise.all([a, b]) };
          }
          const same = await race(pcBannerActor); expect(same.results[0].ok).toBe(true); expect(same.results[1]).toEqual(same.results[0]);
          expect((await f.serviceFor().list()).count).toBe(3); expect((await f.snapshot()).logs).toHaveLength(1);
          const cross = await race({ id: 8 }); expect(cross.results.map(result => result.ok).sort()).toEqual([false, true]);
          expect((await f.serviceFor().list()).count).toBe(4); expect((await f.snapshot()).logs).toHaveLength(2);
          const winningActor = cross.results[0].ok ? pcBannerActor : { id: 8 };
          expect((await f.serviceFor(admin.db).receipt(cross.body.request_id, winningActor)).operation).toBe('create');
          await expect(f.serviceFor(admin.db).receipt(cross.body.request_id, winningActor.id === 7 ? { id: 8 } : pcBannerActor)).rejects.toThrow(/不存在/);
        });
      } finally { await secondDb.$client.end({ timeout: 5 }); }
    });
  });

  it('waits on a legacy data-table writer and then sees its hidden phantom even with a session-default repeatable-read snapshot', async () => {
    await profiles(async admin => f.withPeer(async writer => {
      await admin.exec('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const prior = await f.serviceFor(admin.db).list(), locked = gate(), release = gate();
      const hold = writer.db.transaction(async tx => { await tx.insert(systemGroupData).values({ gid: 66, value: pcBannerStored(), sort: 0, status: 0 }); locked.resolve(); await release.promise; });
      await locked.promise;
      const pending = outcome(f.serviceFor(admin.db).mutate('create', undefined, input(prior.revision), pcBannerActor));
      try { await waitForFinanceBlock(f.db, admin.pid, writer.pid);
        const [lock] = await f.exec(`SELECT mode,granted FROM pg_locks WHERE pid=${admin.pid} AND relation='system_group_data'::regclass AND NOT granted`);
        expect(lock).toEqual({ mode: 'ShareRowExclusiveLock', granted: false });
      } finally { release.resolve(); }
      await hold; const result = await pending; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(PcBannerStaleVersion);
      expect((await f.serviceFor().list()).count).toBe(3); expect((await f.snapshot()).logs).toEqual([]);
    }));
  });

  it('waits for an actual group-metadata writer and rejects the previous row revision without overwriting that metadata', async () => {
    await profiles(async admin => f.withPeer(async writer => {
      const prior = (await f.serviceFor(admin.db).detail(301)).info, locked = gate(), release = gate();
      const hold = writer.db.transaction(async tx => { await tx.update(systemGroup).set({ info: '外部已修订' }).where(eq(systemGroup.id, 66)); locked.resolve(); await release.promise; });
      await locked.promise;
      const pending = outcome(f.serviceFor(admin.db).mutate('update', 301, input(prior.revision), pcBannerActor));
      try { await waitForFinanceBlock(f.db, admin.pid, writer.pid); } finally { release.resolve(); }
      await hold; const result = await pending; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(PcBannerStaleVersion);
      expect((await f.serviceFor().detail(301)).group.info).toBe('外部已修订'); expect((await f.serviceFor().detail(301)).info.values.title).toBe('轮播一');
      expect((await f.snapshot()).logs).toEqual([]);
    }));
  });

  it('waits for attachment metadata and revalidates availability after the actual shared row lock', async () => {
    await profiles(async admin => f.withPeer(async writer => {
      const body = input((await f.serviceFor(admin.db).list()).revision, { ...pcBannerValues(), image: '/api/assets/41' }), locked = gate(), release = gate();
      const hold = writer.db.transaction(async tx => { await tx.update(systemAttachment).set({ fileType: 2 }).where(eq(systemAttachment.attId, 41)); locked.resolve(); await release.promise; });
      await locked.promise;
      const pending = outcome(f.serviceFor(admin.db).mutate('create', undefined, body, pcBannerActor));
      try { await waitForFinanceBlock(f.db, admin.pid, writer.pid); } finally { release.resolve(); }
      await hold; const result = await pending; expect(result.ok).toBe(false);
      expect((await f.serviceFor().list()).count).toBe(2); expect((await f.snapshot()).logs).toEqual([]);
      for (const image of ['/api/assets/41', '/api/assets/42', '/api/assets/43', '/api/assets/999']) {
        const before = await f.snapshot();
        await expect(f.serviceFor(admin.db).mutate('create', undefined, input((await f.serviceFor().list()).revision, { ...pcBannerValues(), image }), pcBannerActor)).rejects.toThrow(/素材不可用|不属于平台/);
        expect(await f.snapshot()).toEqual(before);
      }
    }));
  });

  it('holds real attachment and group share locks until the journal commits, blocking deletion and metadata changes by exact peer PIDs', async () => {
    await profiles(async admin => f.withPeer(async assetWriter => f.withPeer(async groupWriter => {
      const reached = gate(), release = gate(); let observed = false;
      const observing = observeCityDeliveryRecordDb(admin.db, async (_tx: DbClient, command: string) => {
        if (!observed && command.includes('"system_attachment"') && /for share/i.test(command)) { observed = true; reached.resolve(); await release.promise; }
      });
      const body = input((await f.serviceFor().list()).revision, { ...pcBannerValues(), image: '/api/assets/41' });
      const pending = outcome(f.serviceFor(observing).mutate('create', undefined, body, pcBannerActor));
      await reached.promise;
      const deletion = outcome(assetWriter.db.delete(systemAttachment).where(eq(systemAttachment.attId, 41)));
      const metadata = outcome(groupWriter.db.update(systemGroup).set({ info: '保存后更改' }).where(eq(systemGroup.id, 66)));
      try { await Promise.all([waitForFinanceBlock(f.db, assetWriter.pid, admin.pid), waitForFinanceBlock(f.db, groupWriter.pid, admin.pid)]); }
      finally { release.resolve(); }
      const saved = await pending; expect(saved.ok).toBe(true); expect((await deletion).ok).toBe(true); expect((await metadata).ok).toBe(true);
      if (saved.ok) { const row = (await f.serviceFor().detail(saved.value.id)).info; expect(row.image_preview).toBe(''); expect(row.issues.some(issue => issue.includes('素材不可用'))).toBe(true);
        await expect(f.serviceFor(admin.db).mutate('status', row.id, { request_id: crypto.randomUUID(), revision: row.revision, status: 1 }, pcBannerActor)).rejects.toThrow(/素材不可用/); }
      expect((await f.snapshot()).logs).toHaveLength(1);
    })));
  });

  it('keeps management rows above the ten-slide public display limit', async () => {
    await f.db.insert(systemGroupData).values(Array.from({ length: 10 }, (_, n) => ({ gid: 66, value: pcBannerStored(), sort: n, status: n % 2 })));
    await profiles(async admin => {
      const service = f.serviceFor(admin.db), list = await service.list(); expect(list.count).toBe(12);
      await service.mutate('create', undefined, input(list.revision), pcBannerActor);
      expect((await service.list()).count).toBe(13); expect((await service.list()).list).toHaveLength(13);
    });
  });
});
