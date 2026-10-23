import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { vi } from 'vitest';
import { diyFooterBrowserFixture } from './diyFooterBrowserFixture';
import { sortedDiyState, type DiyStateRow, type DiyStateSnapshot } from './diyStateFixture';
import { videoManifest } from './adminProductVideoUpload';
import { AttachmentService, adminAttachmentScope } from '@/services/system/AttachmentService';
import { AdminProductVideoUploadService } from '@/services/admin/AdminProductVideoUploadService';
import { installProductVideoUpload } from '@/migrations/adminProductVideoUpload';
import { createToken, md5, verifyToken } from '@/utils/jwt';
import { systemAdmin, systemAttachmentCategory, systemDise, systemRole } from '@/models/schema';

const colour = (a: string, b = a) => ({ color: [{ item: a }, { item: b }] });
/** Exact five PHP author structures, plus untouched neighboring/unknown fields.
 * The footer remains inherited so a presentation edit cannot erase its contract. */
export function diyPresentationBlocks(image: string, video: string): DiyStateRow[] {
  const common = { topConfig: { val: 6 }, bottomConfig: { val: 8 }, prConfig: { val: 10 }, mbConfig: { val: 7 },
    bottomBgColor: colour('#f3f6fa'), fillet: { type: 1, val: 8, valList: [2, 4, 6, 8].map(val => ({ val })) } };
  return [
    { ...structuredClone(common), name: 'titles', timestamp: 1001, titleConfig: { value: '实际演示标题', max: 10 },
      titleConfigRight: { value: '更多', max: 5 }, linkConfig: { value: '/pages/article/list', max: 100 },
      buttonConfig: { tabVal: 0 }, textPosition: { tabVal: 1 }, textStyle: { tabVal: 1 }, fontSize: { val: 20 }, buttonText: { val: 12 },
      themeColor: colour('#234567'), buttonColor: colour('#456789'), titleColor: colour('#ffffff', '#eaf0f7') },
    { ...structuredClone(common), name: 'blankPage', timestamp: 1002, heightConfig: { val: 750 }, lrEdge: { val: 12 }, bgColor: colour('#f5f5f5') },
    { ...structuredClone(common), name: 'guide', timestamp: 1003, lineStyle: { tabVal: 2 }, lrEdge: { val: 10 },
      lineColor: colour('#375a7f'), lineBgColor: colour('#eaf0f7') },
    { ...structuredClone(common), name: 'richText', timestamp: 1004, lrConfig: { val: 10 }, udConfig: { val: 9 }, bgColor: colour('#ffffff'),
      richText: { val: `<p style="text-align:center;color:#123456"><strong>真实 WangEditor 段落</strong><a href="/pages/article/list?value=a&amp;b">实际链接</a><img src="${image}" alt="原图"><video src='${video}' controls></video></p>` } },
    { ...structuredClone(common), name: 'videos', timestamp: 1005, scaleConfig: { tabVal: 0 }, videoConfig: { url: video }, imgConfig: { url: image },
      preview: video, authorExtra: { link: image, untouched: true } },
  ];
}

/** Owned public namespace is required by the real Admin upload catalog/barriers.
 * Defaults of all inherited fixtures remain unchanged. The only DDL is existing
 * checked-in fixture ORM tables and the existing explicit PG16 upload addon.
 * FixedLengthStream must be supplied by the test/runtime boundary. */
