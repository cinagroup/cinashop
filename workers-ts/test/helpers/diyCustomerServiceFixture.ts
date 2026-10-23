import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { diyFooterBrowserFixture } from './diyFooterBrowserFixture';
import type { DiyStateRow } from './diyStateFixture';
import { systemAdmin, systemConfig, systemDise, systemRole } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { AttachmentService, adminAttachmentScope } from '@/services/system/AttachmentService';

export const DIY_CUSTOMER_CONFIG_KEYS = ['routine_contact_type', 'customer_type', 'customer_phone', 'customer_url', 'wechat_work_corpid'] as const;
export type DiyCustomerConfigKey = typeof DIY_CUSTOMER_CONFIG_KEYS[number];
export const DIY_CUSTOMER_CONFIG_DEFAULTS: Record<DiyCustomerConfigKey, string> = {
  routine_contact_type: '0', customer_type: '0', customer_phone: '400-123-4567',
  customer_url: 'https://customer.example.test/service?from=diy', wechat_work_corpid: 'ww0123456789abcdef',
};

/** Exact home_service/c_home_service author shape, independently of suspended_window. */
export function diyCustomerServiceBlock(image: string): DiyStateRow {
  return { name: 'customerService', cname: '悬浮按钮', timestamp: 200, isHide: false,
    setUp: { tabVal: 0 }, titleLeft: '按钮设置', titleRight: '位置设置',
    buttonConfig: { title: '按钮跳转', tabVal: 0, tabList: [{ name: '页面链接' }, { name: '客服入口' }] },
    locationConfig: { title: '展示位置', tabVal: 1, tabList: [{ name: '左' }, { name: '右' }] },
    logoConfig: { title: '建议：展示上传100*100px；', url: image, link: '/pages/article/list?from=customer&A=1' },
    topConfig: { title: '上下偏移', val: 0, min: 0 },
    routine_contact_type: 91, authorExtra: { preserve: true, image, link: image }, preview: image };
}

/** All schema/role/media writes are explicit owned setup. No production addon,
 * schema/ACL change or synthetic HTTP business response is required. The 73
 * table/68 sequence inherited snapshot is used by every measured read. */
export async function diyCustomerServiceFixture(now = new Date(), options: { batchImages?: number; namespace?: 'public' } = {}) {
  const f = await diyFooterBrowserFixture({ now, ...(options.namespace ? { namespace: options.namespace } : {}) });
  try {
    const resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
      queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length,
      objects: [...f.objects].map(([key, item]) => ({ key, type: item.type, bytes: item.bytes.length,
        sha256: createHash('sha256').update(item.bytes).digest('hex') })).sort((a, b) => a.key.localeCompare(b.key)),
      rendering: { info: f.rendering.info.mock.calls.length, input: f.rendering.input.mock.calls.length,
        transform: f.rendering.transform.mock.calls.length, draw: f.rendering.draw.mock.calls.length, output: f.rendering.output.mock.calls.length } });
    const before = await f.snapshot(), beforeResources = resources();
    async function setCustomerConfig(values: Partial<Record<DiyCustomerConfigKey, string>>) {
      const previous = await f.snapshot(), initialResources = resources();
      for (const [menuName, value] of Object.entries(values)) {
        if (!DIY_CUSTOMER_CONFIG_KEYS.includes(menuName as DiyCustomerConfigKey)) throw Error('Unknown owned customer config key');
        const rows = await f.db.select().from(systemConfig).where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0)));
        if (rows.length) await f.db.update(systemConfig).set({ value: JSON.stringify(value) }).where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0)));
        else await f.db.insert(systemConfig).values({ menuName, value: JSON.stringify(value), isStore: 0, status: 1 });
        f.cache.delete('cfg_' + menuName);
      }
      return { before: previous, after: await f.snapshot(), resources_before: initialResources, resources_after: resources() };
    }
    await setCustomerConfig(DIY_CUSTOMER_CONFIG_DEFAULTS);
    await f.db.insert(systemRole).values({ id: 902, roleName: 'Owned customer component reader', rules: 'dise.view,attachment.view', status: 1 });
    const password = 'owned-customer-component-reader';
    await f.db.insert(systemAdmin).values({ id: 902, account: 'owned-customer-reader', realName: '客服组件只读管理员', pwd: password,
      roles: '902', level: 1, adminType: 1, relationId: 0, status: 1 });
    const readerToken = (await createToken(902, 'admin', md5(password), f.env.APP_KEY)).token;
    const blocks = [diyCustomerServiceBlock(f.platformImage.url), { name: 'unknown-neighbor', timestamp: 300,
      logoConfig: { url: f.platformImage.url }, link: f.platformImage.url, preserve: { empty: [], zero: 0 } }, structuredClone(f.blocks[1])];
    for (const id of [1, 2]) await f.db.update(systemDise).set({ title: id === 1 ? '实际客服首页' : '实际客服微页', value: JSON.stringify(blocks),
      version: 'diy-customer-service-1', content: 'independent-owned-customer-content' }).where(eq(systemDise.id, id));
    const batchImages: Array<{ att_id: number; url: string }> = [], beforeImages = await f.snapshot(), beforeImageResources = resources();
    const count = options.batchImages ?? 257;
    if (!Number.isSafeInteger(count) || count < 0 || count > 257) throw Error('Bounded real image setup is 0..257');
    const attachments = new AttachmentService(f.container, f.env);
    for (let index = 0; index < count; index++) batchImages.push(await attachments.uploadImage(adminAttachmentScope(),
      new File([f.png], `customer-service-batch-${index}.png`, { type: 'image/png' }), 0));
    const imageSetup = { phase: 'owned setup: actual platform image uploads, not public-read work', count,
      before: beforeImages, after: await f.snapshot(), resources_before: beforeImageResources, resources_after: resources(), images: batchImages };
    return { ...f, now, blocks, readerToken, resources, setCustomerConfig, batchImages, imageSetup,
      setup: { before, after: await f.snapshot(), resources_before: beforeResources, resources_after: resources(),
        config_keys: DIY_CUSTOMER_CONFIG_KEYS, additional_role: 902, image_setup_separate: true } };
  } catch (reason) { await f.close(); throw reason; }
}
