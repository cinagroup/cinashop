# DIY 社区组件真实数据与逐组件配置迁移

本批基于 `3afb842699e5d69072e3c03209d7084e3a4cc1fd`，修复 UniApp 首页及微页面中的 community 模块误用 `/diy/video_list` 的问题。每个模块现在先读真实 `/community/config`，开放时再以自己的 `numberConfig` 读取公开社区列表；3 条与 7 条模块各自拥有数据、加载、失败与重试状态。社区卡片使用帖子标题、作者、封面及内容类型，图文／视频跳转复用已注册的规范入口，More 去真实社区主 Tab。预览、刷新和关闭恢复均不调用详情浏览、分享、点赞或短视频播放接口。

这符合 PHP 实际 `pages/index/components/community.vue` 的消费者合同：mounted 先读配置，列表 page=1，limit 来自该模块，topic_id 硬编码为空。Admin 虽可保存 selectConfig，旧消费者未把它传入列表，本批继续保留该边界。旧两列模板存在未实现的 toUser/contentLike 名称，不能据此宣称 DIY 内联作者动作／点赞已经在 PHP 可运行。本批点击进入成熟帖子页面，再使用既有评论与互动。`/diy/video_list` 的独立服务端短视频列表及播放记账兼容保持；修正的是社区消费者，不改它的数据域或写入合同。

模块保留横向／两列布局、文字／图片标题、More 文案，以及 PHP 实际消费的字体、颜色、背景、间距与圆角字段，复用现有安全颜色、图片及链接策略。复核中纠正了两个源字段误读：图片 filletImg 四角按 0、1、2、3，面板 fillet 四角按 0、1、3、2；两列纵向 rowGap 取 videoSpace，横向 columnGap 取 videoSpace2，横向卡片间距仍取 videoSpace2。运行时用不同角值、不同横纵间距作实际值断言。titleText=2 同时加粗和倾斜是 TS 有意补足 PHP 计算却未返回的 bold 意图，不宣称 PHP 与 TS 像素完全一致。数量归一默认 3、上限 100，属于显式 TS 安全边界，不能说成 PHP 编辑器已证明的最大值。

每个动态社区模块以完整 uid／token／sessionVersion、配置指纹、请求代次及可见状态约束成功、失败和 finally 回执。首页与微页面各自只注册一次 show／hide／unload，并把可见性传给模块；动态子组件仅使用 Vue scope 清理，不注册 Uni 页面生命周期。隐藏、卸载、配置替换和换号会清空旧社区展示；晚回执不能恢复它或释放新请求的 busy 状态。共享 availability 收到明确非 5xx 的 410010 会关闭所有社区模块，清空陈旧数据，不退出登录；503 携带 410010 仍按不确定失败处理。关闭后的恢复由用户显式触发只读配置检查，不重放任何未知写入。

公开列表保留已有 typed author 与私有 R2 边界。真实 type2 作者自己的附件可返回签名 URL，跨 owner 私有图片为空。历史非用户作者 DTO 可能仍带未签名的 `/api/assets/:id` 原始引用；实际无签名读取返回 HTTP 404、空 body，本批不为它补签，不把残留引用称为已授权可取。现有 backend 源码、SQL／schema及生产授权合同未因本批改写。隔离 createApp／JWT／owned PG16／memory R2 场景不等同于生产 ACL、真实账号或真机验收。

最终原生验证采用 `backend-native-final2`：完整 10 文件 197 项通过，耗时 71.68 秒，捕获的当前 native 测试／helper／runner 输入无漂移。它在失败 Browser 暴露 fixture content 缺失后重新执行，替换此前 final1 的 197 项，不把两轮或 candidate4 的 8 项相加。8 项新增场景逐请求核对 16 表／16 序列，覆盖真实 schema、3／7 条社区数据、typed 旁观、guest／双账号、私有附件、fresh 开关及 station 准入；该正向 fixture 的全部公开帖子内容都要求 string。显式调用独立 video_list 的单项兼容回归精确增加两个视频播放和两条 play 关系，其余社区只读请求零变，不能称所有原生请求零写。final1 后的 runner 逆向证明保留为历史来源；最终已经重跑当前完整 197，不能沿用“最终未重跑197”的旧描述。

三次前期原生候选均失败并排除：candidate1 错把历史非用户 raw 图片引用期望为空；candidate2 改为验证不可取后仍假设 HTTP 200；candidate3 又把实际 404 空 body 当 JSON 解析。实际控制器合同确认后，candidate4 对 raw 残留、HTTP 404、空 body 分别作精确断言，8 项通过；其后 final1 完整 197 项通过，Browser 夹具修正后又以 final2 完整 197 项替换作为最终来源。未改变生产媒体实现，也未放宽跨 owner 拒绝。

Worker 首轮 `unit-candidate1` 为 29 文件、816 项，其中 815 过、1 败；唯一失败在新 runner 测试的模式字符串拼写。随后 `runner-final1` 使用正确字符串仍暴露非 community 前缀模式误入 unit 路径断言，属于另一个装配／准入候选失败；修正后 `runner-final2` 的整个 runner 文件 495 项通过。有效合并应按首轮其余 28 个完整文件 321 项，加替换后的完整 runner 文件 495 项，候选合计 816，不能把 815 与 495 相加，也不能写成一次完整 29 文件 exit0。逐文件来源与有效 816 项已独立重算核对。495 项 CLI 所依赖的 runner 与测试文件未改；额外捕获的 fixture、native 测试与 Browser 三文件变更仅为两条 content 字符串、全公开 content 类型断言及 More 断言加强，精确整文件逆转均回到原捕获 SHA。这三处由后续完整主 tsconfig、完整十文件 197 项原生及最终 Browser 分别覆盖，不重跑或重复累计 495。

