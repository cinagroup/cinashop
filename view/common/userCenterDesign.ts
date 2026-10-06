/** Six legacy user-centre modules. Assets and links remain server-authorized. */
export type UserCenterToggle = 0 | 1;
export type UserCenterMemberStyle = 1 | 2 | 3 | 4 | 5;
export type UserCenterOrderStyle = 1 | 2 | 3;
export type UserCenterStatisticsStyle = 1 | 2;
export type UserCenterMenuStyle = 1 | 2 | 3;
export type UserCenterPropertyId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** sourceId binds an existing row to server-held opaque fields; null means new. */
export interface UserCenterPosterItem {
  sourceId: string | null;
  name: string;
  pic: string;
  url: string;
}
export interface UserCenterMenuItem extends UserCenterPosterItem { type: 1 | 2 }
export interface UserCenterDesignValue {
  member: { style: UserCenterMemberStyle; property: number[]; per_show_type: UserCenterToggle };
  order: { style: UserCenterOrderStyle };
  orderStatic: { style: UserCenterStatisticsStyle; is_show: UserCenterToggle };
  poster: { is_show: UserCenterToggle; list: UserCenterPosterItem[] };
  menu: { title: string; is_show: UserCenterToggle; style: UserCenterMenuStyle; list: UserCenterMenuItem[] };
  merMenu: { title: string; is_show: UserCenterToggle; style: UserCenterMenuStyle; list: UserCenterMenuItem[] };
}
export interface UserCenterDesignImagePreviews { poster: string[]; menu: string[]; merMenu: string[] }
export interface UserCenterDesignSnapshot {
  revision: string;
  value: UserCenterDesignValue | null;
  configured: boolean;
  editable: boolean;
  issues: string[];
  imagePreviews: UserCenterDesignImagePreviews;
}
export interface UserCenterDesignReceipt {
  operation: 'update'; id: number; operationId: string; payloadHash: string;
}
export interface UserCenterDesignWrite { operationId: string; revision: string; value: UserCenterDesignValue }
export interface UserCenterDesignFailureProof {
  code: 'USER_CENTER_DESIGN_STALE_VERSION' | 'USER_CENTER_DESIGN_REJECTED';
  operation: 'update'; operationId: string; payloadHash: string;
}
export type PublicUserCenterPosterItem = Omit<UserCenterPosterItem, 'sourceId'>;
export type PublicUserCenterMenuItem = Omit<UserCenterMenuItem, 'sourceId'>;
export interface PublicUserCenterDesignValue {
  member: UserCenterDesignValue['member'];
  order: UserCenterDesignValue['order'];
  orderStatic: UserCenterDesignValue['orderStatic'];
  poster: { is_show: UserCenterToggle; list: PublicUserCenterPosterItem[] };
  menu: { title: string; is_show: UserCenterToggle; style: UserCenterMenuStyle; list: PublicUserCenterMenuItem[] };
  merMenu: { title: string; is_show: UserCenterToggle; style: UserCenterMenuStyle; list: PublicUserCenterMenuItem[] };
}
export interface UserCenterDesignPublicState { revision: string; configured: boolean; issues: string[] }

