# 平台品牌层级完整工作流（2026-10-13，本地候选）

本批恢复平台品牌目录的完整层级管理和 `/brand` 第一方页面，覆盖以下六个可读 PHP 业务合同；cascader 同时接无参数及显式类型路径。品牌表没有 Logo 字段，旧 PHP 也没有品牌 Logo 写入合同，新页面不再显示或提交无法保存的 Logo。

| 方法／路径（前缀 `/adminapi/product`） | 实际合同 |
| --- | --- |
| GET `brand` | `pid` 默认 0、`brand_name` 搜索当前父级；`{list,count}` 懒加载 DTO，完整 `fid`、`fid_son`、`type`、子节点加载标记和直接使用商品数 |
| GET `brand/cascader_list[/:type]` | 无参数／1 加“顶级品牌”并截到第二层父选项；2 提供完整三级商品选择树 |
| POST `brand` | 上级父链、最长 10 字名称、排序、显示；服务器确定平台归属 |
| PUT `brand/:id` | 同父编辑或原子移动子树、维护后代父链；不改叶 ID 或商品主品牌 |
| DELETE `brand/:id` | 有活动子品牌或仍有任何已知业务引用时拒绝；无引用叶项按现有 TS 政策软删除 |
| PUT `brand/set_show/:id/:is_show` | 只改当前节点显示；隐藏父级后，后代不会进入商品选择树，子级自身 flag 保留 |

依据：`cinashop-php/route/admin.php:1586-1596`；`StoreBrand.php:36,55,65,76,99,122`；`StoreBrandServices.php:107,143,176,207,227,250`；`StoreBrandDao.php` 的商品聚合查询和 `StoreBrand` model。PHP 只统计 `store_product.brand_id` 直接所属、`pid=0,is_del=0` 的基础商品，不把父品牌改为自动上卷计数。展示传播代码已在旧服务注释，本批不会把非递归写误记为递归状态合同。

旧消费者为 `view/admin/src/pages/product/productBrand/index.vue`、`components/menusFrom.vue`，商品新增页面也使用该组件与 `/brand/cascader_list/2`。旧新建提交 `fid:[0]`；编辑会直接提交当前 DTO，包括 `id,pid,store_id,add_time,is_del,brand_num,type,fid_son,children,loading,_loading`。兼容控制器仅剥除这些已核实只读字段，校验正文 ID 与 URL 一致、正文 `store_id=0`，业务解析器仍只接受四个可写字段；DTO 不能指定所有权或覆盖路径 ID。

旧代码对任意深层父链、环、移动后代和正在被引用的数据保护不足。本批保留可用第一方合同，同时使用现有 TS 真实平台范围 `store_id=0,is_del=0`，三级上限、真实父链验证、同父重名检查、所有权和完整回执检查。根 `fid` 规范为空，后代规范为正数祖先 CSV；只读 DTO 由真实 `pid` 链得出数组。循环、孤儿、跨范围父链、异常商品关联或容量超限明确要求整理，不假报部分成功。

## 权限与共享锁协议

旧 page 1338 的完整 tuple 为 `/admin/product/product_brand` + `admin-store-storeBrand-index`，install SQL `crmeb.sql:9439`。API 1339–1344 对应上表六合同（1340 为 `product/brand/cascader_list/<type?>`），见 `9440-9445`。管理读 `brand.view`，写 `brand.manage`；只读 cascader 为 `PRODUCT_BRAND_SELECTION_PERMISSION` route-only 能力，允许已有 `product.view` 或 `brand.view` 及经过精确验证的 numeric 元数据。它不能作为独立可存储角色字符串授予。

读为有界 `REPEATABLE READ, READ ONLY`，实时重验平台账号、密码摘要、有效期限和当前角色，计数／列表／父链来自同一快照。写复用 `acquireAdminAuthorityWriteBarrier`，以 `resolveRoleAssignment(...,true)` 锁住当前 numeric 菜单授权，复用既有 `UPDATE(id)` 行锁权限，不授予语义菜单 DML。品牌目录再持独立 scope advisory fence；目标、子树和父级行锁采用 NOWAIT。

移动先锁品牌，再用共享 `tryLockProductWrite` 尝试取得每个相关商品的既有 product advisory fence，随后商品／type=2 关联行 NOWAIT 锁。遇到现有商品写者或另一个品牌操作时明确 409 回滚，不按相反锁顺序等待。未知事务状态不重写既有金融或订单事实。无生产 DDL、schema/capability 变更或部署。

