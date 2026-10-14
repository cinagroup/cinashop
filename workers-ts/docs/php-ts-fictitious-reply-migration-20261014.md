# 虚拟评价与真实商品选择器 PHP → TypeScript 增量（2026-10-14）

本批补齐 3 条真实旧接口，并在现有评价页面接入“添加自评”、商品／普通 SKU 选择和素材选择／上传。评价创建同时完成源代码要求的商品评分更新。本地最终候选有 771 项相关测试定义通过，148 项条件定义全部原生补验；完整结果与输入摘要见 [验证账本](../audit/php-ts-fictitious-reply-migration-20261014.json)。本批未发布，整体 PHP → TS 迁移目标继续开放。

## 旧接口、权限与商品选择

| 方法 | `/adminapi` 下新增旧路径 | 合同与独立能力 |
| --- | --- | --- |
| GET | `/product/reply/fictitious_reply/:product_id` | 0 返回选择商品字段，正数路径 ID 返回隐藏商品 ID；`reply.view` |
| POST | `/product/reply/save_fictitious_reply` | 创建平台自评，消息 `添加成功!`，省略 data；`reply.manage` |
| GET | `/product/product/list` | 活旧 goodsList 消费的 `{list,count}` 与 `attrValue`；`product.view` |

184／185／193 使用真实安装种子的完整 API、方法、菜单路径和 auth 元数据。185 的非空 `product-reply-save_fictitious_reply` 保留；页面 6 只授予评价读取。复制种子、改写完整 tuple、579／580 通配或伪装 API 均不能获得这些权限。评价管理、商品读取和素材读取各自检查，不因新增页面把它们合并为一个能力。单条与批量权限解析均有证明。

PHP 的生成表单 GET helper 仍存在，活旧“添加自评”按钮实际打开 addReply.vue 并 POST。表单投影依据可读 FormBuilder 工厂调用保留 8 个字段、component 类型、默认值和提交地址；完整 PHP 序列化未执行。路径 product_id 确实经 Request.param 读取，不能由 postMore 的名字推断为仅 POST 参数。

选择器保留有效平台／门店／供应商商品，要求审核通过且未删除，允许已下架商品；goodsType=0 不代表平台 owner 筛选。分类沿真实 relation 和分类树读取，标签、关键词／ID／条码、指定 IDs、Supplier、VIP／预售与直播排除按源查询处理；普通 SKU 通过 type=0 和未退役状态提供实际 attrValue。is_new 对应内置标签 4，is_integral 在源 search(false) 中没有 searcher，保持无筛选效果。指定 IDs 保留源排序；当 is_supplier=1 时，源 count 不应用 IDs，而 list 应用 IDs，保留这个计数例外。商品详情源 bind 投影为扁平 description，缺失为 null。

商品与 SKU 的真正 canonical R2 图片按其当前商品 owner 生成临时预览，数据库 image 保持原 canonical；外部图片原值保留。实际旧 goodsList.getList 和现代 API／Axios 消费链均验证到 SQL，不能用新增 stub 的返回形状自证旧消费者已完成。

## 自评身份、源边界与评分

新行固定 `uid=0/oid=0/type=0/relation_id=0/reply_type=product/order_cart_info_id=NULL`，生成独立的 32 字符密码学随机 review unique。输入 unique 仅为所选 SKU alias，不能充当新评价唯一标识。选 SKU 必须属于同一当前有效商品、普通且未退役、唯一无歧义，复制真实 suk 快照；源表单省略 SKU 时保留可选空值，活现代／旧自评 UI 要求明确选择。中央 Admin 可为有效 Supplier 或门店商品创建 PHP 所用的平台自评 tuple，不能伪装真实客户、订单或 Supplier 评价身份。

新建保留完整源默认值及已有 TS 可见性扩展，delivery_score 与 logistics_score 双写。未知身份、订单、owner、可见性字段，冲突的 image.product_id／product_id，非法 ID／评分／正文均拒绝。昵称最多 64、正文 512、头像地址 255、SKU 快照 255 个 Unicode 码点，图片最多 8 项；显式拒绝非法控制字符、孤立代理字符、危险媒体地址及过期签名输入。请求体包括流式读取上限 64 KiB。输入数字字符串、源文本“0”和省略评分的默认值有实际 SQL 覆盖。

