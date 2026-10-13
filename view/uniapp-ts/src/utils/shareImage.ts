import { API_BASE } from '@/utils/request';
type ImageFileSystem = { writeFile(options: { filePath: string; data: string; encoding: 'base64'; success(): void; fail(): void }): void; unlink(options: { filePath: string; success?(): void; fail?(): void }): void };
/** Data URIs are decoded locally on mini-programs; signed images retain their original query. */
export async function readableShareImage(source: string): Promise<{ path: string; release(): void }> {
  if (!source) throw Error('分享图片尚未准备好');
  let path = source, release = () => {};
  const native = uni as unknown as { getFileSystemManager?(): ImageFileSystem; env?: { USER_DATA_PATH?: string } };
  const wxEnv = (globalThis as unknown as { wx?: { env?: { USER_DATA_PATH?: string } } }).wx?.env;
  const root = native.env?.USER_DATA_PATH ?? wxEnv?.USER_DATA_PATH;
  if (source.startsWith('data:') && root && native.getFileSystemManager) {
    const match = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(source); if (!match) throw Error('分享图片无法解码');
    const fs = native.getFileSystemManager(), file = `${root}/cinashop-share-${Date.now()}-${Math.random().toString(16).slice(2)}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
    await new Promise<void>((resolve, reject) => fs.writeFile({ filePath: file, data: match[2]!, encoding: 'base64', success: resolve, fail: () => reject(Error('分享图片保存到本机失败')) }));
    path = file; release = () => fs.unlink({ filePath: file, fail: () => {} });
  } else if (source.startsWith('/api/') && API_BASE) path = API_BASE + source;
  try {
    const image = await new Promise<string>((resolve, reject) => uni.getImageInfo({ src: path, success: value => resolve(value.path), fail: () => reject(Error('分享图片无法读取，请重新生成')) }));
    return { path: image, release };
  } catch (error) { release(); throw error; }
}
