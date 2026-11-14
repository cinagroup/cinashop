import type { BuyerInvoiceDraft, BuyerInvoiceFields } from './buyerInvoices';
type Key = 'name' | 'dutyNumber' | 'drawerPhone' | 'email' | 'tell' | 'address' | 'bank' | 'cardNumber';
const fields: Array<{ key: Key; label: string; max: number }> = [
  { key: 'name', label: '发票抬头', max: 100 }, { key: 'dutyNumber', label: '企业税号', max: 50 },
  { key: 'drawerPhone', label: '开票手机号', max: 30 }, { key: 'email', label: '联系邮箱', max: 100 },
  { key: 'address', label: '注册地址', max: 255 }, { key: 'tell', label: '注册电话', max: 30 },
  { key: 'bank', label: '开户银行', max: 50 }, { key: 'cardNumber', label: '银行账号', max: 50 },
];
export const buyerInvoiceFormFields = (draft: BuyerInvoiceDraft) => fields.filter(f => draft.headerType === 2 || ['name', 'drawerPhone', 'email'].includes(f.key))
  .map(f => ({ ...f, required: ['name', 'dutyNumber', 'drawerPhone', 'email'].includes(f.key) || draft.type === 2 }));
export const buyerInvoiceSnapshotFields = (r: BuyerInvoiceFields) => fields.filter(f => ['name', 'drawerPhone', 'email'].includes(f.key) || !!r[f.key]).map(f => ({ label: f.label, value: r[f.key] || '未记录' }));
