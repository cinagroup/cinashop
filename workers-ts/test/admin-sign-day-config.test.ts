import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemDise, systemGroup, systemGroupData, systemLog } from '../src/models/schema';
import { readSignDayBody, signDayMutationCanonical, signDayPayloadHash } from '../src/services/admin/AdminSignDayConfigInput';
import { signDayConfigActor, signDayConfigFixture } from './helpers/signDayConfigFixture';

describe('dedicated seven-day sign configuration', () => {
  let f: Awaited<ReturnType<typeof signDayConfigFixture>>;
  beforeEach(async () => { f = await signDayConfigFixture(); });
  afterEach(async () => { await f?.close(); });
  const uuid = () => crypto.randomUUID();
  const input = (revision: string) => ({ revision, request_id: uuid(), day: ' 第三天 🌿 ', sign_num: 30, sort: 80, status: 1 });

  it('lists the fixed group and theme without modifying either; preserves raw text and unknown legacy keys on edit', async () => {
    const before = await f.db.select().from(systemGroupData);
    const page = await f.serviceFor().list();
    expect(page).toMatchObject({ group_present: true, count: 2, theme: 2, theme_issue: null });
    expect(page.list.map(row => row.id)).toEqual([147, 148]);
    expect(await f.db.select().from(systemGroupData)).toEqual(before);
    const row = (await f.serviceFor().detail(148)).info;
    expect(row).toMatchObject({ gid: 55, day: '第二天', sign_num: 20, status: 1, sort: 99, add_time: 1_700_000_000, issues: [] });
    const body = input(row.revision);
    const canonical = signDayMutationCanonical('update', 148, body).canonical;
    const result = await f.serviceFor().mutate('update', 148, body, signDayConfigActor);
    expect(result).toEqual({ operation: 'update', id: 148, request_id: body.request_id,
      payload_hash: await signDayPayloadHash(canonical) });
    const [saved] = await f.db.select().from(systemGroupData).where(eq(systemGroupData.id, 148));
    expect(JSON.parse(saved.value!)).toMatchObject({ pp: { type: 'upload', value: '/legacy/sign.png' },
      ll: { value: '保留' }, day: { type: 'input', value: body.day }, sign_num: { type: 'input', value: '30' } });
    expect((await f.serviceFor().detail(148)).info.day).toBe(body.day);
  });

  it('initializes missing fixed metadata and first row only on a versioned create, with immutable actor-scoped replay', async () => {
    await f.db.delete(systemGroupData);
    await f.db.delete(systemGroup);
    const empty = await f.serviceFor().list();
    expect(empty).toMatchObject({ group_present: false, list: [], count: 0 });
    expect(await f.db.select().from(systemGroup)).toEqual([]);
    const body = input(empty.revision);
    const result = await f.serviceFor().mutate('create', undefined, body, signDayConfigActor);
    const groups = await f.db.select().from(systemGroup);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ cateId: 1, configName: 'sign_day_num', name: '签到天数配置' });
    expect((await f.db.select().from(systemGroupData))).toHaveLength(1);
    const snapshot = { groups: await f.db.select().from(systemGroup), rows: await f.db.select().from(systemGroupData),
      logs: await f.db.select().from(systemLog) };
    expect(await f.serviceFor().mutate('create', undefined, body, signDayConfigActor)).toEqual(result);
    expect(await f.serviceFor().receipt(body.request_id, signDayConfigActor)).toEqual(result);
    expect({ groups: await f.db.select().from(systemGroup), rows: await f.db.select().from(systemGroupData),
      logs: await f.db.select().from(systemLog) }).toEqual(snapshot);
    await expect(f.serviceFor().receipt(body.request_id, { id: 8 })).rejects.toThrow();
    await expect(f.serviceFor().mutate('create', undefined, body, { id: 8 })).rejects.toThrow();
    await expect(f.serviceFor().mutate('create', undefined, { ...body, sign_num: 31 }, signDayConfigActor)).rejects.toThrow();
  });

  it('uses collection CAS for creation and row+metadata CAS for update, status and deletion', async () => {
    const original = await f.serviceFor().list();
    const first = original.list[0];
    await f.serviceFor().mutate('status', 147, { revision: first.revision, request_id: uuid(), status: 0 }, signDayConfigActor);
    await expect(f.serviceFor().mutate('create', undefined, input(original.revision), signDayConfigActor)).rejects.toThrow();
    await expect(f.serviceFor().mutate('delete', 147, { revision: first.revision, request_id: uuid() }, signDayConfigActor)).rejects.toThrow();
    const current = (await f.serviceFor().detail(147)).info;
    await f.db.update(systemGroup).set({ info: '历史元数据变更' }).where(eq(systemGroup.id, 55));
    await expect(f.serviceFor().mutate('update', 147, input(current.revision), signDayConfigActor)).rejects.toThrow();
    const latest = (await f.serviceFor().detail(147)).info;
    const removed = await f.serviceFor().mutate('delete', 147, { revision: latest.revision, request_id: uuid() }, signDayConfigActor);
    expect(removed).toMatchObject({ operation: 'delete', id: 147 });
    expect((await f.serviceFor().list()).count).toBe(1);
  });

  it('reads all 8 historical entries for repair, blocks a new eighth entry, and bounds abnormal historical loads', async () => {
    const sample = (await f.db.select().from(systemGroupData))[0];
    await f.db.insert(systemGroupData).values(Array.from({ length: 6 }, (_, i) => ({ gid: 55,
      value: sample.value, sort: 90 - i, status: 0 })));
    const page = await f.serviceFor().list();
    expect(page.count).toBe(8);
    expect(page.list).toHaveLength(8);
    await expect(f.serviceFor().mutate('create', undefined, input(page.revision), signDayConfigActor)).rejects.toThrow(/最多7条/);
    const invalid = page.list[2];
    const fixed = await f.serviceFor().mutate('update', invalid.id, input(invalid.revision), signDayConfigActor);
    expect(fixed.id).toBe(invalid.id);
    await f.db.insert(systemGroupData).values(Array.from({ length: 93 }, () => ({ gid: 55, value: sample.value })));
    await expect(f.serviceFor().list()).rejects.toThrow(/超过100条/);
  });

  it('shows malformed history for repair but refuses to enable it; malformed theme stays diagnostic', async () => {
    await f.db.update(systemGroupData).set({ value: '{broken', status: 0 }).where(eq(systemGroupData.id, 147));
    await f.db.update(systemDise).set({ value: '7' }).where(eq(systemDise.id, 9));
    const page = await f.serviceFor().list();
    expect(page).toMatchObject({ theme: null, theme_issue: '签到主题值无效' });
    const bad = page.list.find(row => row.id === 147)!;
    expect(bad).toMatchObject({ day: null, sign_num: null, status: 0 });
    expect(bad.issues.length).toBeGreaterThan(0);
    await expect(f.serviceFor().mutate('status', 147,
      { revision: bad.revision, request_id: uuid(), status: 1 }, signDayConfigActor)).rejects.toThrow(/编辑修复/);
    await f.serviceFor().mutate('update', 147, input(bad.revision), signDayConfigActor);
    expect((await f.serviceFor().detail(147)).info.issues).toEqual([]);
  });

  it('distinguishes a missing receipt from malformed or duplicate journal records', async () => {
    const absent = uuid();
    await expect(f.serviceFor().receipt(absent, signDayConfigActor)).rejects.toThrow(/不存在/);
    const request = uuid(), path = `/marketing/sign-day-config/request/${request}`;
    await f.db.insert(systemLog).values({ type: 'sign_day_config', path, adminId: 7, action: 'corrupted' });
    await expect(f.serviceFor().receipt(request, signDayConfigActor)).rejects.toThrow(/异常/);
    await expect(f.serviceFor().mutate('create', undefined,
      { ...input((await f.serviceFor().list()).revision), request_id: request }, signDayConfigActor)).rejects.toThrow(/已用于/);
    await f.db.delete(systemLog);
    const valid = 'create;id=147;payload=' + 'a'.repeat(64);
    await f.db.insert(systemLog).values([{ type: 'sign_day_config', path, adminId: 7, action: valid },
      { type: 'sign_day_config', path, adminId: 7, action: valid }]);
    await expect(f.serviceFor().receipt(request, signDayConfigActor)).rejects.toThrow(/异常/);
  });

  it('validates precise public fields and preserves whitespace in canonical hashes', async () => {
    const revision = (await f.serviceFor().list()).revision;
    const base = input(revision);
    const a = signDayMutationCanonical('create', 0, base).canonical;
    const b = signDayMutationCanonical('create', 0, { ...base, day: base.day.trim() }).canonical;
    expect(await signDayPayloadHash(a)).not.toBe(await signDayPayloadHash(b));
    for (const patch of [{ day: '   ' }, { day: '🌿'.repeat(65) }, { day: 'bad\nline' },
      { sign_num: '12' }, { sign_num: 0 }, { sign_num: 2147483648 }, { sort: -1 },
      { status: 2 }, { gid: 55 }, { value: '{}' }]) {
      await expect(f.serviceFor().mutate('create', undefined, { ...base, ...patch }, signDayConfigActor)).rejects.toThrow();
    }
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('reads bounded fatal UTF-8 JSON and refuses duplicate decoded keys before mutation', async () => {
    const read = (body: BodyInit) => readSignDayBody(new Request('https://local.invalid', { method: 'POST', body }));
    expect(await read('{"day":"第一天","sign_num":10}')).toEqual({ day: '第一天', sign_num: 10 });
    for (const raw of ['{"sign_num":10,"sign_num":20}', '{"day":1,"\\u0064ay":2}',
      '[1]', 'null', '"text"', '{"sign_num":{"value":1,"value":2}}', '{bad}', 'x'.repeat(4097)]) {
      await expect(read(raw)).rejects.toThrow();
    }
    await expect(read(new Uint8Array([0xff]))).rejects.toThrow(/UTF-8/);
  });
});
