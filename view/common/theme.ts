/** The six presets and six roles are the legacy App.setTheme contract. */
export type ThemeStatus = 1 | 2 | 3 | 4 | 5 | 6;
export interface ThemePreset { status: ThemeStatus; name: string; theme: string; priceColor: string; minorColor: string; minorColorT: string; bntColor: string; gradient: string }
export const THEME_PRESETS: readonly ThemePreset[] = Object.freeze([
  { status: 1, name: '天空蓝', theme: '#1DB0FC', priceColor: '#FD502F', minorColor: 'rgba(58, 139, 236, 0.5)', minorColorT: 'rgba(9, 139, 243, 0.1)', bntColor: '#22CAFD', gradient: '#5ACBFF' },
  { status: 2, name: '生鲜绿', theme: '#42CA4D', priceColor: '#FF7600', minorColor: 'rgba(108, 198, 94, 0.5)', minorColorT: 'rgba(66, 202, 77, 0.1)', bntColor: '#FE960F', gradient: '#4DEA4D' },
  { status: 3, name: '热情红', theme: '#e93323', priceColor: '#e93323', minorColor: 'rgba(233, 51, 35, 0.5)', minorColorT: 'rgba(233, 51, 35, 0.1)', bntColor: '#FE960F', gradient: '#FF7931' },
  { status: 4, name: '魅力粉', theme: '#FF448F', priceColor: '#FF448F', minorColor: 'rgba(255, 68, 143, 0.5)', minorColorT: 'rgba(255, 68, 143, 0.1)', bntColor: '#282828', gradient: '#FF67AD' },
  { status: 5, name: '活力橙', theme: '#FE5C2D', priceColor: '#FE5C2D', minorColor: 'rgba(254, 92, 45, 0.5)', minorColorT: 'rgba(254, 92, 45, 0.1)', bntColor: '#FDB000', gradient: '#FF9451' },
  { status: 6, name: '高端金', theme: '#E0A558', priceColor: '#DA8C18', minorColor: 'rgba(224, 165, 88, 0.5)', minorColorT: 'rgba(224, 165, 88, 0.1)', bntColor: '#1A1A1A', gradient: '#FFCD8C' },
].map(preset => Object.freeze(preset)) as ThemePreset[]);
export const isThemeStatus = (value: unknown): value is ThemeStatus => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6;
export function themePreset(status: unknown): ThemePreset { return THEME_PRESETS.find(preset => preset.status === status) ?? THEME_PRESETS[2]!; }
export function themeVariables(status: unknown): Record<string, string> {
  const preset = themePreset(status);
  return Object.fromEntries(['theme', 'priceColor', 'minorColor', 'minorColorT', 'bntColor', 'gradient'].map(role => [`--view-${role}`, preset[role as keyof ThemePreset] as string]));
}
export function themeStyle(status: unknown): string { return Object.entries(themeVariables(status)).map(([key, value]) => `${key}:${value}`).join(';'); }
export const themeIssueLabel = (issue: string): string => ({ theme_missing: '尚未保存主题配置', theme_duplicate: '存在重复主题配置，需要先修复数据', theme_identity_invalid: '主题记录身份异常，需要先修复数据', theme_status_invalid: '主题值异常，请选择预设并明确保存' }[issue] ?? issue);
