import { integralSiteOrigin } from '../../../common/integralPurchase';

/** API origins and PC configuration never stand in for the actual H5 site. */
export function integralShareUrl(path: string, siteUrl: string): string {
  if (!/^\/pages\/activity\/integralDetail\?id=[1-9]\d*(?:&spid=[1-9]\d*)?$/u.test(path)) return '';
  // #ifdef H5
  if (typeof window !== 'undefined') {
    try {
      const url = new URL(window.location.href);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
        url.search = ''; url.hash = path; return url.href;
      }
    } catch { /* An invalid web document is not a share destination. */ }
  }
  // #endif
  const origin = integralSiteOrigin(siteUrl);
  return origin ? `${origin}/#${path}` : '';
}

export function shareIntegralInApp(options: { url: string; title: string; image: string; summary: string },
  complete: (message: string) => void, current: () => boolean = () => true): void {
  if (!current()) return;
  if (!options.url) { complete('商家尚未配置可分享的站点链接'); return; }
  if (typeof uni.getProvider !== 'function' || typeof uni.share !== 'function') { complete('当前平台不支持微信应用分享'); return; }
  uni.getProvider({ service: 'share', success: result => {
    if (!current()) return;
    if (!result.provider.some(provider => provider === 'weixin')) { complete('当前设备没有可用的微信分享服务'); return; }
    uni.share({ provider: 'weixin', scene: 'WXSceneSession', type: 0, href: options.url,
      title: options.title, summary: options.summary, imageUrl: options.image,
      success: () => { if(current())complete('已调用微信分享'); }, fail: () => { if(current())complete('微信分享失败，请重试或复制商品链接'); } });
  }, fail: () => { if(current())complete('读取分享服务失败，请重试'); } });
}
