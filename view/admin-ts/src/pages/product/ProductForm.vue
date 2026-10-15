<template>
  <div class="product-form">
    <el-card shadow="never" v-loading="loading">
      <template #header>
        <div class="heading"><h1>{{ copySourceId ? '复制商品' : target ? '编辑商品' : '添加商品' }}</h1><el-tag v-if="target">商品 #{{ target }}</el-tag><el-tag v-if="copySourceId" type="warning">来源 #{{ copySourceId }} · 新建独立商品</el-tag><el-tag v-if="owner">归属 {{ ownerName }} · #{{ owner.relation_id }}</el-tag></div>
      </template>
      <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon class="notice" />
      <el-button v-if="loadError" @click="initialize">重新读取当前账号资料</el-button>
      <el-alert v-if="!canManage" title="当前账号没有商品管理权限，不能保存。原账号的未确认请求仍可查询结果。" type="warning" :closable="false" class="notice" />
      <div v-if="pending" class="pending-panel" role="status">
        <strong>保存结果待确认</strong>
        <p>操作 {{ pending.operation_id }} · {{ pending.requested_id ? `商品 #${pending.requested_id}` : '新建商品' }}。原请求可能已提交；请查询或封存结果后继续。</p>
        <el-button :loading="resolving" @click="recover(false)">查询保存结果</el-button>
        <el-button :loading="resolving" @click="recover(true)">确认原事务结果</el-button>
        <el-button v-if="pending.requested_id !== target" @click="openPendingTarget">进入原商品</el-button>
        <p v-if="recoveryMessage">{{ recoveryMessage }}</p>
      </div>
      <template v-if="loaded">
        <el-alert v-if="metadataError" :title="metadataError" type="warning" :closable="false" class="notice" />
        <p class="muted">候选资料各最多显示500项，分类与品牌树最多1000项。历史已选值会保留；未显示的候选请先在基础资料中核实。外部采集入口尚未开放。</p>
        <el-alert v-if="copySourceId" title="复制会创建新商品、新SKU身份及独立库存记录，真实销量从0开始；原卡密与固定交付内容不复制。保存后请进入新商品独立配置交付。目的归属保持来源实际归属，来源快照改变会整次拒绝，请核实后重新读取。" type="warning" :closable="false" show-icon class="notice" />
        <el-button v-if="copySourceId" :disabled="locked" @click="reloadCopySource">重新读取来源并替换当前复制</el-button>
        <el-steps :active="step" simple class="steps"><el-step v-for="name in steps" :key="name" :title="name" /></el-steps>
        <nav class="step-links" aria-label="商品编辑步骤"><el-button v-for="(name, index) in steps" :key="name" :type="step === index ? 'primary' : 'default'" size="small" @click="step = index">{{ index + 1 }} {{ name }}</el-button></nav>
        <el-form :model="form" label-width="112px" :disabled="locked" class="editor-form">
          <section v-show="step === 0" aria-label="基础信息">
            <el-form-item label="履约类型" required><el-radio-group v-model="form.product_type" :disabled="target > 0 || copySourceId > 0" @change="changeProductType"><el-radio-button :value="0">实物商品</el-radio-button><el-radio-button :value="1">卡密/网盘</el-radio-button><el-radio-button :value="3">手工虚拟</el-radio-button><el-radio-button :value="4">次卡商品</el-radio-button></el-radio-group></el-form-item>
            <el-form-item label="商品名称" required><el-input v-model="form.store_name" maxlength="256" show-word-limit /></el-form-item>
            <el-form-item label="商品分类" required><el-cascader v-model="form.cate_id" :options="categoryOptions" :props="treeProps" clearable filterable collapse-tags collapse-tags-tooltip placeholder="可多选分类与子分类" /></el-form-item>
            <el-form-item label="商品品牌"><el-cascader v-model="form.brand_id" :options="brandOptions" :props="treeProps" clearable filterable collapse-tags placeholder="可多选品牌" /></el-form-item>
            <el-form-item label="轮播图" required><div class="stack wide"><div v-for="(image, index) in form.slider_image" :key="index" class="image-row"><img v-if="image" :src="imagePreview(image)" alt="商品轮播图" /><el-input v-model="form.slider_image[index]" placeholder="素材引用 /api/assets/123 或 HTTPS 图片地址" maxlength="256" /><el-button :disabled="index === 0" @click="moveImage(index, -1)">上移</el-button><el-button :disabled="index === form.slider_image.length - 1" @click="moveImage(index, 1)">下移</el-button><el-button type="danger" plain @click="form.slider_image.splice(index, 1)">删除</el-button></div><div><el-button :disabled="form.slider_image.length >= 10" @click="form.slider_image.push('')">添加图片地址</el-button><el-button @click="openAssets('slider')">选择素材</el-button></div><el-text type="info">第一张为主图，最多10张；素材选择保存短引用，签名预览不会写回正文。</el-text></div></el-form-item>
            <el-form-item label="商品单位"><el-select v-model="form.unit_name" filterable allow-create default-first-option><el-option v-for="unit in units" :key="unit.id" :label="unit.name" :value="unit.name" /></el-select></el-form-item>
            <el-form-item label="商品标签"><el-select v-model="form.store_label_id" multiple filterable clearable><el-option v-for="item in optionsFor('product_labels', form.store_label_id)" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
            <el-form-item label="商品条码"><el-input v-model="form.bar_code" maxlength="15" /></el-form-item>
            <el-form-item label="商品编码"><el-input v-model="form.code" maxlength="50" /><el-text v-if="erpEnabled" type="warning">ERP已开启，商品与每个SKU均须填写编码；库存通过ERP维护。</el-text></el-form-item>
            <el-form-item label="商品视频"><div class="stack wide"><el-switch v-model="form.video_open" :active-value="1" :inactive-value="0" /><div v-if="form.video_open || form.video_link" class="field-row"><el-input v-model="form.video_link" maxlength="500" placeholder="素材稳定地址 /api/assets/ID 或完整 HTTPS MP4 地址" /><el-button v-if="form.video_link" @click="form.video_link = ''">移除视频</el-button></div><div class="field-row"><el-button :disabled="!canViewMedia" @click="openAssets('video')">选择视频素材</el-button><el-button @click="videoUploadOpen = true">上传视频</el-button></div><video v-if="videoPreviewUrl" class="video-preview" :src="videoPreviewUrl" controls preload="metadata" aria-label="商品视频预览" /><el-text type="info">视频上传或选择后仍需保存商品；移除视频只修改本商品引用。</el-text></div></el-form-item>
            <el-form-item label="上架状态"><el-select v-model="form.is_show" :disabled="!!form.auto_on_time"><el-option :value="0" label="下架" /><el-option :value="1" label="上架" /><el-option v-if="form.is_show === 2" :value="2" label="保留历史状态 2" /></el-select></el-form-item>
            <el-form-item label="定时上架"><el-date-picker v-model="form.auto_on_time" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" placeholder="北京时间；设置后当前保存为下架" clearable /></el-form-item>
            <el-form-item label="定时下架"><el-date-picker v-model="form.auto_off_time" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" placeholder="北京时间" clearable /></el-form-item>
            <el-form-item v-if="owner" label="供应商归属"><el-input :model-value="String(owner.supplier_id || 0)" disabled /><el-text type="info">归属由服务端验证，编辑器不切换已有商品所有者。</el-text></el-form-item>
          </section>
          <section v-show="step === 1" aria-label="规格库存">
            <el-alert title="历史SKU身份不能通过改名或删除替换。重新生成会保留同一维度和值的身份；停用历史SKU请使用退役。" type="info" :closable="false" class="notice" />
            <el-form-item label="规格类型"><el-radio-group :model-value="form.spec_type" :disabled="form.product_type === 4" @change="changeSpecType"><el-radio-button :value="0">单规格</el-radio-button><el-radio-button :value="1">多规格</el-radio-button></el-radio-group></el-form-item>
            <template v-if="form.spec_type === 1">
              <el-form-item label="规格模板"><div class="field-row"><el-select v-model="skuTemplateId" clearable filterable><el-option v-for="item in options.sku_rule_templates" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button @click="applySkuTemplate">读取模板维度</el-button></div></el-form-item>
              <el-form-item label="规格维度"><div class="stack wide"><div v-for="(dimension, index) in dimensions" :key="index" class="dimension-row"><el-input v-model="dimension.value" maxlength="32" placeholder="规格名，如颜色" /><el-select v-model="dimension.detail" multiple filterable allow-create default-first-option :multiple-limit="50" placeholder="输入规格值后按回车" /><el-button type="danger" plain @click="dimensions.splice(index, 1)">删除维度</el-button></div><div><el-button :disabled="dimensions.length >= 3" @click="dimensions.push({ value: '', detail: [] })">添加规格维度</el-button><el-button type="primary" plain :loading="generating" @click="generateSkus">生成完整组合</el-button></div><el-text type="info">最多3维、每维50值、200个组合。生成新行默认价格与库存为0，请逐项填写。</el-text></div></el-form-item>
            </template>
            <el-form-item label="批量填写"><div class="field-row wrap"><el-select v-model="batchField" class="compact"><el-option v-for="field in batchFields" :key="field.key" :label="field.name" :value="field.key" /></el-select><el-input-number v-model="batchValue" :min="0" :precision="batchField === 'stock' ? 0 : 2" /><el-button @click="applyBatch">应用到当前全部SKU</el-button><el-button @click="fillSkuImages">将主图填入空图片</el-button></div></el-form-item>
            <el-alert v-if="form.product_type === 0 && erpEnabled === null" title="ERP开关未能确认，当前禁止直接修改库存；请重新读取后核实。" type="warning" :closable="false" class="notice" />
            <div class="sku-shell"><el-table :data="form.attrs" border size="small" @selection-change="selectActiveSkus">
              <el-table-column v-if="target" type="selection" width="45" :selectable="historicalSku" />
              <el-table-column prop="suk" label="规格组合" fixed min-width="130" />
              <el-table-column label="规格图片" min-width="180"><template #default="{ row }"><el-input v-model="row.pic" maxlength="128" placeholder="留空使用主图" /></template></el-table-column>
              <el-table-column v-for="column in priceColumns" :key="column.key" :label="column.name" min-width="130"><template #default="{ row }"><el-input-number v-model="row[column.key]" :min="0" :precision="2" controls-position="right" /></template></el-table-column>
              <el-table-column label="库存" min-width="130"><template #default="{ row }"><el-input-number v-model="row.stock" :min="0" :precision="0" :disabled="stockDisabled(row)" controls-position="right" /></template></el-table-column>
              <el-table-column v-if="form.product_type === 1" label="交付方式与内容" min-width="300"><template #default="{ row }"><el-text v-if="copySourceId" type="warning">原卡密、固定内容与库存均不复制；新商品保存后独立配置交付。</el-text><template v-else><el-radio-group v-model="row.delivery_mode" @change="changeDelivery(row)"><el-radio-button value="cards">一次性卡密</el-radio-button><el-radio-button value="fixed">固定内容</el-radio-button></el-radio-group><el-input v-if="row.delivery_mode === 'fixed'" v-model="row.disk_info" type="textarea" :rows="3" maxlength="4096" placeholder="支付后交付的固定内容" /><el-text v-else type="info">可用 {{ row.virtual_available }} / 总数 {{ row.virtual_total }}。保存后进入卡密库存导入；支付发货严格使用下单快照。</el-text></template></template></el-table-column>
              <el-table-column label="条码" min-width="130"><template #default="{ row }"><el-input v-model="row.bar_code" maxlength="50" /></template></el-table-column>
              <el-table-column label="编码" min-width="130"><template #default="{ row }"><el-input v-model="row.code" maxlength="50" /></template></el-table-column>
              <el-table-column v-if="target" prop="unique" label="稳定唯一标识" min-width="130" />
            </el-table></div>
            <template v-if="form.product_type === 4 && form.attrs[0]">
              <el-divider content-position="left">次卡核销规则</el-divider><p class="muted">次卡只支持单规格、自提。规则变更不会改写既有订单权益快照；时间均为北京时间。</p>
              <el-form-item label="每份核销次数" required><el-input-number v-model="form.attrs[0].write_times" :min="1" :max="99999999" :precision="0" /></el-form-item>
              <el-form-item label="有效期"><el-radio-group v-model="form.attrs[0].write_valid"><el-radio :value="1">永久</el-radio><el-radio :value="2">购买后N天</el-radio><el-radio :value="3">固定区间</el-radio></el-radio-group></el-form-item>
              <el-form-item v-if="form.attrs[0].write_valid === 2" label="有效天数"><el-input-number v-model="form.attrs[0].days" :min="1" :max="3650" :precision="0" /></el-form-item>
              <el-form-item v-if="form.attrs[0].write_valid === 3" label="固定有效区间"><el-date-picker v-model="form.attrs[0].section_time" type="datetimerange" value-format="YYYY-MM-DD HH:mm:ss" start-placeholder="开始时间" end-placeholder="结束时间" /></el-form-item>
            </template>
            <div v-if="target && form.product_type !== 4" class="lifecycle"><el-button type="danger" plain :disabled="!selectedActive.length" :loading="lifecycleBusy" @click="changeSkuLifecycle('retire')">退役选中历史SKU</el-button><el-text type="info">这是独立即时操作，会重新读取规格；请先保存其他规格修改。</el-text></div>
            <template v-if="target && retired.length"><el-divider content-position="left">已退役SKU</el-divider><el-table :data="retired" border size="small" @selection-change="selectRetiredSkus"><el-table-column type="selection" width="45" /><el-table-column prop="suk" label="历史组合" /><el-table-column prop="unique" label="唯一标识" /><el-table-column prop="stock" label="保留库存" /><el-table-column prop="sales" label="历史销量" /></el-table><el-button type="success" plain :disabled="!selectedRetired.length" :loading="lifecycleBusy" @click="changeSkuLifecycle('restore')">恢复选中SKU</el-button></template>
          </section>
          <section v-show="step === 2" aria-label="商品详情">
            <el-form-item label="详情HTML"><div class="stack wide"><el-input v-model="form.description" type="textarea" :rows="20" placeholder="编辑规范HTML；素材使用 /api/assets/123 短引用" /><div><el-button @click="openAssets('description')">从素材插入图片</el-button><el-button @click="previewOpen = true">查看详情预览</el-button></div><el-text type="info">编辑正文与预览独立保存。已存商品使用服务端清理与签名预览；修改后的预览先在隔离窗口本地清理，最终以保存后读取为准。</el-text></div></el-form-item>
          </section>
          <section v-show="step === 3" aria-label="物流设置">
            <template v-if="form.product_type === 0">
              <el-form-item label="配送方式" required><el-checkbox-group v-model="form.delivery_type"><el-checkbox :value="1">快递配送</el-checkbox><el-checkbox :value="2">门店自提</el-checkbox><el-checkbox :value="3">同城配送</el-checkbox></el-checkbox-group></el-form-item>
              <el-form-item label="运费方式"><el-radio-group v-model="form.freight"><el-radio :value="1">包邮</el-radio><el-radio :value="2">固定运费</el-radio><el-radio :value="3">运费模板</el-radio></el-radio-group></el-form-item>
              <el-form-item v-if="form.freight === 2" label="固定运费" required><el-input-number v-model="form.postage" :min="0.01" :precision="2" /></el-form-item>
              <el-form-item v-if="form.freight === 3" label="运费模板" required><el-select v-model="form.temp_id" filterable><el-option v-for="item in optionsFor('shipping_templates', form.temp_id ? [form.temp_id] : [])" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
              <el-form-item label="兼容包邮标记"><el-switch v-model="form.is_postage" :active-value="1" :inactive-value="0" /><el-text type="info">保留旧字段，实际运费按上方运费方式计算。</el-text></el-form-item>
              <el-form-item label="门店可用"><el-switch v-model="form.mer_use" :active-value="1" :inactive-value="0" /></el-form-item>
            </template><el-descriptions v-if="form.product_type === 4" :column="1" border><el-descriptions-item label="历史运费方式">{{ form.freight === 1 ? '包邮' : form.freight === 2 ? '固定运费' : '运费模板' }}</el-descriptions-item><el-descriptions-item label="历史邮费 / 模板ID">{{ form.postage }} / {{ form.temp_id }}</el-descriptions-item></el-descriptions><el-empty v-if="form.product_type !== 0" :description="form.product_type === 4 ? '次卡固定为门店自提；已存运费配置保持' : '虚拟商品无需物流，保存时清空配送及邮费'" />
          </section>
          <section v-show="step === 4" aria-label="营销设置">
            <el-form-item label="虚拟销量"><el-input-number v-model="form.ficti" :min="0" :precision="0" /></el-form-item>
            <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :precision="0" /></el-form-item>
            <el-form-item label="赠送积分"><el-input-number v-model="form.give_integral" :min="0" :precision="2" /></el-form-item>
            <el-form-item label="赠送优惠券"><el-select v-model="form.coupon_ids" multiple filterable clearable><el-option v-for="item in optionsFor('gift_coupons', form.coupon_ids)" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
            <el-form-item label="购买用户标签"><el-select v-model="form.label_id" multiple filterable clearable><el-option v-for="item in optionsFor('user_labels', form.label_id)" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-text type="info">取消全部选择会在同一次商品保存中清空关联。</el-text></el-form-item>
            <el-form-item label="会员与佣金"><div class="stack"><el-checkbox-group v-model="form.is_sub"><el-checkbox :value="0">启用会员价</el-checkbox><el-checkbox :value="1">独立佣金</el-checkbox></el-checkbox-group><el-text type="warning">对应金额在规格库存逐SKU填写；关闭独立佣金后保存为0。</el-text></div></el-form-item>
            <el-form-item label="会员专属商品"><el-switch v-model="form.is_vip_product" :active-value="1" :inactive-value="0" /></el-form-item>
            <el-form-item label="限购"><el-switch v-model="form.is_limit" :active-value="1" :inactive-value="0" /></el-form-item>
            <el-form-item v-if="form.is_limit" label="限购规则"><div class="field-row"><el-select v-model="form.limit_type"><el-option :value="1" label="单次购买限购" /><el-option :value="2" label="每人累计限购" /></el-select><el-input-number v-model="form.limit_num" :min="1" :precision="0" /></div></el-form-item>
            <el-form-item label="预售商品"><el-switch v-model="form.is_presale_product" :active-value="1" :inactive-value="0" /></el-form-item>
            <el-form-item v-if="form.is_presale_product" label="预售区间"><el-date-picker v-model="form.presale_time" type="datetimerange" value-format="YYYY-MM-DD HH:mm:ss" start-placeholder="北京时间开始" end-placeholder="北京时间结束" /></el-form-item>
            <el-form-item v-if="form.is_presale_product" label="预售发货天数"><el-input-number v-model="form.presale_day" :min="0" :precision="0" /></el-form-item>
            <el-form-item label="推荐属性"><el-checkbox v-model="form.is_good" :true-value="1" :false-value="0">优品</el-checkbox><el-checkbox v-model="form.is_hot" :true-value="1" :false-value="0">热卖</el-checkbox><el-checkbox v-model="form.is_benefit" :true-value="1" :false-value="0">促销</el-checkbox><el-checkbox v-model="form.is_best" :true-value="1" :false-value="0">精品</el-checkbox><el-checkbox v-model="form.is_new" :true-value="1" :false-value="0">新品</el-checkbox></el-form-item>
            <el-form-item label="活动展示顺序"><div class="stack"><div v-for="(activity, index) in form.activity" :key="activity" class="field-row"><el-tag>{{ activity }}</el-tag><el-button size="small" :disabled="index === 0" @click="moveActivity(index, -1)">上移</el-button><el-button size="small" :disabled="index === form.activity.length - 1" @click="moveActivity(index, 1)">下移</el-button></div></div></el-form-item>
            <el-form-item label="推荐商品ID"><el-select v-model="form.recommend_list" multiple filterable allow-create default-first-option :multiple-limit="100" placeholder="输入商品ID后按回车" @change="normalizeRecommendations"><el-option v-for="item in form.recommend_list" :key="item" :value="item" :label="`商品 #${item}`" /></el-select></el-form-item>
          </section>
          <section v-show="step === 5" aria-label="其他设置">
            <el-form-item label="关键词"><el-input v-model="form.keyword" maxlength="256" /></el-form-item>
            <el-form-item label="商品简介"><el-input v-model="form.store_info" type="textarea" :rows="3" maxlength="256" /></el-form-item>
            <el-form-item label="商品口令"><el-input v-model="form.command_word" maxlength="255" /></el-form-item>
            <el-form-item label="推荐图"><div class="field-row"><el-input v-model="form.recommend_image" maxlength="256" placeholder="素材引用或HTTPS图片地址" /><el-button @click="openAssets('recommend')">选择素材</el-button></div></el-form-item>
            <el-form-item label="保障服务"><el-select v-model="form.ensure_id" multiple filterable clearable><el-option v-for="item in optionsFor('ensures', form.ensure_id)" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
            <el-form-item label="支持退款"><el-switch v-model="form.is_support_refund" :active-value="1" :inactive-value="0" /></el-form-item>
            <el-form-item label="参数模板"><div class="field-row"><el-select v-model="form.specs_id" clearable filterable><el-option v-for="item in optionsFor('parameter_templates', form.specs_id ? [form.specs_id] : [])" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button @click="applyParameterTemplate">替换为模板快照</el-button></div></el-form-item>
            <el-form-item label="参数快照"><div class="stack wide"><div v-for="(parameter, index) in form.specs" :key="index" class="parameter-row"><el-input v-model="parameter.name" maxlength="255" placeholder="名称" /><el-input v-model="parameter.value" maxlength="255" placeholder="参数值" /><el-input-number v-model="parameter.sort" :min="0" :precision="0" controls-position="right" /><el-switch v-model="parameter.status" :active-value="1" :inactive-value="0" /><el-button type="danger" plain @click="form.specs.splice(index, 1)">删除</el-button></div><el-button :disabled="form.specs.length >= 100" @click="form.specs.push({ name: '', value: '', sort: 0, status: 1 })">添加参数</el-button><el-text type="info">名称、值、排序与启用状态作为商品快照保存，不随以后模板修改而变化。</el-text></div></el-form-item>
            <el-form-item label="留言表单模板"><div class="field-row"><el-select v-model="form.system_form_id" clearable filterable><el-option v-for="item in optionsFor('system_forms', form.system_form_id ? [form.system_form_id] : [])" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button :loading="formTemplateLoading" @click="applyFormTemplate">读取并替换快照</el-button></div></el-form-item>
            <el-form-item label="实际表单快照"><div class="stack wide"><el-input v-model="customFormText" type="textarea" :rows="10" @input="applyCustomFormText" /><el-text type="info">这里编辑商品实际保存的JSON快照；切换模板ID不会自动覆盖快照。清空请填写 [] 并保存。读取模板需要相应表单查看权限。</el-text><el-text v-if="customFormError" type="danger">{{ customFormError }}</el-text></div></el-form-item>
          </section>
        </el-form>
        <footer class="actions"><el-button :disabled="step === 0" @click="step--">上一步</el-button><el-button v-if="step < 5" type="primary" plain @click="step++">下一步</el-button><el-button type="primary" :disabled="locked" :loading="submitting" @click="submit">保存完整商品</el-button><el-button :disabled="locked" :loading="draftSaving" @click="saveDraftNow">保存草稿</el-button><el-button :disabled="!!pending || submitting || !canManage" :loading="draftSaving" @click="clearDraft">删除服务器草稿</el-button><el-button @click="router.push('/product')">返回列表</el-button><el-button v-if="target && form.product_type === 1" @click="router.push(`/product/virtual/${target}`)">卡密库存</el-button></footer>
        <p class="muted" role="status">{{ draftStatus }} 草稿每账号一个共享槽，保存后有效19小时；其他窗口或商品可能覆盖。新建自动保存，编辑可手动保存草稿。</p>
        <el-button v-if="availableDraft" :disabled="locked" @click="restoreAvailableDraft">恢复本商品服务器草稿</el-button>
      </template>
    </el-card>
    <ProductVideoUploader v-model:open="videoUploadOpen" :disabled="locked" :context-key="target ? `edit:${target}` : copySourceId ? `copy:${copySourceId}` : 'create'" @use="useUploadedVideo" />
    <el-dialog v-model="previewOpen" title="商品详情预览" width="min(520px, 95vw)" destroy-on-close><p class="muted">{{ form.description === savedDescription ? '已存商品服务端预览' : '当前修改的隔离本地预览，尚未保存' }}</p><iframe class="description-preview" title="商品详情预览" sandbox="" referrerpolicy="no-referrer" :srcdoc="previewDocument" /></el-dialog>
    <el-dialog v-model="assetOpen" :title="assetTarget === 'video' ? '选择商品视频素材' : '选择商品图片素材'" width="min(880px, 95vw)" destroy-on-close><div class="field-row"><el-select v-model="assetCategory" clearable placeholder="根分类" @change="assetPage = 1; loadAssets()"><el-option :value="0" label="根分类" /><el-option v-for="item in assetCategories" :key="item.id" :value="item.id" :label="item.title || item.name" /></el-select><el-input v-model="assetSearch" placeholder="搜索素材名称" @keyup.enter="assetPage = 1; loadAssets()" /><el-button @click="assetPage = 1; loadAssets()">查询</el-button></div><el-alert v-if="assetError" :title="assetError" type="error" :closable="false" /><div v-loading="assetLoading" class="asset-grid"><button v-for="asset in assets" :key="asset.att_id" class="asset-tile" :disabled="locked" @click="selectAsset(asset)"><video v-if="assetTarget === 'video'" :src="asset.att_dir" preload="none" muted /><img v-else :src="asset.att_dir" :alt="asset.real_name" /><span>{{ asset.real_name }}</span></button></div><el-pagination v-model:current-page="assetPage" :page-size="20" :total="assetCount" layout="prev, pager, next" @current-change="loadAssets" /><p class="muted">素材权限与商品实际归属在保存事务中再次验证。素材上传与分类管理可在素材库完成。</p></el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import ProductVideoUploader from '@/components/ProductVideoUploader.vue';