评论时间按 Asia/Shanghai 的真实日历与历史 DST 解析，拒绝无效／不存在墙钟时间和未来日期。源 signed int(11) 允许负 epoch：实际保存与读取证明上海 1970-01-01 07:59:59 为 -1、08:00:00 为 0；输入数字 0 或字符串“0”则仍按 PHP empty 分支取当前时间。1969-12-31 自评经实际旧日期查询可筛中。旧查询解析后 epoch 0 的真值／开放边界保持原合同。

PHP saveReply 发出 product.reply，经 listener／job 计算商品 star。本批把该效果同步到虚拟创建、真实 submitReply 和自动 autoCommentOrder 的事务提交前：统计同商品所有 is_del=0 的 product_score，不过滤 owner、UID 或 TS status，以精确数值均值截取一位小数；没有成员时保留原 star。该策略替换源队列的最终一致时序，不声称旧 Queue 部署或运行时延迟完全相同。

虚拟创建除规定的 star 更新外，不改既有客户评价、评论、真实客户、订单／cart、库存、SKU 身份或其他购买证据。真实订单／cart 评价仍按既有来源完成订单，当前商品缺失时保留历史评价而跳过该商品评分。PHP 删除不发评分事件，Admin 软删只改变 is_del，保留 star；下次创建再按当前成员重新计算。

## 私有素材、事务与完整回执

canonical `/api/assets/:id` 不能仅凭猜测 ID 发布。创建必须另有当前 attachment.view，附件必须是可发布的平台普通 R2 图片元数据；外属 Supplier／客户／模块、非法对象路径、矛盾 MIME、缺失附件或带 ticket 的复制引用拒绝。锁定的完整 metadata 在审计后再次读回，改写或删除必须回滚。无 canonical 的既有外部／相对公开媒体不增加素材权限，也不发起外部取图。

数据库仅存稳定 canonical。Admin 列表、公开评价 list／info 及普通／活动商品详情为已授权的 UID0 平台媒体生成 APP_KEY 短签；商品／SKU／info 商品卡预览依据对应当前商品 owner。顾客素材在原商品详情链仍依 UID 和 module owner 判断，不能因 UID0 自评扩展获得平台签名。私有引用无 key、不可用或 owner 错误时为空；复杂旧 JSON 形状、外部地址和数组位置按各自既有合同保留。此为 TS R2 传输扩展，不宣称 PHP 自带同一私有素材服务。

本地 HTTP 用真实 App 的签名验证入口读取返回的 ticket，并以显式 R2 bucket.get stub 返回 PNG 字节；错误／缺失签名按既有资产接口返回 404，且不触发 R2 get。这个证明覆盖本地 HMAC、HTTP 和数据库授权，不包含真实 R2 对象、供应商或生产环境。

写入保持当前 Admin 身份、密码版本、真实角色历史、能力和 JWT 到期复核；管理员权限 barrier 的 NOWAIT 冲突明确返回重试。业务使用既有商品 731617 锁域及商品行，真实订单／cart 锁先行，多商品按商品 ID 升序全部锁齐再写评价。Admin 删除按商品→父评价→线程、Supplier 回复按商品→父评价顺序协调；SKU 与附件 metadata 使用 NOWAIT 防止逆序维护锁造成死锁。语句／锁／事务空闲上限保持短界限，事务内没有 HTTP 或 R2 I/O。

评价 INSERT、规定的 star UPDATE、完整业务行与全部 11 个非 ID 审计字段及正数 ID 均使用真实 RETURNING／回读，并在审计后复核商品、SKU、评价和素材。日志保持 storeId／merchantId=0、Admin 名称／IP 为空，不冒充真实身份 attribution；摘要只含操作与目标 ID，不保存评价内容或私有签名。触发器抑制、完整行改写、审计前／后改写与会话到期均以 SQL／原生回滚证明；这不是对触发器任意全库副作用的检测承诺。

## 前端、共享锁修复与验证

