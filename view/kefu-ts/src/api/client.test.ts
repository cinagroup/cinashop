import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, KEFU_TOKEN_KEY, KEFU_INFO_KEY } from './client';
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
beforeEach(() => {
  vi.stubGlobal('sessionStorage', storage()); vi.stubGlobal('localStorage', storage()); vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('notification HTTP session boundaries', () => {
  it.each([401, 410000, 410001, 410002])('clears the current session for auth status %s', async (status) => {
    sessionStorage.setItem(KEFU_TOKEN_KEY, 'current'); sessionStorage.setItem(KEFU_INFO_KEY, '{}');
    const expired = vi.fn(); window.addEventListener('kefu-auth-expired', expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status, msg: 'expired' }, { status: 401 })));
    await expect(apiRequest('/kefuapi/messages')).rejects.toThrow('expired');
    expect(sessionStorage.getItem(KEFU_TOKEN_KEY)).toBeNull(); expect(sessionStorage.getItem(KEFU_INFO_KEY)).toBeNull(); expect(expired).toHaveBeenCalledTimes(1);
  });
  it('does not erase a replacement session when an old request returns 401', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    sessionStorage.setItem(KEFU_TOKEN_KEY, 'old'); const old = apiRequest('/kefuapi/messages');
    sessionStorage.setItem(KEFU_TOKEN_KEY, 'new'); sessionStorage.setItem(KEFU_INFO_KEY, 'new identity');
    finish(Response.json({ status: 401, msg: 'expired' }, { status: 401 })); await expect(old).rejects.toThrow('expired');
    expect(sessionStorage.getItem(KEFU_TOKEN_KEY)).toBe('new'); expect(sessionStorage.getItem(KEFU_INFO_KEY)).toBe('new identity');
  });
  it.each([403, 503])('does not log out on permission or infrastructure status %s', async (status) => {
    sessionStorage.setItem(KEFU_TOKEN_KEY, 'current');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status, msg: 'unavailable' }, { status })));
    await expect(apiRequest('/kefuapi/messages')).rejects.toThrow('unavailable'); expect(sessionStorage.getItem(KEFU_TOKEN_KEY)).toBe('current');
  });
});
