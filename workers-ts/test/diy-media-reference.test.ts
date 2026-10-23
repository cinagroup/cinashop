import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemAttachment } from '@/models/schema';
import { R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { canonicalizeDiyEditorialMedia, renderDiyEditorialMedia } from '@/services/content/DiyEditorialMediaPolicy';
import { diyPresentationHtmlMediaReferences } from '../../view/common/diyPresentationHtml';
import { financeMemoryPostgres } from './helpers/financePostgres';

const families = ['news', 'hotspot', 'follow', 'activeParty', 'swipers', 'swiperBg', 'homeComb', 'headerSerch', 'menus', 'pictureCube', 'pageFoot', 'customerService', 'videos', 'richText'] as const;
type Family = typeof families[number];
const appKey = 'owned-diy-reference-unit-key';
const ticket = (id: number) => `/api/assets/${id}?expires=1&signature=historical`;
const legacy = (family: Family) => !['customerService', 'videos', 'richText'].includes(family);
function sample(family: Family, reference: string) {
  const neighbour = { link: ticket(4), preview: ticket(5), authored: { zero: 0, nested: ticket(4) } };
  const field = { url: reference, ...structuredClone(neighbour) };
  if (family === 'richText') {
    const block = { name: family, richText: { val: `<p>作者正文<a href="${ticket(4)}">保留链接</a><img src="${reference}"></p>` }, ...neighbour };
    return { block, pick: () => diyPresentationHtmlMediaReferences(block.richText.val)[0]?.value ?? '' };
  }
  if (family === 'pageFoot') {
    const block = { name: family, menuList: [{ name: '首页', imgList: [reference, '/static/off.png', ticket(4)], ...structuredClone(neighbour) }], ...neighbour };
    return { block, pick: () => block.menuList[0]!.imgList[0]! };
  }
  if (family === 'pictureCube') {
    const block = { name: family, styleConfig: { tabVal: 11 }, picStyle: { picList: [{ image: reference, ...neighbour }], docPicList: [{ img: reference, ...neighbour }] }, ...neighbour };
    return { block, pick: () => block.picStyle.picList[0]!.image };
  }
  if (family === 'activeParty' || family === 'menus') {
    const block = { name: family, menuConfig: { list: [{ img: reference, ...neighbour }] }, ...neighbour };
    return { block, pick: () => block.menuConfig.list[0]!.img };
  }
  if (['swipers', 'swiperBg', 'homeComb'].includes(family)) {
    const block = { name: family, swiperConfig: { list: [{ img: reference, ...neighbour }] }, logoConfig: { url: reference }, ...neighbour };
    return { block, pick: () => block.swiperConfig.list[0]!.img };
  }
  if (['customerService', 'headerSerch'].includes(family)) {
    const block = { name: family, logoConfig: field, ...neighbour };
    return { block, pick: () => block.logoConfig.url };
  }
  if (family === 'hotspot') {
    const block = { name: family, picStyle: field, ...neighbour };
    return { block, pick: () => block.picStyle.url };
  }
  const block = { name: family, imgConfig: field, codeConfig: { url: reference }, ...neighbour };
  return { block, pick: () => block.imgConfig.url };
}

describe('complete DIY media reference identity between current owner approval and HMAC', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async () => { f = await financeMemoryPostgres([systemAttachment]); });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(systemAttachment).values([
      { attId: 1, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/1', name: 'attachments/admin/1/2026/10/public.png', attType: 'image/png' },
      { attId: 2, type: 1, relationId: 0, moduleType: 1, fileType: 2, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/2', name: 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000002.mp4', attType: 'video/mp4' },
      { attId: 4, type: 3, relationId: 11, moduleType: 3, fileType: 1, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/4', name: 'attachments/user/11/2026/10/private.png', attType: 'image/png' },
      { attId: 5, type: 4, relationId: 9, moduleType: 1, fileType: 1, imageType: R2_IMAGE_TYPE, attDir: '/api/assets/5', name: 'attachments/supplier/9/2026/10/foreign.png', attType: 'image/png' },
    ]);
  });

  it.each(families)('keeps the real public raster and every neighbouring field through %s', async family => {
    const entry = sample(family, ticket(1)), before = await f.db.select().from(systemAttachment);
    const neighbour = { link: entry.block.link, preview: entry.block.preview, authored: structuredClone(entry.block.authored) };
    canonicalizeDiyEditorialMedia([entry.block]);
    await renderDiyEditorialMedia(f.db, appKey, [entry.block]);
    expect(entry.pick()).toMatch(/^\/api\/assets\/1\?expires=\d+&signature=[A-Za-z0-9_-]+$/u);
    expect(entry.block).toMatchObject(neighbour);
    expect(await f.db.select().from(systemAttachment)).toEqual(before);
  });

  it.each(families)('never creates a private or foreign-owner ticket by decoding the approved reference again in %s', async family => {
    const before = await f.db.select().from(systemAttachment);
    for (const id of [4, 5, 99]) for (const reference of [ticket(id), `/&#97;pi/assets/${id}`, `/&#x61;pi/assets/${id}`, `/api&#47;assets/${id}`, `/&amp;#97;pi/assets/${id}`, `/&amp;amp;#97;pi/assets/${id}`]) {
      for (const saveFirst of [false, true]) {
        const entry = sample(family, reference);
        if (saveFirst) canonicalizeDiyEditorialMedia([entry.block]);
        await renderDiyEditorialMedia(f.db, appKey, [entry.block]);
        expect(entry.pick(), `${family}/${reference}/save=${saveFirst}`).not.toContain('signature=');
        expect(JSON.stringify(entry.block), `${family}/${reference}/all-slots/save=${saveFirst}`).not.toMatch(/signature=[A-Za-z0-9_-]{43}/u);
      }
    }
    expect(await f.db.select().from(systemAttachment)).toEqual(before);
  });

  it.each(families.filter(family => family !== 'richText'))('preserves the approved static/foreign literal byte identity in %s without APP_KEY', async family => {
    for (const reference of ['/&amp;amp;#97;pi/assets/4', '/static/a.png?x=1&amp;amp;y=2', 'https://foreign.example/api/assets/4?x=1&amp;amp;y=2']) {
      const entry = sample(family, reference);
      await renderDiyEditorialMedia(f.db, undefined, [entry.block]);
      expect(entry.pick()).toBe(legacy(family) ? reference.replaceAll('&amp;', '&') : reference);
    }
  });

  it('retains one actual HTML attribute decode before owner checks while never granting the href or a private src', async () => {
    const blocks = [{ name: 'richText', richText: { val: '<p data-author="x">正文<a href="/api/assets/4?expires=1&amp;signature=historical">link</a><img src="/&#97;pi/assets/1"><video src="/&#97;pi/assets/2"></video><img src="/&#97;pi/assets/4"></p>' } }];
    const before = blocks[0]!.richText.val;
    canonicalizeDiyEditorialMedia(blocks);
    expect(blocks[0]!.richText.val).toContain('href="/api/assets/4?expires=1&amp;signature=historical"');
    await renderDiyEditorialMedia(f.db, appKey, blocks);
    const refs = diyPresentationHtmlMediaReferences(blocks[0]!.richText.val);
    expect(refs.map(ref => ref.kind)).toEqual(['image', 'video']);
    expect(refs.map(ref => ref.value.split('?')[0])).toEqual(['/api/assets/1', '/api/assets/2']);
    expect(refs.every(ref => ref.value.includes('signature='))).toBe(true);
    expect(blocks[0]!.richText.val).toContain('href="/api/assets/4?expires=1&amp;signature=historical"');
    expect(before).toContain('data-author="x"');
  });

  it('does not interchange image/video approvals for an identical local reference', async () => {
    const blocks = [{ name: 'videos', videoConfig: { url: ticket(1) }, imgConfig: { url: ticket(2) } },
      { name: 'videos', videoConfig: { url: ticket(2) }, imgConfig: { url: ticket(1) } }];
    await renderDiyEditorialMedia(f.db, appKey, blocks);
    expect(blocks[0]).toEqual({ name: 'videos', videoConfig: { url: '' }, imgConfig: { url: '' } });
    expect(blocks[1]!.videoConfig.url).toMatch(/^\/api\/assets\/2\?expires=/u);
    expect(blocks[1]!.imgConfig.url).toMatch(/^\/api\/assets\/1\?expires=/u);
  });

  it.each(['customerService', 'videos', 'richText'] as const)('retains the previous Unicode-whitespace refusal in %s without a second entity decode', async family => {
    for (const reference of ['/static/a\u00a0.png', '/static/a\u2028.png', 'https://foreign.example/a\u2003.png']) {
      const entry = sample(family, reference);
      await renderDiyEditorialMedia(f.db, undefined, [entry.block]);
      expect(entry.pick()).toBe('');
    }
  });
});
