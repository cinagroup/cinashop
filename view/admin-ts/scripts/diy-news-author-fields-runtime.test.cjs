const base = require('./helpers/diy-navigation-runtime.cjs');
const { test, assert, vue, path, root, loader, renderer, node, all, text, elementNames, elementStub, tick } = base;
const utilFile = path.join(root, 'utils/diyNewsAuthorFields.ts');
const componentFile = path.join(root, 'components/content/DiyNewsAuthorFields.vue');
// Independent literal: PHP8ed2a5b home_news_roll.defaultConfig (this.num->0; exact news2.png require->static path).
// This fixture is not imported from the new author's defaults or its projection.
const phpNews = {
  "cname": "新闻公告",
  "name": "news",
  "timestamp": 0,
  "isHide": false,
  "setUp": {
    "tabVal": 0
  },
  "titleLeft": "展示设置",
  "titleStyle": "公告风格",
  "titleButton": "按钮设置",
  "titleContent": "公告内容",
  "titleRight": "标题样式",
  "titleCurrency": "通用样式",
  "styleConfig": {
    "title": "选择风格",
    "tabVal": 0,
    "tabList": [
      {
        "name": "样式一"
      },
      {
        "name": "样式二"
      }
    ]
  },
  "titleConfig": {
    "title": "标题类型",
    "tabVal": 0,
    "tabList": [
      {
        "name": "图片"
      },
      {
        "name": "文字"
      }
    ]
  },
  "imgConfig": {
    "url": "/static/images/diy/news2.png",
    "type": "code",
    "delType": 0,
    "name": "上传图片",
    "info": "建议尺寸：28px*28px"
  },
  "titleTxtConfig": {
    "title": "标题文字",
    "value": "商城头条",
    "place": "请输入标题文字",
    "max": 4
  },
  "rollConfig": {
    "title": "滚动方式",
    "tabVal": 0,
    "tabList": [
      {
        "name": "上下滚动"
      },
      {
        "name": "左右滚动"
      }
    ]
  },
  "buttonConfig": {
    "title": "右侧按钮",
    "tabVal": 0,
    "tabList": [
      {
        "name": "显示"
      },
      {
        "name": "隐藏"
      }
    ]
  },
  "textConfig": {
    "title": "右侧文字",
    "value": "更多",
    "place": "请输入右侧文字",
    "max": 4
  },
  "linkConfig": {
    "title": "跳转链接",
    "value": "",
    "place": "选择跳转链接",
    "max": 100,
    "type": "link"
  },
  "listConfig": {
    "max": 10,
    "type": 1,
    "list": [
      {
        "chiild": [
          {
            "title": "标题",
            "val": "标题",
            "max": 20,
            "pla": "输入标题"
          },
          {
            "title": "链接",
            "val": "",
            "max": 200,
            "pla": "输入连接"
          }
        ],
        "show": true
      }
    ]
  },
  "toneConfig": {
    "title": "色调",
    "tabVal": 0,
    "tabList": [
      {
        "name": "跟随主题风格"
      },
      {
        "name": "自定义"
      }
    ]
  },
  "titleBgColor": {
    "title": "标题背景",
    "default": [
      {
        "item": "#FCEAE9"
      },
      {
        "item": "#FCEAE9"
      }
    ],
    "color": [
      {
        "item": "#FCEAE9"
      },
      {
        "item": "#FCEAE9"
      }
    ]
  },
  "titleColor": {
    "title": "标题文字",
    "default": [
      {
        "item": "#E93323"
      }
    ],
    "color": [
      {
        "item": "#E93323"
      }
    ]
  },
  "newsColor": {
    "title": "新闻标题",
    "default": [
      {
        "item": "#333333"
      }
    ],
    "color": [
      {
        "item": "#333333"
      }
    ]
  },
  "bntColor": {
    "title": "按钮颜色",
    "default": [
      {
        "item": "#999999"
      }
    ],
    "color": [
      {
        "item": "#999999"
      }
    ]
  },
  "moduleColor": {
    "title": "组件背景",
    "default": [
      {
        "item": "#fff"
      },
      {
        "item": "#fff"
      }
    ],
    "color": [
      {
        "item": "#fff"
      },
      {
        "item": "#fff"
      }
    ]
  },
  "bottomBgColor": {
    "title": "底部背景",
    "default": [
      {
        "item": "#f5f5f5"
      }
    ],
    "color": [
      {
        "item": "#f5f5f5"
      }
    ]
  },
  "topConfig": {
    "title": "上边距",
    "val": 0,
    "min": 0
  },
  "bottomConfig": {
    "title": "下边距",
    "val": 0,
    "min": 0
  },
  "prConfig": {
    "title": "左右边距",
    "val": 0,
    "min": 0
  },
  "mbConfig": {
    "title": "页面上间距",
    "val": 0,
    "min": 0
  },
  "fillet": {
    "title": "背景圆角",
    "type": 0,
    "list": [
      {
        "val": "全部",
        "icon": "iconcaozuo-zhengti"
      },
      {
        "val": "单个",
        "icon": "iconcaozuo-bianjiao"
      }
    ],
    "valName": "圆角值",
    "val": 0,
    "min": 0,
    "valList": [
      {
        "val": 0
      },
      {
        "val": 0
      },
      {
        "val": 0
      },
      {
        "val": 0
      }
    ]
  }
};
const clone = value => JSON.parse(JSON.stringify(value));
const block = () => clone(phpNews);
const util = () => loader().load(utilFile);
function apply(block, patch) {
  const output = clone(block); let owner = output;
  for (let i = 0; i < patch.path.length - 1; i++) {
    const key = patch.path[i], next = patch.path[i + 1];
    if (owner[key] === undefined) owner[key] = typeof next === 'number' ? [] : {};
    owner = owner[key];
  }
  owner[patch.path.at(-1)] = clone(patch.value); return output;
}
function importedRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    chiild: [{ title: '标题', val: `导入公告${index+1}`, max: 20, pla: '输入标题', dormant: { keep: index } },
      { title: '链接', val: `/pages/article/detail?id=${index+1}`, max: 200, pla: '输入连接' },
      { untouched: ['', null, false, index] }], show: index === count - 1 ? ' true ' : false,
    unknown: { index, list: [], zero: 0 },
  }));
}
function mount(value = block(), options = {}) {
  const l = loader(), props = vue.reactive({ block: value, disabled: false, ...options.props });
  const tree = node('root'), events = [], component = l.load(componentFile).default;
  const app = renderer.createApp({ setup: () => () => vue.h(component, {
    ...props,
    onChange: (path, value) => events.push({ event: 'change', path: clone(path), value: clone(value) }),
    onPickImage: () => events.push({ event: 'pick-image' }),
    onPickLink: path => events.push({ event: 'pick-link', path: clone(path) }),
  }, options.slots) });
  for (const name of elementNames) app.component(name, elementStub(name));
  app.mount(tree);
  return { ...l, tree, props, events, accept(patch = events.at(-1)) { props.block = apply(props.block, patch); }, unmount: () => app.unmount() };
}
function field(r, label) {
  const found = all(r.tree, n => n.props['data-element'] === 'el-form-item' && n.props['data-label'] === label)[0];
  assert.ok(found, label); return found;
}
function control(r, label) {
  const found = all(field(r, label), n => ['el-select', 'el-input', 'el-switch'].includes(n.props['data-element']))[0];
  assert.ok(found, label); return found;
}
function button(r, label, within = r.tree) {
  const found = all(within, n => n.tag === 'button' && text(n) === label)[0]; assert.ok(found, label); return found;
}

