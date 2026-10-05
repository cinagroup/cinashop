export function combinationCsvCell(value: string | number, alreadyProtected = false) {
  let text = String(value);
  // Quoting alone does not stop spreadsheet formulas, including formulas after
  // leading whitespace. Keep decimal strings unchanged and protect text cells.
  if (!alreadyProtected && (/^[\s\u200b\ufeff]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text))) text = "'" + text;
  return '"' + text.replace(/"/gu, '""') + '"';
}

export function buildCombinationCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>, maxBytes = 16777216, alreadyProtected = false) {
  if (headers.length !== 11 || rows.some(row => row.length !== 11)) throw Error('拼团导出必须包含完整11列');
  const csv = '\ufeff' + [headers, ...rows].map(row => row.map(value => combinationCsvCell(value, alreadyProtected)).join(',')).join('\r\n') + '\r\n';
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16777216 || new TextEncoder().encode(csv).byteLength > maxBytes) throw Error('导出文件超限，请缩小筛选范围');
  return csv;
}

export function downloadCombinationCsv(csv: string, filename: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = filename.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '_').slice(0, 120).replace(/\.csv$/iu, '') + '.csv';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
  } finally { anchor.remove(); URL.revokeObjectURL(url); }
}
