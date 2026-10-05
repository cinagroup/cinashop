# 手机经营履约写链验证（2026-10-04）

本批本地履约写链及最终执行验证已完成，完整 customer 手机角色仍为部分承接。当前源码、实际输入、失败尝试、产物与前后副本由不可覆盖的验收清单组织；最终递归字节核验以独立验证收据的实际 passed 与进程退出值为准。没有提交、推送或部署，Checklist 父项仍开放。

## 当前分布与承接范围

实际路由审计：Worker 2272／PHP 1904；911 精确匹配中 890 可执行、21 受控不可用，993 原始缺失减 17 退役后为 976 可行动旧 URL 缺口，有效覆盖 47.2%。新增 17 条独立 UserJWT 合同，不借用旧 AdminJWT 路径等价计分。

| 合同面 | 当前 Worker 路由 | 可行动旧 URL 缺口 |
| --- | ---: | ---: |
| API | 1211 | 11 |
| Admin | 786 | 908 |
| Supplier | 164 | 49 |
| Kefu | 70 | 0 |
| Out | 41 | 0 |
| ERP | 0 | 8 |

Admin 缺口约占 93%，仍是下一阶段主体。Uni 清单 116 页；151 旧逻辑路由为 28 直连／112 兼容／11 缺口，兼容含 62 候选／50 部分。新增 customer-work/delivery，旧 admin/delivery 别名保持 partial。个人中心 25/26 partial、menuRoleGates=false；Checklist 246 完成／158 开放／404 总项的原标题与勾选不变。

| 已实现合同 | 实际边界 |
| --- | --- |
| 原订单备注 | 独立备注 GET 与原实体 POST；负支付父单没有或有多个待履约子单时仍能备注 |
| 手动、配送员、虚拟与拆单 | 唯一 customer=1 的真实用户身份；真实订单、根单、门店、供应商、商品数量；成熟拆单金额、赠品及售后事务 |
| 电子面单 | 独立 customer actor 与实际 service_id；原 UUID 意图回执、商品快照、当前资格、快递及配置在 provider 调用前复核 |
| 面单恢复 | UNKNOWN 不盲重签；应用原单、确认已签发、明确允许重试或关闭；新决定编号绑定原任务与版本 |
| 同城派送 | 实际站点、配置、达达报价下单、耐久任务／attempt／provider 绑定、回调、查询恢复与既有定时补偿；UU 未 commissioning 时默认不可用 |
| 通知 | 取消后新任务有独立不可变通知编号；已取消旧通知不借新配送状态迟到发送 |
| 页面恢复 | 同账号原 UUID、原意图先存储；丢失响应不能证明失败；撤销资格后清空敏感信息，仅保留本人最小回执读取及确认 |
| 账户并发 | 发货与备注在原事务中锁定真实操作者账户；撤销不能先于写事务提交，撤销提交后新的写入被拒绝 |

## 路由合同

以下均在 /api 前缀下，经营读写及结果响应保持 private/no-store。写入使用服务端返回的真实数字实体 ID、原 UUID 与复核版本。

| 方法 | 路径 | 合同 |
| --- | --- | --- |
| GET | /mobile/work/orders/:id/fulfillment | 真实目标、商品、版本及渠道可用性 |
| GET | /mobile/work/orders/:id/remark | 原实体备注与独立版本 |
| GET | /mobile/work/fulfillment/carriers | 当前启用且唯一快递目录 |
| GET | /mobile/work/fulfillment/couriers | 当前有效配送员 |
| GET | /mobile/work/fulfillment/defaults | 默认寄件配置，无凭据 |
| GET | /mobile/work/fulfillment/templates | 真实渠道模板及配置复核 |
| GET | /mobile/work/fulfillment/waybills | 根单、门店供应商与本人任务；拆单剩余子单仍能查原任务 |
| GET | /mobile/work/fulfillment/waybills/:id | 原任务、持久回执与版本 |
| GET | /mobile/work/fulfillment/waybills/:id/actions | 本人恢复历史 |
| POST | /mobile/work/fulfillment/waybills/:id/decisions | 四类明确恢复决定 |
| POST | /mobile/work/orders/:id/fulfillment | 整单手动／虚拟／面单／同城受理 |
| PUT | /mobile/work/orders/:id/split-fulfillment | 选品选数量拆单 |
| POST | /mobile/work/orders/:id/remark | 原实体备注 |
| GET | /mobile/work/operations/:key | 本人最小结果；空结果不代表失败 |
| POST | /mobile/work/operations/:key/abandon | 原编号、原意图串行确定放弃 |
| GET | /mobile/work/operations/city-jobs/:id | 本人原同城任务状态 |
| POST | /mobile/work/operations/city-jobs/:id/recover | 查询原渠道事实，不创建第二次配送 |

