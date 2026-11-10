/** Transport regression only. Public standalone provider calls use production
 * methods; three internal readers are explicitly probed without claiming OAuth
 * issuance, source ownership, notification admission or financial acceptance.
 * Every outbound request is intercepted by the owning Miniflare test. */
import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { readLegacyShareProvider } from '@/services/other/LegacyShareProviderRead';
import { OfficialAccountMenuProvider } from '@/services/wechat/OfficialAccountMenuProvider';
import { PublicGeocodingService } from '@/services/system/PublicGeocodingService';
import { sendWithdrawalWecomRobot } from '@/services/wechat/WithdrawalWecomRobotProvider';
import { EnterpriseWechatProviderClient } from '@/services/work/EnterpriseWechatProviderClient';
import { issueCrmebOnePassWaybill, listCrmebOnePassExpressCatalog, listCrmebOnePassWaybillTemplates, type WaybillIssueInput } from '@/services/waybill/CrmebOnePassWaybillProvider';
import { WechatAppAuthService } from '@/services/wechat/WechatAppAuthService';
import { WechatFollowPosterService } from '@/services/wechat/WechatFollowPosterService';
import { WechatNotificationProvider } from '@/services/wechat/WechatNotificationProvider';

const issue: WaybillIssueInput = {
  carrierCode: 'SF', recipientName: 'local recipient', recipientPhone: '13800000000', recipientAddress: 'local recipient address',
  senderName: 'local sender', senderPhone: '13900000000', senderAddress: 'local sender address', templateId: 'local-template',
  cloudPrinterId: '', count: 1, cargo: 'local goods', weight: '1.00', orderNo: 'LOCAL-TRANSPORT-ONLY',
  carrier: { partnerId: false, partnerKey: false, net: false, checkMan: false, partnerName: false, isCode: false,
    account: '', key: '', netName: '', courierName: '', customerName: '', codeName: '' },
};
const button = [{ type: 'click', name: 'local menu', key: 'local-key' }];
const menuConfig = { appId: 'wx_local_transport', secret: 'inert-local-menu-secret' };
const nativeFetch = globalThis.fetch.bind(globalThis);
let modes: string[] = [];
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  modes.push(request.redirect);
  return nativeFetch(request);
};

async function run(operation: string, env: Env): Promise<unknown> {
  if (operation === 'unsupported-error-probe') {
    await fetch('https://provider.invalid/never-sent', { redirect: 'error' });
    return 'unexpected';
  }
  if (operation === 'share-json' || operation === 'share-image') {
    const response = await readLegacyShareProvider(fetch, 'https://api.weixin.qq.com/local-share', undefined, { json: 4096, image: 65536 });
    return operation === 'share-json' ? response.json() : { bytes: (await response.arrayBuffer()).byteLength };
  }
  if (operation === 'menu-create') return new OfficialAccountMenuProvider().create(menuConfig, button, async () => {});
  if (operation === 'menu-read') return new OfficialAccountMenuProvider().read(menuConfig, async () => {});
  if (operation === 'geocode') return new PublicGeocodingService({ get: async () => 'inert-local-map-key' }).reverse('31.2,121.5');
  if (operation === 'robot') return sendWithdrawalWecomRobot(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${'a'.repeat(32)}`, { kind: 'wecom_robot', withdrawalId: 1 });
  if (operation.startsWith('enterprise-')) {
    const provider = new EnterpriseWechatProviderClient({ ...env, WECHAT_WORK_DIRECTORY_SECRET: 'inert-local-directory-secret',
      WECHAT_WORK_EXTERNAL_CONTACT_SECRET: 'inert-local-contact-secret' }, { corpId: crypto.randomUUID().replaceAll('-', '').slice(0, 18) });
    if (operation === 'enterprise-read') return provider.directoryMember('local-member');
    if (operation === 'enterprise-create') return provider.corpTagCreate({ group_name: 'local-group', order: 1, tag: [{ name: 'local-tag', order: 1 }] });
    if (operation === 'enterprise-welcome') { await provider.sendWelcome('local-single-use', { text: { content: 'local message' } }); return 'sent'; }
  }
  if (operation.startsWith('waybill-')) {
    const credentials = { accessKey: 'inert-local-' + crypto.randomUUID(), secretKey: 'inert-local-onepass-secret' };
    if (operation === 'waybill-catalog') return listCrmebOnePassExpressCatalog(credentials);
    if (operation === 'waybill-template') return listCrmebOnePassWaybillTemplates(credentials, { carrierCode: 'SF', cloudPrinterConfigured: false });
    if (operation === 'waybill-issue') return issueCrmebOnePassWaybill(credentials, issue);
  }
  // These deliberately test the real private network readers only. Their
  // independent production admission/identity/ownership gates are not invoked.
  if (operation === 'app-json-reader') {
    const service = new WechatAppAuthService({} as Container, env);
    return Reflect.get(service, 'providerJson').call(service, new URL('https://api.weixin.qq.com/sns/oauth2/access_token'), Date.now() + 8000);
  }
  if (operation === 'follow-image-reader') {
    const service = new WechatFollowPosterService({} as Container, env);
    const bytes: Uint8Array = await Reflect.get(service, 'load').call(service, { kind: 'https', url: 'https://media.example.com/uploads/local.png', identity: 'local-transport' });
    return { bytes: bytes.byteLength };
  }
  if (operation === 'notification-post-reader') {
    const service = new WechatNotificationProvider({} as Container, env);
    return Reflect.get(service, 'postRoutine').call(service, 'cgi-bin/message/subscribe/send', 'inert-local-token', { touser: 'local-recipient', template_id: 'local-template', data: {} });
  }
  throw Error('Unknown transport operation');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    modes = [];
    try { return Response.json({ ok: true, result: await run(new URL(request.url).pathname.slice(1), env), modes }); }
    catch (error) {
      const failure = error as Error & { kind?: string; code?: number; retryable?: boolean };
      return Response.json({ ok: false, failure: { name: failure.name, message: failure.message, kind: failure.kind, code: failure.code, retryable: failure.retryable }, modes });
    }
  },
};
