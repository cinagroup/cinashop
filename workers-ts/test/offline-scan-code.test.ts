import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedOfflineCodeFetch, offlineH5ScanImage, offlineMiniScanImage, offlineScanType, offlineScanUrl } from '../src/services/order/OfflineScanCode';

const origin = 'https://cinashop-h5.pages.dev';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const svg = (data: string) => new TextDecoder().decode(Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0)));
afterEach(() => vi.useRealTimers());
describe('offline scan fixed navigation and bounded rendering', () => {
  it.each(['', '?type=1', '?type=0'])('accepts only the legacy finite display selector %s', query => {
    expect(offlineScanType(new URL('https://admin.test/offline_scan'+query))).toBe(query === '?type=0' ? 0 : 1);
  });
  it.each(['?type=', '?type=2', '?type=01', '?type=true', '?type=0&type=1', '?url=https://evil.test', '?type=0&uid=1', '?amount=1', '?type='+'1'.repeat(50)])('rejects query override %s', query => {
    expect(() => offlineScanType(new URL('https://admin.test/offline_scan'+query))).toThrow();
  });
  it.each([undefined, '', 'http://shop.test', 'https://user:pass@shop.test', 'https://shop.test/', 'https://shop.test:8443',
    'https://shop.test/path', 'https://shop.test?redirect=evil', 'https://shop.test#x', 'https://127.0.0.1', 'https://SHOP.test'])('rejects noncanonical configured origin %s', value => {
    expect(() => offlineScanUrl(value)).toThrow();
  });
  it('encodes only the hash-routed H5 cashier, with a four-module quiet zone and no external assets', () => {
    const url = offlineScanUrl(origin);
    expect(url).toBe(origin+'/#/pages/annex/offline_pay/index');
    const raw = svg(offlineH5ScanImage(url, 0));
    expect(raw).toContain('<svg'); expect(raw).toContain('M24,24');
    expect(raw).toMatch(/width="\d+px" height="\d+px"/);
    expect(raw).not.toMatch(/<script|foreignObject|href=|onload=/);
    const poster = svg(offlineH5ScanImage(url, 1));
    expect(poster).toContain('应付至少 0.01 元'); expect(poster).toContain('不是付款成功凭据');
    expect(poster).toContain('data:image/svg+xml;base64,');
    expect(poster).not.toMatch(/<script|foreignObject|href="https?:/);
  });
  it.each(['?uid=1','?money=1','?orderId=xx123','?return_url=https://evil.test','/other'])('does not render an overridden cashier target %s', suffix => {
    expect(() => offlineH5ScanImage(offlineScanUrl(origin)+suffix, 0)).toThrow();
  });
  it('wraps only validated PNG/JPEG data and never fetches a poster asset', () => {
    expect(offlineMiniScanImage(png, 0)).toBe(png);
    expect(svg(offlineMiniScanImage(png, 1))).toContain(`href="${png}"`);
    expect(offlineMiniScanImage('data:image/jpeg;base64,/9j/2Q==', 0)).toContain('image/jpeg');
  });
  it.each(['https://evil.test/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,YWJj',
    'data:image/jpeg;base64,iVBORw0KGgo=', 'data:image/png;base64,iVBORw0KGgo=\n', 'data:image/png;base64,'+'A'.repeat(1398108)])('rejects unsafe or oversized mini-program images (%#)', value => {
    expect(() => offlineMiniScanImage(value, 0)).toThrow();
  });
});
describe('offline mini-program transport boundary', () => {
  const code = new URL('https://api.weixin.qq.com/wxa/getwxacode?access_token=synthetic');
  it.each(['https://evil.test/wxa/getwxacode','https://api.weixin.qq.com/wxa/getwxacodeunlimit',
    'http://api.weixin.qq.com/wxa/getwxacode','https://name:secret@api.weixin.qq.com/wxa/getwxacode'])('rejects unexpected provider target %s', async url => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(boundedOfflineCodeFetch(fetcher)(url)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('enforces no redirects and bounded bytes before the existing adapter sees the response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(Uint8Array.from(atob(png.split(',')[1]), c => c.charCodeAt(0)),
      {headers:{'Content-Type':'image/png'}}));
    const response = await boundedOfflineCodeFetch(fetcher)(code, {method:'POST',body:'{}'});
    expect(fetcher).toHaveBeenCalledWith(code, expect.objectContaining({redirect:'manual',signal:expect.any(AbortSignal),method:'POST'}));
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(8);
  });
  it.each([0, 302, 1048577])('rejects empty, redirect or oversized responses (%s)', mode => {
    const response = mode === 302 ? new Response(null,{status:302,headers:{Location:'https://evil.test'}})
      : new Response(new Uint8Array(mode));
    return expect(boundedOfflineCodeFetch(async () => response)(code)).rejects.toThrow('暂不可用');
  });
  it('rejects token responses over 16 KiB without relying on Content-Length', async () => {
    await expect(boundedOfflineCodeFetch(async () => new Response('x'.repeat(16385)))('https://api.weixin.qq.com/cgi-bin/token')).rejects.toThrow();
  });
  it('cancels a chunked oversized body and sanitizes upstream failures', async () => {
    const cancel = vi.fn(); let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(600000)); },cancel });
    await expect(boundedOfflineCodeFetch(async () => new Response(body))(code)).rejects.toThrow('暂不可用');
    expect(cancel).toHaveBeenCalledOnce(); expect(pulls).toBeLessThanOrEqual(3);
    const failure = await boundedOfflineCodeFetch(async () => { throw Error('synthetic-secret-provider-url'); })(code).catch(e => e);
    expect(failure.message).not.toContain('synthetic-secret');
  });
  it('aborts connection work after eight seconds and clears timers', async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Error('secret-url')));
    });
    const result = boundedOfflineCodeFetch(fetcher)(code).catch(e => e);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await result).message).toContain('暂不可用'); expect(vi.getTimerCount()).toBe(0);
  });
  it('the same deadline covers a stalled response body even if its stream ignores AbortSignal', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array([1]));},cancel});
    const result = boundedOfflineCodeFetch(async () => new Response(body))(code).catch(e => e);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await result).message).toContain('暂不可用'); expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
});
