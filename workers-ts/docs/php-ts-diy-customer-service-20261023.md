# 页面悬浮客服 PHP → TypeScript 合同

`customerService` 原来只渲染一行固定客服文字。现在它消费真实 PHP 配置，在首页与微页显示可拖动的圆形图标，并接入实际站点客服配置。它与全局悬浮导航独立维护。基线为 `ee3847f798a92cdb8c00a9e71bbf7bc246c9293b`，父 draft 为 #157。

PHP 合同来自独立 `cinashop-php` 仓库的 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`：Admin 的 `home_service.vue`、`c_home_service.vue`，Uni 的 `customerService.vue`、`util.js` 和 `DiyServices.php`。机器审计记录逐文件指纹、行锚点及本次重新盘点，未沿用“已注册组件等于已迁移”的判断。

## 作者数据与运行行为

保留完整原数组、未知字段、其它族、独立 content 和行元数据。数字 0 与字符串 "0" 按原 JavaScript 真值行为区别处理：按钮模式和侧边字符串 "0" 为真；上移数值 0 或缺省采用 30%，字符串 "0" 为 0%，有效偏移最大 80%。读取不重写导入数据，明确编辑才写入数字枚举。非法配置明确报错并停止操作。

图标固定为 86rpx 圆形、距所选边 20rpx、z-index 40；拖动沿用严格 `66 < clientY < 545`，加入拖后点击抑制。H5 支持鼠标和键盘。MP 的 `routine_contact_type=1` 使用真实 `open-type="contact"` 按钮并优先于页面模式；其它未知 MP 类型不退回普通入口。

客服模式预读现有 `/api/get_customer_type`，仅保留 60 秒。预读成功、重新读取和页面激活都不会自动打开会话；过期后重新读取并等待下一次点击。四种配置分别打开站内客服、电话、配置地址、企业微信客服。微信企业客服调用保留当前用户手势，依据[微信官方 API](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/service-chat/wx.openCustomerServiceChat.html)；MP 原生按钮和 App 地址交接依据 [UniApp 按钮文档](https://uniapp.dcloud.net.cn/component/button.html)及 [HTML5+ runtime 文档](https://www.html5plus.org/doc/zh_cn/runtime.html)。

当前账号 uid/token/session、完整块内容、页面激活、站点关闭、签名过期和卸载都撤销旧事件及异步回调。首页与微页复用既有媒体续期主机；票据变化不改变作者指纹，但旧动作不能跨过续期继续执行。

## 媒体与后台

后端仅增加 `customerService.logoConfig.url` 这一真实图像槽，使用已有平台 owner、当前图像、raster 与公开地址校验。独立上限 20000，原普通 2500、导航/页脚/排版各 20000 不变。完整预算、解析及所有权校验先于查询或签名；沿用 10000 查询分块、256 签名分批及原子提交。`link`、`preview`、未知邻居不获得媒体权限。

后台在实际 DiseList 页面加入本族编辑器，支持完整数组中的增删、族内排序、显隐、模式、位置、偏移、稳定图标及链接。选择使用真实图库，临时签名仅用于同素材预览；保存仍使用稳定地址。保留现有管理/素材权限和会话保护。图库预览曾在父 v-model 的下一轮更新后消失，实际挂载测试复现后修复：先撤销旧回调，等下一轮更新，再核对相同账号、编辑页、选中项、完整数组和素材引用才恢复本次预览。

## 验证记录

| 实际完整验证 | 最终结果 |
| --- | --- |
| Worker | 两套完整 strict；69 文件、1280 项通过 |
| PostgreSQL 16 | 七完整文件、243 项通过；新客服 42，保留其它 201；隔离资源清理、pg_ctl status3、无 PID |
| Admin | 新 31 加原页脚/排版 50，共 81；完整 strict 和实际生产构建通过 |
| UniApp | 当前实际 package 脚本 91 文件、2374 项通过；完整 strict、H5/小程序/App 构建、产物及 i18n 通过 |
| 后台真实 IAB | 一项完整测试、15 检查点、outer exit0；73 表、68 序列；93 真实 GET、41 合成 chrome GET 均无状态变化，一次真实 Admin 保存 |

新增独立定义 162：Uni60、Admin31、media15、runner12、既有 API 审计新增负例1、native42、Browser1。重复候选、保留测试和15检查点均不另计。

浏览器真正点击首页与微页按钮往返、在375/414宽度检查86rpx圆形和位置，以浏览器原生鼠标拖动到200px并验证未误导航；真实后台修改模式、左侧、45%偏移和图库素材后，仅保存一次。该偏移通过真实键盘输入，记录可信的input4/input45/change45/blur45及DOM/aria45，完整原始数组、未知邻居、独立content和行元数据逐项保留。实际客服配置预读后保持原页，下一次新鲜手势真实导航到owned相对目标；换号、访客、真实410010关闭和新实例重开均验收。

前两次 Browser 失败完整保留：第一轮拖动时未稳定IAB自动聚焦后的父页滚动坐标，只完成2点；不能把它当作Uni归一化的隔离GUI负例。已安装Uni源确实会在UNI节点事件中去掉button并调整clientY，H5原生div保持完整MouseEvent；最终实际拖动通过。第二轮6点完成后，在排查工具fill缺失native change期间达到35分钟时限，无业务POST；没有改生产数值控件来迁就工具。第三轮15点正常退出，源、31521项安装文件及658份H5/Admin产物前后不变。

其它红灯也保留：实际挂载发现父v-model下一轮更新清空图库签名预览；连续拖动旧350ms计时器提前解除新拖动抑制（58/59真实复现）；初次全91虽2372全通过，但收据误纳两个随后被清理的Vite临时cache而退出，未计完整成功；首次全Worker strict的三处新测试类型问题修正后，完整两套strict/69/native7重新通过。Browser后仅移除被fixture覆盖的重复setup phase，精确inverse与实际setup序列化同字节证明收据等价；native类型修正不被Browser消费。严格检查、实际执行结果和限制均记录于机器审计。

浏览器全程后台进行，不逐页弹确认；连接为真实IAB，未观察到独立Chrome/Edge扩展会话。41次合成请求只覆盖无关品牌/广告/主题和后台提醒chrome，客服、媒体、装修、素材、Admin保存及购物车均走真实Worker/ORM。初始JWT/SQL配置、平台图片上传以及明确客服/关开站操作单列；R2与Queue采用显式owned边界，未接生产提供方。桌面结果不替代物理MP/App、原生拨号、企业客服提供方、生产TLS或自然等待840秒；840秒同版本签名续期由真实根/微主机的受控时钟运行测试覆盖。重开使用新的真实页面实例。

保留已恢复 `/api/get_script` 及三端加载器；不改生产路由、DDL、ACL、依赖或锁文件。三份根账本只追加，基线6741文件的其它历史审计和旧复选行不变。推送前扫描完整实际暂存补丁，精确新head CI推送后独立读取，不继承父#157绿灯。只推送draft，不合并部署；API-007、DATA-008、FE-003J/K和整体迁移父项继续开放。
提交前暂存空白检查仅发现新 runner 测试末尾多一空行，删除一个 LF。精确逆变换恢复 Worker/native/Uni91 三份最终收据中的原 SHA，其余各6045源码文件逐字节相同；不把纯空白修正称作新的行为验证。外部证明 `/tmp/cinashop-customer-post-validation-EOF-equivalence.json` 由机器审计绑定。
