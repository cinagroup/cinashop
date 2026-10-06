# 分销员申请审核本地验收（2026-09-26，未发布）

已确认 Browser 插件可用，本轮使用 CUA 的 Codex 内置浏览器完成实际 Admin 生产构建页面交互。服务仅监听 `127.0.0.1:5198`，提供本机内存合成账号及申请，不代理生产、不访问数据库。SQL和并发行为由下列数据库测试另行覆盖，不能将合成浏览器服务等同真实后端端到端验收。

| 场景 | 观察结果 |
| --- | --- |
| 只读角色 | `distribution.view` 可读，审批/拒绝/删除按钮数量为0；31条申请每页15条，第2页及UID搜索正确。 |
| 审批 | 确认框显示姓名、UID及获得分销资格的后果；提交一次POST并带revision，重读后显示已通过与审核时间。 |
| 拒绝 | 空理由出现1–1000字验证提示且无写请求；填写合成理由后拒绝，列表显示对应原因。 |
| 末页删除 | 第3页仅ID1，确认提示不撤销分销资格；DELETE携带revision，随后GET第3页再GET第2页，最终Total30、15条记录、下一页禁用。 |
| 列表失败 | 显示明确失败及“重新读取申请状态”；重试GET后恢复15条，无旧行残留。 |
| 响应丢失 | 夹具先保存审批再断开连接；页面提示结果未确认，随后GET显示已通过。第二阶段请求记录只出现一次审批POST，无自动重写。 |
| 状态筛选 | 选择已通过后请求`status=1`，只返回已通过记录。 |
| 桌面/手机 | 1440×900与390×844；手机文档宽390且scrollWidth390。窄屏取消固定操作列并提示横向滑动，避免操作列挤压身份信息。 |
| 控制台与清理 | 最终浏览器error/warn为空；视口已恢复，测试tab关闭，5198服务已停止且无监听。 |

两阶段合成请求记录合计65次API请求：60 GET、3 POST、2 DELETE。夹具重启重置内存，两个删除分别属于不同阶段；仅操纵此夹具的可丢弃数据。浏览器截图和原始请求记录保留在本次工作区外的本机验收目录：

- `C:/Users/cina/.codex/visualizations/2026/09/26/01a0db11-74a0-7cc2-b1f9-ee3b8653056a/promoter-desktop.jpg`
- `C:/Users/cina/.codex/visualizations/2026/09/26/01a0db11-74a0-7cc2-b1f9-ee3b8653056a/promoter-mobile.jpg`
- 同目录 `promoter-qa-requests-phase1.json` 与 `promoter-qa-requests.json`。

使用内置浏览器时，部分定位器点击没有激活预期控件；读取页面后改用可访问控件的Enter/方向键完成交互。夹具原生form提交未生效，改为夹具按钮显式发送本机请求后正常；未修改产品表单来绕过验证。截图使用Browser tab截图API，等待结果渲染后保存。

## 工程验证

- `admin-promoter-applications-frontend.test.ts`：12/12，使用真实Vue与Axios，覆盖权限、失败重读、版本、原因、会话变化及迟到响应。窄屏修订后重新通过。
- 新审核SQL、原生并发与既有申请/SMS测试：PGlite22/22，原生PostgreSQL16.15四文件31/31、零跳过，共36个不同后端用例，包含9个真实并发场景。原生runner报告夹具余留0及实例停止。
- 路由/接口/逐屏/UniApp/权限/导航目录相关九文件60/60（含上方12项前端测试），即另48项通过。
- Worker单元与runtime类型检查、最终Admin类型/生产构建通过；独立后端合同复核无剩余可行动问题。
- 旧砍价退役回归使用原生PG隔离维护夹具20/20、零跳过；实例停止后另用`pg_ctl status`确认no server running，loopback端口无监听。此前PGlite失败保留在营销审计中，不计通过。

分销原生复验命令（在`workers-ts`，使用已有本机PG16运行时）：

```text
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/admin-promoter-application.test.ts test/admin-promoter-application-postgres.test.ts test/agent-application-sms.test.ts test/agent-application-postgres.test.ts
```

新页面使用POST审核和带revision的DELETE；旧GET审核及无body DELETE为兼容入口，仍无新材料版本保护。真实角色、生产数据、完整Linux CI及发布验收未在本轮完成；本次未提交、推送或部署。
