import { readDiyCustomerService } from '../../../common/diyCustomerService';
import { API_BASE } from './request';
import { fabAddressLayers, fabImagePreview, resolveFabLink } from './fab';

declare const wx: {openCustomerServiceChat?: (options: {extInfo: {url: string}; corpId: string; fail: () => void}) => void};

export function normalizeDiyCustomerService(value: unknown) {
  const config = readDiyCustomerService(value);
  const logo = fabImagePreview(config.logo);
  return { ...config, logo: logo && API_BASE && /^\/api\/assets\/[1-9]\d*(?:\?|#|$)/u.test(logo) ? API_BASE + logo : logo };
}

export interface CustomerServiceEntry {
  type: 0 | 1 | 2 | 3;
  phone: string;
  url: string;
  corpId: string;
}
export function readCustomerServiceEntry(value: unknown): CustomerServiceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('客服入口响应无效');
  const data = value as Record<string, unknown>;
  if (typeof data.customer_type !== 'number' || ![0, 1, 2, 3].includes(data.customer_type)) throw Error('客服入口类型无效');
  const text = (key: string, maximum: number) => typeof data[key] === 'string' && data[key].length <= maximum ? data[key] as string : '';
  const phone = text('customer_phone', 64), url = text('customer_url', 2048), corpId = text('wechat_work_corpid', 128);
  if (data.customer_type === 1 && !/^\+?[0-9][0-9 -]{2,62}$/u.test(phone)) throw Error('客服电话无效');
  if ((data.customer_type === 2 || data.customer_type === 3) && (!url || !fabAddressLayers(url, ['https:']))) throw Error('客服地址无效');
  if (data.customer_type === 3 && !/^[A-Za-z0-9_-]{1,128}$/u.test(corpId)) throw Error('企业客服配置无效');
  return { type: data.customer_type as CustomerServiceEntry['type'], phone, url, corpId };
}

/** Every callback retains the same page/actor/config lease as the user gesture. */
export function openCustomerServiceEntry(entry: CustomerServiceEntry, allowed: () => boolean, fail: () => void) {
  if (!allowed()) return;
  const failed = () => { if (allowed()) fail(); };
  if (entry.type === 0) { uni.navigateTo({url: '/pages/user/kefu', fail: failed}); return; }
  if (entry.type === 1) { uni.makePhoneCall({phoneNumber: entry.phone, fail: failed}); return; }
  // #ifdef MP-WEIXIN
  if (entry.type === 3) {
    if (typeof wx !== 'undefined' && typeof wx.openCustomerServiceChat === 'function') wx.openCustomerServiceChat({extInfo: {url: entry.url}, corpId: entry.corpId, fail: failed});
    else failed();
    return;
  }
  // #endif
  // #ifdef H5
  window.location.assign(entry.url);
  // #endif
  // #ifdef APP-PLUS
  if (typeof plus !== 'undefined' && plus.runtime?.openURL) plus.runtime.openURL(entry.url, failed);
  else failed();
  // #endif
  // #ifdef MP
  const page = resolveFabLink(entry.url);
  if (page?.kind === 'page') {
    if (page.tab) uni.switchTab({url: page.url.split('?')[0], fail: failed});
    else uni.navigateTo({url: page.url, fail: failed});
  } else if (/^https:\/\//iu.test(entry.url)) uni.navigateTo({url: `/pages/common/fabWebView?url=${encodeURIComponent(entry.url)}`, fail: failed});
  else failed();
  // #endif
}

export function openCustomerServiceLink(value: string, allowed: () => boolean, fail: () => void) {
  if (!allowed()) return;
  const target = resolveFabLink(value), failed = () => { if (allowed()) fail(); };
  if (!target) { failed(); return; }
  if (target.kind === 'page') {
    if (target.tab) uni.switchTab({url: target.url.split('?')[0], fail: failed});
    else uni.navigateTo({url: target.url, fail: failed});
    return;
  }
  if (target.kind === 'mini') {
    // #ifdef MP
    uni.navigateToMiniProgram({appId: target.appId, path: target.path, envVersion: 'release', fail: failed}); return;
    // #endif
    // #ifndef MP
    failed(); return;
    // #endif
  }
  const externalUrl = target.url;
  // #ifdef H5
  const opened = window.open(externalUrl, '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null; else failed();
  return;
  // #endif
  // #ifndef H5
  uni.navigateTo({url: `/pages/common/fabWebView?url=${encodeURIComponent(externalUrl)}`, fail: failed});
  // #endif
}
