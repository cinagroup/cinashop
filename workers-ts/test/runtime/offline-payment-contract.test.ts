import { expect, it } from 'vitest';
import { assertOfflineProviderRequest, validateOfflinePaymentTicket } from '../../src/services/payment/OfflinePaymentProviderContract';
import { buildJsapiPaySign, rsaVerify } from '../../src/utils/wechat-crypto';

const request = { orderNo: 'xx' + 'a'.repeat(30), amountCents: 1000, transactionType: 'h5' as const, payerId: '', clientIp: '203.0.113.42' };
it.each(['203.0.113.42', '2001:db8::42', '::ffff:192.0.2.42'])('workerd node:net accepts IP %s', clientIp => {
  expect(() => assertOfflineProviderRequest({ ...request, clientIp })).not.toThrow();
});
it.each(['0.0.0.0', '127.0.0.1', '::', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1'])('workerd rejects unspecified/loopback %s', clientIp => {
  expect(() => assertOfflineProviderRequest({ ...request, clientIp })).toThrow();
});
it('workerd WebCrypto creates, serializes and verifies the bounded JSAPI entrance', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair) || !('publicKey' in pair)) throw Error('RSA key pair required');
  const pem = (label: string, bytes: ArrayBuffer) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(bytes)))}\n-----END ${label}-----`;
  const privateDer = await crypto.subtle.exportKey('pkcs8', pair.privateKey), publicDer = await crypto.subtle.exportKey('spki', pair.publicKey);
  if (!(privateDer instanceof ArrayBuffer) || !(publicDer instanceof ArrayBuffer)) throw Error('DER exports required');
  const privateKey = pem('PRIVATE KEY', privateDer), publicKey = pem('PUBLIC KEY', publicDer);
  const appId = 'local-runtime-app', signed = await buildJsapiPaySign(privateKey, appId, 'local-prepay');
  const ticket: unknown = JSON.parse(JSON.stringify({ kind: 'wechat-jsapi', appId, ...signed }));
  validateOfflinePaymentTicket(ticket, { provider: 'wechat', profile: 'wechat', appId, merchantId: '1234567890' }, 'jsapi');
  if (ticket.kind !== 'wechat-jsapi') throw Error('Wrong ticket');
  expect(await rsaVerify(publicKey, `${ticket.appId}\n${ticket.timeStamp}\n${ticket.nonceStr}\n${ticket.package}\n`, ticket.paySign)).toBe(true);
  expect(() => validateOfflinePaymentTicket({ ...ticket, timeStamp: Number(ticket.timeStamp) },
    { provider: 'wechat', profile: 'wechat', appId, merchantId: '1234567890' }, 'jsapi')).toThrow();
});
