import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type ReadResult = { done: boolean; value?: Uint8Array };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Execute the actual installed CF socket, replacing only its platform imports.
// No driver function body, error handler or stream result is rewritten.
function socketFixture(ssl = false) {
  let source = readFileSync(new URL('../node_modules/postgres/cf/polyfills.js', import.meta.url), 'utf8');
  const replacements = [
    ["import { EventEmitter } from 'node:events'", ''],
    ["import { Buffer } from 'node:buffer'", ''],
    ["await import('cloudflare:sockets')", 'await platformSockets()'],
    ['export { setImmediate, clearImmediate }', ''],
  ];
  for (const [before, after] of replacements) {
    expect(source.split(before)).toHaveLength(2);
    source = source.replace(before, after);
  }
  source = source.replaceAll('export const ', 'const ');
  expect(source).not.toMatch(/\b(?:import|export)\b/);
  const read = deferred<ReadResult>();
  const closed = deferred<void>();
  const cancelError = new Error('Stream was cancelled.');
  const reader = { read: vi.fn(() => read.promise) };
  const writer = {
    ready: Promise.resolve(),
    write: vi.fn(async (_data: Uint8Array) => {}),
    close: vi.fn(async () => { read.resolve({ done: true }); closed.resolve(); }),
  };
  const raw = {
    closed: closed.promise,
    readable: { getReader: () => reader },
    writable: { getWriter: () => writer },
    close: vi.fn(async () => { closed.resolve(); read.reject(cancelError); }),
  };
  const factory = new Function('EventEmitter', 'Buffer', 'platformSockets', `${source}\nreturn net.Socket;`);
  const Socket = factory(EventEmitter, Buffer, async () => ({ connect: () => raw })) as
    new () => EventEmitter & { ssl: boolean; readyState: string; connect(port: number, host: string): Promise<void>;
      end(data?: Uint8Array): unknown; destroy(): void };
  const socket = new Socket();
  socket.ssl = ssl;
  const errors: unknown[] = [];
  let closes = 0;
  socket.on('error', error => errors.push(error));
  socket.on('close', () => { closes++; });
  return { socket, raw, reader, writer, read, closed, errors, closes: () => closes };
}

async function settle() {
  // Drain the finite read/write/closed chains without timers or ignored errors.
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

describe('postgres 3.4.9 CF close backport', () => {
  it('locks the complete installed package to the reviewed archive', async () => {
    const scriptUrl = new URL('../scripts/build-postgres-cf-close-backport.mjs', import.meta.url);
    const { POSTGRES_CF_CLOSE_BACKPORT: provenance, verifyPostgresCfCloseBackportArchive: verify } =
      await import(/* @vite-ignore */ scriptUrl.href) as {
        POSTGRES_CF_CLOSE_BACKPORT: { derivedSri: string };
        verifyPostgresCfCloseBackportArchive(bytes: Buffer): Map<string, Buffer>;
      };
    const archive = readFileSync(new URL('../vendor/postgres-3.4.9-cf-close.tgz', import.meta.url));
    const files = verify(archive);
    expect(files.size).toBe(37);
    const root = fileURLToPath(new URL('../node_modules/postgres/', import.meta.url));
    const inventory = (directory: string, prefix = ''): string[] => readdirSync(directory, { withFileTypes: true })
      .flatMap(entry => {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory()) return inventory(join(directory, entry.name), `${path}/`);
        expect(entry.isFile()).toBe(true);
        return [path];
      });
    expect(inventory(root).sort()).toEqual([...files.keys()].map(path => path.slice('package/'.length)).sort());
    for (const [path, bytes] of files) {
      expect(Buffer.from(readFileSync(join(root, path.slice('package/'.length)))), path).toEqual(bytes);
    }
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const dependency = 'file:vendor/postgres-3.4.9-cf-close.tgz';
    expect(manifest.dependencies.postgres).toBe(dependency);
    expect(lock.packages[''].dependencies.postgres).toBe(dependency);
    expect(lock.packages['node_modules/postgres']).toMatchObject({
      version: '3.4.9', resolved: dependency, integrity: provenance.derivedSri,
    });
    const corrupted = Buffer.from(archive);
    corrupted[corrupted.length - 12] ^= 1;
    expect(() => verify(corrupted)).toThrow(/SRI/);
  });

  it('half-closes writes after Terminate and closes once at read EOF', async () => {
    const f = socketFixture();
    await f.socket.connect(5432, 'local-fixture');
    const terminate = Buffer.from([88, 0, 0, 0, 4]);
    f.socket.end(terminate);
    await settle();
    expect(f.writer.write).toHaveBeenCalledExactlyOnceWith(terminate);
    expect(f.writer.close).toHaveBeenCalledOnce();
    expect(f.raw.close).not.toHaveBeenCalled();
    expect(f.closes()).toBe(1);
    expect(f.errors).toEqual([]);
  });

  it.each(['read', 'write', 'writer-close', 'first-read'] as const)('propagates the original active %s failure', async kind => {
    const f = socketFixture(kind === 'first-read');
    await f.socket.connect(5432, 'local-fixture');
    const failure = new Error(`unexpected active ${kind} failure`);
    if (kind === 'write' || kind === 'writer-close') {
      if (kind === 'write') f.writer.write.mockRejectedValueOnce(failure);
      else f.writer.close.mockRejectedValueOnce(failure);
      f.socket.end(Buffer.from([88, 0, 0, 0, 4]));
    } else f.read.reject(failure);
    await settle();
    expect(f.errors).toEqual([failure]);
    expect(f.closes()).toBe(1);
    expect(f.socket.readyState).toBe('closed');
  });

  it('reports raw socket failure while active', async () => {
    const f = socketFixture();
    await f.socket.connect(5432, 'local-fixture');
    const failure = new Error('unexpected raw socket failure');
    f.closed.reject(failure);
    await settle();
    expect(f.errors).toEqual([failure]);
    f.read.resolve({ done: true });
    await settle();
    expect(f.closes()).toBe(1);
  });

  it('does not emit another error/close for cancellation after the terminal close event', async () => {
    const f = socketFixture();
    await f.socket.connect(5432, 'local-fixture');
    // The postgres connection removes its listeners synchronously on close.
    f.socket.once('close', () => f.socket.removeAllListeners());
    f.socket.destroy();
    await settle();
    expect(f.raw.close).toHaveBeenCalledOnce();
    expect(f.closes()).toBe(1);
    expect(f.errors).toEqual([]);
  });
});