export async function diyPresentationFixture(now = new Date()) {
  const f = await diyFooterBrowserFixture({ namespace: 'public', now });
  try {
    const resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
      queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length,
      objects: [...f.objects].map(([key, item]) => ({ key, type: item.type, size: item.bytes.length,
        sha256: createHash('sha256').update(item.bytes).digest('hex') })).sort((a, b) => a.key.localeCompare(b.key)),
      rendering: { info: f.rendering.info.mock.calls.length, input: f.rendering.input.mock.calls.length,
        transform: f.rendering.transform.mock.calls.length, draw: f.rendering.draw.mock.calls.length, output: f.rendering.output.mock.calls.length } });
    const beforeAddon = await f.snapshot(), beforeAddonResources = resources();
    await f.db.transaction(tx => installProductVideoUpload(tx));
    const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).map(row => row.name);
    const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)).map(row => row.name);
    async function snapshot(): Promise<DiyStateSnapshot> {
      const state: DiyStateSnapshot = {};
      for (const row of await f.db.execute<{ name: string; rows: DiyStateRow[] }>(sql.join(tables.map(name =>
        sql`SELECT ${name}::text AS name, COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier('public')}.${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
      state.__sequences = await f.db.execute(sql.join(sequences.map(name =>
        sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier('public')}.${sql.identifier(name)}`), sql` UNION ALL `));
      return sortedDiyState(state);
    }
    const afterAddon = await snapshot();
    const beforeUpload = await snapshot(), beforeUploadResources = resources();
    await f.db.insert(systemAttachmentCategory).values({ id: 920, type: 1, relationId: 0, fileType: 2, name: '真实页面视频' });
    // A second authenticated Admin deliberately lacks dise.manage; no test-only
    // role resolver or middleware bypass stands in for the live authorization.
    await f.db.insert(systemRole).values({ id: 902, roleName: 'Owned presentation reader', rules: 'dise.view,attachment.view', status: 1 });
    await f.db.insert(systemAdmin).values({ id: 902, account: 'owned-presentation-reader', realName: '只读页面管理员', pwd: 'owned-presentation-reader-password', roles: '902', level: 1, adminType: 1, relationId: 0, status: 1 });
    const readerToken = (await createToken(902, 'admin', md5('owned-presentation-reader-password'), f.env.APP_KEY)).token;
    const claims = await verifyToken(f.adminToken, f.env.APP_KEY);
    if (claims.type !== 'admin' || !claims.auth) throw Error('Missing real Admin upload JWT claims');
    const actor = { id: claims.id, authVersion: claims.auth, expiresAt: claims.exp };
    const source = videoManifest(f.mp4, 1024, 920), uploadId = crypto.randomUUID();
    const uploader = new AdminProductVideoUploadService(f.container, f.env);
    const initialized = await uploader.initialize(uploadId, { ...source.manifest, filename: 'presentation-real.mp4' }, actor);
    const parts = [];
    for (const [index, bytes] of source.chunks.entries()) parts.push(await uploader.putPart(uploadId, index + 1, bytes, actor));
    const completed = await uploader.complete(uploadId, actor);
    if (completed.state !== 'committed' || !completed.result) throw Error('Real Admin MP4 upload was not committed');
    const platformVideo = { ...completed.result, att_id: completed.result.id };
    const uploadSetup = { phase: 'owned setup: existing addon + actual Admin upload service', before: beforeUpload,
      after: await snapshot(), resources_before: beforeUploadResources, resources_after: resources(),
      upload_id: uploadId, initialized, parts, completed, bytes: f.mp4.length,
      sha256: createHash('sha256').update(f.mp4).digest('hex'),
      note: 'Real checked-in decodable MP4 bytes; native suite proves exact byte/range read, not browser playback. Queue is captured, not consumed.' };
    const beforeImages = await snapshot(), beforeImagesResources = resources(), batchImages: Array<{ att_id: number; url: string }> = [];
    const attachments = new AttachmentService(f.container, f.env);
    for (let index = 0; index < 257; index++) batchImages.push(await attachments.uploadImage(adminAttachmentScope(), new File([f.png], `presentation-batch-${index}.png`, { type: 'image/png' }), 0));
    const imageSetup = { phase: 'owned setup: 257 actual platform image uploads', before: beforeImages, after: await snapshot(),
      resources_before: beforeImagesResources, resources_after: resources(), images: batchImages };
    const beforeSchema = await snapshot(), blocks = [...diyPresentationBlocks(f.platformImage.url, platformVideo.url), structuredClone(f.blocks[1])];
    for (const id of [1, 2]) await f.db.update(systemDise).set({ title: `实际展示${id === 1 ? '首页' : '微页'}`, version: 'diy-presentation-1', value: JSON.stringify(blocks), content: 'independent-owned-content' }).where(eq(systemDise.id, id));
    async function station(value: string) { const before = await snapshot(); await f.station(value); return { before, after: await snapshot() }; }
    async function saveSchema(id: 1 | 2, value: unknown[]) { const before = await snapshot(), result = await f.saveSchema(id, value); return { ...result, before, after: await snapshot() }; }
    return { ...f, now, tables, sequences, snapshot, resources, station, saveSchema, readerToken, platformVideo, uploadId, uploadSetup, real_upload_setup: uploadSetup, batchImages, imageSetup,
      addonSetup: { before: beforeAddon, after: afterAddon, resources_before: beforeAddonResources, resources_after: beforeUploadResources },
      schemaSetup: { before: beforeSchema, after: await snapshot() }, blocks, uploader, actor };
  } catch (error) { await f.close(); throw error; }
}
