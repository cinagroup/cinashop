import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { SystemConfigService } from '@/services/system/SystemConfigService';
import { financePostgres } from './helpers/financePostgres';
const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));

describe('registered raw PHP statistics JavaScript with the real configuration DAO', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>, container: ReturnType<typeof createContainerFromDb>;
  const cache = new Map<string, string>(), app = createApp();
  const env = { APP_KEY: 'statistics-fixture', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', CONFIG_KV: {
    get: async (key: string) => cache.get(key) ?? null,
    put: async (key: string, value: string) => { cache.set(key, value); },
    delete: async (key: string) => { cache.delete(key); },
  } } as unknown as Env;
  beforeAll(async () => {
    fixture = await financePostgres([systemConfig], { namespace: 'public' });
    container = createContainerFromDb(fixture.db); wiring.open.mockImplementation(() => container);
  }, 30_000);
  beforeEach(async () => { cache.clear(); await fixture.reset(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Statistics tests forbid external I/O')); });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await fixture?.close(); }, 30_000);
  const script = 'globalThis.__cinashopStatisticsLoaded=(globalThis.__cinashopStatisticsLoaded||0)+1;\n/* configured JS */';
  it('returns executable raw JavaScript anonymously, preserving JSON-encoded legacy scalar configuration', async () => {
    await fixture.db.insert(systemConfig).values({ id: 1, menuName: 'system_statistics', value: JSON.stringify(script), isStore: 0 });
    const response = await app.request('/api/get_script', {}, env);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await response.text()).toBe(script); expect(cache.get('cfg_system_statistics')).toBe(script);
  });
  it('returns an empty successful script for missing or explicitly empty configuration', async () => {
    expect(await (await app.request('/api/get_script', {}, env)).text()).toBe('');
    await fixture.db.insert(systemConfig).values({ id: 2, menuName: 'system_statistics', value: '""' });
    await new SystemConfigService(container, env).invalidate('system_statistics');
    const response = await app.request('/api/get_script', {}, env);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/javascript'); expect(await response.text()).toBe('');
  });
  it('uses the platform setting and existing cache invalidation rather than a store setting', async () => {
    await fixture.db.insert(systemConfig).values([{ id: 1, menuName: 'system_statistics', value: script }, { id: 2, menuName: 'system_statistics', value: 'throw Error("foreign store");', isStore: 1 }]);
    expect(await (await app.request('/api/get_script', {}, env)).text()).toBe(script);
    await fixture.db.update(systemConfig).set({ value: 'globalThis.updatedStatistics=true;' });
    expect(await (await app.request('/api/get_script', {}, env)).text()).toBe(script);
    await new SystemConfigService(container, env).invalidate('system_statistics');
    expect(await (await app.request('/api/get_script', {}, env)).text()).toBe('globalThis.updatedStatistics=true;');
  });
  it('does not disguise a real database failure as a successful empty script', async () => {
    await fixture.exec('ALTER TABLE system_config RENAME TO unavailable_statistics_fixture');
    try {
      const response = await app.request('/api/get_script', {}, env);
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(await response.json()).toMatchObject({ status: 500 }); expect(cache.has('cfg_system_statistics')).toBe(false);
    } finally { await fixture.exec('ALTER TABLE unavailable_statistics_fixture RENAME TO system_config'); }
  });
});
