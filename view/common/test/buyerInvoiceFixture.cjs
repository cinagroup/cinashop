const revision = 'a'.repeat(64);
const title = (changes = {}) => ({ id: 71, uid: 11, revision, headerType: 1, type: 1, name: '本机买家', dutyNumber: '', drawerPhone: '13800000000',
  email: 'buyer@example.invalid', tell: '', address: '', bank: '', cardNumber: '', isDefault: false, addTime: '2026-11-14 10:00:00', ...changes });
const record = (changes = {}) => { const { revision: _, isDefault: __, ...fields } = title(); return { ...fields, id: 81, orderId: 91, orderNo: 'invoice_order_A', titleId: 71,
  state: 0, paid: true, refunded: false, amount: '10.00', invoiceNumber: '', remark: '', invoiceTime: '', product: { name: '本机发票商品', image: '' }, ...changes }; };
const page = (query = { kind: 'titles', cursor: null, limit: 20 }, changes = {}) => ({ version: 1, uid: 11, query: { ...query }, capabilities: { enabled: true, special: true },
  items: query.kind === 'titles' ? [title()] : [record()], nextCursor: null, ...changes });
const order = (changes = {}) => ({ version: 1, uid: 11, orderId: 91, orderNo: 'invoice_order_A', revision, paid: true, status: 0, pid: 0,
  capabilities: { enabled: true, special: true }, invoice: null, amount: '10.00', canApply: true, reason: '', ...changes });
module.exports = { revision, title, record, page, order };
