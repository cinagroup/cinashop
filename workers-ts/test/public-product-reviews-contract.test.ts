import { describe, expect, it } from 'vitest';
import { publicReviewBody, publicReviewId, publicReviewQuery } from '@/controllers/api/v1/PublicProductReviewController';
import { publicReviewContent, publicReviewNickname, publicReviewPictures } from '@/services/product/PublicProductReviewService';
describe('versioned public review input contracts', () => {
  it('accepts canonical bounded identities and refuses aliases', () => {
    for (const good of ['1', '2147483647']) expect(publicReviewId(good)).toBe(Number(good));
    for (const bad of [undefined, '', '0', '01', '+1', '-1', '1.0', '1e2', '2147483648', ' 1', '%31']) expect(() => publicReviewId(bad)).toThrow();
  });
  it('bounds pages and all four score buckets and rejects duplicate and foreign query keys', () => {
    expect(publicReviewQuery('https://local/x', true)).toEqual({ page: 1, limit: 10, type: 0 });
    expect(publicReviewQuery('https://local/x?page=1000000&limit=50&type=3', true)).toEqual({ page: 1000000, limit: 50, type: 3 });
    for (const query of ['page=0', 'page=1000001', 'limit=51', 'limit=0', 'type=4', 'page=01', 'page=1&page=2', 'limit=10&%6cimit=20', 'x=1', 'type=', 'type=-1', 'page=Infinity']) expect(() => publicReviewQuery('https://local/x?' + query, true)).toThrow();
    expect(() => publicReviewQuery('https://local/x?type=1')).toThrow();
  });
  it('rejects duplicate decoded JSON keys and exact-shape confusion', () => {
    expect(publicReviewBody('{"version":1}', 'visit')).toEqual({ version: 1 });
    expect(publicReviewBody('{"version":1,"praised":false}', 'praise')).toEqual({ version: 1, praised: false });
    for (const text of ['{}', 'null', '[]', '{"version":"1"}', '{"version":1,"version":1}', '{"version":1,"\\u0076ersion":1}', '{"version":1,"extra":true}']) expect(() => publicReviewBody(text, 'visit')).toThrow();
    for (const text of ['{"version":1}', '{"version":1,"praised":1}', '{"version":1,"praised":true,"praised":false}', '{"version":1,"praised":false,"replyId":5}']) expect(() => publicReviewBody(text, 'praise')).toThrow();
  });
  it('keeps Unicode content limits, private image slots and anonymized names', () => {
    expect(publicReviewContent('  分享体验🙂  ')).toBe('分享体验🙂');
    expect(publicReviewContent('🙂'.repeat(1000))).toHaveLength(2000);
    for (const value of ['', ' ', null, 1, 'x\0y', '🙂'.repeat(1001)]) expect(() => publicReviewContent(value)).toThrow();
    expect(publicReviewPictures('["","/api/assets/41"]')).toEqual(['', '/api/assets/41']);
    expect(publicReviewPictures(null)).toEqual([]); expect(publicReviewPictures('{}')).toEqual([]);
    for (const value of ['invalid', '[1]', JSON.stringify(Array(10).fill('a')), JSON.stringify(['a'.repeat(2049)])]) expect(() => publicReviewPictures(value)).toThrow();
    expect(publicReviewNickname('张小明')).toBe('张***明'); expect(publicReviewNickname('🙂')).toBe('🙂***'); expect(publicReviewNickname('')).toBe('用户');
  });
});
