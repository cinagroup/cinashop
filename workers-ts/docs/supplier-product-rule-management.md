# Supplier 规格模板完整流程

本切片完善五个已经注册的旧路由，不把它们计作新增 missing route。PHP 依据为 `route/supplier.php`、Supplier `product/StoreProductRule.php`、`StoreProductRuleServices.php` 与 `StoreProductRuleDao.php`。服务和 DAO 内容可读；不是对密文继承方法的推测。

| 合同 | 返回或写入 |
| --- | --- |
| GET `product/product/rule` | `{list,count,page,limit,revision}`；每行保留原始 JSON `rule_value`、`attr_name`、`attr_value`、`spec` |
| GET `product/product/get_rule` | 当前 Supplier 的模板数组；`rule_value` 为已解码的规格数组 |
| GET `product/product/rule/:id` | 原 `{info:row}` |
| POST `product/product/rule/:id` | ID=0 新建，否则编辑；`rule_name`、`spec`；返回 `{id,revision}` |
| DELETE `product/product/rule/delete/:id` | 删除自身模板；返回 `null`；支持无 body 和旧 `{ids:''}` |

旧列表在没有 page/limit 时确实不分页。canonical 保持这个行为，按 ID 降序返回全部当前 owner 模板；1000 项或整个结果 2MiB 上限溢出明确失败，不截断。现代管理页显式传 page/limit，limit≤100。搜索保持旧 SQL LIKE 通配符语义。读取仅含 `type=2,relation_id=真实 Supplier 主键`，不把平台模板或其他 Supplier 模板混入目录。

五列原表继续使用，不增加 revision/status/时间列或 DDL。revision 从锁后的完整原行或完整 owner 目录计算。旧编辑组件会 POST 完整 `info` 投影，因此兼容忽略该投影里的 `id/type/relation_id/rule_value/attr_name/attr_value/revision`，实际 owner 由认证身份固定，实际可写列仍只有 `rule_name/rule_value`。现代客户端显式发送 `expected_revision`，旧客户端可省略。

旧表单是 Supplier `productAttr` 页面和 `addAttr` 组件创建的客户端表单，没有单独服务端动态 form 路由。现代 `ProductSpecifications.vue` 提供相同名称和 1–3 维规格编辑，每维 1–50 个值，复用现有规格验证及成功 DTO 语义。

写事务沿用共享规则 namespace `731612,SupplierID`，把删除也纳入同一协议。目标行 `FOR UPDATE NOWAIT`；当前账号、Supplier、staff role、数字菜单 `FOR SHARE NOWAIT`。实际 JWT 的账号 ID、密码版本、过期时间及精确 method/path 权限在事务前后复核。只读事务使用 READ COMMITTED READ ONLY，不要求 lock-column UPDATE 权限；所有响应包括认证前错误为 private/no-store。

INSERT/UPDATE/DELETE 都要求实际完整五列 RETURNING。写后和审计后重新读取完整 owner 目录，精确核对所有未修改的模板行及选中行；触发器跳过或改写操作不能报告成功。审计要求实际完整回执，抑制或改写日志将回滚业务。锁冲突、事务冲突或超时明确返回 409。

商品保存没有持久 rule_id 外键。模板应用复制规格结构，模板删除不会因旧复制商品而被虚构引用关系阻止，也不改写商品、SKU 价格、库存或图片。ProductForm 的共享消费 hook 先调用 `prepareSupplierProductRuleApplication` 完成验证及 ≤200 SKU 预检，再构造全部新 SKU；所有候选成功后才同步替换草稿。正常应用沿用原重建规格行的语义，15×15 溢出不清空已有草稿。含逗号造成重复 SKU 名称的歧义组合明确拒绝。

管理页在发 POST/DELETE 时冻结 attempt 和 payload，重复提交与关闭编辑器被阻止。成功回执仍需完整目录 GET 核对 ID、字段和 revision；未知结果只允许 GET 恢复。只有真实 ApiError 或 HTTP 400/404/409 且正文 status 相同的 genuine AxiosError 表明原子拒绝，才允许用户修改后再提交。HTTP/body 不一致、500、网络失败和成功后读取失败保留未知 attempt。原匹配模板不当作未知新增的成功证据。身份、权限、筛选与分页代次变化使旧响应失效；只读用户不能调用写 handler。

验证使用独立 `fifth-supplier-rule-validation` 本机镜像和既有锁文件依赖，无生产或 provider 操作。最终完整 createApp/JWT/角色/SQL HTTP 15 项及独立 PG16 LOGIN 并发/触发器 14 项，共 29/29 通过；实际挂载 SFC 和纯应用 helper 完整 20/20 通过。原生用例包含请求等待同 owner 锁期间真实 JWT 到期、编辑/删除互斥，以及真实 BEFORE UPDATE/DELETE 抑制、行改写、审计回执抑制/改写、审计后的其他自身模板改写回滚。

完整 `vue-tsc -p tsconfig.app.json --noEmit` 与 `npm run build` 退出 0，锁文件 Vue 为 3.5.42。实际 Playwright 浏览器覆盖桌面 1440×1000、手机 390×844、只读 1024×800 及 ProductForm 闭环：创建编辑删除和新值读取、未知写仅 GET 恢复、明确拒绝改名重提、撤权、超限保完整已定价 SKU 草稿与实际保存 payload、合法“规格”单维及 2×2 模板的正常应用。统计脚本在 SPA 导航中只加载一次。没有意外 console error/warn；HTTP 409 明确拒绝浏览器夹具产生的预期 resource console 单独记录，不当作真实 SQL 冲突证明。

浏览器发现并由共享页面负责人修复旧 `spec_type` watcher 会清空合法“规格”命名模板/已读 SKU 的问题；现在仅真实用户主动切换 radio 才初始化默认结构。商品读取与模板应用不会触发这种清空。完整 Worker 类型及跨模块统一回归由 Root 的独立最终记录提供。本切片证据不借用前批分类或标签的通过记录，初次失败日志保留在第五批 artifact 根。
