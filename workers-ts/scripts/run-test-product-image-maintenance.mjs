// Explicitly authorized one-off production operation. No seed, DDL or general SQL endpoint.
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv[2] !== '--apply-approved-68-test-images') {
  throw Error('Requires explicit approval for these exact 68 production image fields and --apply-approved-68-test-images');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const name = `cinashop-test-images-${randomBytes(6).toString('hex')}`;
const config = 'test/integration/test-product-image-maintenance.wrangler.jsonc';
const token = randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const backupPath = join(tmpdir(), `${name}-before.json`);
const resultPath = join(tmpdir(), `${name}-result.json`);
const report = { name, backupPath, resultPath, assets: [], authorization: {}, cleanup: {} };
let deployedAttempt = false;
let workerUrl;
const cli = args => execFileSync(process.execPath, [join(root,'node_modules/wrangler/bin/wrangler.js'), ...args],
  { cwd: root, encoding: 'utf8', timeout: 120000, stdio: ['ignore','pipe','pipe'] });
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
// A just-published workers.dev hostname can briefly hit a PoP without its route.
// Retry read-only inspection only; never automatically retry an uncertain write.
async function inspect(url, headers) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request(`${url}/inspect`, { method:'POST', headers });
    if (res.status !== 404 || attempt === 4) return res;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
try {
  for (const variant of ['a','b']) {
    const path = `test-media/product-${variant}.svg`;
    const res = await request(`https://shop.cinaseek.ai/${path}`);
    if (res.status !== 200 || !res.headers.get('content-type')?.includes('image/svg+xml')) throw Error('Image availability failed');
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length > 10000 || hash(body) !== hash(readFileSync(resolve(root, '../view/pc-ts/public', path)))) throw Error('Image hash failed');
    report.assets.push({ url: res.url, status: res.status, sha256: hash(body) });
  }
  console.log('Both published image hashes verified.');
  deployedAttempt = true;
  const deployment = cli(['deploy','--config',config,'--name',name,'--var',`AUDIT_TOKEN_SHA256:${hash(token)}`,
    '--var',`EXPIRES_AT:${Date.now()+30*60*1000}`]);
  workerUrl = deployment.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev/)?.[0];
  if (!workerUrl) throw Error('Temporary URL not reported');
  report.workerUrl = workerUrl;
  for (let attempt=0; attempt<5; attempt++) {
    report.authorization.noToken = (await request(`${workerUrl}/inspect`,{method:'POST'})).status;
    if (report.authorization.noToken === 403) break;
  }
  if (report.authorization.noToken !== 403) throw Error('Token gate failed');
  const headers = {'X-Audit-Token':token};
  report.authorization.wrongMethod = (await request(`${workerUrl}/inspect`,{headers})).status;
  report.authorization.missingFingerprint = (await request(`${workerUrl}/apply`,{method:'POST',headers})).status;
  if (report.authorization.wrongMethod !== 404 || report.authorization.missingFingerprint !== 412) throw Error('Method/precondition gate failed');
  const beforeRes = await inspect(workerUrl,headers);
  if (!beforeRes.ok) {
    report.inspectionFailure = { status:beforeRes.status, contentType:beforeRes.headers.get('content-type'), cfRay:beforeRes.headers.get('cf-ray') };
    throw Error(`Inspection failed: ${beforeRes.status}`);
  }
  const before = await beforeRes.json();
  writeFileSync(backupPath, JSON.stringify({ capturedAt:new Date().toISOString(),...before },null,2)+'\n',{flag:'wx'});
  report.beforeFingerprint = before.fingerprint;
  if (before.rows.length !== 68 || before.imageUpdateTriggers.length || before.rules.length) throw Error('Unexpected scope or active triggers/rules; no update');
  console.log(`Read-only backup saved: ${backupPath}; proceeding with conditional image-only transaction.`);
  const appliedRes = await request(`${workerUrl}/apply`,{method:'POST',headers:{...headers,'X-Expected-Fingerprint':before.fingerprint}});
  if (!appliedRes.ok) throw Error(`Conditional update failed: ${appliedRes.status}`);
  report.applied = await appliedRes.json();
  const afterRes = await inspect(workerUrl,headers);
  if (!afterRes.ok) throw Error('Post-update verification unavailable');
  const after = await afterRes.json();
  report.verified = after.fingerprint === report.applied.afterFingerprint && report.applied.updated === 68 && report.applied.nonImageFieldsUnchanged;
  if (!report.verified) throw Error('Post-update fingerprint mismatch');
  console.log('Committed 68 image-only updates; independent database re-read verified.');
} catch (error) {
  report.failure = error instanceof Error ? error.message.split('\n')[0] : 'Maintenance failed';
  process.exitCode = 1;
} finally {
  if (deployedAttempt) {
    try {
      cli(['delete',name,'--config',config,'--force']);
      report.cleanup.deleted = true;
      if (workerUrl) {
        for (let attempt=0; attempt<5; attempt++) {
          report.cleanup.postReturns404 = (await request(`${workerUrl}/inspect`,{method:'POST'})).status === 404;
          if (report.cleanup.postReturns404) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      if (!report.cleanup.postReturns404) process.exitCode = 1;
    } catch { report.cleanup.deleted = false; process.exitCode = 1; }
  }
  writeFileSync(resultPath, JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({name,resultPath,backupPath,verified:report.verified,failure:report.failure,cleanup:report.cleanup}));
}
