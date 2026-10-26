import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reversePointsCentreManifest, pointsCentreManifest as proof } from './helpers/customerPointsCentreManifest';
import { reverseSignCentreManifest } from './helpers/customerSignCentreManifest';
import { REGISTERED_PAGE_ROUTES, LEGACY_ROUTE_RULES, resolveRegisteredPageRoute } from '../../view/uniapp-ts/src/config/navigation';
import { REGISTERED_PAGE_ROUTES as serverRoutes, LEGACY_ROUTE_RULES as serverRules, resolveRegisteredPageRoute as serverResolve } from '@/services/content/FabRouteRegistry';
const root = resolve(import.meta.dirname, '../..'), read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
describe('PHP personal points centre remains distinct from its exchange mall', () => {
  it('adds one actual page and reconstructs both complete prior manifest proofs exactly', () => {
    const actual = read(proof.file), previous = reversePointsCentreManifest(actual), old = JSON.parse(previous), current = JSON.parse(actual);
    expect(sha(actual)).toBe(proof.after_sha256); expect(sha(previous)).toBe(proof.before_sha256);
    expect(current.pages).toHaveLength(140); expect(old.pages).toHaveLength(139);
    expect(current.pages.filter((p: {path: string}) => p.path !== 'pages/user/points')).toEqual(old.pages);
    expect({ ...current, pages: old.pages }).toEqual(old);
    expect(JSON.parse(reverseSignCentreManifest(previous)).pages).toHaveLength(138);
  });
  it.each(['extra','missing','duplicate','title','newline'])('rejects unreviewed page bytes: %s', variant => {
    const actual = read(proof.file), changed = variant === 'extra' ? actual + '\n' : variant === 'missing' ? actual.replace(proof.inserted_source, '')
      : variant === 'duplicate' ? actual + proof.inserted_source : variant === 'title' ? actual.replace('积分详情','其他详情') : actual.replace('\n','\r\n');
    expect(() => reversePointsCentreManifest(changed)).toThrow();
  });
  it('keeps client/server routing equal and corrects only the personal-centre alias while retaining the real mall', () => {
    expect([...REGISTERED_PAGE_ROUTES].sort()).toEqual([...serverRoutes].sort()); expect(LEGACY_ROUTE_RULES).toEqual(serverRules);
    for (const resolve of [resolveRegisteredPageRoute,serverResolve]) {
      expect(resolve('/pages/users/user_integral/index')).toBe('/pages/user/points');
      expect(resolve('/pages/user/points')).toBe('/pages/user/points');
      expect(resolve('/pages/activity/points_mall/index')).toBe('/pages/user/integral');
      expect(resolve('/pages/users/user_integral_detail/index')).toBe('/pages/user/integralLogs');
    }
    const mall = read('view/uniapp-ts/src/pages/user/integral.vue'); expect(mall).toContain('useIntegralPurchase'); expect(mall).toContain('confirmExchange');
    expect(read('view/uniapp-ts/src/pages/user/sign.vue')).toContain('url="/pages/user/integral"');
    expect(read('view/uniapp-ts/src/composables/useUserCenter.ts')).toContain("['积分详情','/pages/user/points']");
  });
  it('retains ten original PNG/GIF assets with fixed provenance, bytes and dimensions', () => {
    const raw = read('view/uniapp-ts/scripts/fixtures/points-centre-original-assets-20261025.json');
    expect(sha(raw)).toBe('5345c0e4507822461726d753be5e6ce71ba8d198b1e7c945225536d993632d63');
    const manifest = JSON.parse(raw) as { php_ref: string; assets: Array<{ target: string; bytes: number; sha256: string; width: number; height: number }> };
    expect(manifest.php_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5'); expect(manifest.assets).toHaveLength(10);
    for (const asset of manifest.assets) {
      const b = new Uint8Array(readFileSync(resolve(root, asset.target))), view = new DataView(b.buffer,b.byteOffset,b.byteLength);
      expect(b.length).toBe(asset.bytes); expect(sha(b)).toBe(asset.sha256);
      if (asset.target.endsWith('.gif')) { expect(String.fromCharCode(...b.subarray(0,6))).toMatch(/^GIF8[79]a$/);expect(view.getUint16(6,true)).toBe(asset.width);expect(view.getUint16(8,true)).toBe(asset.height); }
      else { expect([...b.subarray(0,8)].map(n=>n.toString(16).padStart(2,'0')).join('')).toBe('89504e470d0a1a0a');expect(view.getUint32(16)).toBe(asset.width);expect(view.getUint32(20)).toBe(asset.height); }
    }
  });
});
