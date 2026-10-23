import { customerServiceRecord } from '../../../common/diyCustomerService';
import { canonicalPresentationReference, presentationDocument, presentationPreviewForReference } from './diyPresentationEditor';

export { presentationDocument as customerServiceDocument, presentationPreviewForReference as customerServicePreview };
export function canonicalCustomerServiceBlock(value: Record<string, unknown>) {
  const copy = structuredClone(value), logo = customerServiceRecord(copy.logoConfig);
  if (copy.name === 'customerService' && logo && typeof logo.url === 'string') logo.url = canonicalPresentationReference(logo.url);
  return copy;
}
export function canonicalCustomerServiceValue(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (value === null) throw Error('装修 value 不能为 null');
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) {
    const row = customerServiceRecord(value[index]);
    if (row?.name === 'customerService') value[index] = canonicalCustomerServiceBlock(row);
  }
  return JSON.stringify(value);
}
