import { eq } from 'drizzle-orm';
import { user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { refundApplicationEvidenceFixture } from './refundApplicationEvidence';

/** Dedicated read-only Customer addition to an already identity-checked owned
 * fixture. This is not a production role installer or an author privilege. */
export async function grantCustomerRefundImageReader(role: string, exec: (query: string) => Promise<unknown>) {
  if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unowned Customer evidence LOGIN');
  await exec(`GRANT SELECT ON public."user" TO "${role}"`);
}

/** Synthetic historical display rows only. Actual registered upload/application
 * authors are separately exercised with the unchanged writer fixture. */
export async function customerRefundRequestImagesFixture() {
  const f = await refundApplicationEvidenceFixture();
  try {
    const [buyer] = await f.db.select({ pwd: user.pwd }).from(user).where(eq(user.uid, 11));
    const [foreign] = await f.db.select({ pwd: user.pwd }).from(user).where(eq(user.uid, 12));
    if (!buyer || !foreign) throw Error('Owned Customer image accounts missing');
    const customer = (await createToken(11, 'api', md5(buyer.pwd), f.env.APP_KEY)).token;
    const foreignCustomer = (await createToken(12, 'api', md5(foreign.pwd), f.env.APP_KEY)).token;
    type Peer = Parameters<Parameters<typeof f.withReader>[0]>[0];
    const withReader = <T>(work: (peer: Peer) => Promise<T>) => f.withReader(async peer => {
      await grantCustomerRefundImageReader(peer.role, f.exec); return work(peer);
    });
    return { ...f, withReader, tokens: { ...f.tokens, customer, buyer: customer, foreignCustomer },
      customerIds: { withBoth: 100, legacyGoods: 201, malformed: 202, completed: 301, cancelled: 111 },
      boundary: 'independent_SELECT_only_Customer_LOGIN' as const };
  } catch (error) { await f.close(); throw error; }
}
