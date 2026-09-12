// Read-only release smoke check. Prints statuses/hashes, never response data or credentials.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const apps = [
  ['pc', 'https://shop.cinaseek.ai', '../../view/pc-ts/dist/'],
  ['admin', 'https://cinashop-admin.pages.dev', '../../view/admin-ts/dist/'],
  ['h5', 'https://cinashop-h5.pages.dev', '../../view/uniapp-ts/dist/build/h5/'],
  ['supplier', 'https://cinashop-supplier.pages.dev', '../../view/supplier-ts/dist/'],
  ['kefu', 'https://cinashop-kefu.pages.dev', '../../view/kefu-ts/dist/'],
];
async function request(url, options = {}) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000), ...options });
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error('Response exceeds smoke-check limit');
    chunks.push(chunk);
  }
  return { response, bytes: Buffer.concat(chunks) };
}
async function guarded(name, fn) {
  try { return { name, ...await fn() }; }
  catch (error) { return { name, pass: false, error: error.name, code: error.cause?.code ?? null }; }
}
const results = await Promise.all(apps.map(([name, origin, directory]) => guarded(name, async () => {
  const { response, bytes } = await request(origin + '/');
  const html = bytes.toString('utf8');
  const script = html.match(/<script[^>]*\bsrc="([^"]+\.js)"/)?.[1];
  if (!script) throw new Error('Missing entry script');
  const assetUrl = new URL(script, origin);
  if (assetUrl.origin !== origin || !/^\/assets\/[a-zA-Z0-9_.-]+\.js$/.test(assetUrl.pathname)) throw new Error('Unexpected entry asset');
  const asset = await request(assetUrl.href);
  const local = await readFile(new URL(directory + assetUrl.pathname.slice(1), import.meta.url));
  const localHash = sha256(local); const remoteHash = sha256(asset.bytes);
  return { origin, http: response.status, assetHttp: asset.response.status, script,
    localHash, remoteHash, pass: response.status === 200 && asset.response.status === 200
      && response.headers.get('content-type')?.includes('text/html') && localHash === remoteHash };
})));
const jsonTargets = [
  ['health', 'https://cinashop-api.cinagroup.workers.dev/health', 'health'],
  ['pc-bootstrap', apps[0][1] + '/api/site_config', 200],
  ['pc-products', apps[0][1] + '/api/products?page=1&limit=1', 200],
  ['admin-bootstrap', apps[1][1] + '/api/site_config', 200],
  ['h5-bootstrap', apps[2][1] + '/api/site_config', 200],
  ['supplier-bootstrap', apps[3][1] + '/supplierapi/login/info', 200],
  ['admin-anonymous', apps[1][1] + '/adminapi/config/list', 410000],
  ['supplier-anonymous', apps[3][1] + '/supplierapi/config', 410000],
  ['kefu-anonymous', apps[4][1] + '/kefuapi/service/info', 410000],
];
results.push(...await Promise.all(jsonTargets.map(([name, url, expected]) => guarded(name, async () => {
  const { response, bytes } = await request(url);
  const json = JSON.parse(bytes.toString('utf8'));
  const value = expected === 'health' ? json.ok === true : json.status;
  return { http: response.status, observed: value, pass: response.status === 200
    && response.headers.get('content-type')?.includes('json')
    && value === (expected === 'health' ? true : expected)
    && (expected !== 410000 || json.data == null) };
}))));
for (const origin of ['https://shop.cinaseek.ai', 'https://cinaseek.ai', 'https://cinashop-admin.pages.dev']) {
  results.push(await guarded('cors-' + origin, async () => {
    const { response } = await request('https://cinashop-api.cinagroup.workers.dev/api/site_config', {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    });
    const allowed = response.headers.get('access-control-allow-origin');
    return { http: response.status, allowed, pass: response.status === 204
      && allowed === (origin === apps[0][1] ? origin : null) };
  }));
}
console.log(JSON.stringify({ capturedAt: new Date().toISOString(), mode: 'read-only-full-test-redeploy',
  passed: results.every(result => result.pass), results }, null, 2));
if (results.some(result => !result.pass)) process.exitCode = 1;
