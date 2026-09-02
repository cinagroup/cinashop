import type { LegacyExportCell, LegacyExportManifest } from "@/types";

function safeCell(value: LegacyExportCell | undefined): string {
  const normalized = String(value ?? "").replace(/\0/g, "");
  return /^[\t\r\n ]*[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
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
  if (manifest.header.length !== manifest.filekey.length) {
    throw new Error("导出字段定义不完整");
  }
  const lines = [
    manifest.header.map(csvCell).join(","),
    ...manifest.export.map((row) => manifest.filekey.map((key) => csvCell(row[key])).join(",")),
  ];
  const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
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
