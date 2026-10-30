import { describe, expect, it, vi } from 'vitest';
import type { DbClient, Container } from '@/lib/di';
import { SystemConfigService } from '@/services/system/SystemConfigService';
import { normalizeAdminConfigBatch } from '@/services/system/AdminConfigBatchService';
import { requiredAdminPermission, isAdminPcBaseRecoveryRoute, canRetainOpaqueLegacyMenu } from '@/services/admin/AdminPermissionService';
import { readPcBaseImageReferences, assertPcBaseImageReplacements, renderPcBaseImages } from '@/services/pc/PcBaseAssetPolicy';
import { safePcSiteUrl } from '@/services/pc/PcBaseRuntimeConfig';
import { PC_BASE_KEYS } from '../../view/common/pcBase';

describe('PC controlled runtime boundaries', () => {
  it.each(PC_BASE_KEYS)('rejects generic single/mixed reads and whole mixed writes for %s before SQL/KV', async key => {
    const touch = vi.fn(() => { throw Error('generic boundary crossed'); });
    const service = new SystemConfigService({ systemConfigDao: { getValue: touch, getValues: touch } } as unknown as Container,
      { CONFIG_KV: { get: touch, put: touch, delete: touch } });
    await expect(service.get(key)).rejects.toThrow('PC配置');
    await expect(service.getMany(['unrelated', key])).rejects.toThrow('PC配置');
    expect(() => normalizeAdminConfigBatch({ unrelated: 'kept', [key]: 'bypass' })).toThrow('/config/pc');
    expect(touch).not.toHaveBeenCalled();
  });
  it.each(['/adminapi/', '/api/admin/'])('requires domain permissions and limits owner recovery shapes at %s', prefix => {
    expect(requiredAdminPermission('GET', prefix + 'config/pc')).toBe('pc_base.view');
    expect(requiredAdminPermission('POST', prefix + 'config/pc')).toBe('pc_base.manage');
    for (const route of ['attachment-categories','attachment-options']) expect(requiredAdminPermission('GET', prefix + 'config/pc/' + route)).toBe('pc_base.manage');
    expect(requiredAdminPermission('GET', prefix + 'setting/config/edit_new_build/pc')).toBe('pc_base.view');
    const receipt = prefix + 'config/pc/operations/11111111-1111-4111-8111-111111111111';
    expect(isAdminPcBaseRecoveryRoute('GET', receipt)).toBe(true);
    expect(isAdminPcBaseRecoveryRoute('POST', receipt + '/resolve')).toBe(true);
    for (const [method, path] of [['POST', receipt], ['DELETE', receipt], ['GET', receipt + '/resolve'], ['POST', receipt + '/resolve/extra']]) {
      expect(isAdminPcBaseRecoveryRoute(method!, path!)).toBe(false);
      expect(requiredAdminPermission(method!, path!)).toBeNull();
    }
  });
  it('never retains a copied PC page claim through the opaque legacy menu fallback', () => {
    expect(canRetainOpaqueLegacyMenu({ id: 9999, authType: 1, menuPath: '/admin/app/pc', uniqueAuth: 'app-pc', apiUrl: '', methods: '' })).toBe(false);
  });
});

describe('PC stable HTTP and canonical private image authority', () => {
  const untouched = () => ({ select: vi.fn(() => { throw Error('static image must not query SQL'); }) });
  it('preserves stable HTTP without SQL, APP_KEY, canonicalization or a proxy', async () => {
    const db = untouched(), source = 'http://cdn.example.test/原图.png?size=2';
    expect(await readPcBaseImageReferences(db as unknown as DbClient, [source, '/uploads/logo.png', ''])).toEqual([source, '/uploads/logo.png', '']);
    expect(await assertPcBaseImageReplacements(db as unknown as DbClient, [source])).toEqual([source]);
    expect(await renderPcBaseImages(undefined, [source])).toEqual([source]);
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each(['/api/assets/1?signature=private', '/api/%61ssets/1', 'https://user:private@cdn.example.test/p.png', 'javascript:private'])('never turns retained unsafe image %s into signing authority', async source => {
    const db = untouched();
    expect(await readPcBaseImageReferences(db as unknown as DbClient, [source])).toEqual(['']);
    expect(await renderPcBaseImages(undefined, [source])).toEqual(['']);
    await expect(assertPcBaseImageReplacements(db as unknown as DbClient, [source])).rejects.toThrow('PC图片');
    expect(db.select).not.toHaveBeenCalled();
  });
  it('checks real mature owner/key/MIME policy after selecting and locking canonical IDs', async () => {
    const rows = [
      { attId: 1, type: 1, relationId: 0, moduleType: 1, imageType: 8, fileType: 1, attType: 'image/png', name: 'attachments/admin/1/one.png', attDir: '/api/assets/1' },
      { attId: 2, type: 4, relationId: 9, moduleType: 1, imageType: 8, fileType: 1, attType: 'image/png', name: 'attachments/supplier/9/two.png', attDir: '/api/assets/2' },
    ];
    let locked = [{ id: 1 }];
    const chain = { from: vi.fn(() => chain), where: vi.fn(() => chain), orderBy: vi.fn(() => chain),
      for: vi.fn(async () => locked), then: (yes: (value: typeof rows) => unknown, no: (reason: unknown) => unknown) => Promise.resolve(rows).then(yes, no) };
    const db = { select: vi.fn(() => chain) } as unknown as DbClient;
    expect(await readPcBaseImageReferences(db, ['/api/assets/1', '/api/assets/2'])).toEqual(['/api/assets/1', '']);
    expect(await assertPcBaseImageReplacements(db, ['/api/assets/1', '/api/assets/1'])).toEqual(['/api/assets/1', '/api/assets/1']);
    expect(chain.for).toHaveBeenCalledWith('share', { noWait: true });
    locked = [{ id: 2 }];
    await expect(assertPcBaseImageReplacements(db, ['/api/assets/2'])).rejects.toThrow('不属于平台');
  });
  it.each(['javascript:private', '//evil.example', 'https://user:secret@example.test', 'http://example.test/?signature=private', 'https://example.test/#private'])('rejects unsafe site origin %s without returning its credential material', source => {
    expect(safePcSiteUrl(source)).toBe('');
  });
});