import { apiAdminProductDraft, apiAdminProductDraftDelete, apiAdminProductDraftSave, apiAdminProductEditorOptions, apiAdminProductSkuRestore, apiAdminProductSkuRetire, type ProductEditorOption, type ProductEditorOptions } from '@/api/product';
import { apiFullProductDetail, apiFullProductSave, apiGenerateEditorSkus, apiProductCopyDetail, apiProductCopySave, apiProductSaveOperation } from '@/api/productEditor';
import { apiProductUnitList, type ProductUnit } from '@/api/productMetadata';
import { apiCatalogFilterBrands, apiCatalogFilterCategories, type CatalogFilterNode } from '@/api/productCatalogFilters';
import { apiAdminStockErpEnabled } from '@/api/productStock';
import { apiSystemFormInfo } from '@/api/systemForms';
import { apiAttachmentCategories, apiAttachmentList, type AttachmentCategoryItem, type AttachmentItem } from '@/api/attachment';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { canonicalProductImage, canonicalProductVideo, fromCopyDetail, fromEditorDraft, fromLegacyDetail, makeEditorDraft, mergeGeneratedSkus, newEditorSku, newProductEditor, parseEditorEntry, parsePendingProductSave, toLegacySave, validateProductSave, type EditorDimension, type EditorSku, type Json, type PendingProductSave, type ProductEditorCopy, type ProductSavePayload } from './productEditorModel';

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const route = useRoute(), router = useRouter();
const form = reactive(newProductEditor());
const target = ref(0), copySourceId = ref(0), copyContext = ref<ProductEditorCopy | null>(null), copyProductType = ref<number | null>(null), loading = ref(false), loaded = ref(false), loadError = ref(''), metadataError = ref('');
const step = ref(0), steps = ['基础信息', '规格库存', '商品详情', '物流设置', '营销设置', '其他设置'];
const sessionVersion = ref(0), submitting = ref(false), resolving = ref(false), pending = ref<PendingProductSave | null>(null), recoveryMessage = ref('');
let alive = true, turn = 0, readAbort: AbortController | null = null, boundToken: string | null = null, boundSession: string | null = null, boundActor = 0;
let inFlightPayload: ProductSavePayload | null = null;
const session = computed(() => { void sessionVersion.value; return getAdminSession(); });
const videoUploadOpen = ref(false);
const canViewMedia = computed(() => !!session.value && (session.value.userInfo.level === 0 || session.value.uniqueAuth.some(key => ['attachment.view', 'attachment.manage'].includes(key))));
const canManage = computed(() => { void sessionVersion.value; return !!getToken() && !!session.value && (session.value.userInfo.level === 0 || session.value.uniqueAuth.includes('product.manage')); });
const canRead = () => { const s = getAdminSession(); return !!getToken() && !!s && (s.userInfo.level === 0 || s.uniqueAuth.includes('product.view') || s.uniqueAuth.includes('product.manage')); };
const locked = computed(() => !loaded.value || !canManage.value || submitting.value || !!pending.value || lifecycleBusy.value || generating.value || draftDeleting.value);
const owner = ref<{ type: number; relation_id: number; supplier_id: number } | null>(null);
const ownerName = computed(() => owner.value?.type === 2 ? '供应商' : owner.value?.type === 1 ? '门店' : '平台');
const options = reactive<ProductEditorOptions>({ categories: [], brands: [], product_labels: [], user_labels: [], gift_coupons: [], system_forms: [], shipping_templates: [], ensures: [], parameter_templates: [], sku_rule_templates: [] });
const categoryTree = ref<CatalogFilterNode[]>([]), brandTree = ref<CatalogFilterNode[]>([]), historicalNames = ref<Record<string, Record<number, string>>>({});
const treeProps = { emitPath: false, multiple: true, checkStrictly: true }, units = ref<ProductUnit[]>([]), erpEnabled = ref<boolean | null>(null);
const categoryOptions = computed(() => withSelectedTree(categoryTree.value, form.cate_id, options.categories));
const brandOptions = computed(() => withSelectedTree(brandTree.value, form.brand_id, options.brands));
function withSelectedTree(tree: CatalogFilterNode[], selected: number[], flat: ProductEditorOption[]): CatalogFilterNode[] {
  const ids = new Set<number>(); const walk = (rows: CatalogFilterNode[]) => rows.forEach(row => { ids.add(row.value); if (row.children) walk(row.children); }); walk(tree);
  return [...tree, ...selected.filter(id => !ids.has(id)).map(id => ({ value: id, label: flat.find(row => row.id === id)?.name || `历史已选 #${id}`, pid: 0 }))];
}
function optionsFor(key: keyof ProductEditorOptions, ids: number[]): ProductEditorOption[] {
  const rows = options[key]; return [...rows, ...ids.filter(id => !rows.some(row => row.id === id)).map(id => ({ id, name: historicalNames.value[key]?.[id] || `历史已选 #${id}` }))];
}
function current(run = turn): boolean { return alive && run === turn && boundActor > 0 && getToken() === boundToken && localStorage.getItem('admin_session') === boundSession; }
const pendingStorageKey = (actor: number) => `admin_full_product_pending_v1:${actor}`;
function keepPending(value: PendingProductSave): void { sessionStorage.setItem(pendingStorageKey(value.actor_id), JSON.stringify(value)); pending.value = value; }
function forgetPending(committed = false): void { if (pending.value) { if (committed) { const key = `admin_full_product_resolved_v1:${pending.value.actor_id}`; const prior = JSON.parse(sessionStorage.getItem(key) || '[]') as string[]; sessionStorage.setItem(key, JSON.stringify([...prior.filter(id => id !== pending.value!.operation_id), pending.value.operation_id].slice(-64))); } sessionStorage.removeItem(pendingStorageKey(pending.value.actor_id)); } pending.value = null; inFlightPayload = null; }
function alreadyResolved(operation: PendingProductSave): boolean { try { const values: unknown = JSON.parse(sessionStorage.getItem(`admin_full_product_resolved_v1:${operation.actor_id}`) || '[]'); return Array.isArray(values) && values.includes(operation.operation_id); } catch { return false; } }
function readPending(actor: number): PendingProductSave | null { const raw = sessionStorage.getItem(pendingStorageKey(actor)); return raw ? parsePendingProductSave(JSON.parse(raw), actor) : null; }
function syncCustomForm(): void { customFormText.value = JSON.stringify(form.custom_form, null, 2); customFormError.value = ''; }
function clearSensitive(): void {
  stopDraft(); readAbort?.abort(); readAbort = null; turn++; loaded.value = false; loading.value = false;
  Object.assign(form, newProductEditor()); copySourceId.value = 0; copyContext.value = null; copyProductType.value = null; retired.value = []; owner.value = null; availableDraft.value = null; serverPreview.value = ''; savedDescription.value = ''; serverVideoPreview.value = ''; savedVideoLink.value = ''; inFlightPayload = null;
  assets.value = []; assetCategories.value = []; assetOpen.value = false; previewOpen.value = false; videoUploadOpen.value = false; pending.value = null; selectedActive.value = []; selectedRetired.value = [];
  categoryTree.value = []; brandTree.value = []; units.value = []; historicalNames.value = {}; erpEnabled.value = null; imagePreviews.clear();
  for (const key of Object.keys(options) as Array<keyof ProductEditorOptions>) options[key] = [];
  submitting.value = false; resolving.value = false; generating.value = false; draftDeleting.value = false; lifecycleBusy.value = false; formTemplateLoading.value = false; syncCustomForm();
}
function changedSession(): void { sessionVersion.value++; if (getToken() !== boundToken || localStorage.getItem('admin_session') !== boundSession) { clearSensitive(); boundActor = 0; loadError.value = '登录身份或权限资料已改变，旧商品内容已清除。请重新读取当前账号资料。'; } }
function storageChanged(event: StorageEvent): void { if (event.storageArea === localStorage && (event.key === null || event.key === 'admin_token' || event.key === 'admin_session')) changedSession(); }
async function initialize(): Promise<void> { await initializeEditor(true); }
async function initializeEditor(restoreDraft: boolean): Promise<void> {
  clearSensitive(); loadError.value = ''; metadataError.value = ''; draftStatus.value = ''; recoveryMessage.value = ''; step.value = 0;
  const s = getAdminSession(); boundActor = s?.userInfo.id || 0; boundToken = getToken(); boundSession = localStorage.getItem('admin_session');
  sessionVersion.value++; if (!boundActor || !boundToken) { loadError.value = '请先登录有效管理员账号'; return; }
  try { const entry = parseEditorEntry(route.params.id, route.query.copy, route.query.type); target.value = entry.target; copySourceId.value = entry.copySourceId; pending.value = readPending(boundActor); }
  catch (error) { loadError.value = errorText(error); return; }
  const run = turn;
  if (!canRead() || copySourceId.value && !canManage.value) { loadError.value = '当前账号没有本入口所需的商品查看或管理权限；未确认请求可在上方恢复'; if (pending.value) void recover(false); return; }
  loading.value = true; readAbort = new AbortController(); const signal = readAbort.signal;
  try {
    const results = await Promise.allSettled([apiAdminProductEditorOptions(), apiProductUnitList({ page: 1, limit: 100 }), apiCatalogFilterCategories(signal), apiCatalogFilterBrands(signal), apiAdminStockErpEnabled(signal), copySourceId.value ? apiProductCopyDetail(copySourceId.value, signal) : target.value ? apiFullProductDetail(target.value, signal) : Promise.resolve(null), apiAdminProductDraft()]);
    if (!current(run)) return;
    const [metadata, unit, categories, brands, erp, detail, draft] = results;
    if (metadata.status === 'fulfilled') Object.assign(options, metadata.value); else metadataError.value = '部分基础候选未能读取，历史已选值保持；请核实后保存。';
    if (unit.status === 'fulfilled') units.value = unit.value.list;
    if (categories.status === 'fulfilled') categoryTree.value = categories.value; else categoryTree.value = options.categories.map(item => ({ value: item.id, label: item.name, pid: 0 }));
    if (brands.status === 'fulfilled') brandTree.value = brands.value; else brandTree.value = options.brands.map(item => ({ value: item.id, label: item.name, pid: 0 }));
    erpEnabled.value = erp.status === 'fulfilled' ? erp.value : null;
    if (detail.status === 'rejected') throw detail.reason;
    if (detail.value) {
      const copied = copySourceId.value ? fromCopyDetail(detail.value, copySourceId.value) : null; const state = copied ?? fromLegacyDetail(detail.value); if (copied) { copyContext.value = copied.copy; copyProductType.value = copied.model.product_type; } Object.assign(form, state.model); owner.value = state.owner; retired.value = state.retired; serverPreview.value = state.preview; savedDescription.value = state.savedDescription; serverVideoPreview.value = state.videoPreview; savedVideoLink.value = state.savedVideoLink; if (typeof detail.value.editor.erp_open === 'boolean') erpEnabled.value = detail.value.editor.erp_open;
      for (const source of [...form.slider_image, form.recommend_image, ...form.attrs.map(row => row.pic), ...[...state.preview.matchAll(/\bsrc="([^"]+)"/g)].map(match => match[1]!)]) { try { if (source) { const preview = source.replaceAll('&amp;', '&'); imagePreviews.set(canonicalProductImage(preview), preview); } } catch { /* editable validation reports invalid stored media on save */ } }
      const p = detail.value.productInfo; historicalNames.value = {
        product_labels: nameMap(p.store_label_id, 'label_name'), user_labels: nameMap(p.label_id, 'label_name'), gift_coupons: nameMap(p.coupons, 'title'),
      };
    }
    dimensions.value = cloneJson(form.items); syncCustomForm(); loaded.value = true;
    if (restoreDraft && draft.status === 'fulfilled' && !Array.isArray(draft.value.info)) {
      availableDraft.value = draft.value.info;
      try {
        const restored = fromEditorDraft(draft.value.info, boundActor, target.value, copySourceId.value);
        if (restored.pending && alreadyResolved(restored.pending)) { availableDraft.value = null; throw Error('服务器保留的是已处理操作的旧草稿，请勿恢复；当前商品已重新读取。'); }
        if (restored.pending) {
          if (pending.value && pending.value.operation_id !== restored.pending.operation_id) throw Error('本窗口与服务器草稿存在不同未确认请求，请先核实本窗口操作');
          keepPending(restored.pending);
        }
        if (!target.value || restored.pending) { applyRestoredState(restored); availableDraft.value = null; draftStatus.value = '已恢复本商品完整草稿。'; }
      } catch (error) { draftStatus.value = errorText(error); }
    }
    draftEnabled = !target.value && !pending.value && canManage.value; if (pending.value) void recover(false);
  } catch (error) { if (current(run)) { Object.assign(form, newProductEditor()); loaded.value = false; owner.value = null; retired.value = []; copyContext.value = null; loadError.value = `完整商品读取失败，保存已禁用：${errorText(error)}`; if (pending.value) void recover(false); } }
  finally { if (current(run)) loading.value = false; }
}
async function reloadCopySource(): Promise<void> {
  if (!copySourceId.value || locked.value) return;
  const run = turn;
  try {
    await ElMessageBox.confirm('将用最新来源快照替换本页面未保存的复制内容。服务器草稿在下次保存时更新。', '重新读取复制来源', { confirmButtonText: '重新读取', cancelButtonText: '保留当前内容', type: 'warning' });
    if (!current(run) || locked.value) return;
    stopDraft(); await drainDraft(); if (!current(run)) return;
    await initializeEditor(false);
    if (loaded.value) draftStatus.value = '已采用最新来源快照；原复制草稿未自动恢复，请核实后保存。';
  } catch (error) { if (current(run) && error !== 'cancel' && error !== 'close') ElMessage.error(errorText(error)); }
}
function nameMap(value: unknown, field: string): Record<number, string> { return Array.isArray(value) ? Object.fromEntries(value.flatMap(row => row && typeof row === 'object' && Number.isSafeInteger(row.id) && typeof row[field] === 'string' ? [[row.id, row[field]]] : [])) : {}; }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`; return JSON.stringify(value); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error || '请求未能完成'); }
function ensureWritable(): void { if (!current() || locked.value) throw Error('当前商品或账号状态不允许保存'); }
async function submit(): Promise<void> {
  try { ensureWritable(); applyCustomFormText(); if (customFormError.value) throw Error(customFormError.value); form.specs_id = Number(form.specs_id || 0); form.system_form_id = Number(form.system_form_id || 0); if (copySourceId.value && (!copyContext.value || form.product_type !== copyProductType.value)) throw Error('复制上下文或履约类型已变化，请重新读取来源'); validateProductSave(toLegacySave(form, copyContext.value), erpEnabled.value, Date.now(), copyContext.value); }
  catch (error) { ElMessage.error(errorText(error)); return; }
  const run = turn, actor = boundActor, id = target.value;
  let mutationStarted = false;
  submitting.value = true; stopDraft(); await drainDraft(); if (!current(run)) { submitting.value = false; return; }
  try {
    const operation = { actor_id: actor, requested_id: id, operation_id: crypto.randomUUID() }; inFlightPayload = toLegacySave(form, copyContext.value); keepPending(operation);
    // Save the exact projected payload and minimal recovery marker before starting the mutation.
    await queueDraft(makeEditorDraft(form, id, operation, copyContext.value), run);
    if (!current(run)) return;
    mutationStarted = true; const receipt = await (copyContext.value ? apiProductCopySave(operation, copyContext.value, inFlightPayload) : apiFullProductSave(operation, inFlightPayload));
    if (!current(run)) return;
    if (receipt.state !== 'committed') throw Error('保存响应未证明提交，结果待确认');
    await committed(receipt.result!.id, run);
  } catch (error) {
    if (!current(run)) return;
    if (!mutationStarted) { forgetPending(); draftEnabled = !target.value && canManage.value; ElMessage.error(`商品保存请求尚未发送：${errorText(error)}`); return; }
    if (error instanceof AdminResponseError && typeof error.status === 'number' && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
      // Even business rejection may follow a committed operation-key retry. Resolve before allowing a fresh write.
      recoveryMessage.value = `保存被拒绝：${error.message}。请确认原事务结果后继续。`;
    } else recoveryMessage.value = `无法确认保存结果：${errorText(error)}。不会自动重发。`;
    ElMessage.warning(recoveryMessage.value);
  } finally { if (current(run)) submitting.value = false; }
}
async function committed(id: number, run: number): Promise<void> {
  stopDraft(); await drainDraft(); if (!current(run)) return;
  let cleanupFailed = false; try { await apiAdminProductDraftDelete(); } catch { cleanupFailed = true; }
  if (!current(run)) return;
  forgetPending(true); availableDraft.value = null; loaded.value = false; copyContext.value = null; copySourceId.value = 0; copyProductType.value = null;
  ElMessage.success(cleanupFailed ? '商品已提交，旧服务器草稿清理失败；请勿恢复该旧草稿' : '完整商品已保存');
  await router.replace(`/product/edit/${id}`); if (current(run) && route.query.copy === undefined) await initialize();
}
async function recover(resolve: boolean): Promise<void> {
  if (!pending.value || resolving.value || !current()) return;
  const operation = { ...pending.value }, run = turn; resolving.value = true;
  try {
    const receipt = await apiProductSaveOperation(operation, resolve); if (!current(run)) return;
    if (receipt.state === 'committed') { recoveryMessage.value = '已核实原保存提交成功'; await committed(receipt.result!.id, run); }
    else if (receipt.state === 'not_applied') {
      forgetPending(); recoveryMessage.value = '已封存原请求未提交。请核对表单，明确点击保存会创建新的操作标识。';
      draftStatus.value = recoveryMessage.value; draftEnabled = !target.value && canManage.value;
      if (loaded.value && canManage.value && operation.requested_id === target.value) await queueDraft(makeEditorDraft(form, target.value, null, copyContext.value), run).catch(() => undefined);
    } else recoveryMessage.value = '尚未找到确定回执，不能据此重复保存。原事务仍在处理时“确认原事务结果”会提示忙碌，请稍后重试；结束后可封存结果。';
  } catch (error) { if (current(run)) recoveryMessage.value = `仍无法确认：${errorText(error)}。原请求标识已保留。`; }
  finally { if (current(run)) resolving.value = false; }
}
function openPendingTarget(): void { if (pending.value) void router.push(pending.value.requested_id ? `/product/edit/${pending.value.requested_id}` : '/product/create'); }

let draftEnabled = false, draftTimer: ReturnType<typeof setTimeout> | null = null, draftQueue: Promise<void> = Promise.resolve();
const draftDeleting = ref(false), draftSaving = ref(false), draftStatus = ref(''), availableDraft = ref<Record<string, unknown> | null>(null);
function stopDraft(): void { draftEnabled = false; if (draftTimer) clearTimeout(draftTimer); draftTimer = null; }
function drainDraft(): Promise<void> { return draftQueue.catch(() => undefined); }
function queueDraft(body: ReturnType<typeof makeEditorDraft>, run: number): Promise<void> {
  const value = cloneJson(body), ownerToken = boundToken, ownerSession = boundSession;
  const operation = draftQueue.catch(() => undefined).then(async () => {
    if (!current(run) || ownerToken !== boundToken || ownerSession !== boundSession) return;
    draftSaving.value = true;
    try {
      const saved = await apiAdminProductDraftSave(value);
      if (!current(run)) return;
      if (stableJson(saved.info) !== stableJson(value)) throw Error('服务器草稿回读与完整表单不一致，未确认草稿保存');
      draftStatus.value = `草稿已保存 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (error) { if (current(run)) draftStatus.value = `草稿保存失败，当前内容仍保留：${errorText(error)}`; throw error; }
    finally { if (current(run)) draftSaving.value = false; }
  });
  draftQueue = operation; return operation;
}
async function saveDraftNow(): Promise<void> { try { ensureWritable(); applyCustomFormText(); if (customFormError.value) throw Error(customFormError.value); await queueDraft(makeEditorDraft(form, target.value, null, copyContext.value), turn); } catch (error) { ElMessage.error(errorText(error)); } }
async function clearDraft(): Promise<void> { if (!current() || pending.value || submitting.value || draftDeleting.value || !canManage.value) return; draftDeleting.value = true; const run = turn; stopDraft(); await drainDraft(); if (!current(run)) return; draftSaving.value = true; try { await apiAdminProductDraftDelete(); if (current(run)) { availableDraft.value = null; draftStatus.value = '服务器草稿已删除，当前表单内容保留。再次修改会开始新的自动草稿。'; } } catch (error) { if (current(run)) ElMessage.error(errorText(error)); } finally { if (current(run)) { draftSaving.value = false; draftDeleting.value = false; draftEnabled = !target.value && canManage.value; } } }
function applyRestoredModel(model: ReturnType<typeof newProductEditor>): void { const prior = new Map(form.attrs.filter(row => row.unique).map(row => [row.unique, row])); for (const row of model.attrs) { const old = row.unique ? prior.get(row.unique) : undefined; if (old) { row.id = old.id; row.original_disk_info = old.original_disk_info; row.virtual_available = old.virtual_available; row.virtual_total = old.virtual_total; row.sales = old.sales; } } Object.assign(form, model); dimensions.value = cloneJson(form.items); syncCustomForm(); }
function applyRestoredState(state: ReturnType<typeof fromEditorDraft>): void {
  if (copySourceId.value) { if (!state.copy || state.model.product_type !== copyProductType.value) throw Error('复制草稿履约类型与当前来源不一致，请核实来源变更'); copyContext.value = state.copy; owner.value = { ...state.copy.destination, supplier_id: state.copy.destination.type === 2 ? state.copy.destination.relation_id : 0 }; }
  applyRestoredModel(state.model);
}
function restoreAvailableDraft(): void { if (!availableDraft.value || locked.value) return; try { const state = fromEditorDraft(availableDraft.value, boundActor, target.value, copySourceId.value); if (state.pending && alreadyResolved(state.pending)) throw Error('该草稿属于已处理操作，请勿恢复'); if (state.pending) keepPending(state.pending); applyRestoredState(state); availableDraft.value = null; draftStatus.value = '已恢复服务器完整草稿'; if (state.pending) void recover(false); } catch (error) { ElMessage.error(errorText(error)); } }
watch(form, () => { if (!draftEnabled || !current() || locked.value) return; if (draftTimer) clearTimeout(draftTimer); draftTimer = setTimeout(() => { try { void queueDraft(makeEditorDraft(form, target.value, null, copyContext.value), turn).catch(() => undefined); } catch (error) { draftStatus.value = `草稿未保存：${errorText(error)}`; } }, 1000); }, { deep: true });

