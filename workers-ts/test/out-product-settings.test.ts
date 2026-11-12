import { describe, expect, it } from 'vitest';
import { normalizeOutProductInput } from '@/services/out/OutProductService';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { outProductSettingsInput } from '@/services/out/OutProductSettings';

const body = { cate_id: [9], store_name: '隔离设置商品', slider_image: ['/settings.png'], spec_type: 0,
  product_type: 0, delivery_type: [1], freight: 1, attrs: [{ price: '10.00', stock: 3 }] };
describe('Out product other settings', () => {
  it('preserves the omitted normalized shape and explicit undefined values', async () => {
    const omitted = normalizeOutProductInput(body);
    // Captured from the complete 02436643 predecessor, not this implementation.
    expect(await outRequestHash(omitted)).toBe('c5de6ce54a39cd48cf66bd93ae3455e319945d087a61add46a237c2d9b16f3c5');
    expect(outProductSettingsInput({})).toEqual({});
    for (const key of ['merUse', 'commandWord', 'videoOpen']) expect(Object.hasOwn(omitted, key)).toBe(false);
    expect(normalizeOutProductInput({ ...body, mer_use: undefined, command_word: undefined, video_open: undefined })).toEqual(omitted);
    expect(await outRequestHash(normalizeOutProductInput({ ...body, mer_use: 0, command_word: '', video_open: 0 })))
      .not.toBe(await outRequestHash(omitted));
  });
  it.each([0, 1, '0', '1', false, true])('accepts the legacy flag spelling %j independently', value => {
    const expected = value === 1 || value === '1' || value === true ? 1 : 0;
    expect(outProductSettingsInput({ mer_use: value, video_open: value })).toEqual({ merUse: expected, videoOpen: expected });
  });
  it.each([null, '', 2, -1, 'true', '01', ' 1 ', {}, []])('rejects malformed flags %j', value => {
    expect(() => outProductSettingsInput({ mer_use: value })).toThrow('mer_use');
    expect(() => outProductSettingsInput({ video_open: value })).toThrow('video_open');
  });
  it('binds explicit disabled video separately from the retained valid address', async () => {
    const raw = { ...body, video_link: 'https://media.example.test/fixture.mp4', video_open: false };
    const off = normalizeOutProductInput(raw), on = normalizeOutProductInput({ ...raw, video_open: 1 });
    expect(off).toMatchObject({ videoOpen: 0, videoLink: raw.video_link });
    expect(await outRequestHash(off)).not.toBe(await outRequestHash(on));
    expect(() => normalizeOutProductInput({ ...body, video_open: 1 })).toThrow('视频地址');
  });
  it('normalizes private playback tickets to the same stable video author intent', async () => {
    const stable = normalizeOutProductInput({ ...body, video_open: 1, video_link: '/api/assets/901' });
    const ticket = normalizeOutProductInput({ ...body, video_open: true, video_link: 'https://shop.example.test/api/assets/901?expires=1&signature=fixture' });
    expect(ticket.videoLink).toBe('/api/assets/901'); expect(await outRequestHash(ticket)).toBe(await outRequestHash(stable));
  });
  it('preserves Unicode command text, trims its edges and binds clear/changed text', async () => {
    const value = '隔离😀'.repeat(80);
    expect(outProductSettingsInput({ command_word: '  ' + value + '  ' })).toEqual({ commandWord: value });
    const one = normalizeOutProductInput({ ...body, command_word: value });
    expect(await outRequestHash(one)).not.toBe(await outRequestHash(normalizeOutProductInput({ ...body, command_word: '' })));
  });
  it.each([null, 1, {}, [], 'x'.repeat(256), 'bad\ntext', '\ud800'])('rejects malformed command text %j', value => {
    expect(() => outProductSettingsInput({ command_word: value })).toThrow('复制口令');
  });
  it('retains the implemented fulfillment types and rejects unknown product types', () => {
    for (const type of [0, 1, 2, 3, 4]) expect(normalizeOutProductInput({ ...body, product_type: type, mer_use: 1, video_open: 0,
      attrs: [{ ...body.attrs[0], ...(type === 4 ? { write_times: 2, write_valid: 1 } : {}) }] })).toMatchObject({ productType: type, merUse: 1, videoOpen: 0 });
    expect(() => normalizeOutProductInput({ ...body, product_type: 5 })).toThrow();
  });
});
