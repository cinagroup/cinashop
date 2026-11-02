# 后台分配与店长整单快递页面

第41轮接通第39/40轮的实际前端；付款根、用户、财务门店0和原商品库存来源保持原合同。没有生产DDL、部署或真实微信调用，`runtime_ready=false` 与整体 PHP→TS 迁移未完成状态保持。

## 页面与原请求

Admin 订单详情进入 `/order/fulfillment-assignment?order_id=<numeric-root>`；订单列表另有无查询参数的原请求恢复入口。页面读取当前核对和有效门店游标目录，显式确认批准、改派或撤销；不从旧列表推导履约归属。不在本轮页面续批相同目标门店，需要变更时可先撤销再重新核对。后端仍在提交时重证当前角色、门店、完整批准链、CAS与来源；客户端 hash 不提供权限。

登录后的专用恢复路由不要求仍有 `order.view/manage`。原作者在角色丢失后可读取本机待核对索引和最小 owner receipt；新 review/目录/提交仍按当前权限。独立8字段 journal 先校验请求/作者/hash，可靠保存并回读后才发 POST；按订单的 Web Lock 和原字节 CAS 防止标签页覆盖，recorded tombstone 保留。未知结果不删记录、不换 UUID、不猜失败；恢复只使用原键和原内容。账号、token、storage、路由和实际 hash await 后均有会话/epoch 栅栏；缺 Web Locks 或安全 UUID 能力关闭写入并给出可见错误。

UniApp 新增 `pages/merchant/assignedOrders`，旧 merchant/orders 的入口位于当前门店上下文错误面板之外。旧列表仍按真实财务 `store_id` 读取，不因 grant 扩张。新页先显示独立 journal 的原请求恢复，再读取当前门店和专用待办；只有当前 review 才展示收件人、原整单商品、有效承运商和单号确认。发货仅整单手工快递，不包含分包、自提、虚拟、退款余单或物流更正。

Manager 请求捕获原 UID/token/sessionVersion，并核对持久凭据；门店、账号ABA、隐藏/卸载与晚到响应清除私有核对数据并取消请求。H5 要求 Web Locks；原生 Uni 分支使用既有单JS运行时内的 journal/CAS，未验证多个原生 WebView/进程之间互斥。pending 在网络前持久化；回执要求完整25个公开字段，并关联本机保存的原 intent/hash。角色丢失或旧 context 被拒绝不遮盖 owner GET；恢复 POST 仍需当前门店身份。页面明确区分“发货已记录”和“渠道上报已完成”。

## 专用待办读取

新增 GET `/api/store/manager/assigned-order/inbox?store_id=<id>&after=<id-or-0>`，仅接受唯一门店和可选游标，固定10条与第11条前瞻。实际独立 Manager LOGIN 在 RR/RO 事务中先证明原用户与当前员工 scope，再按当前 grant head 发现候选；NOT EXISTS 检查所有更晚 ordinal，撤销、改派和已发货单不继续显示。

每个候选（包括前瞻）都核对完整不可变链与付款根身份；损坏、超64项、错误买家/财务门店或缺根关闭整页，不静默跳过。结果只带 `requires_review`；不冒称已完成 cart/revision/路由/退款/冲突证明，新 review 与锁内 commit 继续执行这些证明。没有增加 SQL 权限或重写财务门店。

## 执行与保留的失败

全部重型命令使用固定 Node24.14.1/npm11.11.0、自有 PG16.14、单层共享串行锁、Vitest单worker、原内存与每阶段600秒限制。

| 批次 | 实际结果 |
| --- | --- |
| manager-02 native | 完整15项通过，196.63秒；含原10项业务和5项待办；输入不变、remaining0/STOPPED。 |
| admin-03 | 64项通过（新14+既有50），4.83秒；Admin vue-tsc/Vite构建86.26秒；选定707个Admin图输入不变。 |
| final-06 | Admin64项6.11秒、Admin构建93.62秒、Uni行为61项（新19+既有42）17.12秒、Uni类型27.53秒/H5构建37.14秒、Worker unit/runtime类型218.18/109.63秒；8535个输入不变。 |
| browser-07 | 一个完整 createApp/Browser 场景、9个顺序核对阶段通过，外层401.84秒；8535输入不变、remaining0/STOPPED。 |

