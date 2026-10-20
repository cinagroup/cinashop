import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { user } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

export const MAX_CUSTOMER_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_CUSTOMER_VIDEO_REQUEST_BYTES = MAX_CUSTOMER_VIDEO_BYTES + 256 * 1024;

/** Recheck after R2 I/O, and retain the user lock until metadata/post commit. */
export async function assertActiveMediaUser(tx: DbClient, uid: number): Promise<void> {
  await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
  const rows = await tx.select({ uid: user.uid }).from(user).where(and(
    eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime),
  )).limit(1).for("share");
  if (!rows.length) throw new ValidateException("用户状态已变化，请重新登录");
}

/** Bounded ISO-BMFF container validation, not a codec/transcoding service. */
export async function validateCustomerVideo(file: File): Promise<void> {
  if (!(file instanceof File) || file.size < 32) throw new ValidateException("请选择完整的MP4视频");
  if (file.size > MAX_CUSTOMER_VIDEO_BYTES) throw new ValidateException("视频不能超过50 MiB");
  if (file.type && !["video/mp4", "application/octet-stream"].includes(file.type.toLowerCase())) {
    throw new ValidateException("只支持MP4视频");
  }
  let offset = 0, count = 0, ftyp = false, moov = false, mdat = false;
  while (offset < file.size && ++count <= 4096) {
    const header = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
    if (header.length < 8) throw new ValidateException("视频文件不完整");
    const view = new DataView(header.buffer);
    const type = String.fromCharCode(...header.slice(4, 8));
    let size = view.getUint32(0), headerSize = 8;
    if (size === 1) {
      if (header.length < 16) throw new ValidateException("视频文件不完整");
      const extended = view.getBigUint64(8);
      if (extended > BigInt(file.size)) throw new ValidateException("视频文件不完整");
      size = Number(extended); headerSize = 16;
    } else if (size === 0) size = file.size - offset;
    if (size < headerSize || offset + size > file.size) throw new ValidateException("视频文件不完整");
    if (type === "ftyp") {
      if (ftyp || offset !== 0 || size < 16 || size > 1024) throw new ValidateException("MP4容器格式错误");
      const brands = new Uint8Array(await file.slice(offset + 8, offset + size).arrayBuffer());
      ftyp = Array.from({ length: Math.floor(brands.length / 4) }, (_, i) =>
        i === 1 ? "" : String.fromCharCode(...brands.slice(i * 4, i * 4 + 4)))
        .some(brand => /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(brand));
    }
    if (type === "moov" && size > headerSize) moov = true;
    if (type === "mdat" && size > headerSize) mdat = true;
    offset += size;
  }
  if (!ftyp || !moov || !mdat || offset !== file.size) throw new ValidateException("请选择完整的MP4视频");
}
