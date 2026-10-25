const base = require('./diy-list-runtime.cjs');
const editorFile = base.path.join(base.root, 'components/content/DiyStateEditor.vue');
const previewFile = base.path.join(base.root, 'components/content/DiyStatePreview.vue');
const utilFile = base.path.join(base.root, 'utils/diyStateEditor.ts');
const projectionFile = base.path.join(base.root, 'utils/diyStateProjection.ts');
const apiFile = base.path.join(base.root, 'api/diyStateAuthor.ts');
const defaults = JSON.parse(base.fs.readFileSync(base.path.resolve(base.root, '../../../workers-ts/test/fixtures/diy-state-author-defaults.json'), 'utf8'));
const kinds = ['userInfor', 'newVip', 'signIn', 'ranking'];
const labels = { userInfor: '会员信息', newVip: '新人专区', signIn: '签到', ranking: '排行榜' };
function block(kind = 'userInfor', timestamp = 10) { return { ...base.clone(defaults[kind]), timestamp, authorExtra: { empty: [], zero: 0, keep: kind } }; }
function harness(value = [block()], options = {}) {
  const l = base.loader(options), props = base.vue.reactive({ modelValue: JSON.stringify(value), editorKey: 'state:2', disabled: false, pageId: 2, pagePublished: true, ...options.props }), writes = [];
  const m = base.mount(l, editorFile, props, (_event, value) => { writes.push(value); props.modelValue = value; });
  return { ...l, ...m, props, writes, value: () => JSON.parse(props.modelValue), preview: () => l.instances.get(previewFile)?.at(-1) };
}
function controlNode(r, label) {
  const field = base.all(r.tree, node => node.props['data-element'] === 'el-form-item' && node.props['data-label'] === label)[0]; base.assert.ok(field, label);
  const input = base.all(field, node => ['el-select', 'el-input', 'el-input-number', 'el-color-picker'].includes(node.props['data-element']) && typeof node.props['onUpdate:modelValue'] === 'function')[0]; base.assert.ok(input, label); return input;
}
async function update(r, label, value) { controlNode(r, label).props['onUpdate:modelValue'](value); await base.tick(); }
const product = (id = 17) => ({ id, product_id: id, store_name: '当前公开商品' + id, image: '/static/product.png', price: '0.00', ot_price: '12.00' });
const newcomer = () => ({ newcomer_integral: 0, newcomer_products: [product(71)], newcomer_coupon: [
  { id: 81, coupon_title: '零元金额券', coupon_type: 1, applicable_type: 0, coupon_price: '0.00', use_min_price: '0.00', status: 1 },
  { id: 82, coupon_title: '九折商品券', coupon_type: 2, applicable_type: 2, coupon_price: '90.00', use_min_price: '10.00', status: 1 },
] });
const sign = () => ({ signList: [Array.from({ length: 7 }, (_, index) => ({ day: `10/${19 + index}`, is_sign: false, sign_day: index === 5, type: 2, point: 0 }))],
  nextContinuousSignRewardList: [{ id: 1, days: 7, point: 0, exp: 3 }], checkSign: false, signStatus: 1, sign_give_point: 0 });
const ranks = () => ({ sales: [product(301), product(302)], star: [product(302)], collect: [] });
const payload = kind => kind === 'newVip' ? newcomer() : kind === 'signIn' ? sign() : kind === 'ranking' ? ranks() : [];
const response = data => ({ ok: true, json: async () => ({ status: 200, data }) });
function galleryItem(id = 7) { return { att_id: id, canonical_url: '/api/assets/' + id, att_dir: base.ticket(id), satt_dir: base.ticket(id), real_name: `状态作者图片${id}.png` }; }
module.exports = { ...base, editorFile, previewFile, utilFile, projectionFile, apiFile, defaults, kinds, labels, block, harness, controlNode, update, product, newcomer, sign, ranks, payload, response, galleryItem };