待办正例由实际下单、付款回调和 Admin 作者产生；真实11根分页、改派/撤销/发货移出、错误角色/门店/查询、来源仍需review均执行。损坏前瞻和65事件链为明确的维护SQL负例，不是合法作者产生的正向历史。页面行为测试使用实际SFC/组合函数/transport与标注的 HTTP、storage、dialog fixtures，不累计为数据库或浏览器结果。真正 hash await 的账号ABA与缺 UUID 均有实际SFC执行。

首次 manager-02 Uni 行为为60通过/1失败：旧测试依赖不存在的 `.cache`，且108/109页计数早已过时。改为内嵌固定提交审计的真实98原路径和父提交2681f27b的153路径，固定来源/数组hash，最终核对154唯一路径、首页与所有旧路径保留、仅新增assignedOrders；没有虚构98页提交或删断言。新增 `test:manager-assigned-fulfillment`，只在 toolchain 尾部追加，依赖及lock文件未修改。

frontend-04 的Uni61项、类型/H5构建通过，但Worker unit类型实际失败5处；修正共享代码的`globalThis.crypto`跨声明写法和测试回执字面量类型后，final-06重跑全部受影响前端、构建与两套Worker类型。原失败保留，不以旧类型结果替代。

browser-05 真实失败：Vitest缓冲console导致监督未发现早已存在的ready.json，操作窗口后段只完成Admin丢失响应与owner恢复两个核对阶段；六分钟窗口到期，外层521.05秒、输入不变、remaining0/STOPPED。不是数据库死锁，也不能算完整Browser成功。仅修正仓库外监督程序，实时读取新ready.json并转发；没有修改已验证源码、重启活跃进程或提高时限，随后browser-07完整通过。

## 实际浏览器证据与边界

使用可用的 Codex In-app Browser/CUA，无外部Playwright驱动。两个本机loopback origin服务实际构建的Admin与Uni页面；iframe内操作真实路由、axios/uni请求、JWT、createApp和独立commissioned App/Admin/Manager LOGIN。身份会话bootstrap、角色切换和丢弃已提交响应是明确的本机QA控制；批准/改派/撤销/发货均由实际产品DOM/API完成，未用维护SQL制造正向业务结果。

两笔实际Admin assisted checkout→默认RSA/AES Routine回调→App paid订单：第一笔由UI批准77、丢响应、失权owner恢复、改派78、撤销；第二笔UI批准77→Manager待办/current review→整单真实notice/成功ledger→丢响应→撤销店长身份后owner恢复。9阶段共56个实际API请求，两个已提交响应丢失控制；4条真实分配事件、1条Manager发货回执。原账号策略批准及provider/Queue/KV使用本机传输适配；改当前配置为B后断言实际token、上传AppID和付款人仍来自旧A，真实App dispatch actor，锁外传输与重复消息只上传1次。App仍不独立读取或验证新的Manager分配回执。

各阶段比较全部cart/商品/SKU原值和第一笔根全值；第二笔根仅允许7项预期发货字段变化。最终重算3392个源码文件和Admin358/Uni557个dist文件，与初值逐项一致。没有把仅记录构建manifest当作最终复核。

页面身份、非空内容、无框架错误覆盖层、实际交互和截图均核对。Admin桌面截图1163×858；Manager请求390×844移动视口，full-page截图375×1324，页面内容宽338/354且等于scrollWidth，无横向溢出。Admin无warn/error；Uni两条既有vue-router深路径导入弃用提示，无相关应用错误。QA外框与产品iframe均在截图中明确可见；焦点回到Manager时会刷新并清除旧review，重新核对后继续。

证据及截图只保存在本机仓库外 `/tmp/cinashop-assigned-fulfillment-browser-0ff10840-c9b1-470c-a4af-eb80b5fff0d8/`、`/tmp/cinashop-phase41-shots/`；执行日志/输入摘要在本地忽略目录`.cache/php-ts-phase41-validation/`。独立只读复核核对接口、journal、证据范围与验收host，无独立重跑或安全审计声明。

未验真实登录表单、原生小程序/设备、多进程互斥、Workerd/Hyperdrive、生产环境或真实微信。现有用户/UID/权益/旧单/付款保留，未知AppID归属不猜；完整归属manifest、原子切换许可、其他迁移及CI缺口仍待推进。旧2681f27b远端Uni为实际cancelled、20分17秒，原因尚未确认；PC/Kefu依赖审计失败，不能宣称整体CI通过。