export const USER_CENTER_DESIGN_KEYS = Object.freeze(['member', 'order', 'orderStatic', 'poster', 'menu', 'merMenu'] as const);
export const USER_CENTER_DESIGN_MODULES = Object.freeze([
  Object.freeze({ key: 'member', title: '会员信息' }), Object.freeze({ key: 'order', title: '订单中心' }),
  Object.freeze({ key: 'orderStatic', title: '运营统计' }), Object.freeze({ key: 'poster', title: '广告位' }),
  Object.freeze({ key: 'menu', title: '我的服务' }), Object.freeze({ key: 'merMenu', title: '商家管理' }),
] as const);
export const USER_CENTER_DESIGN_LIMITS = Object.freeze({
  posterItems: 10, menuItems: 30, merMenuItems: 30, titleLength: 100, nameLength: 100,
  imageLength: 255, publicImageLength: 8192, linkLength: 2048, memberStyleOneProperties: 5, otherMemberProperties: 3,
});
/** The old editor omitted ordinal 4; the actual Uni consumer defines video collection. */
export const USER_CENTER_LEGACY_EDITOR_PROPERTY_IDS = Object.freeze([0, 1, 2, 3, 5, 6, 7, 8] as const);
export const USER_CENTER_PROPERTY_OPTIONS = Object.freeze([
  Object.freeze({ id: 0, label: '余额', field: 'now_money', url: '/pages/users/user_money/index' }),
  Object.freeze({ id: 1, label: '优惠券', field: 'couponCount', url: '/pages/users/user_coupon/index' }),
  Object.freeze({ id: 2, label: '积分', field: 'integral', url: '/pages/users/user_integral/index' }),
  Object.freeze({ id: 3, label: '收藏商品', field: 'collectProductCount', url: '/pages/users/user_goods_collection/index' }),
  Object.freeze({ id: 4, label: '收藏视频', field: 'collectVideoCount', url: '/pages/users/user_goods_collection/index?active=1' }),
  Object.freeze({ id: 5, label: '浏览记录', field: 'visit_num', url: '/pages/users/visit_list/index' }),
  Object.freeze({ id: 6, label: '推广佣金', field: 'brokerage_price', url: '/pages/users/user_spread_user/index' }),
  Object.freeze({ id: 7, label: '推广人', field: 'spread_user_count', url: '/pages/users/user_spread_user/index' }),
  Object.freeze({ id: 8, label: '推广订单', field: 'spread_order_count', url: '/pages/users/user_spread_user/index' }),
] as const);
/** These historical targets identify protected role entries; this grants no permission. */
export const USER_CENTER_MERCHANT_TARGETS = Object.freeze([
  '/pages/admin/work/index', '/pages/admin/distribution/index',
  '/pages/admin/order_cancellation/index', '/kefu/mobile_list',
  '/pages/delivery/index', '/pages/delivery/orderDetail', '/pages/delivery/scanning', '/pages/delivery/scanDetail',
] as const);

const defaults: UserCenterDesignValue = {
  member: { style: 1, property: [0, 1, 2, 3, 4], per_show_type: 0 },
  order: { style: 1 }, orderStatic: { style: 1, is_show: 1 },
  poster: { is_show: 1, list: [] },
  menu: { title: '我的服务', is_show: 1, style: 1, list: [] },
  merMenu: { title: '商家管理', is_show: 1, style: 1, list: [] },
};
Object.freeze(defaults.member.property);
Object.freeze(defaults.poster.list); Object.freeze(defaults.menu.list); Object.freeze(defaults.merMenu.list);
for (const block of Object.values(defaults)) Object.freeze(block);
export const USER_CENTER_DESIGN_DEFAULT: Readonly<UserCenterDesignValue> = Object.freeze(defaults);