const dimensions = ref<EditorDimension[]>(cloneJson(form.items)), skuTemplateId = ref<number>(), generating = ref(false);
watch(dimensions, () => { if (form.spec_type === 1) form.items = cloneJson(dimensions.value); }, { deep: true });
const retired = ref<EditorSku[]>([]), selectedActive = ref<number[]>([]), selectedRetired = ref<number[]>([]), lifecycleBusy = ref(false);
const historicalSku = (row: EditorSku) => !!row.id && !!row.unique;
const selectActiveSkus = (rows: EditorSku[]) => { selectedActive.value = rows.flatMap(row => row.id ? [row.id] : []); };
const selectRetiredSkus = (rows: EditorSku[]) => { selectedRetired.value = rows.flatMap(row => row.id ? [row.id] : []); };
const priceColumns = computed(() => [{ key: 'price', name: '售价' }, { key: 'ot_price', name: '划线价' }, { key: 'cost', name: '成本价' }, ...(owner.value?.type === 2 ? [{ key: 'settle_price', name: '供应商结算价' }] : []), ...(form.is_sub.includes(0) ? [{ key: 'vip_price', name: '会员价' }] : []), ...(form.is_sub.includes(1) ? [{ key: 'brokerage', name: '一级佣金' }, { key: 'brokerage_two', name: '二级佣金' }] : []), ...(form.product_type === 0 ? [{ key: 'weight', name: '重量 kg' }, { key: 'volume', name: '体积 m³' }] : [])]);
const batchFields = [{ key: 'price', name: '售价' }, { key: 'ot_price', name: '划线价' }, { key: 'cost', name: '成本价' }, { key: 'vip_price', name: '会员价' }, { key: 'stock', name: '库存' }, { key: 'weight', name: '重量' }, { key: 'volume', name: '体积' }, { key: 'brokerage', name: '一级佣金' }, { key: 'brokerage_two', name: '二级佣金' }] as const;
const batchField = ref<(typeof batchFields)[number]['key']>('price'), batchValue = ref(0);
function stockDisabled(row: EditorSku): boolean { return form.product_type === 0 && erpEnabled.value !== false || form.product_type === 1 && (copySourceId.value > 0 || row.delivery_mode === 'cards'); }
function applyBatch(): void { if (locked.value) return; if (batchField.value === 'stock' && form.attrs.some(stockDisabled)) return void ElMessage.error('当前部分库存由ERP或卡密库存维护，不能批量修改'); for (const row of form.attrs) row[batchField.value] = batchValue.value; }
function fillSkuImages(): void { if (!locked.value) for (const row of form.attrs) if (!row.pic) row.pic = form.slider_image[0] || ''; }
function changeDelivery(row: EditorSku): void { if (row.delivery_mode === 'cards') { row.disk_info = ''; if (!row.id || row.original_disk_info.trim()) row.stock = 0; } }
function changeProductType(): void { if (target.value || copySourceId.value) return; if (form.product_type !== 1) form.attrs.forEach(row => { row.disk_info = ''; row.virtual_list = []; row.delivery_mode = 'cards'; }); else form.attrs.forEach(row => { row.stock = 0; }); if (form.product_type === 4) { form.freight = 1; form.postage = 0; form.temp_id = 0; form.delivery_type = [2]; form.spec_type = 0; form.items = [{ value: '规格', detail: ['默认'] }]; form.attrs = [newEditorSku()]; form.unit_name = '次卡'; } }
function changeSpecType(value: unknown): void { const next = Number(value) === 1 ? 1 : 0; if (next === form.spec_type) return; if (form.attrs.some(row => row.unique)) return void ElMessage.error('历史SKU不能通过切换规格类型移除，请先核实并退役'); form.spec_type = next; if (!next) { form.items = [{ value: '规格', detail: ['默认'] }]; form.attrs = [newEditorSku()]; } else { dimensions.value = []; form.items = []; form.attrs = []; } }
function applySkuTemplate(): void { const template = options.sku_rule_templates.find(row => row.id === skuTemplateId.value); if (!template) return void ElMessage.error('请选择规格模板'); dimensions.value = template.dimensions.map(row => ({ value: row.value, detail: [...row.detail] })); }
async function generateSkus(): Promise<void> { if (locked.value) return; const run = turn; generating.value = true; try { const dims = cloneJson(dimensions.value); if (!dims.length || dims.length > 3 || dims.some(row => !row.value || !row.detail.length || row.detail.length > 50) || dims.reduce((n, row) => n * row.detail.length, 1) > 200) throw Error('请填写1至3个有效规格维度，组合最多200项'); const generated = await apiGenerateEditorSkus(target.value, form.product_type, dims); if (!current(run)) return; const rows = mergeGeneratedSkus(generated.attr, generated.value, form.attrs); form.items = generated.attr.map(row => ({ value: row.value, detail: [...row.detail] })); form.attrs = rows; } catch (error) { if (current(run)) ElMessage.error(errorText(error)); } finally { if (current(run)) generating.value = false; } }
async function changeSkuLifecycle(action: 'retire' | 'restore'): Promise<void> { if (locked.value || !target.value) return; const ids = action === 'retire' ? selectedActive.value : selectedRetired.value; if (!ids.length) return; const run = turn; try { const { value } = await ElMessageBox.prompt('此操作会立即改变历史SKU状态并重新读取规格，未保存的规格修改将被替换。请输入2至255字原因。', action === 'retire' ? '退役SKU' : '恢复SKU', { inputValidator: input => input.trim().length >= 2 && input.trim().length <= 255 || '请输入2至255字原因' }); if (!current(run) || locked.value) return; lifecycleBusy.value = true; const result = await (action === 'retire' ? apiAdminProductSkuRetire(target.value, ids, value.trim()) : apiAdminProductSkuRestore(target.value, ids, value.trim())); if (!current(run)) return; if (!result.verified) throw Error('SKU状态回读未通过，请重新读取核实'); const state = fromLegacyDetail(await apiFullProductDetail(target.value)); if (!current(run)) return; form.items = state.model.items; form.attrs = state.model.attrs; form.spec_type = state.model.spec_type; dimensions.value = cloneJson(form.items); retired.value = state.retired; selectedActive.value = []; selectedRetired.value = []; ElMessage.success(`已${action === 'retire' ? '退役' : '恢复'} ${result.changed} 个SKU`); } catch (error) { if (current(run) && error !== 'cancel' && error !== 'close') ElMessage.error(errorText(error)); } finally { if (current(run)) lifecycleBusy.value = false; } }
function moveImage(index: number, by: number): void { const next = index + by; if (next >= 0 && next < form.slider_image.length) [form.slider_image[index], form.slider_image[next]] = [form.slider_image[next]!, form.slider_image[index]!]; }
function moveActivity(index: number, by: number): void { const next = index + by; if (next >= 0 && next < form.activity.length) [form.activity[index], form.activity[next]] = [form.activity[next]!, form.activity[index]!]; }
function normalizeRecommendations(): void { const ids = form.recommend_list.map(Number); if (ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647) || new Set(ids).size !== ids.length) { ElMessage.error('推荐商品须为不重复的正整数ID'); form.recommend_list = ids.filter((id, index) => Number.isSafeInteger(id) && id > 0 && id <= 2147483647 && ids.indexOf(id) === index); } else form.recommend_list = ids; }
function applyParameterTemplate(): void { const template = options.parameter_templates.find(row => row.id === form.specs_id); if (!template) return void ElMessage.error('当前参数模板不在已读取候选中，原快照保持'); form.specs = template.specs.map(row => ({ name: row.name, value: row.value, sort: row.sort, status: row.status === 0 ? 0 : 1 })); }
const customFormText = ref('[]'), customFormError = ref(''), formTemplateLoading = ref(false);
function applyCustomFormText(): void { try { const value: Json = JSON.parse(customFormText.value); if (!value || typeof value !== 'object') throw Error('表单快照须为JSON数组或对象'); if (Object.keys(value).length > 100) throw Error('表单快照最多100项'); form.custom_form = value as typeof form.custom_form; customFormError.value = ''; } catch (error) { customFormError.value = `表单快照未应用：${errorText(error)}`; } }
async function applyFormTemplate(): Promise<void> { if (locked.value || !form.system_form_id) return; const run = turn, id = form.system_form_id; formTemplateLoading.value = true; try { const template = await apiSystemFormInfo(id); if (current(run) && form.system_form_id === id) { form.custom_form = cloneJson(template.value) as unknown as Json[]; syncCustomForm(); } } catch (error) { if (current(run)) ElMessage.error(`表单模板读取失败，原快照保持：${errorText(error)}`); } finally { if (current(run)) formTemplateLoading.value = false; } }

