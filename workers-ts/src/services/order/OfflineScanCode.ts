import qrcode from 'qrcode-generator';
import { offlineReturnOrigin } from '../../../../view/common/offlineReturn';
import { ValidateException } from '@/utils/errors';

export const OFFLINE_SCAN_VERSION = 'admin-offline-scan-v1';
export const OFFLINE_MINI_PAGE = 'pages/annex/offline_pay/index';
const MAX_IMAGE_BYTES = 1024 * 1024;
export function offlineScanType(url: URL): 0 | 1 {
  const keys = [...url.searchParams.keys()];
  if (url.search.length > 32 || keys.some(key => key !== 'type') || keys.length > 1) {
    throw new ValidateException('收银码仅接受 type=0 或 type=1');
  }
  const type = url.searchParams.get('type') ?? '1';
  if (type !== '0' && type !== '1') throw new ValidateException('收银码类型无效');
  return type === '0' ? 0 : 1;
}
export function offlineScanUrl(origin: unknown): string {
  try { return `${offlineReturnOrigin(origin)}/#/${OFFLINE_MINI_PAGE}`; }
  catch { throw new ValidateException('线下收银 H5 站点未就绪'); }
}
function dataUrl(svg: string) {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
/** Only locally generated SVG or validated raster data is embedded. No remote
 * image, arbitrary text, identity, amount, ticket or payment capability. */
function poster(image: string, label: 'H5' | '小程序') {
  return dataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="720" viewBox="0 0 500 720">
    <title>线下消费收银海报</title><desc>扫码进入收银台，登录后核对金额。此码不代表付款成功。</desc>
    <rect width="500" height="720" fill="white"/><rect width="500" height="100" fill="#16324f"/>
    <g text-anchor="middle" font-family="sans-serif"><text x="250" y="63" font-size="30" fill="white">线下消费收银</text>
    <image href="${image}" x="60" y="126" width="380" height="380"/>
    <text x="250" y="551" font-size="24" fill="#16324f">${label} 扫码进入收银台</text>
    <text x="250" y="601" font-size="18" fill="#334155">登录后核对金额，应付至少 0.01 元</text>
    <text x="250" y="636" font-size="18" fill="#334155">此二维码不是付款成功凭据</text></g></svg>`);
}
export function offlineH5ScanImage(url: string, type: 0 | 1): string {
  const parsed = new URL(url);
  if (url !== offlineScanUrl(parsed.origin)) throw new ValidateException('线下收银地址无效');
  const qr = qrcode(0, 'M'); qr.addData(url, 'Byte'); qr.make();
  // Four MODULES of quiet zone, not four pixels.
  const image = dataUrl(qr.createSvgTag({ cellSize: 6, margin: 24, scalable: false }));
  return type === 1 ? poster(image, 'H5') : image;
}
export function offlineMiniScanImage(image: string, type: 0 | 1): string {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new ValidateException('小程序收银码格式无效');
  const bytes = atob(match[2]);
  if (bytes.length > MAX_IMAGE_BYTES || btoa(bytes) !== match[2]
    || (match[1] === 'png' ? !bytes.startsWith('\x89PNG\r\n\x1a\n') : !bytes.startsWith('\xff\xd8\xff'))) {
    throw new ValidateException('小程序收银码内容无效');
  }
  return type === 1 ? poster(image, '小程序') : image;
}

/** Bound the existing mini-program adapter's token/error/image responses before
 * it buffers them. Covers body time as well as connection time, never follows
 * redirects, and never returns provider URLs/diagnostics containing secrets. */
export function boundedOfflineCodeFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const token = url.pathname === '/cgi-bin/token';
    if (url.origin !== 'https://api.weixin.qq.com' || url.username || url.password
      || (!token && url.pathname !== '/wxa/getwxacode')) throw new ValidateException('小程序收银码接口无效');
    const controller = new AbortController();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(Error('code deadline')), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), 8000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Inspect and reject every 3xx before a second destination is requested.
      const response = await Promise.race([fetcher(url, { ...init, redirect: 'manual', signal: controller.signal }), aborted]);
      const limit = token ? 16384 : MAX_IMAGE_BYTES;
      if (response.status >= 300 && response.status < 400 || Number(response.headers.get('Content-Length')) > limit) {
        await response.body?.cancel(); throw Error('invalid response');
      }
      reader = response.body?.getReader();
      if (!reader) throw Error('missing body');
      const parts: Uint8Array[] = []; let size = 0;
      while (true) {
        const part = await Promise.race([reader.read(), aborted]); if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) { await reader.cancel(); throw Error('oversized response'); }
        parts.push(part.value);
      }
      if (controller.signal.aborted || size === 0) throw Error('invalid body');
      const body = new Uint8Array(size); let offset = 0;
      for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
      return new Response(body, { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') ?? '' } });
    } catch { throw new ValidateException('小程序收银码暂不可用，请稍后重试'); }
    finally {
      clearTimeout(timer);
      if (controller.signal.aborted) void reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  };
}
