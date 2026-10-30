import { ValidateException } from '@/utils/errors';

export interface OfficialAccountMenuConfig { appId: string; secret: string }
export type OfficialAccountMenuCreateResult = {
  outcome: 'accepted' | 'rejected' | 'unknown';
  code?: number;
};
export type OfficialAccountMenuReadResult =
  | { outcome: 'read'; button: unknown[] }
  | { outcome: 'rejected'; code?: number };

const ORIGIN = 'https://api.weixin.qq.com';
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only locally maintained wording may reach a caller. */
export function officialAccountMenuReason(code?: number): string {
  switch (code) {
    case -1: return '微信服务繁忙，请稍后重新确认';
    case 40001: case 40014: case 42001: return '公众号凭据已失效，请重新确认后重试';
    case 40013: case 40125: return '公众号凭据不正确，请检查配置';
    case 40164: return '当前服务器未获公众号接口访问许可';
    case 45009: return '公众号接口调用次数已达上限，请稍后重试';
    case 48001: return '公众号未获此接口权限，请检查账号权限';
    default: return '微信未确认菜单，请检查公众号配置与菜单内容';
  }
}

/** Internal failures never retain a transport error, URL or response body. */
class MenuReadFailure extends Error {}

function providerCode(value: Record<string, unknown>): number | undefined {
  if (!own(value, 'errcode')) return undefined;
  if (typeof value.errcode !== 'number' || !Number.isSafeInteger(value.errcode)) {
    throw new MenuReadFailure('公众号接口返回格式异常');
  }
  return value.errcode;
}

function configSnapshot(config: OfficialAccountMenuConfig): OfficialAccountMenuConfig {
  try {
    const appId = config.appId, secret = config.secret;
    if (typeof appId !== 'string' || typeof secret !== 'string' || !appId || !secret
      || appId.length > 128 || secret.length > 1024 || /[\u0000-\u0020\u007f]/.test(appId + secret)) {
      throw new Error();
    }
    return { appId, secret };
  } catch {
    throw new ValidateException('公众号凭据不完整，菜单尚未发送');
  }
}

function menuSnapshot(button: readonly unknown[]): string {
  try {
    // Authoring validation belongs to the caller. Snapshot before any await so
    // the durable dispatch hook and the HTTP request cannot see different drafts.
    if (!Array.isArray(button) || button.length < 1 || button.length > 3) throw new Error();
    const body = JSON.stringify({ button });
    if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new Error();
    return body;
  } catch {
    throw new ValidateException('菜单请求格式或大小不正确，菜单尚未发送');
  }
}

interface MenuCall {
  check(): void;
  json(url: URL, method: 'GET' | 'POST', body?: string): Promise<{ ok: boolean; value: Record<string, unknown> }>;
}

/** The single deadline includes token headers/body, the hook and menu headers/body.
 * An injected fetcher that ignores AbortSignal still cannot publish after a late
 * hook or leave an arriving response body open after the caller has timed out. */
async function withinDeadline<T>(fetcher: typeof fetch, run: (call: MenuCall) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let closed = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const check = () => { if (closed) throw new MenuReadFailure('公众号接口请求超时'); };
  const cancel = () => { closed = true; controller.abort(); void reader?.cancel().catch(() => undefined); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { cancel(); reject(new MenuReadFailure('公众号接口请求超时')); }, TIMEOUT_MS);
  });
  const call: MenuCall = {
    check,
    async json(url, method, body) {
      check();
      const response = await fetcher(url.toString(), {
        method, redirect: 'error', signal: controller.signal,
        headers: body === undefined ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
        ...(body === undefined ? {} : { body }),
      });
      if (closed) { void response.body?.cancel().catch(() => undefined); check(); }
      const length = response.headers.get('Content-Length');
      if (!response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
        void response.body?.cancel().catch(() => undefined);
        throw new MenuReadFailure('公众号接口返回数据过大或不完整');
      }
      const current = response.body.getReader(); reader = current;
      try {
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) {
          check();
          const part = await current.read();
          check();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_BYTES) {
            void current.cancel().catch(() => undefined);
            throw new MenuReadFailure('公众号接口返回数据过大');
          }
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
        catch { throw new MenuReadFailure('公众号接口返回格式异常'); }
        if (!object(value)) throw new MenuReadFailure('公众号接口返回格式异常');
        return { ok: response.ok, value };
      } finally { reader = undefined; current.releaseLock(); }
    },
  };
  try { return await Promise.race([run(call), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); cancel(); }
}