function copyPoster(item: UserCenterPosterItem): UserCenterPosterItem {
  return { sourceId: item.sourceId, name: item.name, pic: item.pic, url: item.url };
}
function copyMenu(item: UserCenterMenuItem): UserCenterMenuItem { return { ...copyPoster(item), type: item.type }; }
/** Deep copies known editor fields only; opaque historical fields stay on the server. */
export function cloneUserCenterDesign(value: UserCenterDesignValue = USER_CENTER_DESIGN_DEFAULT): UserCenterDesignValue {
  return {
    member: { style: value.member.style, property: [...value.member.property], per_show_type: value.member.per_show_type },
    order: { style: value.order.style }, orderStatic: { style: value.orderStatic.style, is_show: value.orderStatic.is_show },
    poster: { is_show: value.poster.is_show, list: value.poster.list.map(copyPoster) },
    menu: { title: value.menu.title, is_show: value.menu.is_show, style: value.menu.style, list: value.menu.list.map(copyMenu) },
    merMenu: { title: value.merMenu.title, is_show: value.merMenu.is_show, style: value.merMenu.style, list: value.merMenu.list.map(copyMenu) },
  };
}
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function toggle(value: unknown): value is UserCenterToggle { return value === 0 || value === 1; }
/** Syntax/bounds only. Ownership, media, executable links and role immutability need SQL checks. */
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}
function safePublicImageLayer(value: string): boolean {
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return false;
  let addressPath: string;
  if (value.startsWith('/')) {
    if (value.startsWith('//')) return false;
    addressPath = value.split(/[?#]/u, 1)[0];
  } else {
    const match = /^https?:\/\/([^/?#]+)(.*)$/i.exec(value);
    if (!match) return false;
    const authority = /^([a-z0-9.-]+|\[[a-f0-9:]+\])(?::([0-9]{1,5}))?$/i.exec(match[1]);
    if (!authority || (authority[2] !== undefined && (Number(authority[2]) < 1 || Number(authority[2]) > 65535))) return false;
    const host = authority[1];
    if (host.startsWith('[')) {
      const ip = host.slice(1, -1), compressed = ip.includes('::'), groups = ip.split(':').filter(Boolean);
      if (!ip.includes(':') || ip.includes(':::') || (ip.startsWith(':') && !ip.startsWith('::'))
        || (ip.endsWith(':') && !ip.endsWith('::')) || ip.split('::').length > 2 || groups.some(group => group.length > 4)
        || (compressed ? groups.length >= 8 : groups.length !== 8)) return false;
    } else {
      const labels = host.replace(/\.$/u, '').split('.');
      if (host.length > 253 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return false;
      if (labels.every(label => /^\d+$/.test(label)) && (labels.length !== 4 || labels.some(label => Number(label) > 255))) return false;
    }
    addressPath = match[2].split(/[?#]/u, 1)[0];
  }
  return !addressPath.startsWith('//') && !addressPath.split('/').some(segment => segment === '.' || segment === '..');
}
/** Signed public previews may exceed canonical-reference bounds. No URL global is required on MP. */
export function isUserCenterPublicImage(value: unknown): value is string {
  if (!text(value, USER_CENTER_DESIGN_LIMITS.publicImageLength) || /\s/u.test(value)) return false;
  let layer = value;
  for (let depth = 0; depth <= 3; depth++) {
    if (!safePublicImageLayer(layer)) return false;
    if (!layer.includes('%')) return true;
    if (depth === 3) return false;
    try { layer = decodeURIComponent(layer); } catch { return false; }
  }
  return false;
}
function item(value: unknown, merchantType: 1 | 2 | null, isPublic: boolean): boolean {
  if (!record(value)) return false;
  const expected = isPublic ? ['name', 'pic', 'url'] : ['sourceId', 'name', 'pic', 'url'];
  if (merchantType !== null) expected.push('type');
  if (!keys(value, expected)) return false;
  if (!isPublic && value.sourceId !== null && (typeof value.sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceId))) return false;
  return text(value.name, USER_CENTER_DESIGN_LIMITS.nameLength)
    && (isPublic ? isUserCenterPublicImage(value.pic) : text(value.pic, USER_CENTER_DESIGN_LIMITS.imageLength))
    && text(value.url, USER_CENTER_DESIGN_LIMITS.linkLength)
    && (merchantType === null || value.type === merchantType);
}
function list(value: unknown, maximum: number, merchantType: 1 | 2 | null, isPublic: boolean): boolean {
  if (!Array.isArray(value) || value.length > maximum || !value.every(row => item(row, merchantType, isPublic))) return false;
  if (isPublic) return true;
  const ids = value.map(row => (row as UserCenterPosterItem).sourceId).filter(id => id !== null);
  return new Set(ids).size === ids.length;
}
function design(value: unknown, isPublic: boolean): boolean {
  if (!record(value) || !keys(value, USER_CENTER_DESIGN_KEYS)) return false;
  const { member, order, orderStatic, poster, menu, merMenu } = value;
  if (!record(member) || !keys(member, ['style', 'property', 'per_show_type'])
    || !integer(member.style, 1, 5) || !toggle(member.per_show_type)) return false;
  const maximum = member.style === 1 ? USER_CENTER_DESIGN_LIMITS.memberStyleOneProperties : USER_CENTER_DESIGN_LIMITS.otherMemberProperties;
  if (!Array.isArray(member.property) || member.property.length > maximum || new Set(member.property).size !== member.property.length
    || !member.property.every(id => integer(id, 0, 8))) return false;
  if (!record(order) || !keys(order, ['style']) || !integer(order.style, 1, 3)) return false;
  if (!record(orderStatic) || !keys(orderStatic, ['style', 'is_show']) || !integer(orderStatic.style, 1, 2) || !toggle(orderStatic.is_show)) return false;
  if (!record(poster) || !keys(poster, ['is_show', 'list']) || !toggle(poster.is_show)
    || !list(poster.list, USER_CENTER_DESIGN_LIMITS.posterItems, null, isPublic)) return false;
  for (const [block, merchantType, maximumItems] of [[menu, 1, USER_CENTER_DESIGN_LIMITS.menuItems], [merMenu, 2, USER_CENTER_DESIGN_LIMITS.merMenuItems]] as const) {
    if (!record(block) || !keys(block, ['title', 'is_show', 'style', 'list']) || !text(block.title, USER_CENTER_DESIGN_LIMITS.titleLength)
      || !toggle(block.is_show) || !integer(block.style, 1, 3) || !list(block.list, maximumItems, merchantType, isPublic)) return false;
  }
  return true;
}
export function isUserCenterDesignValue(value: unknown): value is UserCenterDesignValue { return design(value, false); }
export function isPublicUserCenterDesignValue(value: unknown): value is PublicUserCenterDesignValue { return design(value, true); }
export function clonePublicUserCenterDesign(value: PublicUserCenterDesignValue): PublicUserCenterDesignValue {
  const poster = (row: PublicUserCenterPosterItem): PublicUserCenterPosterItem => ({ name: row.name, pic: row.pic, url: row.url });
  const menu = (row: PublicUserCenterMenuItem): PublicUserCenterMenuItem => ({ ...poster(row), type: row.type });
  return {
    member: { style: value.member.style, property: [...value.member.property], per_show_type: value.member.per_show_type },
    order: { style: value.order.style }, orderStatic: { style: value.orderStatic.style, is_show: value.orderStatic.is_show },
    poster: { is_show: value.poster.is_show, list: value.poster.list.map(poster) },
    menu: { title: value.menu.title, is_show: value.menu.is_show, style: value.menu.style, list: value.menu.list.map(menu) },
    merMenu: { title: value.merMenu.title, is_show: value.merMenu.is_show, style: value.merMenu.style, list: value.merMenu.list.map(menu) },
  };
}
/** Role filtering must keep these lists and previews aligned before this projection. */
export function publicUserCenterDesignValue(value: UserCenterDesignValue, imagePreviews: UserCenterDesignImagePreviews): PublicUserCenterDesignValue {
  for (const key of ['poster', 'menu', 'merMenu'] as const) {
    if (!Array.isArray(imagePreviews[key]) || imagePreviews[key].length !== value[key].list.length) throw Error('个人中心列表与图片预览未对齐');
  }
  const poster = (row: UserCenterPosterItem, pic: string): PublicUserCenterPosterItem => ({ name: row.name, pic, url: row.url });
  const menu = (row: UserCenterMenuItem, pic: string): PublicUserCenterMenuItem => ({ ...poster(row, pic), type: row.type });
  return {
    member: { style: value.member.style, property: [...value.member.property], per_show_type: value.member.per_show_type },
    order: { style: value.order.style }, orderStatic: { style: value.orderStatic.style, is_show: value.orderStatic.is_show },
    poster: { is_show: value.poster.is_show, list: value.poster.list.map((row, index) => poster(row, imagePreviews.poster[index])) },
    menu: { title: value.menu.title, is_show: value.menu.is_show, style: value.menu.style, list: value.menu.list.map((row, index) => menu(row, imagePreviews.menu[index])) },
    merMenu: { title: value.merMenu.title, is_show: value.merMenu.is_show, style: value.merMenu.style, list: value.merMenu.list.map((row, index) => menu(row, imagePreviews.merMenu[index])) },
  };
}
/** Fixed deep key order; operationId stays outside the payload digest. */
export function userCenterDesignPayload(revision: string, value: UserCenterDesignValue) {
  return { operation: 'update' as const, revision, value: cloneUserCenterDesign(value) };
}
