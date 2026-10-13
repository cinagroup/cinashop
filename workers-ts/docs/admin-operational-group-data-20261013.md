# 六组商城运营图片完整工作流（2026-10-13）

本模块恢复 PHP `SystemGroupData` 的可读运营图片数据流程。范围按实际 `system_group.config_name` 白名单确定，既不写字段定义，也不通过组合数据接口改写其它配置。没有新增生产 DDL、运行账号授权或外部存储调用。

## 原合同与第一方消费者

PHP 来源是 sibling `cinashop-php/app/controller/admin/v1/system/config/SystemGroupData.php`、`app/services/system/config/SystemGroupDataServices.php`、`SystemGroupServices.php`、`app/dao/system/config/SystemGroupDataDao.php`；旧后台页面是 `view/admin/src/pages/system/group/list.vue`，动态表单提交由 `components/from/from.vue` 通用表单执行，API 在 `view/admin/src/api/system.js`。安装种子在 `public/install/crmeb.sql:8460–8471`。

| 原 gid（仅来源证据，运行时不硬编码） | config_name | 实际消费 |
| --- | --- | --- |
| 51 | routine_home_bast_banner | PHP PublicController bastBanner、StoreProduct groom type1；TS PublicCatalog home 和 groomList type1 |
| 52 | combination_banner | PHP StoreCombination、TS ActivityJoinService 拼团 banner |
| 57 | routine_home_hot_banner | PHP StoreProduct、TS groomList type2 banner |
| 58 | routine_home_new_banner | PHP PublicController lovely、StoreProduct；TS home 和 groomList type3 |
| 59 | routine_home_benefit_banner | PHP StoreProduct、TS groomList type4 banner |
| 68 | integral_shop_banner | PHP StoreIntegral、TS ActivityService 积分商城 banner |

六组均严格包含 `img(upload,param='')`、`comment(input,param='')`、`link(input,param='')`，原保存要求非空。57–59 的图片字段标签含 `750*280`；实际定义的标签和字段顺序用于 header/form。其它字段类型、增加或重复字段、非空 param、缺失定义均明确不支持，不降级为一个通用 JSON 编辑器。运行时名称和 gid 必须指向同一真实组；定义缺失不会初始化假数据。

| method | 旧精确路径（/adminapi 下） | 行为 |
| --- | --- | --- |
| GET | setting/group_data/header | `{header}` 动态表头 |
| GET | setting/group_data | `{list,count,type:'img',gid}`，分页和 status 筛选，sort DESC/id DESC |
| GET | setting/group_data/create | 添加动态表单，hidden gid、frame img、两个 input、sort、status |
| POST | setting/group_data | 完整旧 flat 字段保存，不更改定义 |
| GET | setting/group_data/:id/edit | 校验实际 row.gid 的编辑表单 |
| PUT | setting/group_data/:id | 完整编辑，gid/add_time 保留 |
| DELETE | setting/group_data/:id | 单条删除；旧无 scope/CAS/UUID 且 row 已不存在时保留幂等成功 |
| PUT | setting/group_data/set_status/:id/:status | 显示/隐藏；显示先校验当前内容和素材 |
| POST | setting/group_data/save_all | 同事务仅清当前组并重建全部记录，排序 N..1、新 ID；空数组清组 |

保存、编辑、删除与状态成功消息分别保留 `添加数据成功!`、`修改成功!`、`删除成功!`、`显示成功/隐藏成功`。旧 list 的 img 仍为单元素数组；旧 form 的 img 为标量。新页面另使用 `img_preview`，长期 `img` 不保存临时签名。新 DTO 的版本和回执是附加资料。PHP 的资源 `read($id)` 是明确空方法，未伪造为 detail；独立现代 `setting/operational_group_data/detail/:id` 才是诚实的新只读合同。

只支持上述九个 canonical 可读业务合同。签到、充值、秒杀时段、PC 首页轮播以及 `routine_my_menus/routine_my_banner` 沿用已有专属模块；其他通用 alias 不因本模块注册而声明支持。旧字段定义管理也继续开放。静态 exact URL 数字提升不代表完整 PHP、全部后台页面或真实生产数据已迁移完成。

## 权限、事务和完整证明

`operational_group.view/manage` 是管理读取与写入权限。源数字菜单 481/482/484–489 的实际 exact API tuple 来自 install SQL:9012–9020：auth_type2、type1、空 menu_path/unique_auth 和确切 method/api_url；通配父项 483 为 `/admin*`、auth_type1，不能提升授权。真实 SQL 用例修改 method、API 路径、菜单路径、auth 或 wildcard 父项，证明权限即时拒绝。商品链接选择保持既有 `product.view`；图库保持既有 `attachment.view`，不会随运营管理权限自动授予。

读取使用 REPEATABLE READ/READ ONLY 快照，图片签名在交易外完成。写入复用既有 staff barrier、当前平台管理员 row SHARE NOWAIT、真实角色/数字菜单 SHARE；验证 JWT password 版本、状态和 expiry，审计后再次核对完整身份和当前权限。scope advisory namespace 731738 按真实 gid 加锁，组合数据表 SHARE ROW EXCLUSIVE 栅栏还覆盖不参与新 advisory 的旧通用写入，锁权限来自既有 DELETE grant。组定义 SHARE NOWAIT、当前组数据 UPDATE NOWAIT；全组 xmin、定义和资料进入确认版本，新增、删除、状态、替换均可携带 expected_revision。

