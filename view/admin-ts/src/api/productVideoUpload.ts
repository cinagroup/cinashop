import request, { getData } from '@/utils/request';
import type { AxiosResponse } from 'axios';

export const VIDEO_CHUNK_SIZE = 3 * 1024 * 1024;
export const VIDEO_MAX_SIZE = 100 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
export interface VideoManifest { filename: string; total_size: number; chunk_size: number; sha256: string[]; pid: number }
export interface VideoReceipt {
  upload_id: string; actor_id: number; state: 'unknown' | 'active' | 'expired' | 'cancelled' | 'committed';
  manifest: VideoManifest | null; confirmed: number[]; result: { id: number; url: string; size: number } | null;
}
export interface PendingVideoUpload { upload_id: string; actor_id: number }
const id = (value: string) => { if (!UUID.test(value)) throw Error('视频上传ID无效'); return value; };
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('视频上传响应不完整'); return value as Record<string, unknown>; }
function positive(value: unknown, max = 2147483647): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max; }
export function validateVideoManifest(manifest: VideoManifest): VideoManifest {
  if (typeof manifest.filename !== 'string' || !manifest.filename || manifest.filename !== manifest.filename.trim()
    || [...manifest.filename].length > 255 || /[\\/\u0000-\u001f\u007f]/u.test(manifest.filename) || !/\.mp4$/i.test(manifest.filename)
    || !positive(manifest.total_size, VIDEO_MAX_SIZE) || manifest.total_size < 12
    || !positive(manifest.chunk_size, 5 * 1024 * 1024) || manifest.chunk_size < 12
    || typeof manifest.pid !== 'number' || !Number.isSafeInteger(manifest.pid) || manifest.pid < 0 || manifest.pid > 2147483647
    || !Array.isArray(manifest.sha256) || manifest.sha256.length !== Math.ceil(manifest.total_size / manifest.chunk_size)
    || manifest.sha256.length > 100 || manifest.sha256.some(hash => typeof hash !== 'string' || !SHA.test(hash))) throw Error('视频文件资料或摘要无效');
  return manifest;
}
export function parseVideoReceipt(value: unknown, pending: PendingVideoUpload): VideoReceipt {
  const row = object(value);
  if (row.upload_id !== id(pending.upload_id) || row.actor_id !== pending.actor_id || !positive(row.actor_id)
    || !['unknown', 'active', 'expired', 'cancelled', 'committed'].includes(String(row.state)) || !Array.isArray(row.confirmed)) throw Error('视频上传结果不属于当前操作');
  let manifest: VideoManifest | null = null;
  if (row.manifest !== null) {
    const source = object(row.manifest);
    if (source.version !== 1 || source.mode !== 'manifest' || source.client_md5 !== null) throw Error('该视频会话不能由当前上传器恢复');
    manifest = validateVideoManifest({ filename: source.filename, total_size: source.total_size, chunk_size: source.chunk_size,
      pid: source.pid, sha256: source.sha256 } as VideoManifest);
    if (source.total_chunks !== manifest.sha256.length) throw Error('视频片数未能确认');
  }
  const confirmed = row.confirmed as number[];
  if (confirmed.length > 100 || new Set(confirmed).size !== confirmed.length
    || confirmed.some(part => !positive(part, manifest?.sha256.length ?? 0))
    || ['active', 'expired', 'committed'].includes(String(row.state)) && !manifest
    || row.state === 'unknown' && (manifest || confirmed.length)) throw Error('视频分片回执无效');
  let result: VideoReceipt['result'] = null;
  if (row.state === 'committed') {
    const saved = object(row.result);
    if (!positive(saved.id) || saved.url !== `/api/assets/${saved.id}` || saved.size !== manifest!.total_size
      || confirmed.length !== manifest!.sha256.length) throw Error('视频素材提交结果无效');
    result = { id: saved.id, url: saved.url as string, size: saved.size as number };
  } else if (row.result !== null) throw Error('视频未提交却包含素材结果');
  return { upload_id: pending.upload_id, actor_id: pending.actor_id, state: row.state as VideoReceipt['state'], manifest,
    confirmed: [...confirmed].sort((a, b) => a - b), result };
}
export function videoConfirmedBytes(receipt: VideoReceipt | null): number {
  if (!receipt?.manifest) return 0;
  return receipt.confirmed.reduce((sum, part) => sum + Math.min(receipt.manifest!.chunk_size,
    receipt.manifest!.total_size - (part - 1) * receipt.manifest!.chunk_size), 0);
}
export function parsePendingVideo(value: string | null, actorId: number): PendingVideoUpload | null {
  if (value === null) return null;
  if (value.length > 200) throw Error('视频恢复记录过大');
  const row = object(JSON.parse(value));
  if (Object.keys(row).length !== 2 || !positive(row.actor_id) || row.actor_id !== actorId || typeof row.upload_id !== 'string') throw Error('视频恢复记录无效');
  return { upload_id: id(row.upload_id), actor_id: row.actor_id };
}
/** Bounded sequential hashing: only one <=5MiB slice is held at a time. */
export async function videoFileManifest(file: File, chunkSize = VIDEO_CHUNK_SIZE, current = () => true, progress: (confirmedBytes: number) => void = () => {}): Promise<VideoManifest> {
  if (!(file instanceof File) || file.size < 12 || file.size > VIDEO_MAX_SIZE || !Number.isSafeInteger(chunkSize)
    || chunkSize < 12 || chunkSize > 5 * 1024 * 1024 || Math.ceil(file.size / chunkSize) > 100) throw Error('请选择100 MiB以内的MP4视频');
  const base = { filename: file.name, total_size: file.size, chunk_size: chunkSize, pid: 0, sha256: Array(Math.ceil(file.size / chunkSize)).fill('0'.repeat(64)) };
  validateVideoManifest(base);
  if (file.type && !['video/mp4', 'application/octet-stream'].includes(file.type.toLowerCase())) throw Error('请选择MP4视频');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (String.fromCharCode(...header.subarray(4, 8)) !== 'ftyp') throw Error('文件内容不是MP4');
  const hashes: string[] = [];
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    if (!current()) throw Error('视频文件校验已停止');
    const digest = await crypto.subtle.digest('SHA-256', await file.slice(offset, offset + chunkSize).arrayBuffer());
    if (!current()) throw Error('视频文件校验已停止');
    hashes.push([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
    progress(Math.min(file.size, offset + chunkSize));
  }
  return { ...base, sha256: hashes };
}
async function receipt(pending: PendingVideoUpload, call: Promise<AxiosResponse<unknown>>) { return parseVideoReceipt(await getData(call), pending); }
export const apiVideoQuery = (pending: PendingVideoUpload, signal?: AbortSignal) => receipt(pending, request.get(`/file/video_uploads/${id(pending.upload_id)}`, { signal }));
export const apiVideoInitialize = (pending: PendingVideoUpload, manifest: VideoManifest, signal?: AbortSignal) => receipt(pending, request.post(`/file/video_uploads/${id(pending.upload_id)}`, validateVideoManifest(manifest), { signal }));
export function apiVideoPart(pending: PendingVideoUpload, part: number, bytes: Uint8Array, signal?: AbortSignal) {
  if (!positive(part, 100) || !bytes.length || bytes.length > 5 * 1024 * 1024) throw Error('视频分片无效');
  return receipt(pending, request.put(`/file/video_uploads/${id(pending.upload_id)}/parts/${part}`, bytes.slice().buffer, { signal, timeout: 120000, headers: { 'Content-Type': 'application/octet-stream' } }));
}
export const apiVideoComplete = (pending: PendingVideoUpload, signal?: AbortSignal) => receipt(pending, request.post(`/file/video_uploads/${id(pending.upload_id)}/complete`, undefined, { signal, timeout: 120000 }));
export const apiVideoCancel = (pending: PendingVideoUpload, signal?: AbortSignal) => receipt(pending, request.post(`/file/video_uploads/${id(pending.upload_id)}/cancel`, undefined, { signal }));
export async function apiVideoPreview(pending: PendingVideoUpload, expectedUrl: string, signal?: AbortSignal): Promise<string> {
  const value = await getData<{ url: string; src: string }>(request.get(`/file/video_uploads/${id(pending.upload_id)}/preview`, { signal }));
  if (value.url !== expectedUrl || typeof value.src !== 'string' || !value.src.startsWith(expectedUrl + '?') || !value.src.includes('signature=')) throw Error('视频预览身份无效');
  return value.src;
}
