import type { LegacyExportCell, LegacyExportManifest } from "@/types";

function safeCell(value: LegacyExportCell | undefined): string {
  const normalized = String(value ?? "").replace(/\0/g, "");
  return /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

function csvCell(value: LegacyExportCell | undefined): string {
  return `"${safeCell(value).replace(/"/g, '""')}"`;
}

function safeFilename(value: string): string {
  const normalized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return normalized || "supplier-export";
}

export function downloadLegacyExport(manifest: LegacyExportManifest): void {
  // A typed HTTP response is still untrusted at runtime. Validate the complete
  // bounded manifest before creating a file or triggering a browser download.
  if (!manifest || manifest.bounded !== true || !Array.isArray(manifest.header) || !Array.isArray(manifest.filekey)
    || manifest.header.length < 1 || manifest.header.length > 64 || manifest.header.length !== manifest.filekey.length
    || manifest.header.some(value => typeof value !== 'string' || value.length > 256)
    || manifest.filekey.some(value => typeof value !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(value)
      || ['__proto__', 'constructor', 'prototype'].includes(value))
    || new Set(manifest.filekey).size !== manifest.filekey.length
    || !Array.isArray(manifest.export) || manifest.export.length > 1000
    || typeof manifest.filename !== 'string' || manifest.filename.length > 256) {
    throw new Error("导出字段定义不完整");
  }
  if (manifest.has_more === true) throw new Error('导出结果尚有后续页，请缩小选择范围后重新导出，未下载不完整文件');
  if (manifest.has_more !== undefined && manifest.has_more !== false) throw new Error('导出分页信息无效');
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const row of manifest.export) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('导出行数据无效');
    for (const key of manifest.filekey) {
      const value = Object.hasOwn(row, key) ? row[key] : undefined;
      if (value !== undefined && !(typeof value === 'string' && value.length <= 16001)
        && !(typeof value === 'number' && Number.isFinite(value))) throw new Error('导出单元格无效');
      bytes += encoder.encode(String(value ?? '')).length;
      if (bytes > 4 * 1024 * 1024) throw new Error('导出内容过大，请缩小选择范围');
    }
  }
  const lines = [
    manifest.header.map(csvCell).join(","),
    ...manifest.export.map((row) => manifest.filekey.map((key) => csvCell(Object.hasOwn(row, key) ? row[key] : undefined)).join(",")),
  ];
  const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  if (blob.size > 4 * 1024 * 1024) throw new Error('导出文件过大，请缩小选择范围');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFilename(manifest.filename)}.csv`;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
