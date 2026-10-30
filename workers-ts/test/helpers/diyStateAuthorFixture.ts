import { and, eq, sql } from 'drizzle-orm';
import { systemConfig, systemDise } from '@/models/schema';
import { AttachmentService, userAttachmentScope } from '@/services/system/AttachmentService';
import { SystemConfigService } from '@/services/system/SystemConfigService';
import { diyNavigationAuthorFixture } from './diyNavigationAuthorFixture';
import { diyFooterBlock } from './diyFooterFixture';
import { sortedDiyState, type DiyStateRow as Row } from './diyStateFixture';
import defaults from '../fixtures/diy-state-author-defaults.json';

export const DIY_STATE_AUTHOR_NAMES = ['userInfor', 'newVip', 'signIn', 'ranking'] as const;
export type DiyStateAuthorName = typeof DIY_STATE_AUTHOR_NAMES[number];
export const DIY_STATE_AUTHOR_STATIC_RANKING = '/static/images/diy/ranking.png';
export const DIY_STATE_AUTHOR_STYLES = DIY_STATE_AUTHOR_NAMES.flatMap(kind => [0, 1].map(style => [kind, style] as const));

/** Complete immutable PHP literals. The ordinary instance only binds its own
 * timestamp; the original ranking asset is served at its migrated static path. */
export function stateAuthorBlock(kind: DiyStateAuthorName, timestamp: number): Row {
  const result: Row = structuredClone(defaults[kind]); result.timestamp = timestamp; return result;
}
type Images = { platformImage: { url: string }; secondIcon: { url: string }; image: { url: string } };
const importedCorners = () => [{ val: '0.0005' }, { val: ' 2.25 ' }, { val: '3e0' }, { val: 4.75 }];

export function stateAuthorBlocks(f: Images, micro = false): Row[] {
  const states = DIY_STATE_AUTHOR_NAMES.map((kind, index) => {
    const block = stateAuthorBlock(kind, 100 + index * 10);
    block.authorExtra = { zero: 0, empty: [], note: `${kind}-retained`, privatePreview: f.image.url };
    if (kind === 'userInfor') block.logoConfig.url = f.platformImage.url;
    if (micro) {
      block.styleConfig.tabVal = index % 2 ? '1' : '0'; block.toneConfig.tabVal = '1';
      block.prConfig.val = ' 12.5 '; block.topConfig.val = '1e30'; block.bottomConfig.val = '0.0005';
      block.fillet.type = true; block.fillet.val = ' 1e-3 '; block.fillet.valList = importedCorners();
      if (kind === 'userInfor') block.checkboxInfo.type = [3, 1, 2, 4, 0, 5, 101, 0];
      if (kind === 'newVip') { block.toneCouponConfig.tabVal = '0'; block.toneGoodsConfig.tabVal = '1'; block.spacingConfig.val = ' 0.0005 '; block.spacingConfig2.val = '2e0'; }
      if (kind === 'ranking') {
        block.imgConfig.url = f.secondIcon.url; block.titleConfig.tabVal = '1'; block.titleText.tabVal = '2e0';
        block.titleNumber.val = '0.0005'; block.bntNumber.val = '1e30';
        block.titleTxtConfig.value = '导入超过六字的排行榜标题'; block.rightBntConfig.value = '导入超过六字的更多按钮';
        for (const key of ['filletBg', 'filletImg']) { block[key].type = true; block[key].valList = importedCorners(); }
      }
    }
    return block;
  });
  const hidden = micro ? DIY_STATE_AUTHOR_NAMES.map((kind, index) => {
    const block = stateAuthorBlock(kind, 200 + index * 10); block.isHide = true; block.styleConfig.tabVal = 1 - index % 2;
    block.importedDuplicate = { noSingleton: true, preserved: [0, false, '', [], {}], image: f.image.url }; return block;
  }) : [];
  const title = { name: 'titles', timestamp: 10, titleConfig: { value: micro ? '状态作者导入微页正文' : '状态作者首页正文' }, fontSize: { val: 18 }, independent: 'retain-title' };
  const neighbor = { name: 'unsupported-state-author-neighbor', timestamp: 150, logoConfig: { url: f.image.url }, imgConfig: { url: f.image.url }, opaque: { zero: 0, list: [] }, preserve: 'whole-object' };
  return [title, ...states, neighbor, ...hidden, diyFooterBlock(f.platformImage.url)];
}

/** Actual authored fields only. Metadata/defaults/list entries and unknown keys
 * stay intact while every conditional color, metric, radius and spacing family
 * is edited, including dormant branches that a different style will consume. */
export function editedStateAuthorBlock(kind: DiyStateAuthorName, style: number, timestamp = 100): Row {
  const block = stateAuthorBlock(kind, timestamp); block.styleConfig.tabVal = style;
  block.authorExtra = { preserve: 'full-literal-and-neighbor-metadata', zero: 0, empty: [] };
  for (const [key, value] of Object.entries(block)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const field = value as Row;
    if (Array.isArray(field.color)) field.color.forEach((item: Row, index: number) => { item.item = index ? '#abcdef' : '#123456'; });
    if (['topConfig', 'bottomConfig', 'prConfig', 'mbConfig', 'spacingConfig', 'spacingConfig2'].includes(key)) field.val = 7.5;
    if (key.startsWith('tone')) field.tabVal = 1;
    if (['fillet', 'filletBg', 'filletImg'].includes(key)) { field.type = 1; field.val = 9.5; field.valList = [{ val: 1.25 }, { val: 2.5 }, { val: 3.75 }, { val: 4 }]; }
  }
  if (kind === 'userInfor') block.checkboxInfo.type = [3, 1, 2, 4, 0, 5];
  if (kind === 'newVip') block.checkboxInfo.type = [0, 1, 2];
  if (kind === 'ranking') { block.titleConfig.tabVal = 1; block.titleTxtConfig.value = '真实榜单'; block.rightBntConfig.value = '看更多'; block.titleText.tabVal = 2; block.titleNumber.val = 17.5; block.bntNumber.val = 13.5; }
  return block;
}

