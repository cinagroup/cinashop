# 买家售后详情：原始申请图片回看

日期：2026-10-19。基线提交72335a91b60f026ea695f4d3139fe5205c4fe321（PR121）。分支codex/customer-refund-request-images，增量草稿PR基于codex/refund-application-evidence。整体PHP→TS迁移仍active。

实际PHP UniApp退款列表进入注册的order_after_details页面。该页100–113行在退款记录存在原始refund_img时显示“售后凭证”，139–151行独立展示后续refund_goods_img。API控制器、服务、模型和真实挂载入口已逐项核对。PHP PC没有被证实的同字段展示入口，原PHP预览方法也没有绑定在这组缩略图上；PC共用展示及全图预览属于现代双端一致性扩展，不能冒称已证PHP PC或点击行为的原样迁移。

本批仅为普通Customer的版本化自有售后详情增加闭合requestImages/requestImagesError，不扩大列表。原始TEXT在SQL传输前按8192 UTF8字节限制，超限内容替换为明确非法哨兵，NULL仍是已知无图；沿原RR READ ONLY快照和每语句不超过5秒限制读取。现代图片复用既有UID/类别/存储归属及签名规则，旧有界公开HTTPS保留历史标签。图片无法核对时仅清空该组并显示错误，真正SQL权限故障仍失败；申请商品历史和后来退货图独立。

公共双端解析器允许旧服务同时缺失两字段并明确提示；任一字段已出现则严格要求完整合同，限制最多三张、闭合src/url、不同规范引用及安全签名/HTTPS，拒绝错误与图片共存。PC显示安全全图链接，UniApp使用真实原生/H5预览。图加载失败提示重新读取，当前对象身份阻止迟到图片错误或预览回调污染新详情。刷新、账号/路由/隐藏/卸载清除旧详情。

最终结果及完整执行源SHA见[机器账本](../audit/php-ts-customer-refund-request-images-20261019.json)。实际作者仍是已注册checkout和分配、合成付款准入、真实上传与普通申请。作者连接为自有maintenance；买家详情、商家及图片GET在独立SELECT-only LOGIN执行。每次GET单独比较全public表、序列及R2写入，整个浏览器流包含真实业务POST，不称整个过程零写。对象存储是保存真实PNG字节的fake R2，不代表真实云、生产角色、支付provider或真实设备验收。

## 最终验收与去重

816项不同用例通过，63项新增，原两项Browser端到端用例扩展，9个直接测试入口。PC315（新增16）、UniApp详情57（新增16），均运行真实编译SFC脚本、存储/会话、实际API适配和生命周期；实际渲染另由生产浏览器验证。Worker四入口完整回归及普通/runtime两个完整类型项目通过；PC/UniApp完整类型及生产构建通过。

| 接受阶段 | 不同用例 | 资格 |
| --- | ---: | --- |
| frontend-v1 | 372 | 相关最终输入SHA逐项匹配，命令终态exit0 |
| native-v1 | 45 | Only the unchanged independent old45 file is counted. The initial new28 are superseded by native-final after its42501 assertion was strengthened; no runtime production/helper change. |
| native-final | 28 | 相关最终输入SHA逐项匹配，命令终态exit0 |
| worker-v1 | 369 | 369 unit cases retained on unchanged relevant inputs. Earlier full types passed before the Browser-only static product fixture addition; final full types accepted separately. |
| worker-final-types | 0 | 相关最终输入SHA逐项匹配，命令终态exit0 |
| browser-v4 | 2 | Two existing end-to-end cases extended with own-Customer review and failure/recovery; they are not counted as newly added test cases. |

首次native-v1完整73通过后，仅把新原生用例的权限失败断言从任意拒绝收紧为Drizzle cause code42501和system_attachment消息；生产/helper未变。全部新28随后在最终源完整重验，仅保留初轮独立旧45，不将初轮新28重复计数。backend-freeze-v2记录最终后端源，独立review-v4覆盖最终11份执行源并保留之前回执。28项专属原生覆盖真实App/apiJWT、SELECT-only认证/权限、原始和退货图独立、空/坏/UTF88192边界、元数据/身份错配、所有退款状态、真实42501、实际RR并发更新，以及已注册作者上传申请后买家读取和PNG字节。

生产浏览器PC场景买家与商家均1200×844，H5场景买家与商家均390×844，买家和商家各自loopback origin与自有同源iframe，真实App/JWT。每端10阶段包含原上传/移除/重传/实际申请、4项新增买家详情预览/图片失败/详情清空/恢复，及原4项商家核对阶段。43次业务GET逐次核对282张public表、229序列、R2 puts不变；6次真实作者POST分开记录，provider0。真实完整图链接/原生H5预览的交互和截图另附在UI回执。移动端仅将外层验收窗口临时设为1280×1200以使固定390×844应用iframe的提交控件可达，应用尺寸不变，完成后已恢复浏览器默认视口。黑色图片为68字节1×1隔离PNG。

图片/详情503由本地bridge在真实后端成功读取后注入，分别记录HTTP200与injected503，不能称为真实后端故障。现代规范引用只保存第二次上传的图片，首次移除对象遵循既有上传保存期；移除不代表删除对象。旧HTTPS有界兼容且明示历史来源，旧PHP上传无relation_id证明，不声称旧图为当前用户实际上传。图片签名复用原有默认15分钟/既有上限，刷新回读新票据，不持久化票据。

浏览器前后Supplier70、PC103、H5344共517份构建SHA不变。6座自有PG包含初轮native均清零并停止，再用pg_ctl和postmaster.pid缺失确认；首次Browser选图调用长时间未返回，原进程固定时限终止并遗留一库/两角色，精确停止集群已用单用户模式离线核验并清除，未开启监听或修改认证；首轮Browser不计为通过；次轮PC发现已有商品夹具/api/qa/image.svg未在bridge提供，随后移动端仅显式结束未完成候选，两例均未计成功。仅为该精确路径提供自有PNG并单列fixture_product_thumbnail_reads，实际身份/订单/退款仍由App读取。第三轮PC完整通过，移动端原图已真实打开、解码并关闭，但清空详情阶段把H5实际“请求失败”错误文案误断言为“503”，该聚合仍失败且不采纳其中PC部分通过。仅收紧该阶段为最近真实Customer详情GET已注入503、按端核对错误文案并继续要求原图区域与图片清零，第四轮两例完整重验。该Browser文件变化后，两个完整Worker类型项目单独再验，原369回归相关源与前端/原生相关源未变；所有业务写入只发生于明确自有夹具作者或用例维护，不对生产角色/库授权。

## 发布与范围

本批15文件包括11份执行源、两个根索引、本文与机器账本。根审计88项（50已选）和Checklist404项（249已选）逐行保持基线。源码、staged和提交范围单独扫描，最终提交/远端SHA、草稿PR和新提交CI由发布回执记录。原始命令、日志/终态SHA、PHP/基线TS来源及各阶段相关输入在机器账本内嵌；/tmp引用为当前工作站证据位置，不假称远程持久附件。

保留已恢复PHP get_script兼容和修订退役审计，两端商家启动实际GET200。沿用现有UniApp依赖的路由弃用提示需在UI回执单独说明，不称所有console为空；无未解释应用错误才接受。用户安装的外部扩展连接目前未被工具库存观察到，使用可用内置浏览器完成验收。

不包括生产部署、schema/GRANT变更、支付provider/账户/回调、真实云R2或真实设备验收。Customer实际部分数量的申请UI及其他PHP→TS缺口仍需继续推进，不能据此宣布整体完成。
