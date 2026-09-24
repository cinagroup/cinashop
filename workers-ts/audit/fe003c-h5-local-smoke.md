# FE-003C 本地 H5 路由烟测

2026-09-25，在隔离工作树运行 UniApp Vite H5 (`127.0.0.1:5174`)，将 `/api` 代理到本机只读夹具 (`127.0.0.1:9191`)。夹具源码为 `view/uniapp-ts/scripts/agent-self-service-h5-mock.mjs`；使用 `node scripts/agent-self-service-h5-mock.mjs` 和 `CINASHOP_API_PROXY_TARGET=http://127.0.0.1:9191 npm run dev:h5 -- --host 127.0.0.1 --port 5174`，浏览器中预置合成 `uni_token`/`uni_uid`。浏览器视口为 390×844。夹具仅返回合成推广员申请、代理商申请、员工和类型 2 代理协议；不调用生产 API，所有写请求返回 404。

| 操作 | 本地观察 |
| --- | --- |
| 打开 `http://127.0.0.1:5174/#/pages/users/agent/apply?id=9` | 页面标题“申请代理商”；从 `/api/division/agent/apply/info` 读取编号 9、拒审理由；从 `/api/agreement/2` 显示类型 2 协议，资质图片和邀请码保留。 |
| 点击“查看审核状态” | 导航到 `/#/pages/users/agent/state?type=agent&id=9`；显示编号 9、拒审理由和刷新入口。 |
| 打开 `/#/pages/users/agent/record` | `/api/user/promoter/apply/info` 与 `/api/division/agent/apply/info` 都被读取；同页展示各自当前申请，没有 Supplier 记录或 Supplier 跳转。 |
| 打开 `/#/pages/users/distributor/apply?id=7` | 页面标题“申请分销员”；展示合成 UID 11、真实姓名、拒审状态与分销说明。 |
| 打开 `/#/pages/users/agent/state?type=agent&id=999` | 夹具实际申请编号为 9；页面显示“申请编号与当前账号不匹配”，不显示他人或错号申请。 |
| 日期修正后刷新记录 | 代理申请 Unix 秒数 `1727160000` 与分销员无时区 UTC 字符串 `2024-09-24 06:40:00` 均显示为 `2024-09-24 14:40`；该 390×844 H5 页面复测无控制台 error。 |
| 打开 `/#/pages/users/agent/staff_list` | 显示合成 UID 33、Test Staff、比例 10%、2 单及修改/移除按钮；本次只读浏览未触发写操作，控制台无 error。 |

浏览器控制台在上述页面报告 0 条 error，1 条既有 DCloud 内置 `vue-router/dist/vue-router.esm-bundler.js` deprecated warning。最后一次日期/员工复测的夹具日志为推广员申请信息、代理申请信息和员工列表三个 GET；员工弹窗与比例写入另由 Vue 运行时隔离测试验证。浏览器原始网络事件收集受本机浏览器权限限制，因此此处不声称完整请求清单。

此烟测不覆盖真实客户账号、短信投递、验证码发送/消费端到端、图片上传、员工实际角色/数据、微信小程序或 App 真机、生产发布。旧 PHP 的 `agent/record` 实际复用了 Supplier 记录和导航，新的双域记录只展示当前未删除申请，不提供已删除历史。上述外部门禁仍归 FE-003J/K。

本地独立 PostgreSQL 16.15 测试 `agent-application-postgres.test.ts` 执行两个真实 Hono 路由与 SQL 写路径：代理申请预检失败、类型 2 协议停用时不消费验证码；错误用途不写记录；正确用途写入 `division_apply` 后不可重放；分销员路径的错误用途、写入 `promoter_apply` 和重放亦核对。另以独立 PG 后端锁竞争验证申请审核／重提和角色删除／重提两种顺序，完成 4/4。Redis OTP 锁/缓存使用测试内存替身，未调用短信服务商。新增专用 purpose 的线上旧客户端需原位升级；真实 AppID、签名、各渠道版本和旧 API 域名仍待 FE-003K 核对。

候选本地门禁：Worker 双类型检查通过；Worker 申请/SMS/协议专项 19/19，通过；隔离 PostgreSQL 16.15 四条路由/并发场景 4/4，通过且 `FINANCE_LOCAL_FIXTURES remaining=0`、`FINANCE_LOCAL_STOPPED`；UniApp 类型检查、完整工具链 752/752、H5/MP-WEIXIN/APP-PLUS 三端生产构建及产物核对 3/3，通过；151 条旧路由台账审计通过。工具链在隔离工作树借用依赖 junction，运行时使用 `NODE_OPTIONS=--preserve-symlinks` 保留本工作树路径；不作为 Linux CI 的替代证据。
