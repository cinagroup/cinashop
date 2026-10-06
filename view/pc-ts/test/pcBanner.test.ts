import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePcHomeBanners, resolvePcBannerLink, safePcBannerImage } from '../src/api/pcBanner.ts';

test('legacy product jumps adapt to actual PC goods routes and retain query/hash', () => {
  assert.deepEqual(resolvePcBannerLink('/product/detail/42?from=banner#review'), { kind: 'router', href: '/goods/42?from=banner#review' });
  assert.deepEqual(resolvePcBannerLink('/goods?q=white%20shirt'), { kind: 'router', href: '/goods?q=white%20shirt' });
  assert.deepEqual(resolvePcBannerLink('/legacy/page?from=home'), { kind: 'href', href: '/legacy/page?from=home' });
  assert.deepEqual(resolvePcBannerLink('http://legacy.example/page'), { kind: 'href', href: 'http://legacy.example/page' });
  assert.deepEqual(resolvePcBannerLink('https://example.test/page'), { kind: 'href', href: 'https://example.test/page' });
});
test('dangerous URL schemes, credentials, whitespace and encoded control/backslash/protocol-relative layers are not navigable', () => {
  for (const value of ['', 'javascript:alert(1)', 'data:text/html,x', 'blob:https://evil/a', '//evil/a', '/%252f%252fevil', '/%255cevil', '/x%250ay', '/x%250dy', 'https://u:p@example.test/x', ' /goods', '/goods?q=white shirt', '/x%252525250ay', 'https:example.com', '/a/..//evil.test', '/a/%2e%2e//evil.test']) assert.equal(resolvePcBannerLink(value), null, value);
});
test('public picture previews permit HTTPS signed assets and encoded normal spaces while rejecting untrusted sources', () => {
  for (const value of ['/api/assets/42?sig=preview&expires=99', '/static/My%20Banner.png', 'https://img.example/My%20Banner.png']) assert.equal(safePcBannerImage(value), value);
  for (const value of ['http://img.example/a.png', '//img.example/a.png', 'data:image/png,x', 'https://u:p@img.example/a.png', '/a%255cb.png', '/My Banner.png']) assert.equal(safePcBannerImage(value), '');
});
test('public projection retains server order and cap ten, uses static entries without fake links, and rejects corrupt responses', () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ id: 20 - i, title: `轮播${i}`, image: '/static/a.png', url: i ? '/goods/42' : '', sort: 3, status: 1, extra_safe_field: 'legacy' }));
  const parsed = parsePcHomeBanners({ list }); assert.deepEqual(parsed.map(item => item.id), list.map(item => item.id)); assert.equal(parsed[0].url, '');
  for (const value of [null, { list: [...list, { ...list[0], id: 99 }] }, { list: [list[0], list[0]] }, { list: [{ ...list[0], id: 0 }] }, { list: [{ ...list[0], image: 'http://evil/a.png' }] }, { list: [{ ...list[0], url: 'javascript:alert(1)' }] }, { list: [{ ...list[0], title: null }] }]) assert.throws(() => parsePcHomeBanners(value));
  assert.deepEqual(parsePcHomeBanners({ list: [] }), []);
});
