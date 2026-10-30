# 公众号关注组件的后台作者迁移

本批补齐 `follow` 的后台编辑、只读预览及页面保存链路。实际入口为 Admin「DIY 装修 / 自定义页面」中的「公众号关注」。整体 PHP → TS 迁移继续开放。

## 原始合同

PHP 来源固定于 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`：

- `view/admin/src/components/mobilePage/z_wechat_attention.vue:73–181` 的完整 `defaultConfig`，只将 `this.num` 替换为新增时的排序值。
- `view/admin/src/components/mobileConfig/c_wechat_attention.vue` 的标题、位置、头像、二维码、按钮色、背景渐变、边距和圆角控件。
- `view/uniapp/pages/index/components/follow.vue` 的展示与二维码消费行为。

默认值通过 TypeScript AST 静态提取，没有执行 PHP 仓库组件。来源文件原始字节 SHA-256 为 `8e96a58d3d3cbb2bd8bdbf166838e0f870f4e0d1b4d8d57bee49420d67b79263`；独立默认值 JSON 为 1,185 字节，SHA-256 为 `1dc548f44c1910c0bfdbebcace10e76c65fb014e4d515b78a8618e0217492c13`。

## 作者与消费边界

新增、精确删除和跨普通正文组件排序均保留未知邻居、页脚及原始字段。导入配置不合并默认值、不自动截断、不在挂载或未改变的数字控件事件中重写；修改明确的叶字段时保留该字段的其它元数据。普通新值采用当前消费者的边距及圆角上限，超过上限的导入原值仍保留。

位置选择继续持久化。PHP 前台及当前 TS 消费者均未按 `positionConfig` 实现固定顶部或底部布局，编辑器明确说明仍按页面组件顺序展示。预览的独立四角按当前 TS 的 `[0,1,3,2]` 消费顺序投影，未借本批改写公开渲染规则。

头像与二维码共用既有图库查看权限，分别绑定当前组件及素材身份。保存只规范这两个明确槽位的附件地址，临时签名不写入 JSON。换组件、换账号、换持久会话、关闭编辑、页面变化、卸载及替换配置都会撤销旧回执；真实父组件的异步 `v-model` 传播允许本次提交对应的预览，显式会话失效仍通过独立代次拒绝。连续选择两张图时，只保留仍匹配当前引用且未过期的预览票据。

已发布素材预览只匿名读取既有 `/api/diy/get_diy/:id`，要求整个规范组件与当前配置一致，再逐槽核对票据。预览关注按钮不可执行，不读取订阅状态、不生成海报、不上传图片。公开消费者原有关注、二维码保存及海报能力保持原实现；本批未新增业务 API、权限、SQL 或外部调用。

页面保存复用原 `/dise/save`，保留独立 `content` 和不可变元数据。原有未提交的会员权益作者工作继续保留。完整历史 API 清单的 follow 追加层记录在 [精确源码与报告增量](../audit/diy-follow-author-source-binding-20261024.json)，保留之前的 state 层和全部旧审计断言。

## 验证

本机定向测试 190 项通过、零失败及跳过：新增模型／Vue 运行时 42 项、原内容排版作者回归 33 项、五文件 API 与历史源码审计 115 项。115 项中包含本批新增的 20 项精确源码／报告正负例，新增独立测试合计 62 项，其余保留原断言。42 项包含与实际安装 UniApp 消费者的六类独立投影比较、真实父组件双图回执、同值会话事件失效及原页面保存链路；没有用测试定义数替代执行结果。

执行命令为 `node --test --test-concurrency=1 scripts/diy-follow-editor-model-runtime.test.cjs scripts/diy-follow-editor-runtime.test.cjs`、原 `diy-presentation-editor-runtime.test.cjs` 和 Worker `vitest run --maxWorkers=1` 的五个指定审计文件，均通过父目录共享串行包装器执行。Admin 严格类型、Vite 生产构建及 Worker 主类型项目全部 exit 0。环境缺少 npm 可执行文件，最初的 package 启动未执行构建，不计为构建结果；改为通过共享串行包装器直接执行已安装的 `vue-tsc -b`、`vite build` 与主 Worker `tsc --noEmit`，参数保持原 package scripts 合同。未重复计算此前已经通过的测试。

最终生产构建的实际浏览器会话完成桌面 Admin 新增、标题编辑、排序、两次真实图库选择及一次夹具保存；两张图同时预览，保存为稳定引用，独立 content 保留，0 console error / warning。浏览器使用已安装 Chrome / Playwright，原因是当前会话未列出 Browser plugin / browser skill；实际地址 `http://127.0.0.1:5186/content/dise`，视口 1365×1000。

浏览器 API、图库图片及通知 WebSocket 均为本地拦截夹具：最终构建会话记录 12 次 HTTP 请求、一次保存，此前开发会话不重复累计，不代表 PostgreSQL、R2、真实微信或生产 ACL 验收。首轮通知 WebSocket 夹具缺失造成的浏览器失败不计通过；补齐隔离夹具后重跑成功。首次运行测试的控件定位及父组件等待假设失败同样排除，修正后另行验证。截图及原始日志位于本轮 `/tmp/cinashop-follow-author/`。浏览器会话和本轮两个自有开发／预览服务器均已关闭。

本批没有合并或部署。生产身份、素材来源、移动设备和其余 DIY 作者组件仍需后续验收；保留已恢复的 `/api/get_script` 及三客户端脚本加载合同。
