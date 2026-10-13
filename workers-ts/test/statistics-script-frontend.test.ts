import { describe, expect, it } from 'vitest';
import { loadStatisticsScript, statisticsScriptUrl } from '../../view/common/statisticsScript';
describe('statistics script frontend origin and platform boundaries', () => {
  it.each(['', '/', '/api', '/adminapi', '/supplierapi', '/api/admin', '/api/supplier'])('maps %s to the public endpoint', base => {
    expect(statisticsScriptUrl(base)).toBe('/api/get_script');
  });
  it.each(['https://shop.example', 'https://shop.example/adminapi/', 'https://shop.example/api/supplier', 'http://127.0.0.1:8080/api'])('retains the configured origin for %s', base => {
    expect(statisticsScriptUrl(base)).toBe(`${base.startsWith('http://') ? 'http://127.0.0.1:8080' : 'https://shop.example'}/api/get_script`);
  });
  it('retains a reverse-proxy path prefix', () => { expect(statisticsScriptUrl('/shop/adminapi')).toBe('/shop/api/get_script'); });
  it.each(['//elsewhere/api', 'javascript:alert(1)', 'https://user:secret@shop.example/api', '/api?secret=1', '/api#hash', '/a/../api', '/%2e%2e/api', '/bad\\api', '/api\u0000'])('rejects malformed input before creating any script: %s', base => {
    expect(() => statisticsScriptUrl(base)).toThrow('统计脚本接口地址无效');
  });
  it('requires no browser globals in Mini Program or native application contexts', () => {
    expect(Reflect.get(globalThis, 'document')).toBeUndefined(); expect(loadStatisticsScript('/api')).toBeUndefined();
  });
});