/** No shared token/config cache and no automatic retry of a menu publish. */
export class OfficialAccountMenuProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async token(config: OfficialAccountMenuConfig, call: MenuCall): Promise<string> {
    const url = new URL('/cgi-bin/token', ORIGIN);
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', config.appId);
    url.searchParams.set('secret', config.secret);
    const { ok, value } = await call.json(url, 'GET');
    const code = providerCode(value);
    if (!ok || code !== undefined && code !== 0) {
      throw new MenuReadFailure(officialAccountMenuReason(code));
    }
    if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 2048
      || /[\u0000-\u0020\u007f]/.test(value.access_token)
      || typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in)
      || value.expires_in < 1 || value.expires_in > 7200) {
      throw new MenuReadFailure('公众号凭据响应不完整，菜单尚未发送');
    }
    return value.access_token;
  }

  async create(config: OfficialAccountMenuConfig, button: readonly unknown[], beforeDispatch: () => Promise<void>): Promise<OfficialAccountMenuCreateResult> {
    const credentials = configSnapshot(config), body = menuSnapshot(button);
    let dispatched = false, hookFailed = false, hookError: unknown;
    try {
      return await withinDeadline(this.fetcher, async call => {
        const token = await this.token(credentials, call);
        call.check();
        try { await beforeDispatch(); } catch (error) { hookFailed = true; hookError = error; throw error; }
        call.check();
        const url = new URL('/cgi-bin/menu/create', ORIGIN);
        url.searchParams.set('access_token', token);
        // Set before invoking fetch: a synchronous transport exception also does
        // not prove the remote side received no request.
        dispatched = true;
        const { ok, value } = await call.json(url, 'POST', body);
        const code = providerCode(value);
        if (!ok || code === undefined) return { outcome: 'unknown' };
        return code === 0 ? { outcome: 'accepted' } : { outcome: 'rejected', code };
      });
    } catch (error) {
      if (dispatched) return { outcome: 'unknown' };
      if (hookFailed) throw hookError;
      throw new ValidateException(error instanceof MenuReadFailure ? error.message : '公众号接口暂不可用，菜单尚未发送');
    }
  }

  async read(config: OfficialAccountMenuConfig, beforeDispatch: () => Promise<void>): Promise<OfficialAccountMenuReadResult> {
    const credentials = configSnapshot(config);
    let hookFailed = false, hookError: unknown;
    try {
      return await withinDeadline(this.fetcher, async call => {
        const token = await this.token(credentials, call);
        call.check();
        try { await beforeDispatch(); } catch (error) { hookFailed = true; hookError = error; throw error; }
        call.check();
        const url = new URL('/cgi-bin/menu/get', ORIGIN);
        url.searchParams.set('access_token', token);
        const { ok, value } = await call.json(url, 'GET');
        const code = providerCode(value);
        if (!ok) return code !== undefined && code !== 0 ? { outcome: 'rejected', code } : { outcome: 'rejected' };
        if (code !== undefined && code !== 0) return { outcome: 'rejected', code };
        if (!object(value.menu) || !Array.isArray(value.menu.button)) {
          throw new MenuReadFailure('公众号默认菜单响应不完整');
        }
        // Conditional menus are a different resource. No filtering, projection
        // or merging may turn an unreadable default menu into an empty match.
        return { outcome: 'read', button: value.menu.button };
      });
    } catch (error) {
      if (hookFailed) throw hookError;
      throw new ValidateException(error instanceof MenuReadFailure ? error.message : '公众号菜单读取失败，请稍后重新确认');
    }
  }
}
