const base = require('./helpers/diy-navigation-runtime.cjs');
const { getEventListeners, setMaxListeners } = require('node:events');
const { test, assert, fs, path, root, ts, vue, sfc, dom, renderer, node, all, text, elementNames, elementStub, tick, deferred } = base;
const { renderToString } = require('@vue/server-renderer');
const { ElInputNumber, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } = require('element-plus');
const editorFile = path.join(root, 'components/content/DiyEditorialEditor.vue');
const canvasFile = path.join(root, 'components/content/DiyHotspotAuthorCanvas.vue');
const utilFile = path.join(root, 'utils/diyEditorialEditor.ts');
// Same installed Vue/SFC loader as the navigation suite. This parent's actual
// template contains valid TypeScript non-null assertions; transpile the actual
// compiler-dom output too, as Vite does, before evaluating its render function.
function loader(options = {}) {
  const cache = new Map(), instances = new Map(), notices = [], calls = [], galleryCalls = [], categoryCalls = [], uploadCalls = [];
  const actor = options.actor ?? vue.reactive({ token: 'A', userInfo: { id: 11, level: 0 }, uniqueAuth: [] });
  const storage = new Map([['admin_token', 'A'], ['admin_session', 'session-A']]);
  // A single imported document mounts >10 independent real link pickers.
  // Node's EventTarget warning limit is not a browser listener limit; every
  // parent harness below still asserts all session listeners leave on unmount.
  const window = new EventTarget(); setMaxListeners(100, window);
  const gateway = options.gateway ?? { get: async url => { calls.push({ method: 'GET', url }); return { data: [] }; }, post: async (url, body) => { calls.push({ method: 'POST', url, body: clone(body) }); return { data: { id: 2 } }; } };
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    let source = fs.readFileSync(file, 'utf8'), descriptor, script;
    if (file.endsWith('.vue')) { descriptor = sfc.parse(source, { filename: file }).descriptor; script = sfc.compileScript(descriptor, { id: 'navigation-editor-runtime' }); source = script.content; }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    new Function('require', 'exports', 'window', 'localStorage', output)(name => {
      if (name === 'vue') return vue;
      if (name === 'element-plus') return { ElMessage: { error: value => notices.push(['error', value]), success: value => notices.push(['success', value]), warning: value => notices.push(['warning', value]) }, ElMessageBox: { confirm: async () => {} } };
      if (name === '@/stores/auth') return { useAuthStore: () => actor };
      if (name === '@/utils/auth') return { getToken: () => storage.get('admin_token') ?? null, getAdminSession: () => ({ userInfo: actor.userInfo, uniqueAuth: actor.uniqueAuth }) };
      if (name === '@/utils/request') return { __esModule: true, default: gateway, getData: async promise => (await promise).data };
      if (name === '@/api/attachment') return {
        apiAttachmentCategories: async (signal, params) => { categoryCalls.push({ signal, params }); return (options.categories ?? (async () => ({ list: [] })))(signal, params); },
        apiAttachmentList: async (params, signal) => { galleryCalls.push({ params: clone(params), signal }); return (options.gallery ?? (async () => ({ list: [], count: 0 })))(params, signal); },
        apiAttachmentUpload: async (file, pid, signal) => { uploadCalls.push({ file, pid, signal }); return (options.upload ?? (async () => ({ att_id: 18, url: '/api/assets/18', src: ticket(18) })))(file, pid, signal); },
      };
      // These adjacent editors are not this suite's producer. Keep the footer's
      // real named canonicalizer because actual DiseList.save composes it.
      if (name === '@/components/content/DiyPresentationEditor.vue') return { __esModule: true, default: vue.defineComponent({ setup: () => () => null }) };
      if (name === '@/components/content/DiyFooterEditor.vue') return { __esModule: true, ...load(path.join(root, name.slice(2))), default: vue.defineComponent({ setup: () => () => null }) };
      if (name.startsWith('@/')) return load(path.join(root, name.slice(2)));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name));
      return require(name);
    }, exports, window, { getItem: key => storage.get(key) ?? null });
    if (descriptor) {
      const component = exports.default, setup = component.setup;
      component.setup = (props, context) => { const state = setup(props, context); const values = instances.get(file) ?? []; values.push(vue.proxyRefs(state)); instances.set(file, values); return state; };
      component.render = new Function('Vue', ts.transpileModule(dom.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: script.bindings }).code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(vue);
    }
    return exports;
  }
  return { load, instances, actor, storage, window, notices, calls, galleryCalls, categoryCalls, uploadCalls, componentOverrides: options.componentOverrides };
}
// Independent full literals from PHP8ed2a5b, not imported from the implementation's defaults.
// this.num is0; the exact news2.png require is bound to the original static URL.
const phpDefaults = {
  "news": {
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
  },
  "hotspot": {
    "cname": "热区",
    "name": "hotspot",
    "timestamp": 0,
    "isHide": false,
    "setUp": {
      "tabVal": 0
    },
    "titleLeft": "内容设置",
    "titleRight": "通用样式",
    "picStyle": {
      "url": "",
      "list": []
    },
    "bottomBgColor": {
      "title": "底部背景",
      "name": "bottomBgColor",
      "default": [
        {
          "item": "#F5F5F5"
        }
      ],
      "color": [
        {
          "item": "#F5F5F5"
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
  },
  "activeParty": {
    "name": "activeParty",
    "timestamp": 0,
    "setUp": {
      "tabVal": 0
    },
    "titleConfig": {
      "title": "促销标题",
      "value": "超值爆款",
      "place": "请输入标题",
      "max": 10
    },
    "desConfig": {
      "title": "促销简介",
      "value": "美好生活由此开始",
      "place": "请输入简介",
      "max": 8
    },
    "menuConfig": {
      "title": "最多可添加4个版块，图片建议尺寸140 * 140px；鼠标拖拽左侧圆点可 调整版块顺序",
      "maxList": 4,
      "list": [
        {
          "img": "",
          "info": [
            {
              "title": "标题",
              "value": "今日推荐",
              "tips": "选填，不超过4个字",
              "max": 4
            },
            {
              "title": "简介",
              "value": "店主诚意推荐 品质商品",
              "tips": "选填，不超过20个字",
              "max": 20
            },
            {
              "title": "链接",
              "value": "",
              "tips": "请输入链接",
              "max": 100
            }
          ]
        },
        {
          "img": "",
          "info": [
            {
              "title": "标题",
              "value": "热门榜单",
              "tips": "选填，不超过4个字",
              "max": 4
            },
            {
              "title": "简介",
              "value": "店主诚意推荐 品质商品",
              "tips": "选填，不超过20个字",
              "max": 20
            },
            {
              "title": "链接",
              "value": "",
              "tips": "请输入链接",
              "max": 100
            }
          ]
        },
        {
          "img": "",
          "info": [
            {
              "title": "标题",
              "value": "首发新品",
              "tips": "选填，不超过4个字",
              "max": 4
            },
            {
              "title": "简介",
              "value": "新品上架等 你来拿",
              "tips": "选填，不超过20个字",
              "max": 20
            },
            {
              "title": "链接",
              "value": "",
              "tips": "请输入链接",
              "max": 100
            }
          ]
        },
        {
          "img": "",
          "info": [
            {
              "title": "标题",
              "value": "促销单品",
              "tips": "选填，不超过4个字",
              "max": 4
            },
            {
              "title": "简介",
              "value": "综合评选好 产品",
              "tips": "选填，不超过20个字",
              "max": 20
            },
            {
              "title": "链接",
              "value": "",
              "tips": "请输入链接",
              "max": 100
            }
          ]
        }
      ]
    },
    "themeColor": {
      "title": "主题颜色",
      "name": "themeColor",
      "default": [
        {
          "item": "#fc3c3e"
        }
      ],
      "color": [
        {
          "item": "#fc3c3e"
        }
      ]
    },
    "bgColor": {
      "title": "标签背景颜色",
      "name": "bgColor",
      "default": [
        {
          "item": "#F62C2C"
        },
        {
          "item": "#F96E29"
        }
      ],
      "color": [
        {
          "item": "#F62C2C"
        },
        {
          "item": "#F96E29"
        }
      ]
    },
    "boxColor": {
      "title": "背景颜色",
      "name": "boxColor",
      "default": [
        {
          "item": "#ffe5e3"
        }
      ],
      "color": [
        {
          "item": "#ffe5e3"
        }
      ]
    },
    "mbConfig": {
      "title": "页面间距",
      "val": 0,
      "min": 0
    }
  }
};
const clone = value => JSON.parse(JSON.stringify(value));
function block(kind, timestamp = 10) { return { ...clone(phpDefaults[kind]), timestamp }; }
function region(overrides = {}) { return { number: 1, starX: 25, starY: 30, areaWidth: 100, areaHeight: 80, nowImgWidth: 750, link: '/pages/goods/list', imported: { keep: [], zero: 0 }, ...overrides }; }
function hotspot() { const b = block('hotspot'); b.picStyle.url = '/api/assets/7'; b.picStyle.list = [region()]; return b; }
const ticket = (id, expires = Math.floor(Date.now() / 1000) + 900) => `/api/assets/${id}?expires=${expires}&signature=${'A'.repeat(43)}`;
const response = data => ({ ok: true, json: async () => ({ status: 200, data }) });
function harness(value = [block('news')], options = {}) {
  const l = loader(options), props = vue.reactive({ modelValue: JSON.stringify(value), editorKey: 'editorial:2', disabled: false, pageId: 2, pagePublished: true, ...options.props }), writes = [], tree = node('root');
  const component = l.load(editorFile).default;
  const app = renderer.createApp({ setup: () => () => vue.h(component, { ...props, 'onUpdate:modelValue': value => { writes.push(value); if (!options.deferEcho) props.modelValue = value; } }) });
  for (const name of elementNames) app.component(name, elementStub(name));
  app.directive('loading', {}); app.mount(tree); let alive = true;
  return { ...l, tree, props, writes, value: () => JSON.parse(props.modelValue), get state() { return l.instances.get(editorFile).at(-1); }, unmount() { if (alive) { alive = false; app.unmount(); for (const event of ['admin-session-changed','admin-auth-expired','storage']) assert.equal(getEventListeners(l.window, event).length, 0, event + ' listener cleanup'); } } };
}
function control(r, label) {
  const field = all(r.tree, n => n.props['data-element'] === 'el-form-item' && n.props['data-label'] === label)[0]; assert.ok(field, label);
  const input = all(field, n => ['el-input', 'el-input-number', 'el-select', 'el-color-picker'].includes(n.props['data-element']))[0]; assert.ok(input, label); return input;
}
function sourceFunctions(relative, wanted, suffix = '') {
  const file = path.resolve(root, '../../../workers-ts/src', relative), source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) && wanted.includes(n.name?.text)).map(n => n.getText(ast));
  assert.equal(declarations.length, wanted.length);
  const output = ts.transpileModule(declarations.join('\n') + suffix, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {}; new Function('exports', output)(exports); return exports;
}
function independentWorker() {
  const canonical = sourceFunctions('services/content/ArticleContentPolicy.ts', ['decodePublishedArticleAttribute', 'canonicalizePublishedAttachmentReference'], '\nconst decodeAttributeEntities=decodePublishedArticleAttribute;');
  const transform = sourceFunctions('services/content/DiyHomeCompatibilityService.ts', ['record', 'deleteNestedKey', 'transformLegacyHomeComponents']);
  return { ...canonical, ...transform };
}
function publicBlock(input) {
  const worker = independentWorker(), b = worker.transformLegacyHomeComponents([clone(input)], true)[0];
  if (b.name === 'news') b.imgConfig.url = ticket(7);
  if (b.name === 'hotspot') b.picStyle.url = ticket(7);
  if (b.name === 'activeParty') b.menuConfig.list.slice(0, 4).forEach((row, i) => { row.img = ticket(i + 1); });
  return b;
}
function partyWithOverflow() {
  const b = block('activeParty');
  b.menuConfig.list = Array.from({ length: 6 }, (_, index) => ({ ...clone(b.menuConfig.list[0]), img: `/api/assets/${index+1}`, extra: { index, empty: [] } }));
  b.extra = { keep: true }; b.titleConfig.extra = 'retain'; b.desConfig.extra = 'retain'; return b;
}

for (const kind of ['news', 'hotspot', 'activeParty']) test(`actual parent adds complete PHP ${kind} defaults without merging neighbors or footer`, async () => {
  const neighbors = [{ name: 'headerSerch', timestamp: -1, unknown: { keep: [] } }, { name: 'unknown-neighbor', timestamp: 1, retain: [0, null, false] }, { name: 'titles', timestamp: 20, titleConfig: { value: '旁边标题' } }, { name: 'pageFoot', timestamp: 999, retained: true }];
  const before = clone(neighbors), r = harness(neighbors);
  try { await tick(); assert.deepEqual(r.writes, []); r.state.addKind = kind; r.state.add(); await tick(); const expected = clone(before); expected.splice(3, 0, { ...clone(phpDefaults[kind]), timestamp: 21 }); assert.deepEqual(r.value(), expected); assert.equal(Object.keys(r.value()[3]).length, { news: 32, hotspot: 14, activeParty: 10 }[kind]); assert.equal(r.writes.length, 1); }
  finally { r.unmount(); }
});
test('actual parent duplicates/removes/moves complete imports with dormant data, unknown rows and full overflow', async () => {
  const b = block('news'); b.listConfig.list = Array.from({ length: 14 }, (_, i) => ({ chiild: [{ val: `导入${i}` }, { val: '/pages/article/list' }, { keep: i }], show: false, unknown: [null, [], 0] })); b.extra = { neverMerge: true };
  const initial = [b, { name: 'titles', timestamp: 20, untouched: '邻居' }, { name: 'pageFoot', timestamp: 999, kept: true }], r = harness(initial);
  try { r.state.add(true); await tick(); const expected = clone(initial); expected.splice(2, 0, { ...clone(b), timestamp: 21 }); assert.deepEqual(r.value(), expected); r.state.remove(); await tick(); assert.deepEqual(r.value(), initial); r.state.select(0); r.state.move(1); await tick(); const moved = [clone(initial[1]), clone(initial[0]), clone(initial[2])]; moved[0].timestamp = 10; moved[1].timestamp = 20; assert.deepEqual(r.value(), moved); }
  finally { r.unmount(); }
});
test('unrelated parent visibility edit retains malformed/imported overflow and does not fill missing defaults', async () => {
  const sparse = { name: 'news', timestamp: '10', isHide: ' 0 ', listConfig: { max: 999, list: [...Array.from({ length: 12 }, (_, i) => ({ show: i === 11, chiild: [{ val: '导入' + i }, { val: '' }], extra: i })), 0] }, untouched: { keep: [] } }, r = harness([sparse]);
  try { await tick(); assert.deepEqual(r.writes, []); r.state.setVisible(false); await tick(); const expected = clone(sparse); expected.isHide = true; assert.deepEqual(r.value(), [expected]); assert.equal(Object.hasOwn(r.value()[0], 'styleConfig'), false); }
  finally { r.unmount(); }
});
test('parent rejects malformed documents and move boundary without replacing original JSON', async () => {
  for (const raw of ['null', '{}', '[{"name":"news","__proto__":{"bad":true}}]']) {
    const r = harness([], { props: { modelValue: raw } }); try { await tick(); assert.deepEqual(r.writes, []); assert.ok(r.state.parsed.error); r.state.add(); assert.equal(r.props.modelValue, raw); } finally { r.unmount(); }
  }
  const r = harness([{ name: 'headerSerch', timestamp: 0 }, block('news', 10)]); try { r.state.move(-1); await tick(); assert.deepEqual(r.writes, []); assert.match(r.state.error, /不能越过/u); } finally { r.unmount(); }
});
test('ordinary image identity independently equals the actual Worker attribute/entity decoder', () => {
  const u = loader().load(utilFile), worker = independentWorker();
  for (const raw of [' /api/assets/7?expires=1&amp;signature=old ', '&#47;api&#x2f;assets/7?old', '/api/assets/0007', 'https&colon;//example.com/a?x=1&amp;y=2', '/static/images/diy/news2.png', '&#1114112;/x', '&NewLine;/api/assets/7#old', '&#x2fapi/assets/7']) assert.equal(u.editorialImageIdentity(raw), worker.canonicalizePublishedAttachmentReference(raw));
});
test('activeParty published comparison removes exactly four metadata leaves and canonicalizes only first4 authorized media', () => {
  const b = partyWithOverflow(), before = clone(b), u = loader().load(utilFile), worker = independentWorker();
  b.menuConfig.list.forEach((row, i) => { row.img = ticket(i + 1); });
  const expected = worker.transformLegacyHomeComponents([clone(b)], true)[0];
  expected.menuConfig.list.slice(0, 4).forEach(row => { row.img = worker.canonicalizePublishedAttachmentReference(row.img); });
  assert.deepEqual(u.canonicalEditorialBlock(b, true), expected); assert.deepEqual(u.editorialMediaPaths(b), [0, 1, 2, 3].map(i => ['menuConfig', 'list', i, 'img']));
  assert.equal(expected.titleConfig.extra, 'retain'); assert.equal(expected.desConfig.extra, 'retain'); assert.ok(Object.hasOwn(expected.menuConfig.list[0].info[0], 'max'));
  const stored = u.canonicalEditorialBlock(b); assert.ok(Object.hasOwn(stored.titleConfig, 'max')); assert.ok(Object.hasOwn(stored.desConfig, 'place'));
  assert.equal(stored.menuConfig.list[4].img, b.menuConfig.list[4].img); assert.equal(stored.menuConfig.list[5].img, b.menuConfig.list[5].img);
  assert.equal(Object.keys(before).length, Object.keys(b).length);
});
test('canonical value leaves follow, unknown media-like strings and every imported later card unchanged', () => {
  const u = loader().load(utilFile), b = partyWithOverflow(), other = { name: 'follow', imgConfig: { url: ticket(90) }, unknown: ticket(91) };
  b.preview = ticket(80); b.menuConfig.list[0].info[2].value = ticket(81);
  const input = [b, other], before = clone(input), output = JSON.parse(u.canonicalEditorialValue(JSON.stringify(input)));
  assert.deepEqual(output, before); assert.deepEqual(input, before);
});
test('same ordinary asset signature renewal preserves all regions and raw entity reference without a config write', async () => {
  const b = hotspot(); b.picStyle.url = '&#47;api/assets/7?old'; b.picStyle.list = Array.from({ length: 33 }, (_, i) => region({ number: i + 1, imported: { i } })); const r = harness([b]);
  try { const choose = r.state.mediaSession(['picStyle', 'url']).choose, signed = ticket(7); await choose('/api/assets/7', signed); await tick(); assert.deepEqual(r.writes, []); assert.deepEqual(r.value(), [b]); assert.equal(r.state.previewImage(['picStyle', 'url']), signed); assert.equal(r.state.items.length, 33); }
  finally { r.unmount(); }
});
test('different selected hotspot image clears regions but preserves full picture metadata and installs a same-owner preview', async () => {
  const b = hotspot(); b.picStyle.unknown = { keep: true }; const r = harness([b]);
  try { const signed = ticket(8); await r.state.mediaSession(['picStyle', 'url']).choose('/api/assets/8', signed); await tick(); const expected = clone(b); expected.picStyle.url = '/api/assets/8'; expected.picStyle.list = []; assert.deepEqual(r.value(), [expected]); assert.equal(r.writes.length, 1); assert.equal(r.state.previewImage(['picStyle', 'url']), signed); }
  finally { r.unmount(); }
});
test('explicit hotspot image removal clears only URL and retains complete raw regions as original PHP does', async () => {
  const b = hotspot(), before = clone(b), r = harness([b]);
  try { r.state.clearImage(); await tick(); const expected = clone(before); expected.picStyle.url = ''; assert.deepEqual(r.value(), [expected]); assert.equal(r.writes.length, 1); }
  finally { r.unmount(); }
});
test('fifth activity image and mismatched/expired signatures confer no media write or preview authority', async () => {
  const b = partyWithOverflow(), r = harness([b]);
  try { await r.state.mediaSession(['menuConfig', 'list', 4, 'img']).choose('/api/assets/9', ticket(9)); await r.state.mediaSession(['menuConfig', 'list', 0, 'img']).choose('/api/assets/9', ticket(8)); await r.state.mediaSession(['menuConfig', 'list', 0, 'img']).choose('/api/assets/9', ticket(9, Math.floor(Date.now()/1000)-1)); await tick(); assert.deepEqual(r.writes, []); assert.deepEqual(r.value(), [b]); assert.deepEqual(r.state.previews, {}); }
  finally { r.unmount(); }
});
test('published full activeParty response accepts exact4 metadata removal, leases first4 only, and never rewrites stored config', async () => {
  const b = partyWithOverflow(), r = harness([b]), oldFetch = global.fetch, calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return response({ value: [publicBlock(b)] }); };
  try { await r.state.loadSavedMedia(); await tick(); assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/diy/get_diy/2'); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.credentials, 'omit'); assert.deepEqual(Object.keys(r.state.previews).sort(), [1,2,3,4].map(i => '/api/assets/' + i)); assert.deepEqual(r.writes, []); assert.deepEqual(r.value(), [b]); }
  finally { global.fetch = oldFetch; r.unmount(); }
});
test('published response cannot borrow media from a component differing only in later-card content or dormant metadata', async () => {
  const b = partyWithOverflow(), oldFetch = global.fetch;
  try { for (const mutate of [row => { row.menuConfig.list[5].info[0].value = '变更'; }, row => { row.titleConfig.extra = 'changed'; }]) {
    const r = harness([b]); global.fetch = async () => { const found = publicBlock(b); mutate(found); return response({ value: [found] }); };
    try { await r.state.loadSavedMedia(); await tick(); assert.deepEqual(r.state.previews, {}); assert.match(r.state.error, /不同/u); assert.deepEqual(r.writes, []); } finally { r.unmount(); }
  } } finally { global.fetch = oldFetch; }
});
const transitions = {
  raw: r => { const value = r.value(); value[0].unknown = 'external edit'; r.props.modelValue = JSON.stringify(value); },
  editor: r => { r.props.editorKey = 'editorial:other'; },
  page: r => { r.props.pageId = 3; },
  unpublished: r => { r.props.pagePublished = false; },
  disabled: r => { r.props.disabled = true; },
  actor: r => { r.actor.token = 'B'; r.storage.set('admin_token', 'B'); },
  revoked: r => { r.actor.uniqueAuth.splice(0); },
  selection: r => { r.state.select(1); },
  sessionEvent: r => { r.window.dispatchEvent(new Event('admin-session-changed')); },
  close: r => { r.unmount(); },
};
for (const [name, transition] of Object.entries(transitions)) test(`actual parent rejects stale gallery/link/published callbacks after ${name}`, async () => {
  const b = hotspot(), actor = vue.reactive({ token: 'A', userInfo: { id: 11, level: 1 }, uniqueAuth: ['dise.manage', 'attachment.view'] });
  const r = harness([b, block('news', 20)], { actor }), before = r.props.modelValue, pending = deferred(), oldFetch = global.fetch; let request;
  global.fetch = (url, options) => { request = { url, options }; return pending.promise; };
  try { const media = r.state.mediaSession(['picStyle', 'url']), link = r.state.linkSession(['picStyle', 'list', 0, 'link']), publicJob = r.state.loadSavedMedia();
    assert.ok(request); transition(r); await tick(); const expected = r.props.modelValue;
    await media.choose('/api/assets/8', ticket(8)); link.choose({ url: '/pages/article/list' }); pending.resolve(response({ value: [publicBlock(b)] })); await publicJob; await tick();
    assert.equal(r.props.modelValue, expected); assert.deepEqual(r.writes, []); assert.deepEqual(r.state.previews, {}); assert.equal(request.options.signal.aborted, true); if (name !== 'raw') assert.equal(r.props.modelValue, before);
  } finally { global.fetch = oldFetch; r.unmount(); }
});
test('manage-only image-denied and view-only actors cannot select gallery media; view-only cannot edit at all', async () => {
  for (const permissions of [['dise.manage'], ['dise.view']]) {
    const b = hotspot(), actor = vue.reactive({ token: 'A', userInfo: { id: 11, level: 1 }, uniqueAuth: permissions }), r = harness([b], { actor });
    try { assert.equal(r.state.canChooseMedia, false); await r.state.mediaSession(['picStyle', 'url']).choose('/api/assets/8', ticket(8)); assert.deepEqual(r.writes, []); if (permissions[0] === 'dise.view') { r.state.leaf(['mbConfig', 'val'], 9); r.state.add(); r.state.setVisible(false); assert.deepEqual(r.writes, []); } }
    finally { r.unmount(); }
  }
});
async function actualNumber(props) { const app = vue.createSSRApp({ render: () => vue.h(ElInputNumber, props) }); app.provide(ID_INJECTION_KEY, { prefix: 164, current: 0 }); app.provide(ZINDEX_INJECTION_KEY, { current: 0 }); return renderToString(app); }
test('installed number component control proves a fixed max normalizes an imported coordinate and reaches the real parent handler', async () => {
  const b = hotspot(); b.picStyle.url = '/static/canvas.png'; b.picStyle.list[0].starX = '1e30'; const r = harness([b]);
  try { await parentImageLoaded(r); const input = control(r, '左侧位置（750 设计坐标）'), updates = [], handler = input.props['onUpdate:modelValue']; const props = { ...input.props, max: 600, 'onUpdate:modelValue': value => { updates.push(value); handler(value); } }; for (const key of ['data-element', 'data-label', 'data-title']) delete props[key];
    await actualNumber(props); await tick(); assert.deepEqual(updates, [600]); assert.equal(r.writes.length, 1); assert.equal(r.value()[0].picStyle.list[0].starX, 600);
  } finally { r.unmount(); }
});
test('actual parent coordinate and tiny/exponent/radius controls do not rewrite imported JSON during installed input mount', async () => {
  const b = hotspot(); b.picStyle.list[0].starX = '1e30'; b.picStyle.list[0].areaWidth = '0.0005'; b.topConfig.val = '1e30'; b.mbConfig.val = '0.0005'; b.fillet.type = true; b.fillet.valList = [{ val: '5e-4' }, { val: ' 2.25 ' }, { val: '3e0' }, { val: 4.75 }];
  const r = harness([b]); try { await tick(); const raw = r.props.modelValue;
    for (const [label, expected] of [['左侧位置（750 设计坐标）', 1e30], ['区域宽度（750 设计坐标）', 0.0005], ['上边距（设计 px）', 1e30], ['组件上间距（设计 px）', 0.0005], ['公告与热区左上圆角', 0.0005], ['公告与热区右上圆角', 2.25], ['公告与热区左下圆角', 3], ['公告与热区右下圆角', 4.75]]) {
      const input = control(r, label); assert.equal(input.props.modelValue, expected); const updates = [], handler = input.props['onUpdate:modelValue'], props = { ...input.props, 'onUpdate:modelValue': value => { updates.push(value); handler(value); } }; for (const key of ['data-element', 'data-label', 'data-title']) delete props[key]; await actualNumber(props); await tick(); assert.deepEqual(updates, [], label); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []);
    }
  } finally { r.unmount(); }
});

function canvasHarness(options = {}) {
  const l = loader(), allowed = vue.ref(true), props = vue.reactive({ image: '/static/canvas.png', imageIdentity: '/static/canvas.png', areas: [region()], editorKey: 'canvas:1', disabled: false, allowed: () => allowed.value, ...options.props }), tree = node('root'), events = [];
  const app = renderer.createApp({ setup: () => () => vue.h(l.load(canvasFile).default, { ...props, onCreate: rect => events.push({ event: 'create', rect: clone(rect) }), onRect: (index, rect) => events.push({ event: 'rect', index, rect: clone(rect) }), onSelect: index => events.push({ event: 'select', index }) }) });
  app.mount(tree); let alive = true; const state = l.instances.get(canvasFile).at(-1), host = state.host, capture = new Set();
  host.getBoundingClientRect = () => ({ width: 375, left: 10, top: 20 }); host.focus = () => {}; host.querySelector = () => all(tree, n => n.tag === 'img')[0]; host.setPointerCapture = id => capture.add(id); host.hasPointerCapture = id => capture.has(id); host.releasePointerCapture = id => capture.delete(id);
  return { ...l, tree, props, allowed, events, state, host, capture, unmount() { if (alive) { alive = false; app.unmount(); } } };
}
function eventHandler(element, event) { const fn = Object.entries(element.props).find(([key]) => key.toLowerCase() === 'on' + event.toLowerCase())?.[1]; assert.equal(typeof fn, 'function', event); return fn; }
function pointer(r, clientX, clientY, overrides = {}) { return { target: r.host, button: 0, pointerId: 3, clientX, clientY, preventDefault() {}, stopPropagation() {}, ...overrides }; }
async function loaded(r, width = 1500, height = 750) { const image = all(r.tree, n => n.tag === 'img')[0]; image.naturalWidth = width; image.naturalHeight = height; eventHandler(image, 'load')({ target: image, currentTarget: image }); await tick(); }
const actualAreas = r => all(r.tree, n => String(n.props.class ?? '').split(/\s+/u).includes('area') && !String(n.props.class).includes('draft'));
test('actual canvas requires positive loaded image dimensions, then draws exact750-unit coordinates from source pointer handlers', async () => {
  const r = canvasHarness(); try { const before = clone(r.props.areas); await loaded(r, 0, 0); assert.equal(r.state.ready, false); assert.equal(actualAreas(r).length, 0); eventHandler(r.host, 'pointerdown')(pointer(r, 60, 70)); assert.deepEqual(r.events, []);
    await loaded(r); assert.equal(r.state.height, 375); assert.equal(r.state.ready, true); eventHandler(r.host, 'pointerdown')(pointer(r, 60, 70)); eventHandler(r.host, 'pointermove')(pointer(r, 160, 170)); eventHandler(r.host, 'pointerup')(pointer(r, 160, 170)); await tick(); assert.deepEqual(r.events.at(-1), { event: 'create', rect: { starX: 100, starY: 100, areaWidth: 200, areaHeight: 200 } }); assert.deepEqual(r.props.areas, before); assert.equal(r.capture.size, 0);
  } finally { r.unmount(); }
});
test('actual canvas area move and resize preserve original raw area metadata and emit only exact geometry intents', async () => {
  const r = canvasHarness({ props: { areas: [region({ starX: 50, starY: 50 })] } }); try { await loaded(r); const before = clone(r.props.areas), area = actualAreas(r)[0]; eventHandler(area, 'pointerdown')(pointer(r, 60, 60)); eventHandler(r.host, 'pointermove')(pointer(r, 110, 80)); eventHandler(r.host, 'pointerup')(pointer(r, 110, 80)); await tick(); assert.deepEqual(r.events.at(-1), { event: 'rect', index: 0, rect: { starX: 150, starY: 90, areaWidth: 100, areaHeight: 80 } });
    const resize = all(actualAreas(r)[0], n => n.tag === 'button')[0]; eventHandler(resize, 'pointerdown')(pointer(r, 85, 85)); eventHandler(r.host, 'pointermove')(pointer(r, 135, 110)); eventHandler(r.host, 'pointerup')(pointer(r, 135, 110)); await tick(); assert.deepEqual(r.events.at(-1), { event: 'rect', index: 0, rect: { starX: 50, starY: 50, areaWidth: 200, areaHeight: 130 } }); assert.deepEqual(r.props.areas, before);
  } finally { r.unmount(); }
});
for (const reason of ['pointercancel', 'escape', 'lostpointercapture', 'lease', 'raw', 'editor']) test(`actual canvas cancels ${reason} drag without a persisted rectangle`, async () => {
  const r = canvasHarness(); try { await loaded(r); eventHandler(r.host, 'pointerdown')(pointer(r, 60, 70)); eventHandler(r.host, 'pointermove')(pointer(r, 160, 170));
    if (reason === 'escape') {
      const calls = []; assert.notEqual(r.state.drag, null);
      eventHandler(r.host, 'keydown')({ key: 'Escape', stopPropagation() { calls.push('stop'); }, preventDefault() { calls.push('prevent'); } });
      assert.deepEqual(calls, ['stop', 'prevent']); assert.equal(r.state.drag, null);
    }
    else if (reason === 'lease') r.allowed.value = false;
    else if (reason === 'raw') r.props.areas[0].link = '/pages/article/list';
    else if (reason === 'editor') r.props.editorKey = 'canvas:new';
    else eventHandler(r.host, reason)(pointer(r, 160, 170));
    await tick(); eventHandler(r.host, 'pointerup')(pointer(r, 160, 170)); await tick(); assert.deepEqual(r.events.filter(x => x.event !== 'select'), []); assert.equal(r.capture.size, 0);
  } finally { r.unmount(); }
});
test('actual compiled Escape from a focused resize control stops dialog bubbling, prevents default and cancels only the draft', async () => {
  const r = canvasHarness({ props: { areas: [region({ starX: 50, starY: 50, extra: { imported: true } })] } });
  try {
    await loaded(r); const before = clone(r.props.areas), resize = all(actualAreas(r)[0], n => n.tag === 'button')[0];
    assert.equal(resize.props.class, 'resize');
    eventHandler(resize, 'pointerdown')(pointer(r, 85, 85, { target: resize }));
    eventHandler(r.host, 'pointermove')(pointer(r, 135, 110));
    assert.equal(r.state.drag.mode, 'resize'); assert.notDeepEqual(r.state.drag.rect, r.state.drag.start); assert.equal(r.capture.size, 1);
    // Both calls use the real SFC compiler's withKeys/withModifiers listener,
    // including an actual descendant button as the keyboard event target.
    eventHandler(r.host, 'keydown')({ key: 'Enter', target: resize, currentTarget: r.host,
      stopPropagation() { assert.fail('Enter must keep bubbling'); }, preventDefault() { assert.fail('Enter must retain its default behavior'); } });
    assert.equal(r.state.drag.mode, 'resize');
    const calls = [], escape = { key: 'Escape', target: resize, currentTarget: r.host, cancelBubble: false, defaultPrevented: false,
      stopPropagation() { calls.push('stop'); this.cancelBubble = true; }, preventDefault() { calls.push('prevent'); this.defaultPrevented = true; } };
    eventHandler(r.host, 'keydown')(escape);
    assert.deepEqual(calls, ['stop', 'prevent']); assert.equal(escape.cancelBubble, true); assert.equal(escape.defaultPrevented, true);
    assert.equal(r.state.drag, null); assert.equal(r.capture.size, 0);
    await tick(); eventHandler(r.host, 'pointerup')(pointer(r, 135, 110)); await tick();
    assert.deepEqual(r.events.filter(item => item.event !== 'select'), []); assert.deepEqual(r.props.areas, before);
  } finally { r.unmount(); }
});
test('actual canvas ignores old image/error callbacks after source-key change and blocks expired image lease', async () => {
  const r = canvasHarness(); try { const image = all(r.tree, n => n.tag === 'img')[0], oldLoad = eventHandler(image, 'load'), oldError = eventHandler(image, 'error');
    r.props.image = '/static/new.png'; r.props.imageIdentity = '/static/new.png'; r.props.editorKey = 'canvas:2'; await tick(); oldLoad({ target: { naturalWidth: 10, naturalHeight: 10 } }); assert.equal(r.state.ready, false);
    await loaded(r); assert.equal(r.state.ready, true); oldError(); assert.equal(r.state.ready, true); r.allowed.value = false; await tick(); assert.equal(r.state.ready, false); assert.equal(actualAreas(r).length, 0); assert.deepEqual(r.events, []);
  } finally { r.unmount(); }
});

for (const changed of ['width', 'left', 'top']) test(`actual canvas cancels a drag when responsive host ${changed} changes`, async () => {
  const r = canvasHarness(); try { await loaded(r); eventHandler(r.host, 'pointerdown')(pointer(r, 60, 70)); eventHandler(r.host, 'pointermove')(pointer(r, 160, 170));
    r.host.getBoundingClientRect = () => ({ width: changed === 'width' ? 300 : 375, left: changed === 'left' ? 25 : 10, top: changed === 'top' ? 35 : 20 });
    eventHandler(r.host, 'pointerup')(pointer(r, 160, 170)); await tick(); assert.deepEqual(r.events.filter(x => x.event !== 'select'), []); assert.equal(r.capture.size, 0);
  } finally { r.unmount(); }
});
test('actual canvas rejects a same-key foreign image load before its own image is ready', async () => {
  const r = canvasHarness(); try { const image = all(r.tree, n => n.tag === 'img')[0];
    eventHandler(image, 'load')({ target: { naturalWidth: 1500, naturalHeight: 750 }, currentTarget: image }); await tick();
    assert.equal(r.state.ready, false); assert.equal(r.state.height, 0); assert.equal(actualAreas(r).length, 0);
    await loaded(r); assert.equal(r.state.ready, true); assert.equal(r.state.height, 375);
  } finally { r.unmount(); }
});

async function parentImageLoaded(r, width = 750, height = 750) {
  const file = path.join(root, 'components/content/DiyHotspotEditorCanvas.vue');
  const actual = r.instances.get(file)?.at(-1);
  assert.ok(actual, 'the real detailed canvas must be mounted');
  actual.imageSession.load({ currentTarget: { naturalWidth: width, naturalHeight: height } });
  await tick(); assert.equal(r.state.imageSize.width, width); assert.equal(r.state.imageSize.height, height);
}
async function chooseParentBackground(r, reference, signed) {
  await r.state.mediaSession(['picStyle', 'url']).choose(reference, signed);
  await tick(); await parentImageLoaded(r);
}
test('actual parent canvas session appends complete PHP region shape after every imported area without trimming or mutating metadata', async () => {
  const b = hotspot(); b.picStyle.list = Array.from({ length: 33 }, (_, i) => region({ number: 100 + i, extra: { i } })); const r = harness([b]);
  try { await chooseParentBackground(r, '/api/assets/7', ticket(7)); const rect = { starX: 10, starY: 20, areaWidth: 30, areaHeight: 40 };
    const session = r.state.canvasSession; assert.equal(session.allowed(), true); session.create(rect); await tick();
    const expected = clone(b); expected.picStyle.list.push({ number: 34, ...rect, nowImgWidth: 750, link: '' }); assert.deepEqual(r.value(), [expected]); assert.equal(r.writes.length, 1);
  } finally { r.unmount(); }
});
test('actual parent canvas rect changes only four coordinates and preserves complete region metadata', async () => {
  const b = hotspot(), r = harness([b]); try { await chooseParentBackground(r, '/api/assets/7', ticket(7));
    const rect = { starX: 10, starY: 20, areaWidth: 30, areaHeight: 40 }; r.state.canvasSession.rect(0, rect); await tick(); const expected = clone(b); Object.assign(expected.picStyle.list[0], rect); assert.deepEqual(r.value(), [expected]); assert.equal(r.writes.length, 1);
  } finally { r.unmount(); }
});
for (const reason of ['disabled', 'revoked', 'page']) test(`actual parent canvas session rejects captured geometry after ${reason}`, async () => {
  const b = hotspot(), actor = vue.reactive({ token: 'A', userInfo: { id: 11, level: 1 }, uniqueAuth: ['dise.manage','attachment.view'] }), r = harness([b], { actor });
  try { await chooseParentBackground(r, '/api/assets/7', ticket(7)); const session = r.state.canvasSession; assert.equal(session.allowed(), true);
    if (reason === 'disabled') r.props.disabled = true; else if (reason === 'revoked') r.actor.uniqueAuth.splice(0); else r.props.pageId = 3; await tick();
    const rect = { starX: 10, starY: 20, areaWidth: 30, areaHeight: 40 }; session.create(rect); session.rect(0, rect); await tick(); assert.deepEqual(r.writes, []); assert.deepEqual(r.value(), [b]); assert.equal(session.allowed(), false);
  } finally { r.unmount(); }
});
test('actual parent lease timer expires signed preview and captured canvas authority without a stored-config write', async t => {
  const now = 1800000000000; t.mock.timers.enable({ apis: ['Date','setTimeout'], now }); const b = hotspot(), r = harness([b]);
  try { await chooseParentBackground(r, '/api/assets/7', ticket(7, Math.floor(now/1000)+2)); const session = r.state.canvasSession; assert.equal(session.allowed(), true); assert.equal(r.state.previewImage(['picStyle','url']).includes('signature='), true);
    t.mock.timers.tick(2002); await tick(); assert.equal(session.allowed(), false); assert.equal(r.state.previewImage(['picStyle','url']), ''); assert.deepEqual(r.state.previews, {});
    session.create({ starX: 10, starY: 20, areaWidth: 30, areaHeight: 40 }); await tick(); assert.deepEqual(r.writes, []); assert.deepEqual(r.value(), [b]);
  } finally { r.unmount(); t.mock.timers.reset(); }
});


test('actual parent own commit echo keeps one valid background across consecutive create move resize without choosing media again', async () => {
  const r = harness([hotspot()]);
  try {
    const signed = ticket(7); await chooseParentBackground(r, '/api/assets/7', signed);
    const initial = clone(r.value()), first = r.state.canvasSession;
    first.create({ starX: 200, starY: 100, areaWidth: 100, areaHeight: 80 }); await tick();
    assert.equal(r.state.previewImage(['picStyle','url']), signed); assert.equal(r.state.canvasSession.allowed(), true); assert.equal(first.allowed(), false);
    r.state.canvasSession.rect(1, { starX: 220, starY: 120, areaWidth: 100, areaHeight: 80 }); await tick();
    assert.equal(r.state.previewImage(['picStyle','url']), signed); assert.equal(r.state.canvasSession.allowed(), true);
    r.state.canvasSession.rect(1, { starX: 220, starY: 120, areaWidth: 140, areaHeight: 110 }); await tick();
    assert.equal(r.state.previewImage(['picStyle','url']), signed); assert.equal(r.state.canvasSession.allowed(), true); assert.equal(r.writes.length, 3);
    assert.deepEqual(r.value()[0].picStyle.list[0], initial[0].picStyle.list[0]);
    assert.deepEqual(r.value()[0].picStyle.list[1], { number: 2, starX: 220, starY: 120, areaWidth: 140, areaHeight: 110, nowImgWidth: 750, link: '' });
  } finally { r.unmount(); }
});
test('actual parent accepts only its exact immediate own prop echo and preserves all still-current activity media slots', async () => {
  const r = harness([partyWithOverflow()], { deferEcho: true });
  try {
    for (let i = 0; i < 4; i++) await r.state.mediaSession(['menuConfig','list',i,'img']).choose(`/api/assets/${i+1}`, ticket(i+1));
    await tick(); const leases = clone(r.state.previews); assert.equal(Object.keys(leases).length, 4);
    r.state.setText('titleConfig', '改标题'); assert.deepEqual(r.state.previews, {});
    r.props.modelValue = r.writes.at(-1); await tick(); assert.deepEqual(r.state.previews, leases);
  } finally { r.unmount(); }
});
for (const reason of ['raw','revoked','selection','page','editor','disabled','token','storage','session-event','unpublished']) test(`actual parent refuses own-echo lease restoration after ${reason} before the echo`, async () => {
  const actor = vue.reactive({ token: 'A', userInfo: { id: 11, level: 1 }, uniqueAuth: ['dise.manage','attachment.view'] });
  const r = harness([hotspot(), block('news', 20)], { actor, deferEcho: true });
  try {
    await chooseParentBackground(r, '/api/assets/7', ticket(7)); assert.notEqual(r.state.previewImage(['picStyle','url']), '');
    r.state.canvasSession.create({ starX: 200, starY: 100, areaWidth: 100, areaHeight: 80 }); const expected = r.writes.at(-1); assert.equal(typeof expected, 'string');
    if (reason === 'raw') { const changed = r.value(); changed[0].external = true; r.props.modelValue = JSON.stringify(changed); await tick(); }
    else if (reason === 'revoked') r.actor.uniqueAuth.splice(0);
    else if (reason === 'selection') r.state.select(1);
    else if (reason === 'page') r.props.pageId = 3;
    else if (reason === 'editor') r.props.editorKey = 'other-editor';
    else if (reason === 'disabled') r.props.disabled = true;
    else if (reason === 'token') r.actor.token = 'B';
    else if (reason === 'storage') r.window.dispatchEvent(new Event('storage'));
    else if (reason === 'session-event') r.window.dispatchEvent(new Event('admin-session-changed'));
    else if (reason === 'unpublished') r.props.pagePublished = false;
    r.props.modelValue = expected; await tick(); assert.deepEqual(r.state.previews, {}); assert.equal(r.state.canvasSession.allowed(), false); assert.equal(r.writes.length, 1);
  } finally { r.unmount(); }
});
test('actual parent never restores a lease that expires before its exact own prop echo', async t => {
  const now = 1800000000000; t.mock.timers.enable({ apis: ['Date','setTimeout'], now }); const r = harness([hotspot()], { deferEcho: true });
  try {
    await chooseParentBackground(r, '/api/assets/7', ticket(7, Math.floor(now/1000)+2));
    r.state.canvasSession.create({ starX: 200, starY: 100, areaWidth: 100, areaHeight: 80 }); t.mock.timers.tick(2002);
    r.props.modelValue = r.writes.at(-1); await tick(); assert.deepEqual(r.state.previews, {}); assert.equal(r.state.previewImage(['picStyle','url']), ''); assert.equal(r.state.canvasSession.allowed(), false);
  } finally { r.unmount(); t.mock.timers.reset(); }
});
test('actual parent external raw edits clear an installed preview instead of borrowing the own-echo allowance', async () => {
  const r = harness([hotspot()]);
  try {
    await chooseParentBackground(r, '/api/assets/7', ticket(7));
    r.state.canvasSession.create({ starX: 200, starY: 100, areaWidth: 100, areaHeight: 80 }); await tick(); assert.notEqual(r.state.previewImage(['picStyle','url']), '');
    const external = r.value(); external[0].topConfig.val = 6; r.props.modelValue = JSON.stringify(external); await tick();
    assert.deepEqual(r.state.previews, {}); assert.equal(r.state.canvasSession.allowed(), false); assert.equal(r.writes.length, 1);
  } finally { r.unmount(); }
});
