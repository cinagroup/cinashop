import { userCenterDestination } from './userCenter';

/** Editorial links use the same admitted destinations as the author picker. */
export function normalizeDiyEditorialLink(value: unknown): string {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const source = typeof value === 'string' ? value.trim() : ['url', 'value', 'title', 'link'].map(key => row?.[key]).find((v): v is string => typeof v === 'string' && !!v.trim())?.trim() ?? '';
  const target = userCenterDestination(source);
  return target ? target.kind === 'page' || target.kind === 'external' ? target.url : `${target.path}@APPID=${target.appId}` : '';
}
