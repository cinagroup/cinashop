import { describe, expect, it } from 'vitest';
import type { Container } from '@/lib/di';
import { AdminPermissionService, assertDelegablePermissions, hasAdminPermission,
  normalizeRoleRules, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { RECHARGE_REFUND_PERMISSION, rechargeRefundRoutePermission } from '@/services/admin/AdminRechargeRefundPermission';

describe('dedicated recharge refund route and grant', () => {
  it.each(['quote/11','execute/11','abandon/11','cancel/11','receipt','execution','query'])(
    'requires the same explicit grant for the versioned %s action', suffix => {
      for (const prefix of ['/adminapi/', '/api/admin/']) {
        expect(requiredAdminPermission('POST', prefix + 'finance/recharge-refunds/' + suffix)).toBe(RECHARGE_REFUND_PERMISSION);
      }
    });
  it.each(['GET','HEAD','PUT','DELETE'])('does not admit a %s alias', method => {
    expect(requiredAdminPermission(method, '/adminapi/finance/recharge-refunds/execute/11')).toBeNull();
  });
  it.each(['', '/execute/0', '/execute/01', '/execute/2147483648', '/execute/11/extra', '/unknown/11'])(
    'closes unsupported namespace suffix %j', suffix => {
      expect(requiredAdminPermission('POST', '/adminapi/finance/recharge-refunds' + suffix)).toBeNull();
    });
  it('does not accept a trailing newline as a canonical operation identifier', () => {
    expect(rechargeRefundRoutePermission('POST', 'finance/recharge-refunds/execute/11\n')).toBeNull();
  });
  it('leaves the established recharge order queries under the view grant', () => {
    expect(requiredAdminPermission('GET', '/adminapi/finance/recharge-orders')).toBe('recharge_order.view');
    expect(requiredAdminPermission('GET', '/adminapi/finance/recharge-orders/11')).toBe('recharge_order.view');
  });
  it('does not derive money authority from generic refund, order, user or recharge viewing grants', () => {
    const broad = new Set(['refund.manage','order.manage','user.manage','recharge_order.view']);
    expect(hasAdminPermission(broad, RECHARGE_REFUND_PERMISSION)).toBe(false);
    expect(() => assertDelegablePermissions(broad, [RECHARGE_REFUND_PERMISSION])).toThrow('不能授予');
  });
  it('makes explicit delegation visible in the recharge permission tree and includes its review reader', () => {
    const rules = normalizeRoleRules(RECHARGE_REFUND_PERMISSION).split(',');
    expect(new Set(rules)).toEqual(new Set(['recharge_order.view', RECHARGE_REFUND_PERMISSION]));
    const tree = new AdminPermissionService({} as Container).permissionTree();
    expect(tree.find(group => group.key === 'recharge_order')?.children).toContainEqual({ key: RECHARGE_REFUND_PERMISSION, label: '充值退款' });
    expect(hasAdminPermission(new Set([RECHARGE_REFUND_PERMISSION]), RECHARGE_REFUND_PERMISSION)).toBe(true);
  });
});
