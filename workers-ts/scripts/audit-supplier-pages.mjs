// Read-only FE-004K acceptance. Never prints environment values or response bodies.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const supplierOrigin = 'https://cinashop-supplier.pages.dev';
export const workerOrigin = 'https://cinashop-api.cinagroup.workers.dev';
const projectUrl = 'https://api.cloudflare.com/client/v4/accounts/7ea8e46d8210bad342fa7595f7935fea/pages/projects/cinashop-supplier';
const root = new URL('../../', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function environment(value) {
  if (value !== null && !object(value)) throw new Error('Invalid environment inventory');
  const entries = Object.entries(value ?? {});
  if (entries.some(([, item]) => !object(item) || !['plain_text', 'secret_text'].includes(item.type))) {
    throw new Error('Unknown environment entry');
  }
  const target = value?.WORKERS_API;
  if (target && (target.type !== 'plain_text' || target.value !== workerOrigin)) throw new Error('Unverified API override');
  return { inventory: entries.map(([name, item]) => ({ name, type: item.type })),
    workerMapping: target ? 'verified-plaintext-override' : 'checked-in-default', expectedWorker: workerOrigin };
}

export function inspectSupplierProject(project, expectedSha) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error('Exact release SHA required');
  if (!object(project) || project.name !== 'cinashop-supplier' || project.production_branch !== 'main'
    || !Array.isArray(project.domains) || project.domains.length !== 1 || project.domains[0] !== 'cinashop-supplier.pages.dev') {
    throw new Error('Unexpected Supplier project/origin');
  }
  const config = project.deployment_configs?.production;
  const deployment = project.canonical_deployment;
  if (!object(config) || !Object.hasOwn(config, 'env_vars') || !object(deployment) || !Object.hasOwn(deployment, 'env_vars')
    || !/^[a-f0-9-]{36}$/.test(deployment.id) || deployment.environment !== 'production'
    || deployment.production_branch !== 'main' || deployment.latest_stage?.status !== 'success'
    || deployment.uses_functions !== true || deployment.deployment_trigger?.metadata?.commit_hash !== expectedSha) {
    throw new Error('Incomplete or unexpected production deployment');
  }
  // This proxy needs only optional WORKERS_API, not direct DB/storage credentials.
  // Fail on unknown populated configuration rather than silently omit new binding types.
  const settings = new Set(['env_vars', 'fail_open', 'always_use_latest_compatibility_date', 'compatibility_date',
    'compatibility_flags', 'build_image_major_version', 'usage_model', 'placement']);
  const resources = Object.entries(config).filter(([key]) => !settings.has(key)).map(([kind, value]) => {
    const empty = value == null || (object(value) && Object.keys(value).length === 0) || (Array.isArray(value) && value.length === 0);
    if (!empty) throw new Error('Unexpected populated Pages resource/configuration');
    return { kind, empty };
  });
  return { name: project.name, origin: supplierOrigin, productionBranch: project.production_branch,
    deploymentId: deployment.id, sourceCommit: expectedSha, status: deployment.latest_stage.status, usesFunctions: true,
    production: environment(config.env_vars), deployed: environment(deployment.env_vars),
    resourceInventory: resources, directResourceBindings: 0, compatibilityDate: deployment.compatibility_date };
}

async function bounded(url, init = {}, limit = 3 * 1024 * 1024) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error('Response limit exceeded');
    chunks.push(chunk);
  }
  return { response, bytes: Buffer.concat(chunks) };
}

export async function auditSupplierPages(expectedSha, token) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || !token) throw new Error('Release SHA and Cloudflare token required');
  execFileSync('git', ['diff', '--exit-code', expectedSha, '--', 'view/supplier-ts'], { cwd: fileURLToPath(root), stdio: 'pipe' });
  const project = async () => {
    const { response, bytes } = await bounded(projectUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('Cloudflare project read failed');
    const result = JSON.parse(bytes.toString('utf8'));
    if (result.success !== true) throw new Error('Cloudflare result rejected');
    return inspectSupplierProject(result.result, expectedSha);
  };
  const control = await project();
  const proxy = await readFile(new URL('view/supplier-ts/functions/supplierapi/[[path]].ts', root), 'utf8');
  if (!proxy.includes(`const DEFAULT_WORKER = "${workerOrigin}"`) || !proxy.includes('context.env.WORKERS_API ?? DEFAULT_WORKER')) {
    throw new Error('Unchecked proxy default');
  }
  const { response, bytes } = await bounded(supplierOrigin + '/');
  if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Missing Supplier HTML');
  const script = bytes.toString('utf8').match(/<script[^>]*\bsrc="(\/assets\/[a-zA-Z0-9_.-]+\.js)"/)?.[1];
  if (!script) throw new Error('Missing safe Supplier entry');
  const remote = await bounded(supplierOrigin + script);
  const local = await readFile(new URL('view/supplier-ts/dist' + script, root));
  if (remote.response.status !== 200 || hash(local) !== hash(remote.bytes)
    || !local.toString('utf8').includes('baseURL:"/supplierapi"')) throw new Error('Supplier artifact/base URL mismatch');
  const requests = [];
  for (const [name, path, expected, headers] of [
    ['bootstrap', '/supplierapi/login/info', 200, {}],
    ['anonymous-config', '/supplierapi/config', 410000, {}],
    ['invalid-token-config', '/supplierapi/config', 410000, { Authorization: 'Bearer invalid-pages-acceptance' }],
  ]) {
    const observed = await bounded(supplierOrigin + path, { headers: { Origin: supplierOrigin, ...headers } });
    const body = JSON.parse(observed.bytes.toString('utf8'));
    const pass = observed.response.status === 200 && observed.response.headers.get('content-type')?.includes('json')
      && body.status === expected && (expected === 200 || body.data == null);
    requests.push({ name, http: observed.response.status, status: body.status, pass: Boolean(pass) });
  }
  const after = await project();
  if (JSON.stringify(control) !== JSON.stringify(after)) throw new Error('Deployment/config changed during audit');
  return { capturedAt: new Date().toISOString(), scope: 'FE-004K Supplier Pages configuration and same-origin transport',
    passed: requests.every(item => item.pass), control,
    artifact: { path: script, localSha256: hash(local), onlineSha256: hash(remote.bytes), sameOriginBaseUrl: '/supplierapi',
      proxySourceSha256: hash(proxy.replaceAll('\r\n', '\n')) }, requests,
    boundaries: { productionMutations: false, authenticatedBusinessE2E: false, providerFlows: false,
      browserRenderedQA: false, deploymentObservationWindow: false, upstreamRuntimeLeastPrivilege: false } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/audit-supplier-pages.mjs <release-sha>');
    const result = await auditSupplierPages(process.argv[2], process.env.CLOUDFLARE_API_TOKEN);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    // Do not print exception message/stack: a fetch/CLI error may contain sensitive input.
    console.log(JSON.stringify({ passed: false, errorType: error.name }));
    process.exitCode = 2;
  }
}
