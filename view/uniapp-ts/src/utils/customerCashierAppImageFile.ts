interface AppFile { size: number }
interface AppFileReader {
  result?: unknown; error?: unknown;
  onloadend: ((event: { target?: { result?: unknown } }) => void) | null;
  onerror: (() => void) | null; onabort: (() => void) | null;
  readAsDataURL: (file: AppFile) => void; abort: () => void;
}
interface AppIo {
  resolveLocalFileSystemURL: (path: string, success: (entry: { isDirectory?: boolean; file: (success: (file: AppFile) => void, fail: () => void) => void }) => void, fail: () => void) => void;
  FileReader: new () => AppFileReader;
}
const appIo = (): AppIo | undefined => (globalThis as unknown as { plus?: { io?: AppIo } }).plus?.io;
export function canReadCustomerCashierAppImage(): boolean {
  const io = appIo(); return !!io && typeof io.resolveLocalFileSystemURL === 'function' && typeof io.FileReader === 'function';
}
/** The App JS engine uses HTML5+ IO; its FileReader exposes data URLs rather than ArrayBuffer. */
export function decodeCustomerCashierAppImage(value: unknown, size: number, maximum: number): Uint8Array {
  if (typeof value !== 'string' || !Number.isSafeInteger(size) || size < 1 || size > maximum || value.length > Math.ceil(maximum / 3) * 4 + 256) throw Error('图片文件内容无效或超过上限');
  const match = /^data:[^;,]{0,100}(?:;charset=[A-Za-z0-9_-]{1,40})?;base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (!match || match[1].length % 4 !== 0) throw Error('图片文件读取结果无效');
  const encoded = match[1], padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (encoded.length / 4 * 3 - padding !== size) throw Error('图片实际大小与文件信息不一致');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', result = new Uint8Array(size);
  let cursor = 0;
  for (let index = 0; index < encoded.length; index += 4) {
    const a = alphabet.indexOf(encoded[index]), b = alphabet.indexOf(encoded[index + 1]);
    const c = encoded[index + 2] === '=' ? 0 : alphabet.indexOf(encoded[index + 2]), d = encoded[index + 3] === '=' ? 0 : alphabet.indexOf(encoded[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0 || index + 4 === encoded.length && (padding === 2 && (b & 15) !== 0 || padding === 1 && (c & 3) !== 0)) throw Error('图片文件编码无效');
    result[cursor++] = a << 2 | b >> 4;
    if (cursor < size) result[cursor++] = (b & 15) << 4 | c >> 2;
    if (cursor < size) result[cursor++] = (c & 3) << 6 | d;
  }
  return result;
}
/** Only reads the chooser's local file. Neither the path nor base64 contents are stored. */
export async function readCustomerCashierAppImage(path: string, maximum: number): Promise<Uint8Array> {
  const io = appIo();
  if (!canReadCustomerCashierAppImage() || !io) throw Error('当前设备无法读取所选图片');
  if (!path || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path) || /^[a-z][a-z0-9+.-]*:/iu.test(path) && !/^(?:file|content):/iu.test(path)) throw Error('请选择本机图片');
  return new Promise((resolve, reject) => {
    let done = false, reader: AppFileReader | undefined;
    const timer = setTimeout(() => { finish(undefined, Error('图片读取超时，请重新选择')); reader?.abort(); }, 15_000);
    function finish(bytes?: Uint8Array, failure?: Error) {
      if (done) return; done = true; clearTimeout(timer);
      if (reader) { reader.onloadend = null; reader.onerror = null; reader.onabort = null; }
      if (failure) reject(failure); else resolve(bytes!);
    }
    try {
      io.resolveLocalFileSystemURL(path, entry => {
        if (done) return;
        if (entry.isDirectory || typeof entry.file !== 'function') { finish(undefined, Error('请选择有效图片文件')); return; }
        entry.file(file => {
          if (done) return;
          if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maximum) { finish(undefined, Error('图片需为 10 MiB 以内的有效文件')); return; }
          try {
            reader = new io.FileReader();
            reader.onerror = () => finish(undefined, Error('无法读取所选图片'));
            reader.onabort = () => finish(undefined, Error('图片读取已取消'));
            reader.onloadend = event => {
              if (done) return;
              try { if (reader?.error) throw Error('无法读取所选图片'); finish(decodeCustomerCashierAppImage(event.target?.result ?? reader?.result, file.size, maximum)); }
              catch (failure) { finish(undefined, failure instanceof Error ? failure : Error('图片读取结果无效')); }
            };
            reader.readAsDataURL(file);
          } catch { finish(undefined, Error('无法读取所选图片')); }
        }, () => finish(undefined, Error('无法读取所选图片文件')));
      }, () => finish(undefined, Error('所选图片已不可用，请重新选择')));
    } catch { finish(undefined, Error('当前设备无法读取所选图片')); }
  });
}
