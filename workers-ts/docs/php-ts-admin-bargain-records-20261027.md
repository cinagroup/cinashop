# Admin 砍价运营记录与统计迁移（2026-10-27）

本轮补齐 PHP 原运营查询流程：全局参与记录、活动六项汇总、参与人和订单分页、帮砍明细。新页为 `/activity/bargain-records` 与 `/activity/bargain-statistics/:id?`，保留原 `/admin/marketing/store_bargain/bargain_list` 和统计页别名。六个新 GET 与五个原 PHP GET 均在 `/adminapi`、`/api/admin` 可用。

查询恢复原字段、日期/状态筛选和十五条分页，增加有效的昵称、UID、电话等字面搜索。金额保留十进制字符串，当前价为起价减已砍金额；帮砍数正确按参与记录及活动关联。注销、取消、缺失关联和状态4历史保留，过期只作展示，不触发结算。修正旧 PHP 订单列表/总数不一致与拆单重复统计：卡片、列表、总数统一按已支付主订单计算，保留退款/删除后的毛额历史；支付转化率保持旧版先截断再乘百分比的口径。帮砍次数、发起记录、可购买记录和订单数均明确标注，避免误称去重人数。

全局与统计分别使用 `bargain_record.view`、`bargain_statistics.view`；原数字菜单仅按固定 PHP 安装元组映射。订单详情另需 `order.view` 和有效业务订单号。帮砍详情按参与及活动双重约束，输入、重复参数、日期和分页均作显式校验（每页最多100、偏移最多10000）。所有业务读取均为有界的 repeatable-read/read-only 事务，不放宽更严格的调用方超时。原砍价、帮砍、取消、订单/财务写者、数据库权限计划、schema及生产 DI 均保持原字节。

本地验证：

| 检查 | 结果 |
| --- | --- |
| 后端业务及原权限/拼团回归 | 121 通过 |
| 真实 Vue/Pinia/Axios 原生事件 | 52 通过 |
| PG16 当前 App/Admin 独立 LOGIN、实际 Hono/JWT/default DI | 2 通过 |
| 来源绑定 | 4877 通过，原35套4681个完整用例身份保持 |
| Worker 两套类型、Admin 类型与 Vite | 通过 |
| API 静态清单 | 795 调用 / 833 变体，零缺口，原827完整调用对象保留 |
| 桌面/375px/320px 渲染及交互 | 十图逐张复核，六项 QA 检查通过 |

原生数据库用例覆盖真实五个旧地址和六个新读取接口、旧数字权限、角色/菜单/密码撤销、整库283表和序列无业务写入、并发 count/list 同快照及意外 DML 的25006拒绝；fixture清零、服务已停止。前端覆盖分页/筛选/重试、帮砍明细、只读角色、独立订单跳转，以及账号、令牌、页面、权限和查询切换后旧响应与旧事件的失效。浏览器使用已安装 Playwright/Chrome（Browser plugin/browser skill 未提供），本地 `http://127.0.0.1:5224/admin/marketing/store_bargain/bargain_list` 构建产物和受控 GET 夹具；GUI 不代替真实 SQL/ACL 证据。验收中唯一503控制台错误为刻意的读取失败/中文重试场景，随后重试成功；无非预期网络、框架覆盖层或页面错误。安装 Browser 插件后可在应用内执行这类渲染验收。

主要命令：共享 `validate-serial.sh` 外层串行运行 `validate-final.py`、`freeze-and-source.py` 和 `run-browser.py`；Vitest 单 worker，原生 PostgreSQL16 隔离库。原始 stdout/JSON、完整运行输入、26份固定 PHP 全文、整文件前后像、失败尝试和图像见 `/home/cina/cinagroup/cinashop/.cache/migration-evidence/admin-bargain-records-20261027`。来源 proof SHA256 `8a16677fdec197431c839311f311aa3a54cbe9d85904578344af9799e23ed95f`。1739份旧证据字节冻结，原旧生成产物由精确物理缓存读端口复验，新构建产物独立绑定。

首次原生 HTTP 失败为 Node 连续模拟 Worker 请求未回收连接导致夹具连接额度耗尽，修复只清理本库已完成请求连接；首次最终回归失败为新权限缺少目录路由覆盖样例，补齐真实样例且保留原完整断言。失败和中间成功不重复计入最终 5052 个唯一通过用例（新增 277）。

验收范围为本地隔离环境；真实生产数据规模、生产部署及远端 CI 不在本轮证据内。整体 PHP→TypeScript 迁移、ADM-002/FE-001 仍开放。
