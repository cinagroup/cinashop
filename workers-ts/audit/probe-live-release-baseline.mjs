// Read-only public deployment smoke probe. No credentials, writes or providers.
// Deliberately prints shape/status only, never configuration or account values.
import { createHash } from 'node:crypto';
const targets = [
  ['worker-health', 'https://cinashop-api.cinagroup.workers.dev/health'],
  ['pc-home', 'https://cinashop-pc.pages.dev/'],
  ['pc-product', 'https://cinashop-pc.pages.dev/goods/16'],
  ['pc-product-api', 'https://cinashop-pc.pages.dev/api/product/detail/16'],
  ['worker-product-api', 'https://cinashop-api.cinagroup.workers.dev/api/product/detail/16'],
  ['admin-home', 'https://cinashop-admin.pages.dev/'],
  ['admin-config-anonymous', 'https://cinashop-admin.pages.dev/adminapi/config/list'],
  ['worker-admin-config-anonymous', 'https://cinashop-api.cinagroup.workers.dev/api/admin/config/list'],
  ['h5-home', 'https://cinashop-h5.pages.dev/'],
];
const results = [];
for (const [name, url] of targets) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json,text/html;q=0.9', 'User-Agent': 'CinaShop-ReadOnly-Release-Audit' } });
    const reader = response.body?.getReader(); const chunks = []; let bytes = 0;
    if (reader) for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('BodyLimit'); }
      chunks.push(Buffer.from(chunk.value));
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const result = { name, url, status: response.status, contentType: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'), nosniff: response.headers.get('x-content-type-options'),
      bytes, bodySha256: createHash('sha256').update(body).digest('hex') };
    if (result.contentType?.includes('json')) {
      const parsed = JSON.parse(body);
      result.businessStatus = parsed.status ?? null;
      result.healthOk = name === 'worker-health' ? parsed.ok === true : undefined;
      result.dataIsNull = parsed.data == null;
      result.topLevelKeys = Object.keys(parsed).sort();
      if (name.endsWith('product-api')) {
        result.dataKeys = parsed.data && typeof parsed.data === 'object' ? Object.keys(parsed.data).sort() : [];
        const info = parsed.data?.storeInfo;
        result.storeInfoPresent = !!info;
        result.storeNamePresent = typeof info?.store_name === 'string' && info.store_name.length > 0;
      }
    } else if (result.contentType?.includes('html')) {
      result.title = body.match(/<title>([^<]*)<\/title>/i)?.[1] ?? null;
      result.assetPaths = [...body.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map(match => match[1]);
      result.hasAppRoot = /id=["']app["']/.test(body);
    }
    results.push(result);
  } catch (error) { results.push({ name, url, failed: true, errorName: error.name, code: error.cause?.code ?? null }); }
}
console.log(JSON.stringify({ capturedAt: new Date().toISOString(), mode: 'unauthenticated-read-only-before-release', results }, null, 2));
if (results.some(result => result.failed)) process.exitCode = 1;
