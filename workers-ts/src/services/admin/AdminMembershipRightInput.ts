import { ValidateException } from '@/utils/errors';
import { parseLevelActivationJson } from './AdminLevelActivationInput';

export const MEMBERSHIP_RIGHT_AUTHOR_FIELDS = ['right_type', 'title', 'show_title', 'image', 'explain', 'number', 'sort'] as const;
export type MembershipRightAuthorField = typeof MEMBERSHIP_RIGHT_AUTHOR_FIELDS[number];
export interface MembershipRightAuthorInput { author: 1; version: string; fields: Record<string, unknown>; create: boolean; statusOnly: boolean }
const bad = (message: string): never => { throw new ValidateException(message); };
export function parseMembershipRightAuthorJson(source: string): Record<string, unknown> {
  const value = parseLevelActivationJson(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('会员权益请求须为JSON对象');
  return value as Record<string, unknown>;
}
export function membershipRightAuthorId(value: unknown, create = false): number {
  if (!['number', 'string'].includes(typeof value) || !(create ? /^(?:0|[1-9]\d{0,9})$/ : /^[1-9]\d{0,9}$/).test(String(value))
    || Number(value) > 2147483647) return bad('会员权益ID无效');
  return Number(value);
}
export function membershipRightAuthorQuery(query: URLSearchParams): { page: number; limit: number } {
  for (const key of query.keys()) if (!['author', 'page', 'limit'].includes(key) || query.getAll(key).length !== 1) return bad('会员权益查询字段未知或重复');
  if (query.get('author') !== '1') return bad('author须为1');
  const number = (key: string, fallback: number, max: number) => { const raw = query.get(key); if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) return bad('会员权益分页无效'); return Number(raw); };
  const page = number('page', 1, 10000), limit = number('limit', 30, 100);
  if ((page - 1) * limit > 100000) return bad('会员权益分页偏移超过100000');
  return { page, limit };
}
export function membershipRightAuthorInput(value: Record<string, unknown>, id: number, content = false): MembershipRightAuthorInput {
  if (value.author !== 1 || typeof value.version !== 'string' || !(id === 0 ? value.version === 'absent' : /^[a-f0-9]{64}$/.test(value.version))) return bad('会员权益版本无效，请重新读取');
  const fields = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'author' && key !== 'version'));
  const keys = Object.keys(fields), create = id === 0, statusOnly = !content && !create && keys.length === 1 && keys[0] === 'status';
  if (content) { if (create || keys.length !== 1 || keys[0] !== 'content') return bad('权益介绍只接受content字段'); }
  else if (create) { const expected = [...MEMBERSHIP_RIGHT_AUTHOR_FIELDS, 'status']; if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(fields, key))) return bad('新增权益须完整提交7项资料与status'); }
  else if (!statusOnly && (!keys.length || keys.some(key => !MEMBERSHIP_RIGHT_AUTHOR_FIELDS.includes(key as MembershipRightAuthorField)))) return bad('权益资料字段未知；status须独立保存');
  return { author: 1, version: value.version, fields, create, statusOnly };
}
export function membershipRightText(value: unknown, max: number, label: string, required = true, multiline = false): string {
  if (typeof value !== 'string' || [...value].length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)
    || [...value].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; }) || required && !value.trim()) return bad(`${label}格式无效或过长`);
  return value as string;
}
export function membershipRightInteger(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return bad(`${label}须为${min}至${max}的整数`);
  return value as number;
}
