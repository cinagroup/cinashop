import { ValidateException } from "@/utils/errors";

/** Read a UTF-8 request body without buffering beyond the declared limit. */
export async function readBoundedUtf8Text(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const limitLabel = maxBytes % 1024 === 0 ? `${maxBytes / 1024} KiB` : `${maxBytes} bytes`;
  const declaredRaw = request.headers.get("content-length");
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new ValidateException("Content-Length 无效");
    }
    if (declared > maxBytes) {
      throw new ValidateException(`请求数据不能超过${limitLabel}`);
    }
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ValidateException(`请求数据不能超过${limitLabel}`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ValidateException("请求数据不是有效 UTF-8");
  }
}

/** Parse any JSON value without allowing an unbounded request body into memory. */
export async function readBoundedJsonValue(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const limitLabel = maxBytes % 1024 === 0 ? `${maxBytes / 1024} KiB` : `${maxBytes} bytes`;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ValidateException(`请求数据不能超过${limitLabel}`);
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ValidateException(`请求数据不能超过${limitLabel}`);
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ValidateException("请求数据格式错误");
  }
  return body;
}

/** Parse a JSON object without allowing an unbounded request body into memory. */
export async function readBoundedJsonObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const body = await readBoundedJsonValue(request, maxBytes);
  if (body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ValidateException("请求数据格式错误");
  }
  return body as Record<string, unknown>;
}
