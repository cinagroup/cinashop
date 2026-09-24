import { parseOrderSystemFormTemplate, prepareOrderSystemFormSubmission } from './order-system-form';

export interface AssistedFormAnswer { id?: string | number; name: string; value: string | string[] }
const names = new Set(['texts','radios','checkboxs','selects','citys','dates','dateranges','times','timeranges','uploadPicture']);
export function assistedImageId(value: unknown): number {
  const match = typeof value === 'string' && /^\/api\/assets\/([1-9]\d*)$/.exec(value);
  const id = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw Error('请使用当前代客结算上传的图片');
  return id;
}

/** Minimal, bounded original values only. Never persist templates, preview
 * signatures, tokens in metadata, or client-provided attachment ownership. */
export function decodeAssistedFormAnswers(value: unknown): AssistedFormAnswer[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw Error('代客表单答案无效');
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1_000_000) throw Error('代客表单答案过大');
  const keys = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('代客表单答案无效');
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(key => !['id','name','value'].includes(key)) || typeof row.name !== 'string' || !names.has(row.name)) throw Error('代客表单答案字段无效');
    if (row.id !== undefined && !(typeof row.id === 'string' && row.id.length <= 10000) && !(typeof row.id === 'number' && Number.isSafeInteger(row.id))) throw Error('代客表单项目标识无效');
    const key = row.id === undefined ? `index:${index}` : `id:${row.id}`;
    if (keys.has(key)) throw Error('代客表单项目重复'); keys.add(key);
    const text = (part: unknown) => { if (typeof part !== 'string' || part.length > 10000) throw Error('代客表单答案文字无效'); return part; };
    const answer = Array.isArray(row.value) ? row.value.map(text) : text(row.value);
    if (Array.isArray(answer) && answer.length > 100) throw Error('代客表单答案过多');
    if (row.name === 'uploadPicture') {
      if (!Array.isArray(answer) || answer.length > 9) throw Error('代客表单图片无效');
      answer.forEach(assistedImageId);
    }
    return { ...(row.id === undefined ? {} : { id: row.id as string | number }), name: row.name, value: answer };
  });
}

export function prepareAssistedFormAnswers(template: unknown, submission: unknown, formId: number): AssistedFormAnswer[] {
  const prepared = prepareOrderSystemFormSubmission(parseOrderSystemFormTemplate(template), submission, formId);
  return decodeAssistedFormAnswers((JSON.parse(prepared.snapshotJson) as Record<string, unknown>[])
    .map(row => ({ ...(row.id === undefined ? {} : { id: row.id }), name: row.name, value: row.value })));
}