// Source-specific projections, edit limits and preservation controls are independent of the SFC template.
test('complete32-key PHP fixture projects the original news controls without merging or changing metadata', () => {
  const u = util(), b = block(), before = clone(b), p = u.projectNewsAuthorFields(b);
  assert.equal(Object.keys(b).length, 32); assert.equal(b.imgConfig.url, '/static/images/diy/news2.png');
  assert.deepEqual({ style: p.style, title: p.titleType, roll: p.roll, button: p.button, tone: p.tone }, { style: 0, title: 0, roll: 0, button: 0, tone: 0 });
  assert.equal(p.titleText, '商城头条'); assert.equal(p.moreText, '更多');
  assert.deepEqual(p.rows, [{ index: 0, record: true, shown: true, title: '标题', link: '', titleEditable: true, linkEditable: true }]);
  assert.equal(p.showRoll, true); assert.equal(p.showTone, false); assert.equal(p.showMoreLink, false); assert.equal(p.showMoreText, false);
  assert.equal(p.imageEditable, true); assert.equal(p.canAdd, true); assert.deepEqual(b, before);
});
test('PHP right-panel visibility covers both layouts/title kinds/buttons/tones while dormant configuration survives', () => {
  const u = util();
  for (const style of [0, 1]) for (const title of [0, 1]) for (const button of [0, 1]) for (const tone of [0, 1]) {
    const b = block(); b.styleConfig.tabVal = style; b.titleConfig.tabVal = title; b.buttonConfig.tabVal = button; b.toneConfig.tabVal = tone;
    const before = clone(b), p = u.projectNewsAuthorFields(b);
    assert.equal(p.showRoll, style === 0); assert.equal(p.showTone, style === 0 && title === 1);
    assert.equal(p.showMoreLink, style === 1 && button === 0); assert.equal(p.showMoreText, style === 1 && button === 0);
    assert.equal(p.showTitleBackground, style === 0 && title === 1 && tone === 1);
    assert.equal(p.showTitleColor, title === 1 && (style === 1 || tone === 1)); assert.equal(p.showButtonColor, button === 0);
    assert.deepEqual(b, before);
  }
});
test('numeric-style imports project like client Number ordinals and same-effective selections never rewrite them', () => {
  const u = util(), cases = [[0, 0], [1, 1], ['01', 1], [' 1 ', 1], ['1e0', 1], [true, 1], [false, 0], [null, 0], [[], 0], [{}, null], [undefined, null], [-1, null], [2, null], ['bad', null]];
  for (const [raw, expected] of cases) for (const key of ['styleConfig', 'titleConfig', 'rollConfig', 'buttonConfig', 'toneConfig']) {
    const b = block(); b.titleConfig.tabVal = 1; b[key].tabVal = raw;
    const fallback = key === 'titleConfig' ? 1 : 0, effective = expected ?? fallback, before = u.cloneNewsAuthorValue(b);
    assert.equal(u.newsAuthorOrdinal(raw, fallback), effective);
    assert.equal(u.newsAuthorPatch(b, [key, 'tabVal'], effective), null);
    assert.deepEqual(b, before);
  }
  assert.equal(u.newsAuthorOrdinal(Symbol('invalid'), 1), 1);
});
test('authored limits reject only new oversized edits and retain identical imported long strings', () => {
  const u = util(), b = block(); b.styleConfig.tabVal = 1; b.titleConfig.tabVal = 1;
  for (const [key, max] of [['titleTxtConfig', 4], ['textConfig', 4], ['linkConfig', 100]]) {
    b[key].value = '导'.repeat(max + 2); const before = clone(b);
    assert.equal(u.newsAuthorPatch(b, [key, 'value'], b[key].value), null);
    assert.throws(() => u.newsAuthorPatch(b, [key, 'value'], '新'.repeat(max + 1)), /不能超过/u);
    const patch = u.newsAuthorPatch(b, [key, 'value'], '新'.repeat(max));
    assert.deepEqual(patch, { path: [key, 'value'], value: '新'.repeat(max) }); assert.deepEqual(b, before);
  }
  const titlePath = u.newsAuthorRowTitlePath(0), linkPath = u.newsAuthorRowLinkPath(0);
  assert.throws(() => u.newsAuthorPatch(b, titlePath, '题'.repeat(21)), /20/u);
  assert.throws(() => u.newsAuthorPatch(b, linkPath, '/'.repeat(201)), /200/u);
  assert.deepEqual(u.newsAuthorPatch(b, titlePath, '新的公告'), { path: titlePath, value: '新的公告' });
});
test('a leaf intent changes exactly that leaf after a parent applies it, preserving32 defaults and imported extras', () => {
  const u = util(), b = block(); b.listConfig.list = importedRows(12); b.titleConfig.tabVal = 1; b.titleTxtConfig.value = '超过原版四字限制的已导入标题'; b.extra = { empty: [], zero: 0, null: null };
  const before = clone(b), p = u.projectNewsAuthorFields(b); assert.equal(p.rows.length, 12); assert.equal(p.rows.at(-1).shown, true);
  const patch = u.newsAuthorPatch(b, u.newsAuthorRowTitlePath(11), '最后公告');
  const expected = clone(b); expected.listConfig.list[11].chiild[0].val = '最后公告';
  assert.deepEqual(apply(b, patch), expected); assert.deepEqual(b, before);
  assert.equal(p.canAdd, false); assert.equal(p.titleText, before.titleTxtConfig.value);
});
test('show imports and hidden-mode controls remain unchanged on no-op or dormant edits', () => {
  const u = util(), b = block(); b.listConfig.list[0].show = ' true ';
  assert.equal(u.newsAuthorPatch(b, ['listConfig', 'list', 0, 'show'], true), null);
  assert.deepEqual(u.newsAuthorPatch(b, ['listConfig', 'list', 0, 'show'], false), { path: ['listConfig', 'list', 0, 'show'], value: false });
  assert.equal(u.newsAuthorPatch(b, ['titleTxtConfig', 'value'], '休眠字段'), null);
  assert.equal(u.newsAuthorPatch(b, ['textConfig', 'value'], '休眠'), null);
  b.styleConfig.tabVal = 1;
  assert.equal(u.newsAuthorPatch(b, ['rollConfig', 'tabVal'], 1), null); assert.equal(u.newsAuthorPatch(b, ['toneConfig', 'tabVal'], 1), null);
});
test('add clones the complete last row and PHP empty flag clears only its first two values', () => {
  const u = util(), b = block(); b.listConfig.list = importedRows(1); const before = clone(b);
  let patch = u.newsAuthorRowsPatch(vue.reactive(b), 'add'); assert.equal(patch.value.length, 2); assert.deepEqual(patch.value[1], before.listConfig.list[0]);
  patch.value[1].chiild[0].dormant.keep = 99; assert.deepEqual(b, before);
  b.listConfig.list[0].chiild[0].empty = true; const row = u.newNewsAuthorRow(b.listConfig.list[0]);
  const expected = clone(b.listConfig.list[0]); expected.chiild[0].val = ''; expected.chiild[1].val = ''; assert.deepEqual(row, expected);
});
test('empty recovery has complete original row metadata and imported max cannot bypass10 new rows', () => {
  const u = util(), b = block(); b.listConfig.list = [];
  const patch = u.newsAuthorRowsPatch(b, 'add'), expected = clone(phpNews.listConfig.list[0]); expected.chiild[0].val = '';
  assert.deepEqual(patch.value, [expected]); assert.equal(b.listConfig.list.length, 0);
  b.listConfig.max = 999; b.listConfig.list = importedRows(10); const before = clone(b);
  assert.throws(() => u.newsAuthorRowsPatch(b, 'add'), /最多10/u); assert.deepEqual(b, before);
});
test('reorder/delete preserve all over-cap rows, primitives, unknown children and sibling metadata', () => {
  const u = util(), b = block(); b.listConfig.list = importedRows(12); b.listConfig.list[2] = 0; b.listConfig.tabCur = '11';
  const before = clone(b), moved = u.newsAuthorRowsPatch(b, 'move', 11, -1), expected = clone(before.listConfig.list);
  [expected[10], expected[11]] = [expected[11], expected[10]]; assert.deepEqual(moved.value, expected);
  const removed = u.newsAuthorRowsPatch(b, 'remove', 2); assert.deepEqual(removed.value, before.listConfig.list.filter((_, i) => i !== 2));
  assert.deepEqual(b, before); assert.equal(b.listConfig.tabCur, '11');
  assert.throws(() => u.newsAuthorRowsPatch(b, 'move', 0, -1), /边界/u); assert.throws(() => u.newsAuthorRowsPatch(b, 'remove', 12), /索引/u);
});
test('malformed ancestors and unauthorized metadata paths fail without implicit repair or mutation', () => {
  const u = util();
  for (const bad of [null, 0, false, [], 'broken']) {
    const b = block(); b.listConfig = bad; const before = clone(b); assert.equal(u.projectNewsAuthorFields(b).listEditable, false);
    assert.throws(() => u.newsAuthorRowsPatch(b, 'add'), /结构异常/u); assert.deepEqual(b, before);
  }
  const b = block(); b.listConfig.list = [{ chiild: [null, { val: '/pages/article/list' }], show: true }, null, 0];
  const before = clone(b); assert.equal(u.projectNewsAuthorFields(b).rows[0].titleEditable, false);
  assert.throws(() => u.newsAuthorPatch(b, u.newsAuthorRowTitlePath(0), '修复'), /结构异常/u);
  assert.throws(() => u.newsAuthorPatch(b, ['listConfig', 'max'], 999), /路径/u);
  assert.throws(() => u.newsAuthorPatch(b, ['__proto__', 'polluted'], true), /路径/u);
  assert.equal(u.newsAuthorCanPickLink(b, ['listConfig', 'list', 1, 'chiild', 1, 'val']), false);
  assert.deepEqual(b, before); assert.equal({}.polluted, undefined);
  assert.throws(() => u.newsAuthorPatch({ name: 'hotspot' }, ['styleConfig', 'tabVal'], 1), /未选择/u);
});
test('full-row cloning preserves reserved unknown keys as own data without prototype pollution', () => {
  const u = util(), b = block(); b.listConfig.list[0].unknown = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"keep":1}}');
  const before = clone(b), patch = u.newsAuthorRowsPatch(b, 'add');
  assert.deepEqual(patch.value[1], before.listConfig.list[0]); assert.equal(Object.hasOwn(patch.value[1].unknown, '__proto__'), true); assert.equal({}.polluted, undefined); assert.deepEqual(b, before);
});

