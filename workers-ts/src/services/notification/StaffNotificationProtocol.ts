import { AuthException, ValidateException } from "@/utils/errors";

export type StaffAudience = "admin" | "kefu";
export type StaffNotificationScope = 'withdrawal' | 'product_stock';
export interface StaffPrincipal { audience: StaffAudience; id: number; scope?: StaffNotificationScope }
export interface StaffSocketSession extends StaffPrincipal {
  authId: number;
  tokenKey: string;
  authVersion: string;
  expiresAt: number;
}
export const STAFF_REFRESH_EVENT = "withdrawal.staff.refresh";
export function staffPrincipalName(value: StaffPrincipal): string {
  if (!value || !["admin", "kefu"].includes(value.audience) || !Number.isSafeInteger(value.id) || value.id <= 0) {
    throw new ValidateException("通知接收身份无效");
  }
  if (value.scope !== undefined && value.scope !== 'withdrawal' && value.scope !== 'product_stock' || value.scope === 'product_stock' && value.audience !== 'admin') throw new ValidateException('通知作用域无效');
  if (value.scope === 'product_stock') return `staff-stock:admin:${value.id}`;
  return `staff-notice:${value.audience}:${value.id}`;
}
export function parseStaffSession(value: unknown): StaffSocketSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthException("通知登录状态无效");
  const s = value as Partial<StaffSocketSession>;
  if ((s.audience !== "admin" && s.audience !== "kefu") || !Number.isSafeInteger(s.id) || Number(s.id) <= 0
    || s.scope !== undefined && s.scope !== 'withdrawal' && s.scope !== 'product_stock'
    || s.scope === 'product_stock' && s.audience !== 'admin'
    || !Number.isSafeInteger(s.authId) || Number(s.authId) <= 0
    || (s.audience === "admin" && s.id !== s.authId)
    || !Number.isSafeInteger(s.expiresAt) || Number(s.expiresAt) <= 0
    || typeof s.tokenKey !== "string" || !/^[a-f0-9]{32}$/.test(s.tokenKey)
    || typeof s.authVersion !== "string" || !/^[a-f0-9]{32}$/.test(s.authVersion)) {
    throw new AuthException("通知登录状态无效");
  }
  return { audience: s.audience, id: s.id!, authId: s.authId!, expiresAt: s.expiresAt!, tokenKey: s.tokenKey, authVersion: s.authVersion,
    ...(s.scope === undefined ? {} : { scope: s.scope }) };
}
export function parseStaffEventKey(value: unknown): string {
  if (typeof value !== "string" || !/^(?:withdrawal\.staff\.refresh:[1-9]\d{0,9}|product\.(?:stock|save)\.effects:[1-9]\d{0,9}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(value)
    || Number(value.split(":")[1]) > 2_147_483_647) throw new ValidateException("通知事件键无效");
  return value;
}
export function assertStaffEventScope(principal: StaffPrincipal, key: string): void {
  parseStaffEventKey(key);
  const stockEvent = key.startsWith('product.stock.effects:') || key.startsWith('product.save.effects:');
  if ((principal.scope === 'product_stock') !== stockEvent) throw new ValidateException('通知事件与作用域不匹配');
}
