import { and, eq } from 'drizzle-orm';
import { storeOrderCartInfo, user } from '@/models/schema';
import { createContainerFromDb } from '@/lib/di';
import { createToken, md5 } from '@/utils/jwt';
import { refundApplicationEvidenceWriterFixture } from './refundApplicationEvidence';
import { grantCustomerRefundImageReader } from './customerRefundRequestImages';

/** Registered checkout/allocation and apiJWT, with explicitly synthetic paid
 * admission. HTTP authors use owned maintenance SQL; only the separate reader
 * LOGIN is SELECT-only. This does not install any production role or policy. */
export async function customerRefundQuantitiesFixture() {
  const f = await refundApplicationEvidenceWriterFixture();
  try {
    const carts = await f.db.select().from(storeOrderCartInfo)
      .where(and(eq(storeOrderCartInfo.oid, f.ids.sourceOrder), eq(storeOrderCartInfo.uid, f.ids.buyer)))
      .orderBy(storeOrderCartInfo.id);
    const selected = carts.find(row => row.productId === 70), unselected = carts.find(row => row.productId === 71);
    if (carts.length !== 2 || !selected || !unselected || selected.cartNum !== 2 || unselected.cartNum !== 1
      || selected.refundNum !== 0 || unselected.refundNum !== 0) throw Error('Owned checkout quantity proof requires exact 2+1 lines');
    const [foreign] = await f.db.select({ pwd: user.pwd }).from(user).where(eq(user.uid, 22));
    if (!foreign) throw Error('Owned foreign Customer missing');
    const foreignBuyer = (await createToken(22, 'api', md5(foreign.pwd), f.env.APP_KEY)).token;
    type Peer = Parameters<Parameters<typeof f.withReader>[0]>[0];
    const withCustomerReader = <T>(work: (peer: Peer) => Promise<T>) => f.withReader(async peer => {
      await grantCustomerRefundImageReader(peer.role, f.exec); return work(peer);
    });
    return { ...f, container: createContainerFromDb(f.db), selected, unselected, carts, withCustomerReader, tokens: { ...f.tokens, foreignBuyer } };
  } catch (error) { await f.close(); throw error; }
}
