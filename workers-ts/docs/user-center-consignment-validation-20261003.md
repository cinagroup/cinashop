# 个人中心待发货统计合同纠错（2026-10-03，本地修复，未发布）

## 当前增量：待发货统计的旧筛选合同纠错（2026-10-03，本地修复，未发布）

旧 get_date 的 status=1 是 DAO 筛选器：已支付、原始状态 **0/4**、退款状态 **0/3**、配送方式 **1/3**，排除用户及系统删除订单，商家订单只计 **pid=0/-1**。上批查询把原始状态1误计为待发货；本批用共享状态谓词修正，并与个人待发货计数复用。当前有效店长及明确有效门店集合继续限定统计范围；支付金额与订单总数口径不变。原始状态1保留为必须不计的真实数据库反例。

当前后端 **485 项独立用例通过**（226 项原生 PostgreSQL/SQL-HTTP，259 项其它运行时/单元/嵌入 SQL）；双类型及完整源/mutant三套 **295/295** 通过。真实 SQL 覆盖16个正向组合、各状态/支付/退款/配送/删除/父子与跨门店反例、失效/重复身份及 HTTP/只读一致性；不把组合数累加为独立用例。旧20项 workerd HTTP 因 Windows启动崩溃未进入业务断言，本次仅统计修复未重复执行，仍待可运行环境复验。

注册路由与前端源未变，日期分布仍为 Worker2206、PHP1904、可执行890、可行动URL缺口976、有效覆盖47.2%；个人中心仍24/26 partial，statisticsTwoStyles/menuRoleGates保留false，checklist246完成/158开放/404不变。旧商家经营概览、管理订单列表/详情与发货操作，客服/工作台/配送目标页及真实provider/设备/生产发布继续开放。配送旧status2/9也须另批对照DAO selector，不能凭原始状态补UI。

原首批 master/proof及所有 producer 字节副本完整保留；本批从36824条当前入批摘要开始，逐项分类改动，保护33个历史构建目录/9236文件。客户端14份源码、H5/MP/App962份产物、原后台与客户端浏览器22+26组报告均保持原始字节；本批新增浏览器执行0、构建0，原受控HTTP截图不证明这次SQL修复。当前4个自建PG集群已停止且端口关闭，诊断数据保留。

详见[本批验证](user-center-consignment-validation-20261003.md)、[新冻结验收](../audit/user-center-consignment-acceptance-20261003.json)；下方保留首批及既有历史。


旧调用链是 PublicController.get_date → BaseServices/BaseDao.count → StoreOrderDao.search → StoreOrder model searchers。DAO 的 status selector1包含原始0和4（部分发货仍待发货），不是原始1（已发货/待收货）。筛选本身没有store/type/orderType/供应商条件；当前系统保留已审阅的有效店长、orderStatus与有效门店范围，未恢复旧全平台读取。状态谓词只承载订单状态条件；门店、账号及父子归属留在调用查询中。个人计数既有pid>=0与商家pid IN(0,-1)分别保持。

修复由 UserCenterPublicReadService 与 OrderReadStatusPredicate 实际消费；金额price、订单数num和其它统计查询保持原条件。原生PG矩阵在真实 SQL 与真实JWT/Hono HTTP查询验证正确计数及失败关闭，并校验读取前后订单/账单/余额等原始数据不变。两次公开读取的actor/revision/consistency_key协议、管理身份重验与未知写意图规则保持。当前完整预测试输入独立冻结，不复用首批2276份旧输入冒称修复后源码。

本批前端没有修改：Admin运行时32、Uni运行时48及四处资源构建、浏览器22+26组为首批已执行且源/产物仍逐文件一致的证据。它们覆盖编辑器、布局、收藏与会员码等交互，不代替新增SQL语义测试。首批六项页面QA均保留可点击报告；后续交互审查可启用Browser插件，当前已安装Playwright/Chrome的验证原样保留。

| 六项页面检查 | 保留证据与结果 |
| --- | --- |
| 首屏资料与主要操作 | 原桌面/手机通过，当前源及产物不变 |
| 主流程 | 六模块保存、收藏、付款码原交互通过 |
| 控制台与未处理异常 | 原未预期0 |
| 资源与HTTP | 原未归因0，受控故障明确归因 |
| 响应式布局 | 原390×844无横向溢出 |
| 空态、恢复、账号切换 | 原实际交互通过 |

两份master、独立proof、失败尝试与诊断数据不覆盖。本批没有安装、提交、推送、部署或生产DDL/grants。新reader只读检查新源及before/capture、所有历史group记录和完整目录、实际终端输入/日志、前端复用证明及全部本批端口；以生成的[新冻结验收](../audit/user-center-consignment-acceptance-20261003.json)和[独立证明](../../.cache/user-center-consignment-acceptance-independent-verification-20261003.json)为准。
