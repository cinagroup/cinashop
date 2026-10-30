import { createCipheriv, createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { systemConfig, wechatCallbackEvent, wechatCallbackOutbox, wechatKey, wechatReply } from '../src/models/schema';
import { financeMemoryPostgres } from './helpers/financePostgres';
import { WechatCallbackService } from '../src/services/wechat/WechatCallbackService';
import { decryptWechatCallback, verifyWechatEncryptedSignature, wechatEncryptedXmlValue, wechatXmlText, type WechatCallbackQuery } from '../src/services/wechat/WechatCallbackCrypto';
import { WECHAT_BASE_CALLBACK_AUTHORITY_KEY } from '../../view/common/wechatBase';

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const aesKey = key.toString('base64').slice(0, -1), appId = 'legacy-callback-app', token = 'FixtureToken123';
const timestamp = '1800000001', nonce = 'owned-mode-nonce';
function sha(secret: string, encrypted = '') { return createHash('sha1').update([secret, timestamp, nonce, ...(encrypted ? [encrypted] : [])].sort().join('')).digest('hex'); }
function query(encrypted = '', secret = token): WechatCallbackQuery { return { signature: sha(secret), msgSignature: encrypted ? sha(secret, encrypted) : '', timestamp, nonce }; }
function xml(content = 'hello', id = '1001') { return `<xml><ToUserName>official-receiver</ToUserName><FromUserName>owned-openid</FromUserName><CreateTime>1800000000</CreateTime><MsgType>text</MsgType><MsgId>${id}</MsgId><Content><![CDATA[${content}]]></Content></xml>`; }
function encrypt(message: string, account = appId): string {
  const body = Buffer.from(message), length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const raw = Buffer.concat([Buffer.alloc(16, 7), length, body, Buffer.from(account)]), padding = 32 - raw.length % 32;
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
}
const outer = (encrypted: string) => `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;

describe('official-account three callback modes use the actual durable pipeline', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, env: Env, service: WechatCallbackService;
  beforeAll(async () => {
    f = await financeMemoryPostgres([systemConfig, wechatCallbackEvent, wechatCallbackOutbox, wechatKey, wechatReply]);
    // The isolated finance helper creates columns/primary keys only. Install
    // the real callback arbiter indexes required by the durable ON CONFLICTs.
    await f.exec('CREATE UNIQUE INDEX wcevt_source_event_uq ON wechat_callback_event (source,event_key)');
    await f.exec('CREATE UNIQUE INDEX wcevt_replay_key_uq ON wechat_callback_event (replay_key)');
    await f.exec('CREATE UNIQUE INDEX wcout_event_uq ON wechat_callback_outbox (event_id)');
    await f.exec('CREATE UNIQUE INDEX wcout_replay_key_uq ON wechat_callback_outbox (replay_key)');
  });
  afterAll(async () => { await f.close(); });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No live callback/provider requests'));
    env = { APP_KEY: 'owned-base-callback-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      CONFIG_KV: { get: vi.fn(async (name: string) => name === 'cfg_routine_appId' ? 'mini-account' : null), put: vi.fn(), delete: vi.fn() },
      WECHAT_MINI_CALLBACK_TOKEN: 'MiniToken', WECHAT_MINI_CALLBACK_AES_KEY: aesKey,
    } as unknown as Env;
    for (const table of [wechatCallbackOutbox, wechatCallbackEvent, wechatKey, wechatReply, systemConfig]) await f.db.delete(table);
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'wechat_appid', value: '"' + appId + '"' },
      { id: 2, menuName: 'wechat_token', value: token },
      { id: 3, menuName: 'wechat_encodingaeskey', value: aesKey },
      { id: 4, menuName: 'wechat_encode', value: '0' },
      { id: 5, menuName: WECHAT_BASE_CALLBACK_AUTHORITY_KEY, value: 'database' },
      { id: 6, menuName: 'routine_appId', value: '"mini-account"' },
    ]);
    await f.db.insert(wechatReply).values({ id: 1, type: 'text', data: JSON.stringify({ content: 'reply from durable snapshot' }), status: 1, hide: 0 });
    await f.db.insert(wechatKey).values({ id: 1, replyId: 1, keys: 'default' });
    service = new WechatCallbackService(createContainerFromDb(f.db), env);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const mode = (value: 0 | 1 | 2) => f.db.update(systemConfig).set({ value: String(value) }).where(eq(systemConfig.id, 4));
  const evidence = async () => ({ events: await f.db.select().from(wechatCallbackEvent).orderBy(wechatCallbackEvent.id), outboxes: await f.db.select().from(wechatCallbackOutbox).orderBy(wechatCallbackOutbox.id) });
  async function noEvidence() { expect(await evidence()).toEqual({ events: [], outboxes: [] }); }

  it('plaintext mode persists the same sanitized event/outbox and returns a plaintext durable reply', async () => {
    await f.db.update(systemConfig).set({ value: '' }).where(eq(systemConfig.id, 3));
    const result = await service.receiveOfficial(query(), xml());
    expect(result.duplicate).toBe(false); expect(result.responseBody).toContain('reply from durable snapshot'); expect(result.responseBody).not.toContain('<Encrypt>');
    const rows = await evidence(); expect(rows.events).toHaveLength(1); expect(rows.outboxes).toHaveLength(1);
    expect(rows.events[0]).toMatchObject({ source: 'official', appId, status: 'RECEIVED', replyPayload: { type: 'text', content: 'reply from durable snapshot' } });
    expect(rows.events[0].payload).not.toHaveProperty('content'); expect(JSON.stringify(rows.events[0].payload)).not.toContain('hello');
    expect(rows.outboxes[0]).toMatchObject({ eventId: result.eventId, replayKey: result.replayKey, status: 'PENDING' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('plaintext retry reuses the real event/outbox and its original reply snapshot', async () => {
    const first = await service.receiveOfficial(query(), xml());
    await f.db.update(wechatReply).set({ data: JSON.stringify({ content: 'changed reply' }) }).where(eq(wechatReply.id, 1));
    const retry = await service.receiveOfficial(query(), xml());
    expect(retry).toMatchObject({ eventId: first.eventId, outboxId: first.outboxId, replayKey: first.replayKey, duplicate: true, responseBody: first.responseBody });
    expect((await evidence()).events).toHaveLength(1); expect((await evidence()).outboxes).toHaveLength(1);
  });
  it('plaintext POST uses the body budget rather than the shorter URL challenge echo budget', async () => {
    const content = 'x'.repeat(800);
    await expect(service.receiveOfficial(query(), xml(content))).resolves.toHaveProperty('duplicate', false);
    expect(JSON.stringify((await evidence()).events[0].payload)).not.toContain(content);
  });
  it('compatibility mode still handles an authenticated plaintext POST', async () => {
    await mode(1); expect((await service.receiveOfficial(query(), xml())).responseBody).toContain('reply from durable snapshot');
  });
  it.each([1, 2] as const)('mode %s uses authenticated ciphertext instead of forged outer plaintext and encrypts its reply', async value => {
    await mode(value); const encrypted = encrypt(xml()), body = xml('forged outer text', '9999').replace('</xml>', `<Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`);
    const result = await service.receiveOfficial(query(encrypted), body), replyCipher = wechatEncryptedXmlValue(result.responseBody);
    const replyQuery: WechatCallbackQuery = { signature: '', msgSignature: wechatXmlText(result.responseBody, 'MsgSignature')!, timestamp: wechatXmlText(result.responseBody, 'TimeStamp')!, nonce: wechatXmlText(result.responseBody, 'Nonce')! };
    await expect(verifyWechatEncryptedSignature(replyQuery, replyCipher, token)).resolves.toBeUndefined();
    expect(decryptWechatCallback(replyCipher, aesKey, appId)).toContain('reply from durable snapshot');
    expect((await evidence()).events[0].payload.msgId).toBe('1001');
  });
  it('compatibility mode never falls back to a valid plain signature when the encrypted signature is wrong', async () => {
    await mode(1); const encrypted = encrypt(xml()), proof = { ...query(encrypted), msgSignature: '0'.repeat(40) };
    await expect(service.receiveOfficial(proof, xml().replace('</xml>', `<Encrypt>${encrypted}</Encrypt></xml>`))).rejects.toThrow('signature_invalid');
    await noEvidence();
  });
  it('compatibility ciphertext without msg_signature is rejected even with valid visible plaintext', async () => {
    await mode(1); const encrypted = encrypt(xml());
    await expect(service.receiveOfficial(query(), xml().replace('</xml>', `<Encrypt>${encrypted}</Encrypt></xml>`))).rejects.toThrow('encrypted_mode_required');
    await noEvidence();
  });
  it('compatibility msg_signature without ciphertext is not interpreted as plaintext', async () => {
    await mode(1); await expect(service.receiveOfficial(query(encrypt(xml())), xml())).rejects.toThrow('xml_invalid'); await noEvidence();
  });
  it('safe mode rejects a valid plain POST without changing its durable evidence tables', async () => {
    await mode(2); await expect(service.receiveOfficial(query(), xml())).rejects.toThrow('encrypted_mode_required'); await noEvidence();
  });
  it('plaintext mode does not silently accept an encrypted request', async () => {
    const encrypted = encrypt(xml()); await expect(service.receiveOfficial(query(encrypted), outer(encrypted))).rejects.toThrow('plain_mode_required'); await noEvidence();
  });
  it('wrong encrypted app identity rejects before an event or outbox is inserted', async () => {
    await mode(2); const encrypted = encrypt(xml(), 'different-account');
    await expect(service.receiveOfficial(query(encrypted), outer(encrypted))).rejects.toThrow('app_id_mismatch'); await noEvidence();
  });
  it('missing explicit database authority cannot admit a plain or encrypted POST', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 5));
    await expect(service.receiveOfficial(query(), xml())).rejects.toThrow('authority_disabled'); await noEvidence();
  });
  it('a deployment binding retains safe-mode behavior despite database plaintext staging', async () => {
    env.WECHAT_OFFICIAL_CALLBACK_TOKEN = 'DeploymentToken'; env.WECHAT_OFFICIAL_CALLBACK_AES_KEY = aesKey;
    await expect(service.receiveOfficial(query('', 'DeploymentToken'), xml())).rejects.toThrow('encrypted_mode_required'); await noEvidence();
    const encrypted = encrypt(xml());
    expect((await service.receiveOfficial(query(encrypted, 'DeploymentToken'), outer(encrypted))).responseBody).toContain('<Encrypt>');
  });
  it('mini callbacks keep their independent deployment binding and encrypted-only admission', async () => {
    await f.db.update(systemConfig).set({ value: 'unknown' }).where(eq(systemConfig.id, 5));
    const encrypted = encrypt(xml(), 'mini-account');
    const received = await service.receiveEncrypted('mini', query(encrypted, 'MiniToken'), outer(encrypted));
    expect(received.responseBody).toBe('success'); expect((await evidence()).events[0]).toMatchObject({ source: 'mini', appId: 'mini-account' });
    await expect(service.receiveEncrypted('mini', query('', 'MiniToken'), xml())).rejects.toThrow('encrypted_mode_required');
    expect(env.CONFIG_KV.get).not.toHaveBeenCalledWith('cfg_routine_appId');
  });
  it('plaintext challenge works without AES only after explicit database mode opt-in', async () => {
    await f.db.update(systemConfig).set({ value: '' }).where(eq(systemConfig.id, 3));
    await expect(service.verifyChallenge('official', query(), 'owned-echo')).resolves.toBe('owned-echo');
    await noEvidence();
  });
  it('compatible encrypted challenge verifies and decrypts its current account identity', async () => {
    await mode(1); const encrypted = encrypt('verified-echo');
    await expect(service.verifyChallenge('official', query(encrypted), encrypted)).resolves.toBe('verified-echo'); await noEvidence();
  });
});