新增前端测试清单为 29 个实际生产 SFC／composable Node 场景和 9 个 Worker AST 装配场景。它们覆盖逐块配置、真实 API 请求、关闭与恢复、配置／会话／生命周期竞态、两根页面真实可见性及 type-only import／事件断连负例。实际 12 个社区与 DIY Node 脚本共 241 项全部通过，其中新增 29 项；9 项 AST 与其他 Worker 完整文件的来源计入上述有效 816。原三项类型检查全部通过；三处测试源修正后，完整主 tsconfig 又经 backend-types-followup1 通过（152.52 秒、exit0、无漂移）。runtime-test 配置和独立 Browser 配置的编译输入不含这三处测试，原通过结果按精确范围保留。前端八份输入、241 运行时与完整 1561 工具链及三端产物不变。

浏览器 candidate1 只完成前五个检查点，进入真实 More 主页面后，两条 typed 旁观帖的 fixture 漏写 content 导致值为 null，被既有帖子 DTO 校验正确拒绝。根代理记录原始 DOM／截图后以乱序 finished 显式终止；日志的 stage mismatch 是退出收据，原始缺陷是 fixture，不是生产校验。该失败候选和前五阶段均不计通过数。只修两个 fixture 字符串，并加强 native 全公开 content:string 与 Browser More 必显两标题／不得有格式错断言；这是构造符合既有 checkedCommunityPost 字符串合同的正向夹具；community.content 列仍 nullable（schema/community.ts:33），本批不迁移任意旧数据的 NULL、不放宽响应校验，也不声称任意历史主列表均可渲染，该兼容边界继续归 DATA-008／严格 DTO 数据治理。生产、前端和构建字节保持，最终使用成功的完整 18 阶段候选，浏览器仍只计 1 项。

最终校验：

- 定向 1,255 项独立用例通过，新增 51 项：Worker 有效整文件组合 816、原生 PG16 197、Node 运行时 241、实际浏览器 1。失败候选的部分成功不累计；241 已包含在完整工具链 1,561 项内，不再加一次。
- UniApp 完整 13 步全部 exit0，涵盖类型、1,561 项工具链、依赖边界回归、H5／MP／App 干净构建、产物、二维码、实际 i18n 多模式构建及 common security。实际 MP 的新组件 WXML／JS／JSON 与 renderer usingComponents、App bundle 标记均存在。
- 后台 CUA 浏览器完成 18 阶段，90 次实际 API 请求，0 次显式业务写、2 次正常详情浏览与 3 次单列 fixture 配置变更。每次实际 API 核对 16 表／16 序列；两次详情只允许各自 playNum+1、本人首次 browse edge 与对应序列+1。短视频表及 play 关系不变，R2 验收增量写删均 0、对象字节不变，外部调用 0。
- 3／7 两组件首轮独立失败与重试、只读刷新、真实微页面、经导航和版本刷新的 5／2 配置及顺序变化、文字／图片标题、More 主 Tab、图文与真实视频详情、关闭后清空并显式恢复、guest／双账号均通过。视频实际播放另见机器记录。根 schema 原位竞态未混称已经解决；组件本身的原位迟到回执由运行时场景覆盖。
- 每个阶段内容区 375px 且无横向溢出；控制台只有 6 条既有路由弃用 warning、error 0；网络收据另列 1 次故意注入的 503 和 2 次未签名旧附件 404，签名资源正常。367 个最终 H5 文件在实际验收前后 SHA／字节一致。浏览器后台执行，无额外验收确认框，临时页已关闭。
- 8 座自有 PG（含失败候选）分别通过独立 pg_ctl status=3／no server 核对，fixture remaining=0；2775 份保护源、历史正文和 88／404 复选行另由最终机器记录断言。
- 本机 Node 24.19.0／npm 11.7.0，与 CI 固定 24.14.1／11.11.0 有差异；不能将本机通过替代新 SHA 的 Actions。依赖与锁文件保持，raw npm audit82 仅承接历史基线，不冒称本批重跑或全零。

当前 widget 的回执隔离只负责已经由根页面采用的 schema。首页 loadDiy、微页面 reload 及通用 loadDiyPage 仍保留基线既有的重叠请求／旧 schema 与缓存晚回填问题，本批没有声称一并解决。下一独立完整切片建议把 schema／version／cache 与 API-007 userInfor、newVip、signIn、ranking 四个实际消费者的配置、导航、账号及生命周期一致性共同收口；PHP 对应消费者同样没有完整竞态保护，新增代次／owner 硬化应标为 TS 改进。源码哈希与 17 类验收矩阵在 `/tmp/cinashop-diy-next-source.json`，并不代表已经实现或验收。

API-007 父项、DATA-008 运营初始化、真实媒体来源对账、FE-003J／K 设备／账号／发布观察继续开放。本批不合并、不部署，不将本机隔离场景当作真机、生产账号、Provider 或全站迁移完成。

完整命令、捕获源 SHA、日志／报告 SHA、失败候选、27 份下一批来源、构建指纹与逐请求收据均内嵌于[机器记录](../audit/php-ts-diy-community-20261021.json)。临时路径仅作当次定位，关键证据不只依赖临时文件长期存在。提交与新 SHA CI 在发布后另行核实；本记录不自引用未来提交 SHA。
