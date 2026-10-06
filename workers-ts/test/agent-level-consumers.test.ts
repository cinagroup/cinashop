import { describe, expect, it } from 'vitest';
import type { agentLevel, agentLevelTask } from '../src/models/schema';
import { AgentLevelTaskInvalidException, agentTaskRemainingTitle, planAgentLevelUpgrade, resolveAgentUpgradeUids, type AgentTaskMetrics,
  type AgentUpgradePolicy } from '../src/services/agent/AgentLevelTaskService';
import { operationalErrorCode } from '../src/utils/observability';

const level = (id: number, grade: number, extra: Partial<typeof agentLevel.$inferSelect> = {}): typeof agentLevel.$inferSelect => ({
  id, grade, name: `等级${id}`, image: '', color: '#123456', oneBrokerage: 10, twoBrokerage: 5,
  status: 1, isDel: 0, addTime: 1, ...extra,
});
const task = (id: number, levelId: number, type = 1, number = 1,
  extra: Partial<typeof agentLevelTask.$inferSelect> = {}): typeof agentLevelTask.$inferSelect => ({
  id, levelId, type, number, name: `任务${id}`, desc: '', isMust: 0, sort: 0, status: 1, isDel: 0, addTime: 1, ...extra,
});
const metrics: AgentTaskMetrics = { inviteCount: 2, ownOrderCents: 9999, ownOrderCount: 1,
  downlineOrderCents: 9999, downlineOrderCount: 1 };
const policy: AgentUpgradePolicy = { enabled: true, selfBuy: false, bindingMode: 1, bindingDays: 30 };
const accounts = [{ uid: 30, spreadUid: 20, spreadTime: 100 }, { uid: 20, spreadUid: 10, spreadTime: 100 },
  { uid: 10, spreadUid: 5, spreadTime: 100 }];

describe('distributor upgrade consumers', () => {
  it.each([
    { type: 0, number: 1 }, { type: 2, number: 0 }, { type: 2, number: -1 },
  ])('refuses a new uncompleted invalid active task %j instead of granting a rank', invalid => {
    expect(() => planAgentLevelUpgrade(0, [level(1, 1)], [task(1, 1), task(2, 1, invalid.type, invalid.number)],
      new Set(), metrics)).toThrow(AgentLevelTaskInvalidException);
    expect(operationalErrorCode(new AgentLevelTaskInvalidException())).toBe('agent_level_task_invalid_exception');
  });
  it('keeps invalid historical completed evidence and gifted rank durable without creating its new record', () => {
    const requirements = [task(1, 1), task(2, 1, 0, -1)];
    expect(planAgentLevelUpgrade(0, [level(1, 1)], requirements, new Set(['1:2']), metrics))
      .toEqual({ levelId: 1, currentGrade: 0, newRecords: [{ levelId: 1, taskId: 1 }] });
    expect(planAgentLevelUpgrade(50, [level(1, 1), level(50, 10, { status: 0 })], requirements, new Set(), metrics))
      .toEqual({ levelId: 50, currentGrade: 10, newRecords: [] });
  });
  // Exact PHP TaskType wording, with the existing five independent metrics:
  // one cent short must remain 0.01 yuan, never round into a completed task.
  it.each([
    [1, 3, '还需邀请好友1人成为下级'],
    [2, 100, '还需自身消费满0.01元'],
    [3, 2, '还需自身消费满1单'],
    [4, 100, '还需下级消费满0.01元'],
    [5, 2, '还需下级消费满1单'],
  ] as const)('preserves legacy type %s task text and exact amount/count units', (type, number, expected) => {
    expect(agentTaskRemainingTitle({ type, number }, metrics)).toBe(expected);
  });
  it.each([{ status: 0 }, { isDel: 1 }])('retains an assigned hidden/deleted rank without downgrading: %j', hidden => {
    const result = planAgentLevelUpgrade(50, [level(1, 1), level(50, 10, hidden), level(2, 20)],
      [task(1, 1), task(2, 2, 2, 100)], new Set(['1:1']), metrics);
    expect(result).toEqual({ levelId: 50, currentGrade: 10, newRecords: [] });
  });
  it('requires every active task and stops at the first incomplete rank regardless of is_must', () => {
    const result = planAgentLevelUpgrade(0, [level(1, 1), level(2, 2)],
      [task(1, 1), task(2, 1, 2, 100, { isMust: 0 }), task(3, 2)], new Set(), metrics);
    expect(result.levelId).toBe(0);
    expect(result.newRecords).toEqual([{ levelId: 1, taskId: 1 }]);
  });
  it('skips empty ranks and counts exact money thresholds without rounding up', () => {
    expect(planAgentLevelUpgrade(0, [level(1, 1), level(2, 2)], [task(2, 2, 2, 100)], new Set(), metrics).levelId).toBe(0);
    expect(planAgentLevelUpgrade(0, [level(1, 1), level(2, 2)], [task(2, 2, 2, 100)], new Set(),
      { ...metrics, ownOrderCents: 10000 }).levelId).toBe(2);
  });
  it('keeps historical completed evidence durable and never inserts its duplicate', () => {
    expect(planAgentLevelUpgrade(0, [level(1, 1)], [task(1, 1, 2, 100)],
      new Set(['1:1', '1:1']), metrics)).toEqual({ levelId: 1, currentGrade: 0, newRecords: [] });
  });
  it('rejects missing assigned ranks and ambiguous duplicate active grades', () => {
    expect(() => planAgentLevelUpgrade(9, [level(1, 1)], [], new Set(), metrics)).toThrow('引用缺失');
    expect(() => planAgentLevelUpgrade(0, [level(1, 1), level(2, 1)], [], new Set(), metrics)).toThrow('重复分销级别');
  });
  it('selects the user and two legacy upstream accounts in sorted locking order', () => {
    expect(resolveAgentUpgradeUids(30, policy, accounts, 1000)).toEqual([10, 20, 30]);
    expect(resolveAgentUpgradeUids(30, { ...policy, selfBuy: true }, accounts, 1000)).toEqual([20, 30]);
  });
  it('honors exact relation expiry, permanent modes and disabled distribution', () => {
    expect(resolveAgentUpgradeUids(30, { ...policy, bindingMode: 2, bindingDays: 1 }, accounts, 86500)).toEqual([30]);
    expect(resolveAgentUpgradeUids(30, { ...policy, bindingMode: 2, bindingDays: 1 }, accounts, 86499)).toEqual([10, 20, 30]);
    expect(resolveAgentUpgradeUids(30, { ...policy, bindingMode: 3 }, accounts, 999999)).toEqual([10, 20, 30]);
    expect(resolveAgentUpgradeUids(30, { ...policy, enabled: false }, accounts, 1000)).toEqual([]);
  });
  it('does not bypass second-hop expiry when self-buy replaces the first recipient', () => {
    expect(resolveAgentUpgradeUids(30, { ...policy, selfBuy: true, bindingMode: 2, bindingDays: 0 }, accounts, 101)).toEqual([30]);
  });
});
