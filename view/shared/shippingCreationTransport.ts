import { creationScope, type CreationIdentity } from './shippingCreation';

/** Capture authorization and expected identity before the first await. */
export async function postShippingCreation(url: string, tokenHeader: 'Authori-zation' | 'Authorization', token: string | null,
  key: string, body: Record<string, unknown>, signal: AbortSignal, identity: CreationIdentity): Promise<unknown> {
  signal.throwIfAborted();
  if (!token) throw new Error('请重新登录后恢复原创建请求');
  const expectedScope = `v1:${creationScope(identity)}`;
  // Bound the entire response, not just its headers. Abort this attempt, never
  // the mounted session: the original key must remain available for recovery.
  const attempt = new AbortController();
  const cancelSession = () => attempt.abort(signal.reason);
  signal.addEventListener('abort', cancelSession, { once: true });
  const timeoutError = new Error('创建或恢复请求超时，结果尚未确认；原请求已保留，请恢复查询');
  const deadline = setTimeout(() => attempt.abort(timeoutError), 30_000);
  try {
    return await request(url, tokenHeader, token, key, body, attempt.signal, expectedScope);
  } catch (error) {
    // Body consumption may surface a generic AbortError instead of our reason.
    if (attempt.signal.aborted) throw attempt.signal.reason;
    throw error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', cancelSession);
    attempt.abort(); // also close an unread rejected HTTP response body
  }
}

async function request(url: string, tokenHeader: string, token: string, key: string,
  body: Record<string, unknown>, signal: AbortSignal, expectedScope: string): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
    headers: { [tokenHeader]: `Bearer ${token}`, 'Idempotency-Key': key, 'X-Shipping-Creation-Scope': expectedScope, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
    if (response.status === 412) throw new Error('创建身份已变化或缺失，原请求已保留；请重新登录并核对原账号与供应商归属');
    throw new Error(response.status === 409 ? '创建请求内容冲突，原记录已保留，请联系管理员核对' : '创建结果暂无法确认，请恢复原请求');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('创建响应为空，原请求已保留');
  const decoder = new TextDecoder(); let bytes = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) throw new Error('创建响应过大，原请求已保留');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const envelope = JSON.parse(text);
  if (!envelope || envelope.status !== 200 || !Object.hasOwn(envelope, 'data')) throw new Error('服务器未确认创建结果，请保留原请求并恢复查询');
  return envelope.data;
}