实际 Vue／Element Plus 页面支持分页商品选择、真实普通规格、素材选择／上传、canonical 提交、刷新后的签名预览；写结果未知时先读取确认，不重复发送。独立 product.view、attachment.view／manage、reply.manage 失效各自停用对应操作；权限变化与旧异步响应不能把已关闭或已换会话的弹窗重新写回。浏览器发现素材权限提示把临时 disabled 状态当成撤权，已修复真实 picker 的提示条件，保留原按钮禁用和提交 guard。

[最终浏览器回执](/tmp/cinashop-fictitious-qa/final-summary.json)记录真实 Chrome／Playwright 的 7 个流程、1360×900 和 390×844 两个视口，15 个状态／截图检查；移动端表单 footer 可滚动到达，无页面横向溢出或框架错误覆盖层。所有 API 为明确本地 mock transport，该回执不证明 SQL、JWT、HMAC 或 provider；自有 Vite／Chrome 退出及 4974 端口关闭另有清理证据。Browser 插件当时不可用，未为此安装新依赖或使用 preview 绕过。

扩大原生验证发现共享 ProductUnitLifecycle 把真实 SKU editor 的 750 ms 锁等待界限改成 2 秒。修复只保留调用方更严格的有限值；0 表示无限时取 2000 ms，较宽有限值上限同为 2000 ms，既有 namespace、错误路径和 checkout 断言不变。新增一个原生测试定义，在真实独立 peer 内覆盖 0／750／2000／5000 四种输入×commit／主动 rollback，实际 helper 锁与 pg_settings 证明得到 2000／750／2000／2000 ms，statement／idle 不变，结束后 session 设置恢复。此证明限定共享 helper 和该 Admin 并发路径，Supplier 后续分支另设的限制仍按各自合同判断。循环不另计定义；两完整原生专项的 25 项通过作为修复确认，最终去重总数不重复累加该重跑。

| 最终验证事实 | 结果与计数口径 |
| --- | --- |
| 完整普通测试（49 文件） | 623 通过，148 条件定义跳过，0 失败 |
| 完整原生 PostgreSQL（28 文件） | 356 通过，条件定义补验见逐定义回执 |
| 去重 | 普通／原生重合 208 只计一次，合计 771 |
| Worker 两套完整类型 | 标准及 runtime；最终终态退出 0 |
| Admin／Supplier | 各自完整类型检查与 Vite build；最终终态退出 0 |

八项检查均按上级 AGENTS 的共享串行入口运行，Vitest 单 worker，Worker 完整类型使用 8192 MiB。以最终 [逐定义计数](../audit/fictitious-20261014/verification-summary.json)、各执行 status／raw log 与 [冻结输入](../audit/fictitious-20261014/frozen-before.json)为准；冻结摘要为 `39e342050e8db8107f869dc2b3cf11fb6cf43e40e06e8f721d6bad3340caf7e4`。声明目录完整枚举与配置、包／锁、入口和实际消费者输入的哈希不等于全部构建图，环境值、已安装依赖字节、真实生产数据与 provider 状态在证明范围外。

历史失败不覆盖、不计最终通过：源形测试的完整表单数组／扁平 description／权限排序修正、native 媒体锁测试误用持锁者单连接 pool 的控制死锁及 teardown 孤留 fixture、扩大普通时覆盖审计旧调用文本／缓存响应头计数、完整类型错误和扩大原生时共享 unit 超时覆盖均有原始回执。自有孤留 fixture 的 cleanup 单独记录；只针对明确终态且停止的自有集群恢复／清理，不因观察超时重启测试。最终进程、数据库余额和集群停止状态由账本逐次核对。

[独立源码复核](../audit/fictitious-20261014/source-independent-review.json)保留其当时输入与结论；后续纯测试控制、类型和共享 unit 修复由最终交付复核补审，不刷新旧摘要冒充当时源码。上一批评价／Rule 报告、账本和复核回执保持历史原貌。

PHP 解释器、编码 BaseController 和完整 FormBuilder 应用没有执行；旧 SPA 实际脚本消费者的本地编译／Axios 证明与 PHP 全运行时证明分开。未提交、推送、修改生产数据、发布或下线 PHP。整迁移父项、完整旧商品列表导航／浏览器别名、全局 get_script 既有冲突、全库 CI 与真实账号／设备／生产验收继续开放。

