/** Actual paid/held/sole-POST producer plus a synthetic local platform issuer.
 * Only RSA/AES issuer material is generated here; provider rows are written
 * exclusively by the production App callback verifier and SQL writer. */
import { createCipheriv, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { RechargeRefundCallbackService } from '@/services/payment/RechargeRefundCallbackService';
import type { RechargeRefundCallbackStatus } from '@/services/payment/RechargeRefundCallbackCodec';
import { rechargeFirstProviderHistoryFixture, type RechargeFirstProviderHistoryFixture } from './rechargeFirstProviderHistoryNative';
import { rechargeAuthorOriginal as original } from './rechargeRefundAdminAuthorNative';

export type CallbackNativeSpecimen = Awaited<ReturnType<RechargeFirstProviderHistoryFixture['persisted']>>;
export interface CallbackNativePacket {
  readonly body: string; readonly plaintext: string;
  readonly envelope: Record<string, unknown>; readonly headers: Record<string, string>;
}
export async function rechargeRefundCallbackNativeFixture(values: Map<string, unknown>) {
  const f = await rechargeFirstProviderHistoryFixture(values);
  try {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const apiKey = Buffer.from(randomBytes(24)).toString('base64'), keyId = 'TEST_RECHARGE_REFUND_NOTIFY_V3';
    const registry = JSON.parse(f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS!) as { format: number; credentials: Array<Record<string, unknown>> };
    const first = registry.credentials.find(r => r.version === 1); if (!first) throw Error('Actual first credential missing');
    if (keys.publicKey === first.platformPublicKey || apiKey === first.apiV3Key) throw Error('Notify materials must actually rotate');
    f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = JSON.stringify({ ...registry, credentials: [...registry.credentials,
      { ...first, version: 3, serialNo: 'ABCDEF345678', privateKey: keys.privateKey,
        platformPublicKey: keys.publicKey, platformPublicKeyId: keyId, apiV3Key: apiKey }] });
    function issue(envelope: Record<string, unknown>, plaintext: string, headerPatch: Record<string, string> = {}): CallbackNativePacket {
      const body = JSON.stringify(envelope, null, 1), timestamp = String(Math.floor(Date.now() / 1000)), nonce = Buffer.from(randomBytes(12)).toString('hex');
      const h = { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-serial': keyId, ...headerPatch };
      const signature = Buffer.from(sign('RSA-SHA256', Buffer.from(h['wechatpay-timestamp'] + '\n' + h['wechatpay-nonce'] + '\n' + body + '\n'), keys.privateKey)).toString('base64');
      return { body, plaintext, envelope, headers: { ...h, 'wechatpay-signature': signature } };
    }
    function encrypted(envelope: Record<string, unknown>, plaintext: string, bytes?: Uint8Array, wrongKey = false) {
      const nonce = Buffer.from(randomBytes(6)).toString('hex'), aad = 'refund';
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(wrongKey ? 'x'.repeat(32) : apiKey), Buffer.from(nonce));
      cipher.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([cipher.update(bytes ?? Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]).toString('base64');
      return issue({ ...envelope, resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'refund', ciphertext, nonce, associated_data: aad } }, plaintext);
    }
    function packet(r: CallbackNativeSpecimen, status: RechargeRefundCallbackStatus = 'SUCCESS', patch: Record<string, unknown> = {},
      options: { eventId?: string; eventType?: string; bytes?: Uint8Array; wrongKey?: boolean } = {}): CallbackNativePacket {
      const time = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
      const payload = { mchid: original.merchantId, out_trade_no: r.order.orderId, transaction_id: r.transaction,
        out_refund_no: r.operation.out_refund_no, refund_id: 'cb' + String(r.operation.operation_id).replaceAll('-', '').slice(0, 28),
        refund_status: status, ...(status === 'SUCCESS' ? { success_time: time } : {}), user_received_account: 'synthetic original wallet',
        amount: { total: 1000, refund: 1000, payer_total: 1000, payer_refund: 1000 }, ...patch };
      // Whitespace is deliberate: the verifier must digest actual decrypted
      // bytes, never a canonical re-serialization of the parsed object.
      const plaintext = '\n' + JSON.stringify(payload, null, 1) + '\n';
      return encrypted({ id: options.eventId ?? randomUUID(), create_time: time, event_type: options.eventType ?? 'REFUND.' + status,
        resource_type: 'encrypt-resource', summary: 'synthetic refund notice' }, plaintext, options.bytes, options.wrongKey);
    }
    return { ...f, keyId, packet, issue,
      reencrypt: (p: CallbackNativePacket) => encrypted(p.envelope, p.plaintext),
      service: (root: DbClient = f.appRuntime.db) => new RechargeRefundCallbackService(createContainerFromDb(root), f.env) };
  } catch (error) { await f.close(); throw error; }
}
export type RechargeRefundCallbackNativeFixture = Awaited<ReturnType<typeof rechargeRefundCallbackNativeFixture>>;
