import { http } from '@/utils/request';
import { isThemeStatus, type ThemeStatus } from '../../../common/theme';
export interface PublicTheme { status: ThemeStatus | 0; navigation: unknown; product_category_level: unknown; theme_issues: string[] }
export function parsePublicTheme(value: unknown): PublicTheme {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('主题配置格式错误');
  const row = value as Record<string, unknown>;
  if (row.status !== 0 && !isThemeStatus(row.status) || !Array.isArray(row.theme_issues) || row.theme_issues.length > 20 || row.theme_issues.some(issue => typeof issue !== 'string' || [...issue].length > 256 || /[\u0000-\u001f\u007f]/u.test(issue))) throw Error('主题配置字段无效');
  return { status: row.status as PublicTheme['status'], navigation: row.navigation, product_category_level: row.product_category_level, theme_issues: row.theme_issues as string[] };
}
export async function apiTheme(): Promise<PublicTheme> { return parsePublicTheme(await http.get('/v2/diy/color_change/color_change', undefined, { noAuth: true })); }
