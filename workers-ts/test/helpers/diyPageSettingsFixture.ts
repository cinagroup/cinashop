import { eq, sql } from 'drizzle-orm';
import { systemDise } from '@/models/schema';
import { diyCustomerServiceFixture } from './diyCustomerServiceFixture';

/** Row metadata is deliberately separate from the imported component document.
 * Reuse the actual73-table/68-sequence Admin+attachment setup without changing
 * any older fixture's defaults or adding a production table/route/permission. */
export async function diyPageSettingsFixture(now = new Date(), options: { namespace?: 'public' } = {}) {
  const f = await diyCustomerServiceFixture(now, { batchImages: 0, ...options });
  try {
    const before = await f.snapshot(), resourcesBefore = f.resources();
    const blocks = [{ name: 'titles', timestamp: 100, titleConfig: { value: '真实页面设置正文', authorNote: 'retain' }, unknown: { zero: 0, list: [] } },
      { name: 'blankPage', timestamp: 110, heightConfig: { val: 350 }, bgColor: { color: [{ item: 'transparent' }] } },
      ...structuredClone(f.blocks)];
    const homeAppearance = { is_show: 1, is_bg_color: 1, is_bg_pic: 1, color_picker: '#eaf0f7', bg_pic: f.platformImage.url, bg_tab_val: 0 };
    const microAppearance = { is_show: 1, is_bg_color: 1, is_bg_pic: 1, color_picker: '#fff5ef', bg_pic: f.secondIcon.url, bg_tab_val: 1 };
    for (const id of [1, 2]) {
      const settings = id === 1 ? homeAppearance : microAppearance;
      await f.db.update(systemDise).set({ title: id === 1 ? '真实背景首页' : '真实背景微页', isShow: settings.is_show,
        isBgColor: settings.is_bg_color, isBgPic: settings.is_bg_pic, colorPicker: settings.color_picker, bgPic: settings.bg_pic, bgTabVal: settings.bg_tab_val,
        value: JSON.stringify(blocks), content: 'independent-owned-page-settings-content', version: 'diy-page-settings-1' }).where(eq(systemDise.id, id));
    }
    // Earlier imported rows use explicit IDs. Allocate subsequent real Admin
    // creates beyond them; this sequence movement is owned setup, never a GET.
    await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('system_dise','id'),(SELECT MAX(id) FROM system_dise),true)`);
    return { ...f, now, blocks, homeAppearance, microAppearance,
      pageSettingsSetup: { phase: 'owned row metadata and component setup, not measured read work', before, after: await f.snapshot(), resources_before: resourcesBefore, resources_after: f.resources() } };
  } catch (reason) { await f.close(); throw reason; }
}
