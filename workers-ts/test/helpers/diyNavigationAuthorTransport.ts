import type { IncomingMessage, ServerResponse } from 'node:http';

// Only an actual incoming-stream read may create this marker. Business and
// assertion errors are never classified from a disconnected socket alone.
class NavigationAuthorBodyDisconnect extends Error {
  constructor(readonly request: IncomingMessage, cause: unknown) {
    super('Owned navigation author client disconnected while reading request', { cause });
  }
}
const socketCodes = new Set(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR', 'ERR_STREAM_DESTROYED']);
function socketError(reason: unknown): boolean {
  return reason instanceof Error && socketCodes.has(String((reason as NodeJS.ErrnoException).code));
}
export async function readNavigationAuthorBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  try {
    for await (const value of req) {
      const chunk = Buffer.from(value); length += chunk.length;
      if (length > 4_100_000) throw new RangeError('Owned navigation author request exceeds4100000bytes');
      chunks.push(chunk);
    }
  } catch (reason) {
    if (req.aborted && socketError(reason)) throw new NavigationAuthorBodyDisconnect(req, reason);
    throw reason;
  }
  return Buffer.concat(chunks);
}
export function isNavigationAuthorBodyDisconnect(reason: unknown, req: IncomingMessage): boolean {
  return reason instanceof NavigationAuthorBodyDisconnect && reason.request === req && req.aborted;
}
function responseDisconnected(req: IncomingMessage, res: ServerResponse): boolean {
  return req.aborted || res.destroyed && !res.writableFinished;
}
export function sendNavigationAuthorResponse(
  res: ServerResponse, value: string | Uint8Array, status: number, type: string,
  disconnected: () => void,
): boolean {
  if (responseDisconnected(res.req, res)) { disconnected(); return false; }
  try {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(value); return true;
  } catch (reason) {
    if (responseDisconnected(res.req, res) && socketError(reason)) { disconnected(); return false; }
    throw reason;
  }
}
