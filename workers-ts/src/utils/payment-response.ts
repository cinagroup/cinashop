/** Bounded raw UTF-8, retained unchanged for provider signature verification.
 * Content-Length is only an early rejection hint, never the actual byte limit.
 */
export async function readPaymentProviderResponse(response: Response): Promise<string> {
  const limit = 64 * 1024;
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error('支付渠道响应长度无效或超过64 KiB');
  }
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('支付渠道响应超过64 KiB');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  // Preserve a BOM if present: never silently change the signed byte sequence.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