/** Exact three GUI expectations. These functions describe real UI edits only;
 * they never save or patch a Browser database row on the author's behalf. */
export function expectedStateRootEdit(f: Images, baseline = stateAuthorBlocks(f)): Row[] {
  const value = structuredClone(baseline), by = (name: string) => value.find(row => row.name === name)!;
  by('userInfor').styleConfig.tabVal = 0; by('newVip').styleConfig.tabVal = 0;
  by('ranking').imgConfig.url = f.secondIcon.url;
  return value;
}
export function expectedStateAlternateEdit(f: Images, baseline = expectedStateRootEdit(f)): Row[] {
  const value = structuredClone(baseline), by = (name: string) => value.find(row => row.name === name)!;
  for (const name of DIY_STATE_AUTHOR_NAMES) by(name).styleConfig.tabVal = 1;
  by('userInfor').toneConfig.tabVal = 1; by('userInfor').progressColor.color[0].item = '#a13f67';
  by('newVip').toneCouponConfig.tabVal = 1; by('newVip').couponBgColor2.color[0].item = '#ffeedd'; by('newVip').spacingConfig2.val = 8.5;
  by('signIn').toneConfig.tabVal = 1; by('signIn').labelBgColor.color[0].item = '#ffeecc';
  const rank = by('ranking'); rank.titleConfig.tabVal = 1; rank.titleTxtConfig.value = '真实榜单'; rank.rightBntConfig.value = '看更多'; rank.titleText.tabVal = 2; rank.titleNumber.val = 17.5;
  rank.toneConfig.tabVal = 1; rank.goodsPriceColor.color[0].item = '#13579b';
  return value;
}
export function expectedStateMicroEdit(f: Images, baseline = stateAuthorBlocks(f, true)): Row[] {
  const value = structuredClone(baseline); value.find(row => row.name === 'titles')!.titleConfig.value = '状态作者已验收微页'; return value;
}

/** Test-only owned setup over the unchanged full canonical fixture. Every table
 * and sequence is inventoried dynamically; no production DDL, ACL or new route
 * is introduced. Account/coupon/sign/rank seed domains remain separate from the
 * authored document and from measured read/author-save work. */
export async function diyStateAuthorFixture(now = new Date(), options: { namespace?: 'public' } = {}) {
  const f = await diyNavigationAuthorFixture(now, options);
  try {
    const before = await f.snapshot(), resourcesBefore = f.resources();
    const foreignImage = await new AttachmentService(f.container, f.env).uploadImage(userAttachmentScope(22), new File([f.png], 'state-author-other-user.png', { type: 'image/png' }), 0);
    const rootBlocks = stateAuthorBlocks(f), microBlocks = stateAuthorBlocks(f, true);
    for (const id of [1, 2]) await f.db.update(systemDise).set({ name: id === 1 ? '状态作者首页' : '状态作者微页', title: id === 1 ? '状态作者首页' : '状态作者导入微页',
      value: JSON.stringify(id === 1 ? rootBlocks : microBlocks), content: `independent-state-author-content-${id}`, version: 'state-author-initial', updateTime: Math.floor(now.getTime() / 1000) - 3600 }).where(eq(systemDise.id, id));
    const tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r => r.name);
    const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(r => r.name);
    async function snapshot() {
      const result = await f.snapshot();
      if (Object.keys(result).length !== tables.length + 1 || result.__sequences.length !== sequences.length) throw Error('State author full inventory changed');
      return sortedDiyState(result);
    }
    const configs = new SystemConfigService(f.container, f.env);
    async function setStateAuthorConfig(menuName: 'station_open', value: string) {
      const previous = await snapshot(), previousResources = f.resources();
      await f.db.update(systemConfig).set({ value }).where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0)));
      f.cache.delete('cfg_' + menuName); await configs.getMany([menuName]);
      return { before: previous, after: await snapshot(), resources_before: previousResources, resources_after: f.resources() };
    }
    return { ...f, tables, sequences, snapshot, rootBlocks, microBlocks, foreignImage, setStateAuthorConfig,
      stateAuthorSetup: { phase: 'owned complete four-family literal defaults, independent imported state rows and real foreign-user image setup; not GET or GUI author writes',
        before, after: await snapshot(), resources_before: resourcesBefore, resources_after: f.resources(), tables, sequences,
        default_keys: { userInfor: 22, newVip: 37, signIn: 22, ranking: 33 }, ranking_static_reference: DIY_STATE_AUTHOR_STATIC_RANKING,
        inherited_setup: f.navigationAuthorSetup, account_domains: ['user11', 'user22', 'coupons', 'userSign', 'systemUserLevel', 'public product ranks'] } };
  } catch (reason) { await f.close(); throw reason; }
}
