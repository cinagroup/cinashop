import { afterEach, describe, expect, it, vi } from 'vitest';

const { inspectSupplierProject, auditSupplierPages } = await import(new URL('../scripts/audit-supplier-pages.mjs', import.meta.url).href);
const { onRequest } = await import(new URL('../../view/supplier-ts/functions/supplierapi/[[path]].ts', import.meta.url).href);
const sha = '614bf34cafeb7a2b0e9d307b8c1f9f518d350f2f';
const worker = 'https://cinashop-api.cinagroup.workers.dev';
const origin = 'https://cinashop-supplier.pages.dev';
function project() {
  return {
    name: 'cinashop-supplier', production_branch: 'main', domains: ['cinashop-supplier.pages.dev'],
    deployment_configs: { production: { env_vars: null, compatibility_date: '2026-09-12' } },
    canonical_deployment: { id: '04babf74-a4e2-42d9-b75c-0aad5fc499d9', environment: 'production',
      production_branch: 'main', latest_stage: { status: 'success' }, uses_functions: true,
      deployment_trigger: { metadata: { commit_hash: sha } }, env_vars: null },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('Supplier Pages configuration acceptance boundaries', () => {
  it('accepts the deployed default mapping without inventing secret or resource requirements', () => {
    expect(inspectSupplierProject(project(), sha)).toMatchObject({ sourceCommit: sha, directResourceBindings: 0,
      production: { inventory: [], workerMapping: 'checked-in-default' }, deployed: { inventory: [], workerMapping: 'checked-in-default' } });
  });
  it.each([
    ['wrong project', { name: 'another-project' }],
    ['wrong branch', { production_branch: 'preview' }],
    ['occupied origin', { domains: ['supplier.cinaseek.ai'] }],
    ['additional origin', { domains: ['cinashop-supplier.pages.dev', 'cinaseek.ai'] }],
    ['missing configuration', { deployment_configs: {} }],
  ])('rejects %s', (_label, change) => {
    expect(() => inspectSupplierProject({ ...project(), ...change }, sha)).toThrow();
  });
  it.each([
    ['wrong SHA', { deployment_trigger: { metadata: { commit_hash: 'f'.repeat(40) } } }],
    ['preview', { environment: 'preview' }], ['wrong deployment branch', { production_branch: 'feature' }],
    ['no functions', { uses_functions: false }], ['missing inventory', { env_vars: undefined }],
    ['failed', { latest_stage: { status: 'failure' } }], ['pending', { latest_stage: { status: 'active' } }],
  ])('rejects deployment %s', (_label, change) => {
    const p = project();
    expect(() => inspectSupplierProject({ ...p, canonical_deployment: { ...p.canonical_deployment, ...change } }, sha)).toThrow();
  });
  it.each(['production', 'deployed'])('checks %s API overrides without exposing unrelated values', scope => {
    const env = { WORKERS_API: { type: 'plain_text', value: worker }, UNUSED: { type: 'secret_text', value: 'private-fixture-value' } };
    const p = project();
    const check = () => inspectSupplierProject(scope === 'production'
      ? { ...p, deployment_configs: { production: { env_vars: env } } }
      : { ...p, canonical_deployment: { ...p.canonical_deployment, env_vars: env } }, sha);
    const result = check();
    expect(result[scope].workerMapping).toBe('verified-plaintext-override');
    expect(JSON.stringify(result)).not.toContain('private-fixture-value');
    env.WORKERS_API.value = 'https://wrong.example';
    expect(check).toThrow();
    env.WORKERS_API.value = worker;
    env.WORKERS_API.type = 'secret_text';
    expect(check).toThrow();
  });
  it.each(['kv_namespaces', 'd1_databases', 'r2_buckets', 'services', 'future_resource'])('does not omit populated %s', kind => {
    const p = project();
    const withResource = (value: unknown) => ({ ...p, deployment_configs: { production: { env_vars: null, [kind]: value } } });
    expect(() => inspectSupplierProject(withResource({ BINDING: { id: 'fixture' } }), sha)).toThrow();
    expect(inspectSupplierProject(withResource({}), sha).resourceInventory).toEqual([{ kind, empty: true }]);
  });
  it('rejects missing or abbreviated target before network access', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(auditSupplierPages('614bf34', 'fixture')).rejects.toThrow();
    await expect(auditSupplierPages(sha, '')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('actual Supplier Pages proxy transport', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('preserves %s path/query and request identity metadata without forwarding Host', async method => {
    const response = new Response(null, { status: 302, headers: { Location: '/fixture-redirect' } });
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetch);
    const request = new Request(origin + '/supplierapi/config?limit=1&order=desc', { method,
      headers: { Origin: origin, Host: 'cinashop-supplier.pages.dev', Authorization: 'Bearer fixture', 'X-Request-ID': 'pages-fixture' } });
    expect(await onRequest({ request, env: {} })).toBe(response);
    const sent = fetch.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(worker + '/supplierapi/config?limit=1&order=desc');
    expect(sent.method).toBe(method);
    expect(sent.redirect).toBe('manual');
    expect(sent.headers.get('host')).toBeNull();
    expect(sent.headers.get('origin')).toBe(origin);
    expect(sent.headers.get('authorization')).toBe('Bearer fixture');
    expect(sent.headers.get('x-request-id')).toBe('pages-fixture');
  });
});
