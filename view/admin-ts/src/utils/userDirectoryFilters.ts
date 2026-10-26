export type UserSource = '' | 'wechat' | 'routine' | 'h5' | 'pc' | 'app';
export type OptionKind = 'groups' | 'labels' | 'levels';
export interface DirectoryOption { id: number; name: string }
export interface UserFilterDraft {
  field_key: 'all' | 'uid' | 'phone' | 'nickname'; nickname: string;
  group_id: number | null; label_ids: number[]; sex: '' | '0' | '1' | '2';
  level: number | null; isMember: '' | '0' | '1'; is_promoter: '' | '0' | '1';
  user_time_type: '' | 'visitno' | 'visit' | 'add_time'; dates: string[] | null;
  pay_count: '' | '-1' | '0' | '1' | '2' | '3' | '4';
  country: '' | 'domestic' | 'abroad'; province: string; city: string;
}
export interface UserDirectoryQuery {
  page?: number; limit?: number; uid?: number; phone?: string; status?: 0 | 1;
  field_key?: UserFilterDraft['field_key']; nickname?: string; group_id?: number;
  label_ids?: string; sex?: '0' | '1' | '2'; level?: number; isMember?: '0' | '1';
  is_promoter?: '0' | '1'; user_time?: string; user_time_type?: Exclude<UserFilterDraft['user_time_type'], ''>;
  pay_count?: Exclude<UserFilterDraft['pay_count'], ''>; country?: 'domestic' | 'abroad';
  province?: string; city?: string; user_type?: Exclude<UserSource, ''>;
}
export const USER_SOURCE_TABS: ReadonlyArray<{ value: UserSource; label: string }> = [
  { value: '', label: '全部' }, { value: 'wechat', label: '微信公众号' },
  { value: 'routine', label: '微信小程序' }, { value: 'h5', label: 'H5' },
  { value: 'pc', label: 'PC' }, { value: 'app', label: 'APP' },
];
export const MAX_USER_ID = 2_147_483_647;
export const validId = (value: unknown, minimum = 1): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= MAX_USER_ID;
export function emptyUserFilters(): UserFilterDraft {
  return { field_key: 'all', nickname: '', group_id: null, label_ids: [], sex: '', level: null,
    isMember: '', is_promoter: '', user_time_type: '', dates: null, pay_count: '', country: '', province: '', city: '' };
}
function literal(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw Error('筛选文本格式错误');
  const text = value.trim().normalize('NFC');
  if ([...text].length > maximum) throw Error(`筛选文本不能超过${maximum}个字符`);
  return text;
}
function dateEpoch(value: string): number {
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(value)) throw Error('请选择完整有效的访问日期');
  const [year, month, day] = value.split('/').map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day!));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month! - 1 || utc.getUTCDate() !== day) throw Error('访问日期不存在');
  const epoch = utc.getTime() / 1000 - 8 * 3600;
  if (year! < 1901 || year! > 2038 || epoch < -2_147_483_648 || epoch + 86400 > MAX_USER_ID) throw Error('访问日期超出支持范围');
  return epoch;
}
export function applyUserFilters(draft: UserFilterDraft): UserDirectoryQuery {
  if (!['all', 'uid', 'phone', 'nickname'].includes(draft.field_key)) throw Error('请选择用户搜索范围');
  const query: UserDirectoryQuery = { field_key: draft.field_key };
  const nickname = literal(draft.nickname, 100);
  if (nickname) {
    if (draft.field_key === 'uid' && (!/^\d{1,10}$/.test(nickname) || !validId(Number(nickname)))) throw Error('请输入有效的 UID');
    query.nickname = nickname;
  }
  if (draft.group_id !== null) { if (!validId(draft.group_id, 0)) throw Error('用户分组无效'); query.group_id = draft.group_id; }
  if (!Array.isArray(draft.label_ids) || draft.label_ids.length > 100 || draft.label_ids.some(id => !validId(id)) || new Set(draft.label_ids).size !== draft.label_ids.length) throw Error('最多选择100个不同的用户标签');
  if (draft.label_ids.length) query.label_ids = draft.label_ids.join(',');
  if (draft.level !== null) { if (!validId(draft.level)) throw Error('会员等级无效'); query.level = draft.level; }
  for (const [key, values] of [['sex', ['', '0', '1', '2']], ['isMember', ['', '0', '1']], ['is_promoter', ['', '0', '1']],
    ['pay_count', ['', '-1', '0', '1', '2', '3', '4']], ['country', ['', 'domestic', 'abroad']]] as const) {
    const value = draft[key]; if (!values.some(item => item === value)) throw Error('筛选选项无效');
    if (value !== '') Object.assign(query, { [key]: value });
  }
  if (!['', 'visitno', 'visit', 'add_time'].includes(draft.user_time_type)) throw Error('访问情况无效');
  const dates = draft.dates ?? [];
  if (draft.user_time_type || dates.length) {
    if (!draft.user_time_type || dates.length !== 2 || dates.some(date => typeof date !== 'string' || !date)) throw Error('访问时间与访问情况需要同时选择');
    if (dateEpoch(dates[0]!) > dateEpoch(dates[1]!)) throw Error('开始日期不能晚于结束日期');
    query.user_time_type = draft.user_time_type; query.user_time = dates.join('-');
  }
  const province = literal(draft.province, 100), city = literal(draft.city, 100);
  if (province) query.province = province;
  if (city) query.city = city;
  return query;
}