// Actual installed Vue/compiler SFC handlers run below. Element adapters do not simulate native/browser behavior.
test('actual news SFC mount emits no changes, performs no I/O and renders the original image reference as text only', async () => {
  const original = block(), r = mount(original); try {
    await tick(); assert.deepEqual(r.events, []); assert.deepEqual(r.props.block, original);
    assert.equal(all(r.tree, n => n.tag === 'img' || n.tag === 'image').length, 0); assert.match(text(r.tree), /news2\.png/u);
    assert.equal(control(r, '新闻风格').props.modelValue, 0); assert.equal(control(r, '第1条标题').props.modelValue, '标题');
    assert.deepEqual(r.calls, []); assert.deepEqual(r.galleryCalls, []); assert.deepEqual(r.categoryCalls, []);
  } finally { r.unmount(); }
});
test('actual SFC emits only a leaf intent; its props stay unchanged until the parent accepts it', async () => {
  const b = block(), r = mount(b); try {
    control(r, '新闻风格').props['onUpdate:modelValue'](1); await tick();
    assert.deepEqual(r.events, [{ event: 'change', path: ['styleConfig', 'tabVal'], value: 1 }]); assert.equal(r.props.block.styleConfig.tabVal, 0);
    r.accept(); await tick(); assert.equal(control(r, '列表更多文字').props.modelValue, '更多');
    control(r, '列表更多文字').props['onUpdate:modelValue']('查看'); await tick();
    assert.deepEqual(r.events.at(-1), { event: 'change', path: ['textConfig', 'value'], value: '查看' });
    assert.deepEqual(b, phpNews);
  } finally { r.unmount(); }
});
test('actual SFC numeric and overlong imported controls do not emit on mount or same-effective updates', async () => {
  const b = block(); b.styleConfig.tabVal = '1e0'; b.titleConfig.tabVal = '01'; b.buttonConfig.tabVal = false; b.titleTxtConfig.value = '超过四字的原样导入标题'; b.textConfig.value = '超过四字更多文字'; b.listConfig.list = importedRows(12);
  const before = clone(b), r = mount(b); try {
    await tick(); assert.deepEqual(r.events, []); assert.equal(control(r, '标题文字').props.modelValue, b.titleTxtConfig.value);
    for (const [label, value] of [['新闻风格', 1], ['标题类型', 1], ['右侧按钮', 0], ['标题文字', b.titleTxtConfig.value], ['列表更多文字', b.textConfig.value]]) control(r, label).props['onUpdate:modelValue'](value);
    await tick(); assert.deepEqual(r.events, []); assert.deepEqual(r.props.block, before);
    assert.equal(all(r.tree, n => n.tag === 'article').length, 12); assert.equal(button(r, '添加公告').props.disabled, true);
  } finally { r.unmount(); }
});
test('actual fallback pickers emit exact unfiltered source paths and never a change or image fetch', async () => {
  const b = block(); b.listConfig.list = importedRows(12); const r = mount(b); try {
    button(r, '选择图片').props.onClick(); button(r, '选择链接', field(r, '第12条链接')).props.onClick(); await tick();
    assert.deepEqual(r.events, [{ event: 'pick-image' }, { event: 'pick-link', path: ['listConfig', 'list', 11, 'chiild', 1, 'val'] }]);
    assert.deepEqual(r.props.block, b); assert.deepEqual(r.calls, []);
    r.props.block = { ...clone(b), styleConfig: { tabVal: 1 } }; await tick();
    button(r, '选择链接', field(r, '更多跳转链接')).props.onClick(); assert.deepEqual(r.events.at(-1), { event: 'pick-link', path: ['linkConfig', 'value'] });
  } finally { r.unmount(); }
});
test('named image/link slots receive precise paths and disabled state for parent-owned selectors', async () => {
  const b = block(); b.styleConfig.tabVal = 1; b.listConfig.list = importedRows(2);
  const r = mount(b, { props: { disabled: true }, slots: {
    image: scope => vue.h('button', { 'data-image-slot': true, slotPath: scope.path, disabled: scope.disabled }, '父级图库'),
    link: scope => vue.h('button', { 'data-link-slot': true, slotPath: scope.path, disabled: scope.disabled }, '父级链接'),
  } });
  try {
    await tick(); const images = all(r.tree, n => n.props['data-image-slot']), links = all(r.tree, n => n.props['data-link-slot']);
    assert.equal(images.length, 1); assert.deepEqual(images[0].props.slotPath, ['imgConfig', 'url']); assert.equal(images[0].props.disabled, true);
    assert.deepEqual(links.map(n => n.props.slotPath), [['linkConfig', 'value'], ['listConfig', 'list', 0, 'chiild', 1, 'val'], ['listConfig', 'list', 1, 'chiild', 1, 'val']]);
    assert.ok(links.every(n => n.props.disabled)); assert.deepEqual(r.events, []);
  } finally { r.unmount(); }
});
test('actual disabled SFC handlers reject explicit changes and fallback picker/action calls', async () => {
  const b = block(), r = mount(b, { props: { disabled: true } }); try {
    control(r, '新闻风格').props['onUpdate:modelValue'](1); control(r, '第1条标题').props['onUpdate:modelValue']('被禁修改');
    button(r, '选择图片').props.onClick(); button(r, '选择链接', field(r, '第1条链接')).props.onClick(); button(r, '添加公告').props.onClick();
    const remove = all(r.tree, n => n.tag === 'button' && n.props['aria-label'] === '删除第1条')[0]; remove.props.onClick();
    await tick(); assert.deepEqual(r.events, []); assert.deepEqual(r.props.block, b);
  } finally { r.unmount(); }
});
test('actual SFC row edits and order intents preserve complete imported overflow/metadata without mutating props', async () => {
  const b = block(); b.listConfig.list = importedRows(12); const before = clone(b), r = mount(b); try {
    control(r, '第12条标题').props['onUpdate:modelValue']('最后公告'); await tick();
    assert.deepEqual(r.events.at(-1), { event: 'change', path: ['listConfig', 'list', 11, 'chiild', 0, 'val'], value: '最后公告' });
    const move = all(r.tree, n => n.tag === 'button' && n.props['aria-label'] === '第12条上移')[0]; move.props.onClick(); await tick();
    const expected = clone(before.listConfig.list); [expected[10], expected[11]] = [expected[11], expected[10]];
    assert.deepEqual(r.events.at(-1), { event: 'change', path: ['listConfig', 'list'], value: expected }); assert.deepEqual(r.props.block, before);
  } finally { r.unmount(); }
});
test('stale fallback image handlers cannot open after the title mode or block kind changed', async () => {
  const r = mount(); try {
    const old = button(r, '选择图片').props.onClick; r.props.block = { ...block(), titleConfig: { tabVal: 1 } }; await tick(); old();
    r.props.block = { name: 'hotspot', picStyle: { url: '/static/x.png' } }; await tick(); old();
    assert.deepEqual(r.events, []); assert.match(text(r.tree), /未选择新闻公告/u);
  } finally { r.unmount(); }
});