替换预先验证所有成员，锁内逐条检查真实 INSERT/UPDATE/DELETE RETURNING 和完整最终集合；非当前组无 DML。单条编辑保留可合并历史 JSON 的其它键和已知 wrapper 附加 metadata。损坏历史内容有明确诊断，可隐藏/删除；显示必须先修复。容量有界：每组完整快照最多5000项、整组一次替换0–100项、JSON body 256 KiB、单条 JSON16 KiB、描述500字符、图片255字符、链接2048字符。超过容量拒绝而不截断或部分提交。

原 `system_log.action` 是 varchar255，审计使用紧凑 `[operation,id,payload_hash,revision,count]`，scope、UUID、actor 与 HTTP method 分别由 page/path/admin_id/method 证明。单条返回确切 id/ids；整组返回 id0、ids空数组、确切 count、原请求哈希和完整集合 revision，避免把100个新ID塞进255字符。每个新ID仍在交易中通过真实返回和最终 SQL 集合逐条证明。回执插入受抑制、被改写、审计 trigger 改业务数据/actor 时全部回滚。UUID 可选供新页面使用：同 actor/scope/intent 的重试读取已经提交的回执，不重复 DML；冲突 intent 明确409。

素材复用平台商品公共授权：稳定 `/api/assets/:id` 与允许的静态图片路径，实际 attachment owner/module、R2 object folder 和 MIME 核验，写入 attachment SHARE NOWAIT。签名仅用于预览及 root 接入的六组公开 projection，不改变 canonical。旧 Vue 图片 R2 端到端尚未验证，本批新 Vue 才消费 img_preview；不得把合成浏览器图片等同真实 R2/CDN/设备验证。

## 新前端和验证证据

入口 `/setting/operational-groups` 使用实际三字段表单、成熟图库和商品 selector。整组编辑先读取未筛选完整0–100项，不用当前分页20项覆盖全组；可新增、移除、上下排序与确认清空。未知结果冻结 actor 身份绑定的原 UUID/CAS/内容并保留本地，单条与整组 modal 内都有可点击的重试/回执入口；只接受 matching hash/scope/operation/count 的完整 positive receipt。400011 会清草稿、锁住当前缓存身份，普通刷新不会恢复写权。

独立验证根为 `C:/Users/cina/.codex/visualizations/2026/10/13/01a13321-41f8-7ea2-9370-103a58344561/operational-group-validation`。

- 实际 ordinary 三文件：15 business +4 complete createApp/JWT/SQL HTTP +11 compiled Vue/state =30 pass/0 fail，`workers-ts/.cache/operational-final-tests.{json,log}`。只替换连接工厂注入真实 fixture，保留注册 app、真实 auth/role/controller/SQL 和 session close；不证明实际生产 Hyperdrive。
- PG16.15 三完整文件：15 business +4 HTTP +5 independent LOGIN/column-ACL/concurrency =24 pass/0 fail，`workers-ts/.cache/operational-native-full.log`。19个复验与 ordinary 重叠，不重复累计；本模块当前35个独立自动化用例。
- 源权限缺 keys 的初次失败、审计255容量真实失败、素材/流 fixture 修复前失败保留在 early/full 原始日志，未删除或覆盖。
- Admin 完整 vue-tsc exit0 和 production build exit0：`view/admin-ts/.cache/operational-admin-types-final-ready.log`、`operational-admin-build-final-ready.log`。初次类型失败仅验证副本漏复制既有 uniapp-ts navigation 文件，已补完整依赖，不修改共享源码。
- 浏览器完整桌面/手机、未知恢复与撤权证据由 artifact 根 `operational-group-browser-final.json`、对应截图和脚本记录。合成 API 明确不证明真实 DB/JWT/并发；统计 `/api/get_script` fixture 为本机 JavaScript，一页生命周期一次请求、一次执行、一个 script 标签，无外网 analytics。

最终浏览器 exit0：16完整流程、11次明确合成业务提交，desktop1440×1000/mobile390×844，error/warn/外网/失败HTTP均0；图片表单截图已目视核验，字段与保存按钮在手机视口内完整可见。统计脚本在三个page生命周期共3GET，每个生命周期执行1次、script标签1个。截图为 artifact 根 operational-group-desktop.png、operational-group-mobile-form.png、operational-group-mobile.png、operational-group-mobile-revoked.png、operational-group-viewonly.png。

临时 PG data finance-postgres-mdKuuz/data 独立 pg_ctl status exit3，61781监听0、fixture0；最终 Vite PID23268已停止，5217监听0，浏览器已关闭。证据见 operational-group-pg-cleanup.json 与 operational-group-dev-cleanup.json。14 owned 文件 source/copy 哈希见 operational-group-agent-freeze.json；没有部署、提交或推送。