## 已使用子树的原子移动

合法已有引用不自动禁止移动。所有后代 `fid` 同事务重算，直接品牌 ID 的营销范围、优惠券定义和历史辅助资料保留；优惠券当前祖先语义来自实际品牌 `pid/fid`。商品 `brandId`、价格、库存、订单快照等保持不变，实际返回整行证明唯一被维护的商品字段是 `brandCom`。

仅多 ID 且精确等于旧真实祖先＋叶完整链的 `brandCom` 属于可证明派生形态，替换为新完整链。单叶明确选择、其他合法显式品牌 ID 集合以及空 `brandCom`＋有效 primary 叶保持原事实；原根的单 ID 无法区分旧链与现代选择，也保持原值。非空 type=2 关联必须恰好匹配旧选择集合且无重复；维护时只增删差量，共同关联的行 ID、状态和历史 add_time 完整保留。完全空的历史关联不自动回填，不读取或双写辅助表作为活动权威。异常／跨范围／不一致数据要求先 repair，整批回滚。

品牌更新、确切派生商品维护、完整审计回执均同事务提交。数据库跳过审计、修改其他商品字段或返回不完整差量时拒绝成功并回滚。最多读取 1000 品牌、每次移动最多关联 500 商品、每个商品最多 20 个明确品牌 ID，写请求流最多 16 KiB 并严格解码 UTF-8；超限没有部分提交。

删除保护当前 `store_product_relation(type=2)`、未删除商品的 `brandId`／规范化 `brandCom`、历史 `store_product_category_brand.brandId`、营销辅助品牌 ID、品牌优惠券 `brandId/legacyBrandId`。空 CSV 段、0 和不相关十进制 ID 不造成引用；十进制前导零／正号准确匹配。非规范非空 token 不丢弃放行，先整理历史资料。当前商品建立品牌关联的 FOR SHARE 与品牌更新／删除行锁共用真实协议。

## 前端和验证边界

新页面提供懒加载三级目录、当前父级品牌搜索、直接使用数、完整父级／名称／排序／显示表单、子品牌新增、移动、删除和单节点显示开关。成功刷新会重建懒加载缓存，避免移动后继续显示旧父级。冲突保留草稿；未知写结果冻结原 DTO，核对当前事实或重试原操作。Vue reactive pending 使用可审查的专属 plain DTO 复制，成功核对或重试后清空新增草稿，防止误重复提交。

身份／角色变更撤销旧读取和弹窗。服务端 400011 或登录拒绝清空资料、草稿并锁住该会话后续写入，相同缓存事件不能解锁；更新身份／角色快照后方可继续。同页及跨标签页会话事件都接入。

专属 ordinary 12、实际注册 HTTP 4、独立 PG16 LOGIN 5、前端状态／真实编译 SFC 12，共 33 个用例已编写，实际执行收据由主线程统一复验后记录。新增模板回归实际渲染保留的弹窗，检查其内部恢复按钮并激活重试／核对，不允许只有遮罩后的页面按钮。HTTP 仅替换连接 factory 为夹具，仍执行真实 JWT、角色、路由、控制器和 SQL；不证明实际 Hyperdrive。原生包含 menu UPDATE(id) 的真实 LOGIN、SELECT-only 拒写、同父创建竞争、商品写者先提交及品牌移动先提交两种次序。

本机锁定 Vue 3.5.42 的 Admin 镜像已完成 Playwright 16 项品牌页面流程：1440×1000 桌面、390×844 手机、只读角色、三级新增／编辑／移动、直接计数、父级选项、显示、删除保护、未知结果原内容重试／核对和服务器撤权。发现并修复未知结果恢复按钮被弹窗遮罩阻挡的问题；最终恢复按钮在弹窗内用真实鼠标点击，未强制点击或通过页面脚本绕过遮罩。截图已目视检查，控制台错误／警告、外部请求和 HTTP 错误均为零。API 与缓存会话为明确的合成夹具，未知结果使用不完整回执模拟；本段不证明真实 SQL／JWT、网络断开后的落盘结果或数据库并发。原始浏览器结果、脚本、截图和构建日志保存在主线程本机 `admin-brand-validation-final`，完整后端执行及最终全 Admin 构建收据由主报告记录。未将已冻结标签批次、迁移总表或 opaque 资源标记为本模块完成。
