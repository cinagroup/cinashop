import { ServiceUnavailableException, ValidateException } from '@/utils/errors';

/** One wall-clock deadline covers headers and all streamed bytes. The injected
 * fetcher may ignore AbortSignal; the explicit race still rejects on time and
 * cancels a body that arrives after the caller has already timed out. */
export async function readLegacyShareProvider(fetcher: typeof fetch, input: RequestInfo | URL, init: RequestInit | undefined,
  limits: { json: number; image: number; timeout?: number }): Promise<Response> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve,reject) => {
    timer = setTimeout(() => {
      timedOut = true; controller.abort(); void reader?.cancel().catch(() => undefined);
      reject(new ServiceUnavailableException('分享图片读取超时，请稍后重试'));
    }, limits.timeout ?? 10000);
  });
  const operation = (async () => {
    const response = await fetcher(input,{...init,signal:controller.signal,redirect:'error'});
    if (timedOut) { void response.body?.cancel().catch(() => undefined); throw new ServiceUnavailableException('分享接口超时'); }
    const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
    const image = ['image/png','image/jpeg','image/gif'].includes(mime), limit = image ? limits.image : limits.json;
    const length = response.headers.get('Content-Length');
    if (!response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      void response.body?.cancel().catch(() => undefined); throw new ValidateException('分享接口返回数据过大');
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        if (timedOut) throw new ServiceUnavailableException('分享接口超时');
        const {done,value} = await reader.read(); if (done) break;
        size += value.length;
        if (size > limit) { void reader.cancel().catch(() => undefined); throw new ValidateException('分享接口返回数据过大'); }
        chunks.push(value);
      }
      if (timedOut) throw new ServiceUnavailableException('分享接口超时');
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
      return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
    } finally { reader.releaseLock(); }
  })();
  try { return await Promise.race([operation,timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
