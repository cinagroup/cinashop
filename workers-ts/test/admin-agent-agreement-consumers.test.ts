import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { agreement, promoterApply, user, userBrokerage } from '../src/models/schema';
import { PromoterApplicationService } from '../src/services/agent/PromoterApplicationService';
import { readAgreementByType } from '../src/services/user/PublicAgreementService';
import { V2UserCompatibilityService } from '../src/services/user/V2UserCompatibilityService';
import { financePostgres } from './helpers/financePostgres';

describe('historical promoter agreement consumer projections', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  const unsafe = '<p onclick="evil()">历史分销说明</p><a href="javascript:evil()">查看</a><img src="https://example.invalid/a.png" onerror="evil()"><script>alert(1)</script>';

  beforeAll(async () => {
    fixture = await financePostgres([agreement, promoterApply, user, userBrokerage]);
    container = { db: fixture.db } as Container;
    await fixture.db.insert(agreement).values([
      { type: 1, title: '会员协议', content: '<p>会员原文</p>', status: 1 },
      { type: 2, title: '分销说明', content: unsafe, status: 1 },
    ]);
    await fixture.db.insert(user).values({ uid: 11, account: 'promoter-applicant', phone: '13800138000', status: 1 });
  });
  afterAll(async () => { await fixture?.close(); });

  it('sanitizes the public, applicant and legacy v2 invite outputs without altering storage or type=1', async () => {
    const publicRow = await readAgreementByType(container, 2);
    if (Array.isArray(publicRow)) throw new Error('missing agreement fixture');
    const applicant = await new PromoterApplicationService(container, {} as Env).applyInfo(11);
    const invite = await new V2UserCompatibilityService(container).agentInfo(11);
    for (const html of [publicRow.content, applicant.agreement?.content, invite.agreement]) {
      expect(html).toContain('历史分销说明');
      expect(html).not.toMatch(/<script|onclick|onerror|javascript:/i);
    }
    const member = await readAgreementByType(container, 1);
    expect(member).toMatchObject({ type: 1, content: '<p>会员原文</p>' });
    const [stored] = await fixture.db.select({ content: agreement.content }).from(agreement).where(eq(agreement.type, 2));
    expect(stored.content).toBe(unsafe);
  });

  it('retains public and legacy v2 disabled-row semantics while preventing new applications', async () => {
    await fixture.db.update(agreement).set({ status: 0 }).where(eq(agreement.type, 2));
    expect(await readAgreementByType(container, 2)).toMatchObject({ type: 2, status: 0 });
    expect((await new PromoterApplicationService(container, {} as Env).applyInfo(11)).agreement).toBeNull();
    const invite = await new V2UserCompatibilityService(container).agentInfo(11);
    expect(invite.agreement).toContain('历史分销说明');
    expect(invite.agreement).not.toMatch(/<script|onclick|onerror|javascript:/i);
  });
});
