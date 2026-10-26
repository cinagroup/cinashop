import { reverseGrowthRecordsManifest } from './helpers/customerGrowthRecordsManifest';
import { reversePointsCentreManifest } from './helpers/customerPointsCentreManifest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signCentreManifest as proof, reverseSignCentreManifest } from './helpers/customerSignCentreManifest';
import { REGISTERED_PAGE_ROUTES, LEGACY_ROUTE_RULES, resolveRegisteredPageRoute } from '../../view/uniapp-ts/src/config/navigation';
import { REGISTERED_PAGE_ROUTES as serverRoutes, LEGACY_ROUTE_RULES as serverRules, resolveRegisteredPageRoute as serverResolve } from '@/services/content/FabRouteRegistry';
const root = resolve(import.meta.dirname, '../..'), read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const hash = (source: string | Buffer) => createHash('sha256').update(source).digest('hex');
describe('customer sign centre exact additive page and original PHP assets', () => {
  it('registers only one new page and reconstructs the complete existing138-page manifest without changing dated footer proof', () => {
    const actual = reversePointsCentreManifest(reverseGrowthRecordsManifest(read(proof.file))), previous = reverseSignCentreManifest(actual);
    expect(hash(actual)).toBe(proof.after_sha256); expect(hash(previous)).toBe(proof.before_sha256);
    const current = JSON.parse(actual), old = JSON.parse(previous);
    expect(current.pages).toHaveLength(139); expect(old.pages).toHaveLength(138);
    expect(current.pages.filter((p: {path: string}) => p.path !== 'pages/user/signRecords')).toEqual(old.pages);
    expect(current.pages.filter((p: {path: string}) => p.path === 'pages/user/signRecords')).toEqual([{ path: 'pages/user/signRecords', style: { navigationBarTitleText: '签到记录' } }]);
    expect({ ...current, pages: old.pages }).toEqual(old);
    expect(hash(read('workers-ts/audit/diy-footer-source-binding-20261022.json'))).toBe('88ada866df4f97a5f50e3cce0321ac7accf16f0989198e2877d4455c7f51b2dd');
  });
  it.each(['extra', 'missing', 'duplicate', 'old', 'newline', 'unrelated-title'])('rejects unreviewed manifest bytes before the historical proof: %s', kind => {
    const actual = reversePointsCentreManifest(reverseGrowthRecordsManifest(read(proof.file))); let changed = actual;
    if (kind === 'extra') changed += '\n'; if (kind === 'missing') changed = actual.replace(proof.inserted_source, '');
    if (kind === 'duplicate') changed += proof.inserted_source; if (kind === 'old') changed = reverseSignCentreManifest(actual);
    if (kind === 'newline') changed = actual.replace('\n', '\r\n'); if (kind === 'unrelated-title') changed = actual.replace('个人资料', '别的标题');
    expect(changed).not.toBe(actual); expect(() => reverseSignCentreManifest(changed)).toThrow();
  });
  it('resolves the old sign history and real registered destination identically for client and server, keeping integral history distinct', () => {
    expect([...REGISTERED_PAGE_ROUTES].sort()).toEqual([...serverRoutes].sort());
    expect(LEGACY_ROUTE_RULES).toEqual(serverRules);
    for (const resolver of [resolveRegisteredPageRoute, serverResolve]) {
      expect(resolver('/pages/users/user_sgin_list/index')).toBe('/pages/user/signRecords');
      expect(resolver('/pages/user/signRecords')).toBe('/pages/user/signRecords');
      expect(resolver('/pages/users/user_sgin/index')).toBe('/pages/user/sign');
      expect(resolver('/pages/users/user_integral_detail/index')).toBe('/pages/user/integralLogs');
    }
    expect(LEGACY_ROUTE_RULES['/pages/users/user_sgin_list/index']).toEqual({ target: '/pages/user/signRecords', coverage: 'candidate_covered' });
  });
  it('ships all ten exact local PHP images with original dimensions and no provider URL dependency', () => {
    const manifest = JSON.parse(read('view/uniapp-ts/scripts/fixtures/sign-centre-original-assets-20261025.json')) as { php_ref: string; assets: Array<{ target: string; sha256: string; bytes: number; width: number; height: number }> };
    expect(manifest.php_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5'); expect(manifest.assets).toHaveLength(10);
    for (const item of manifest.assets) {
      const bytes = readFileSync(resolve(root, 'view/uniapp-ts', item.target)); expect(hash(bytes)).toBe(item.sha256); expect(bytes.length).toBe(item.bytes);
      const pixels = new Uint8Array(bytes), view = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      expect([...pixels.subarray(0, 8)].map(value => value.toString(16).padStart(2, '0')).join('')).toBe('89504e470d0a1a0a'); expect(view.getUint32(16)).toBe(item.width); expect(view.getUint32(20)).toBe(item.height);
    }
  });
});