const serverPreview = ref(''), savedDescription = ref(''), previewOpen = ref(false), imagePreviews = new Map<string, string>();
const serverVideoPreview = ref(''), savedVideoLink = ref('');
function useUploadedVideo(value: { url: string; src: string }): void {
  if (locked.value) return;
  try { const reference = canonicalProductVideo(value.url);
    if (!reference) throw Error('视频素材地址为空');
    form.video_open = 1; form.video_link = reference; savedVideoLink.value = reference;
    serverVideoPreview.value = value.src && canonicalProductVideo(value.src) === reference ? value.src : '';
  } catch (reason) { ElMessage.error(errorText(reason)); }
}
const videoPreviewUrl = computed(() => {
  if (!form.video_open || !form.video_link) return '';
  try {
    const reference = canonicalProductVideo(form.video_link);
    if (!reference.startsWith('/api/assets/')) return reference;
    return reference === canonicalProductVideo(savedVideoLink.value) && serverVideoPreview.value
      && canonicalProductVideo(serverVideoPreview.value) === reference ? serverVideoPreview.value : '';
  } catch { return ''; }
});
const imagePreview = (value: string) => imagePreviews.get(value) || value;
const previewDocument = computed(() => {
  let html = form.description === savedDescription.value ? serverPreview.value : localPreview(form.description);
  html = html.replace(/<meta\b[^>]*>/gi, '');
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{margin:12px;font:14px/1.6 sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${html}</body></html>`;
});
function localPreview(html: string): string { if (typeof DOMParser === 'undefined') return ''; const doc = new DOMParser().parseFromString(html, 'text/html'); const allowed = new Set(['P', 'BR', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'IMG', 'HR']); for (const element of [...doc.body.querySelectorAll('*')]) { if (!allowed.has(element.tagName)) { element.remove(); continue; } for (const attribute of [...element.attributes]) if (!(element.tagName === 'IMG' && attribute.name === 'src') && attribute.name !== 'alt') element.removeAttribute(attribute.name); if (element.tagName === 'IMG') { const source = element.getAttribute('src') || ''; try { const canonical = canonicalProductImage(source); element.setAttribute('src', imagePreviews.get(canonical) || source); } catch { element.remove(); } } } return doc.body.innerHTML; }
const assetOpen = ref(false), assetLoading = ref(false), assetError = ref(''), assetSearch = ref(''), assetCategory = ref(0), assetPage = ref(1), assetCount = ref(0), assets = ref<AttachmentItem[]>([]), assetCategories = ref<AttachmentCategoryItem[]>([]);
let assetTarget: 'slider' | 'recommend' | 'description' | 'video' = 'slider', assetRun = 0, assetSetupRun = 0;
async function openAssets(target: typeof assetTarget): Promise<void> { if (locked.value) return; assetTarget = target; assetOpen.value = true; assetError.value = ''; assetRun++; assets.value = []; assetCount.value = 0; assetCategories.value = []; assetCategory.value = 0; assetPage.value = 1; const run = turn, setup = ++assetSetupRun; try { const result = await apiAttachmentCategories(undefined, { all: true, file_type: target === 'video' ? 2 : 1 }); if (current(run) && setup === assetSetupRun && assetOpen.value) assetCategories.value = result.list; } catch (error) { if (current(run) && setup === assetSetupRun) assetError.value = errorText(error); } if (current(run) && setup === assetSetupRun) await loadAssets(); }
async function loadAssets(): Promise<void> { if (!current() || !assetOpen.value) return; const run = turn, query = ++assetRun, fileType = assetTarget === 'video' ? 2 : 1; assetLoading.value = true; assetError.value = ''; try { const result = await apiAttachmentList({ page: assetPage.value, limit: 20, pid: assetCategory.value || 0, name: assetSearch.value, file_type: fileType }); if (!current(run) || query !== assetRun || !assetOpen.value) return; assets.value = result.list.filter(row => fileType === 2 ? row.file_type === 2 && row.att_type.trim().toLowerCase() === 'video/mp4' : row.att_type.startsWith('image/')); assetCount.value = result.count; } catch (error) { if (current(run) && query === assetRun) { assets.value = []; assetError.value = `素材读取失败：${errorText(error)}`; } } finally { if (current(run) && query === assetRun) assetLoading.value = false; } }
function selectAsset(asset: AttachmentItem): void { if (locked.value || !assets.value.includes(asset)) return; try { if (assetTarget === 'video') useUploadedVideo({ url: canonicalProductVideo(asset.canonical_url), src: asset.att_dir }); else { const canonical = canonicalProductImage(asset.canonical_url); imagePreviews.set(canonical, asset.att_dir); if (assetTarget === 'slider') { if (form.slider_image.length >= 10) throw Error('轮播图最多10张'); form.slider_image.push(canonical); } else if (assetTarget === 'recommend') form.recommend_image = canonical; else form.description += `\n<p><img src="${canonical.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" alt=""></p>`; } assetOpen.value = false; } catch (error) { ElMessage.error(errorText(error)); } }
onMounted(() => { window.addEventListener('admin-session-changed', changedSession); window.addEventListener('admin-auth-expired', changedSession); window.addEventListener('storage', storageChanged); void initialize(); });
watch([() => route.params.id, () => route.query.copy, () => route.query.type], () => { if (alive) void initialize(); });
onBeforeUnmount(() => { alive = false; stopDraft(); readAbort?.abort(); window.removeEventListener('admin-session-changed', changedSession); window.removeEventListener('admin-auth-expired', changedSession); window.removeEventListener('storage', storageChanged); });
</script>

<style scoped>
.video-preview{width:100%;max-width:640px;max-height:360px;background:#111}
.product-form{max-width:1420px}.heading{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.heading h1{font-size:20px;margin:0}.notice{margin-bottom:16px}.muted{font-size:13px;color:var(--el-text-color-secondary);line-height:1.7}.steps{margin:20px 0}.step-links{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 24px}.step-links .el-button{margin:0}.editor-form{min-width:0}.editor-form :deep(.el-select),.editor-form :deep(.el-cascader){width:100%;max-width:640px}.wide{width:100%}.stack{display:grid;gap:12px}.field-row{display:flex;align-items:center;gap:8px;width:100%;min-width:0}.field-row .el-select,.field-row .el-input{flex:1}.wrap{flex-wrap:wrap}.field-row .compact{max-width:180px}.image-row{display:flex;align-items:center;gap:8px}.image-row img{width:60px;height:60px;object-fit:cover;border-radius:4px}.dimension-row{display:grid;grid-template-columns:160px minmax(180px,1fr) auto;gap:8px}.parameter-row{display:grid;grid-template-columns:minmax(100px,1fr) minmax(150px,2fr) 120px 45px auto;gap:8px;align-items:center}.sku-shell{width:100%;overflow:hidden;margin-bottom:18px}.sku-shell :deep(.el-input-number){width:100%}.lifecycle{display:flex;align-items:center;gap:12px;margin:12px 0;flex-wrap:wrap}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--el-border-color-lighter);padding-top:20px;margin-top:24px}.actions .el-button{margin:0}.pending-panel{padding:16px;border:1px solid var(--el-color-warning-light-5);background:var(--el-color-warning-light-9);border-radius:6px;margin-bottom:20px;overflow-wrap:anywhere}.pending-panel p{line-height:1.7}.description-preview{width:100%;height:560px;border:1px solid var(--el-border-color);background:white}.asset-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0;min-height:160px}.asset-tile{background:var(--el-fill-color-blank);border:1px solid var(--el-border-color);padding:8px;cursor:pointer;display:grid;gap:8px;min-width:0;color:var(--el-text-color-primary)}.asset-tile img,.asset-tile video{width:100%;height:120px;object-fit:contain}.asset-tile span{overflow-wrap:anywhere;font-size:12px}
@media(max-width:760px){.steps{display:none}.editor-form :deep(.el-form-item){display:block}.editor-form :deep(.el-form-item__label){width:auto!important;height:auto;margin-bottom:7px;line-height:1.5}.editor-form :deep(.el-form-item__content){margin-left:0!important}.image-row{flex-wrap:wrap}.image-row .el-input{flex:1;min-width:170px}.dimension-row,.parameter-row{grid-template-columns:1fr}.field-row{flex-wrap:wrap}.asset-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.step-links .el-button{flex:1 1 28%;height:auto;min-height:32px}.description-preview{height:480px}}
</style>