## 最终执行验证

当前输入下 Worker 唯一 159 项通过：普通 LOGIN 履约 65 项（43 新写链＋22 原读链）、同城 27 项、显式 PG16 目录 2 项、Root 65 项（37 真实主题宿主及负例＋28 面单、权限、拆单与通知回归）。Uni 42 项（27 履约＋15 原读链）与窄类型通过；标准 Worker unit/runtime 原配置完整类型均通过，没有临时 DOM 声明或补充配置。

Uni 完整类型及 H5、微信小程序、App 构建通过，共 1141 个真实文件（294 H5／712 小程序／133 App／2 sibling .nvue）。借用依赖已恢复原空目录，锁文件及依赖字节不变。编译语义 6 项、实际 H5 浏览器 20 组及单列 QA6 通过；桌面、手机宽度与备注焦点截图已实际查看。这里只记录浏览器响应式与焦点验证，真机系统键盘合同仍开放。

真实失败发现并修复了拆单剩余子单面单断链、同城未安装读取、快照回执 DTO、资格／站点／配置复核、取消重派通知编号、HTTP200 业务拒绝后的敏感信息清理，以及账户撤销并发。未修并发实际见证保留：不同普通 LOGIN/PID 的撤销先提交，原发货仍提交；修后发货与备注都得到真实 NOWAIT 55P03 排他见证，随后撤销成功且新写拒绝。六种失效账户分别验证发货与备注无变更、无回执。

最终递归验收首轮在原真实单对象 absence 收据解析处退出 1、完成哈希 0；原 master、reader、proof 与执行收据保持，新版精确兼容该格式并继续保持唯一观察、真实时间和继承不存在约束。所有失败、零执行初始化和被替代通过保留，不累计旧通过数。浏览器前两次分别为 3/20 与 19/20（实际选择器／fixture 假设失败），最终 20/20；原日志、截图与版本脚本均保留。验收逐项绑定实际进程、输入、计数日志、当前构建与结果，保护前批 68 个目录／19982 文件并增量保留本批 4 个目录／1141 文件。最终独立收据同时检查每个当前输入与全部继承字节，原验收 master／reader／proof 不改。

## 明确安装与生产边界

操作回执表、三个 customer 锁函数、0091 面单 customer actor 前进迁移、0173 同城三表与站点列均为独立 owner 维护操作，没有加入启动自动安装。PG16 实际安装测量覆盖完整列、默认值、CHECK、FK、索引顺序／算子类、触发器与目录指纹。运行账户仅有操作回执 SELECT/INSERT、资格与目录只读（聊天 online 原更新保留），同城只允许指定状态列更新。

UU 公开 V3 SDK不能证明完整生产合同；originId 与重量映射、真实 provider 配置／签名／站点、回调 origin、生产列权限、真机、Linux/Hyperdrive、容量与发布继续开放。

## 下一批未完成合同

完整 17 管理页＋5 代客页、43 个 admin.js 函数与 ERPconfig/express 辅助合同仍 partial。按缺口推进商品/SKU、用户分组标签等级与优惠券，再推进改价、线下付款、退款财务、余额积分、代客选客到支付和独立核销。旧详情 give_coupon/give_integral、virtual_info 与优惠积分扩展仍开放。

[实际路由分布](../audit/route-distribution-customer-work-fulfillment-followup-20261004.json)、[当前 Uni 合同](../audit/uniapp-frontend-parity-customer-work-fulfillment-followup-20261004.json)、[本批验收清单](../audit/customer-work-fulfillment-acceptance-final2-20261004.json)、[独立物理验证](../../.cache/customer-work-fulfillment-independent-verification-final2-20261004.json)、[前批七页读链](../audit/customer-work-read-acceptance-final3-20261004.json)。
