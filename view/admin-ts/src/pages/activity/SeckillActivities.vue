<template>
  <div class="seckill-activities">
    <div class="heading"><div><h2>秒杀父活动</h2><p class="hint">在活动日期内，每天按所选场次开放购买。累计限购和额度按每个秒杀商品计算。</p></div><el-button v-if="canManage" type="primary" :disabled="!ready || submitting || confirming" @click="openForm(0, 'create')">添加秒杀活动</el-button></div>
    <el-alert v-if="!canView" title="当前账号没有秒杀父活动查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <div class="filters">
        <label><span>活动名称或ID</span><el-input v-model="draftKeyword" aria-label="活动名称或ID" maxlength="100" placeholder="名称关键词或完整ID" clearable :disabled="submitting" @keyup.enter="search" /></label>
        <label><span>日期阶段</span><el-select v-model="draftPhase" aria-label="日期阶段" clearable placeholder="全部阶段" :disabled="submitting" @change="search"><el-option label="未开始" value="future" /><el-option label="活动日期内" value="active" /><el-option label="已结束" value="ended" /><el-option label="日期损坏" value="invalid" /></el-select></label>
        <label><span>是否开启</span><el-select v-model="draftStatus" aria-label="是否开启" clearable placeholder="全部状态" :disabled="submitting" @change="search"><el-option label="开启" :value="1" /><el-option label="关闭" :value="0" /></el-select></label>
        <div class="actions"><el-button type="primary" :disabled="submitting" @click="search">查询</el-button><el-button :disabled="submitting" @click="reset">重置</el-button></div>
      </div>
      <el-alert v-if="actionNotice" :title="actionNotice" :type="uncertainOperation ? 'warning' : 'info'" :closable="false" show-icon class="notice"><template #default><el-button link :disabled="loading || submitting" @click="load()">重新读取活动</el-button></template></el-alert>
      <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon><template #default><el-button link @click="load()">重试列表</el-button></template></el-alert>
      <div v-else class="table-scroll">
        <el-table :data="list" row-key="id" border v-loading="loading" :empty-text="loading ? '加载中…' : '暂无秒杀父活动'">
          <el-table-column prop="id" label="父活动ID" width="100" />
          <el-table-column label="活动名称" min-width="170"><template #default="{ row }"><span>{{ row.name || '未命名活动' }}</span><el-tag v-if="!row.valid" type="danger" size="small">需修复</el-tag></template></el-table-column>
          <el-table-column label="活动日期" min-width="195"><template #default="{ row }">{{ row.start_day || '日期损坏' }} — {{ row.end_day || '日期损坏' }}</template></el-table-column>
          <el-table-column label="每日场次" min-width="180"><template #default="{ row }"><div v-for="time in row.time_list" :key="time.id">{{ time.start_time }} — {{ time.end_time }}<span v-if="time.status !== 1" class="hint">（隐藏）</span></div><span v-if="!row.time_list.length" class="hint">没有可用场次</span></template></el-table-column>
          <el-table-column prop="product_count" label="参与商品" width="100" />
          <el-table-column label="日期阶段" width="125"><template #default="{ row }"><el-tag :type="row.phase === 'active' ? 'success' : row.phase === 'invalid' ? 'danger' : 'info'">{{ phaseLabel(row.phase) }}</el-tag></template></el-table-column>
          <el-table-column label="是否开启" width="95"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? '开启' : '关闭' }}</el-tag></template></el-table-column>
          <el-table-column label="创建时间" width="165"><template #default="{ row }">{{ createdAt(row.add_time) }}</template></el-table-column>
          <el-table-column label="操作" :fixed="compact ? undefined : 'right'" width="285"><template #default="{ row }"><div class="actions"><el-button link @click="openForm(row.id, 'view')" :disabled="!ready || submitting || confirming">详情</el-button><template v-if="canManage"><el-button link type="primary" :disabled="!ready || submitting || confirming" @click="openForm(row.id, 'edit')">编辑</el-button><el-button link type="primary" :disabled="!ready || submitting || confirming" @click="openForm(row.id, 'copy')">复制</el-button><el-button link :type="row.status === 1 ? 'warning' : 'success'" :disabled="!ready || submitting || confirming" @click="toggleStatus(row)">{{ row.status === 1 ? '关闭' : '开启' }}</el-button><el-button link type="danger" :disabled="!ready || submitting || confirming" @click="remove(row)">删除</el-button></template></div></template></el-table-column>
        </el-table>
      </div>
      <el-pagination v-if="ready && !listError" :current-page="page" :page-size="15" :total="count" :page-count="Math.min(Math.max(1, Math.ceil(count / 15)), MAX_PAGE)" :disabled="loading || submitting || confirming" layout="total, prev, pager, next" @current-change="load" class="pager" />
      <p v-if="count > MAX_PAGE * 15" class="hint">请用活动名称、ID或状态筛选缩小范围。</p>
    </template>

    <el-dialog v-model="formVisible" :title="mode === 'view' ? '秒杀父活动详情' : mode === 'copy' ? '复制秒杀父活动' : formId ? '编辑秒杀父活动' : '添加秒杀父活动'" width="min(1180px, calc(100vw - 24px))" top="4vh" :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting" @closed="onFormClosed">
      <div v-loading="formLoading">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon class="notice" />
        <el-alert v-if="optionsError" :title="optionsError" type="warning" :closable="false" show-icon class="notice"><template #default><el-button link @click="loadOptions">重新读取场次</el-button></template></el-alert>
        <template v-if="form">
          <el-alert v-if="mode === 'copy'" title="复制会新建父活动、子商品和活动规格。额度预填原活动当前剩余量，可在保存前调整；来源的订单、销量和规格身份不会复制。" type="info" :closable="false" show-icon class="notice" />
          <el-alert v-if="formIssues.length" :title="formIssues.join('；')" type="warning" :closable="false" show-icon class="notice" />
          <details v-if="raw && Object.keys(raw).length" class="legacy"><summary>查看历史原值</summary><pre>{{ JSON.stringify(raw, null, 2) }}</pre></details>
          <el-tabs v-model="formTab">
            <el-tab-pane label="基础设置" name="base">
              <el-form :model="form" label-width="130px" :disabled="!editable || submitting">
                <el-form-item label="活动名称" required><el-input v-model="form.name" maxlength="128" placeholder="活动名称" /></el-form-item>
                <div class="date-fields"><el-form-item label="开始日期" required><input v-model="form.start_day" type="date" aria-label="开始日期" :disabled="!editable || submitting" /></el-form-item><el-form-item label="结束日期" required><input v-model="form.end_day" type="date" aria-label="结束日期" :disabled="!editable || submitting" /></el-form-item></div>
                <p class="hint inset">日期按上海时间计算，结束日期当天也可参加。跨天活动在每天所选场次开放。</p>
                <el-form-item label="每日秒杀场次" required><el-select v-model="form.time_ids" multiple filterable placeholder="选择1–64个场次" style="width:100%" :disabled="!editable || submitting || optionsLoading"><el-option v-for="item in availableTimes" :key="item.id" :value="item.id" :label="`${item.start_time || '损坏'} — ${item.end_time || '损坏'}（${item.title || item.id}${item.status !== 1 ? '，隐藏' : ''}${!item.valid ? '，需修复' : ''}）`" :disabled="!item.valid && !form.time_ids.includes(item.id)" /><el-option v-for="id in missingTimes" :key="`missing-${id}`" :value="id" :label="`缺失的历史场次 #${id}`" /></el-select></el-form-item>
                <p v-if="missingTimes.length" class="hint inset">已保留缺失场次 {{ missingTimes.join('、') }}，请选择有效场次进行修复。</p>
                <el-form-item label="累计限购" required><el-input-number v-model="form.num" :min="1" :max="2147483647" :precision="0" /><span class="hint">每位用户在整个活动内，每个商品累计最多购买数量</span></el-form-item>
                <el-form-item label="单次限购" required><el-input-number v-model="form.once_num" :min="1" :max="2147483647" :precision="0" /><span class="hint">每订单上限，不能大于累计限购</span></el-form-item>
                <el-form-item label="活动氛围图"><div class="image-field"><el-input v-model="form.image" maxlength="128" placeholder="可选；图库稳定图片地址" @input="formPreview = ''" /><SeckillActivityImagePicker v-if="editable" :disabled="!editable || submitting || formLoading" :editor-key="`${sessionKey}:${generation}:${formGeneration}`" @choose="chooseImage" /><el-image v-if="formImage" :src="formImage" :preview-src-list="[formImage]" preview-teleported fit="contain" /></div></el-form-item>
                <el-form-item label="是否开启"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" /></el-form-item>
                <p class="hint inset">保存基础设置时保留各商品自身开关；父活动关闭会阻止购买。列表中的“开启/关闭”操作会同时改写全部关联商品开关。</p>
              </el-form>
            </el-tab-pane>
            <el-tab-pane :label="`商品与规格（${form.products.length}）`" name="products">
              <div class="product-toolbar"><el-button v-if="editable" type="primary" :disabled="submitting || form.products.length >= 100" @click="openProducts">添加商品</el-button><el-input v-model="productFilter" aria-label="已选商品搜索" placeholder="搜索已选商品名称或ID" clearable /><span class="hint">最多100商品，每商品500规格，总5000规格（当前 {{ skuCount }}）</span></div>
              <div v-if="editable" class="product-toolbar"><el-checkbox :model-value="allBulkSelected" :indeterminate="someBulkSelected && !allBulkSelected" :disabled="submitting || addingProduct || bulkRemoving || !bulkEligibleProducts.length" @change="toggleAllBulkProducts">选择当前筛选商品</el-checkbox><span class="hint">已选择 {{ bulkProductKeys.length }} 个商品（筛选后仍保留选择）</span><el-button :disabled="!bulkProductKeys.length || submitting || addingProduct || bulkRemoving" @click="openBulkSettings">批量设置价格/总额度</el-button><el-button type="danger" plain :disabled="!bulkProductKeys.length || submitting || addingProduct || bulkRemoving" @click="removeBulkProducts">批量移除商品</el-button><el-button link :disabled="submitting || addingProduct || bulkRemoving" @click="clearBulkSelection">清空选择</el-button></div>
              <p class="hint">录入的是规格总额度，剩余额度由总额度减去已消耗量计算。停用/移除历史商品会保留其子商品和规格身份供订单、退款使用。</p>
              <el-empty v-if="!form.products.length" description="尚未选择商品，请添加商品和参与规格" />
              <el-collapse v-model="expandedProducts">
                <el-collapse-item v-for="(product, index) in form.products" v-show="matchesProduct(product)" :key="productKey(product, index)" :name="productKey(product, index)">
                  <template #title><div class="product-title"><span v-if="editable" @click.stop><el-checkbox :model-value="bulkProductKeys.includes(productKey(product))" :disabled="submitting || addingProduct || bulkRemoving || !!product.deleted" :aria-label="`选择商品${product.product_id}进行批量操作`" @change="toggleBulkProduct(product, $event)" /></span><el-image v-if="productImage(product)" :src="productImage(product)" :preview-src-list="[productImage(product)]" preview-teleported fit="cover" /><strong>{{ product.store_name || '缺失的基础商品' }}</strong><span>#{{ product.product_id }}</span><el-tag :type="product.status === 1 ? 'success' : 'info'" size="small">{{ product.status === 1 ? '商品开启' : '商品关闭' }}</el-tag><el-tag v-if="product.deleted" type="info" size="small">历史已删除</el-tag><el-tag v-else-if="!product.valid" type="danger" size="small">需修复</el-tag></div></template>
                  <template v-if="expandedProducts.includes(productKey(product, index))">
                    <el-alert v-if="product.issues.length" :title="product.issues.join('；')" type="warning" :closable="false" show-icon />
                    <div class="product-actions"><span class="hint">基础商品 #{{ product.product_id }} · {{ product.child_id ? `原子商品 #${product.child_id}` : product.deleted ? '仅保留来源历史项，不参与复制' : '保存时创建子商品' }}</span><el-switch v-model="product.status" :active-value="1" :inactive-value="0" active-text="商品开启" :disabled="!editable || submitting || !!product.deleted" /><el-button v-if="editable" type="danger" plain size="small" :disabled="submitting || (!!product.deleted && !!product.child_id)" @click="removeProduct(product)">{{ product.child_id ? '停用并移除参与规格' : '移除商品' }}</el-button></div>
                    <div v-if="editable && !product.deleted" class="batch"><el-input v-model="batchPrice" aria-label="批量秒杀价" placeholder="批量秒杀价（可留空）" inputmode="decimal" /><el-input v-model="batchQuota" aria-label="批量总额度" placeholder="批量总额度（可留空）" inputmode="numeric" /><el-button :disabled="submitting" @click="applyBatch(product)">应用到该商品参与规格</el-button><el-button :disabled="submitting" @click="selectSkus(product)">选择可用规格</el-button><el-button :disabled="submitting" @click="clearSkus(product)">关闭全部规格</el-button></div>
                    <div class="table-scroll"><el-table :data="product.skus" border :row-key="skuKey">
                      <el-table-column label="参与" width="75"><template #default="{ row }"><el-checkbox v-model="row.enabled" :disabled="!editable || submitting || !!product.deleted || !!row.retired || (!row.valid && !row.id && !row.enabled)" /></template></el-table-column>
                      <el-table-column label="规格" min-width="210"><template #default="{ row }"><div class="sku-info"><el-image v-if="skuImage(row)" :src="skuImage(row)" :preview-src-list="[skuImage(row)]" preview-teleported fit="cover" /><span v-else class="hint">无规格图</span><span>{{ row.suk || '默认规格' }}</span></div><p class="hint">{{ row.id ? `活动规格 #${row.id}` : `基础规格 ${row.base_unique || '缺失'}` }}</p><el-tag v-if="row.retired" type="info" size="small">已退役</el-tag><p v-if="row.issues.length" class="bad">{{ row.issues.join('；') }}</p></template></el-table-column>
                      <el-table-column label="秒杀价（元）" width="145"><template #default="{ row }"><el-input v-model="row.price" inputmode="decimal" maxlength="16" :disabled="!editable || submitting || !row.enabled || !!row.retired || !!product.deleted" /></template></el-table-column>
                      <el-table-column label="成本价（元）" width="110"><template #default="{ row }">{{ row.cost ?? '—' }}</template></el-table-column><el-table-column label="划线价（元）" width="110"><template #default="{ row }">{{ row.ot_price ?? '—' }}</template></el-table-column>
                      <el-table-column label="配置总额度" width="145"><template #default="{ row }"><el-input v-model.number="row.quota_total" type="number" min="0" max="2147483647" :disabled="!editable || submitting || !row.enabled || !!row.retired || !!product.deleted" /></template></el-table-column>
                      <el-table-column prop="consumed" label="已消耗" width="90" /><el-table-column prop="remaining" label="当前剩余" width="100" /><el-table-column label="保存后剩余" width="105"><template #default="{ row }">{{ nextRemaining(row) }}</template></el-table-column><el-table-column prop="base_stock" label="基础库存" width="100" /><el-table-column prop="stock" label="活动库存" width="100" />
                    </el-table></div>
                  </template>
                </el-collapse-item>
              </el-collapse>
            </el-tab-pane>
          </el-tabs>
        </template>
      </div>
      <template #footer><el-button :disabled="submitting" @click="closeForm">{{ editable ? '取消' : '关闭' }}</el-button><el-button v-if="editable && formTab === 'base'" :disabled="formLoading || submitting" @click="formTab = 'products'">下一步：商品与规格</el-button><el-button v-if="editable" type="primary" :loading="submitting" :disabled="!form || formLoading || optionsLoading || !!optionsError" @click="save">{{ mode === 'copy' ? '创建复制活动' : '保存活动' }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="productsVisible" title="选择参与商品" width="min(900px, calc(100vw - 24px))" append-to-body @closed="onProductsClosed">
      <div class="product-toolbar"><el-cascader v-model="productCategory" :options="categoryOptions" :props="{ checkStrictly: true, emitPath: false }" filterable clearable placeholder="商品分类（含子分类）" aria-label="商品分类" :disabled="addingProduct" @change="searchProducts" /><el-select v-model="productLabel" filterable clearable placeholder="商品标签" aria-label="商品标签" :disabled="addingProduct" @change="searchProducts"><el-option v-for="label in productLabels" :key="label.id" :label="label.label_name" :value="label.id" /></el-select><el-input v-model="productKeyword" aria-label="基础商品名称或ID" maxlength="100" placeholder="商品名称或ID" clearable :disabled="addingProduct" @keyup.enter="searchProducts" /><el-button :disabled="addingProduct" @click="searchProducts">查询</el-button><el-button :disabled="addingProduct" @click="resetProducts">重置筛选</el-button></div>
      <el-alert v-if="productError" :title="productError" type="error" :closable="false" show-icon />
      <div class="table-scroll"><el-table :data="productOptions" v-loading="productsLoading" border row-key="product_id"><el-table-column label="选择" width="80"><template #header><el-checkbox :model-value="allPageProductsSelected" :indeterminate="somePageProductsSelected && !allPageProductsSelected" :disabled="productsLoading || addingProduct || !pageEligibleProducts.length" aria-label="选择本页商品" @change="togglePageProducts" /></template><template #default="{ row }"><el-checkbox :model-value="productChoices.some(item => item.product_id === row.product_id)" :disabled="!row.valid || productsLoading || addingProduct || selectedProduct(row.product_id)" :aria-label="`选择基础商品${row.product_id}`" @change="toggleProductChoice(row, $event)" /><span v-if="selectedProduct(row.product_id)" class="hint">已添加</span></template></el-table-column><el-table-column prop="product_id" label="基础商品ID" width="110" /><el-table-column label="商品" min-width="190"><template #default="{ row }"><div class="product-title"><el-image v-if="productImage(row)" :src="productImage(row)" fit="cover" /><span>{{ row.store_name }}</span></div><p v-if="row.issues.length" class="bad">{{ row.issues.join('；') }}</p></template></el-table-column><el-table-column label="商品类型" width="115"><template #default="{ row }">{{ productTypeLabel(row.product_type) }}</template></el-table-column><el-table-column prop="category_name" label="商品分类" min-width="150" /><el-table-column prop="stock" label="库存" width="95" /></el-table></div>
      <el-pagination :current-page="productPage" :page-size="15" :total="productCount" :disabled="productsLoading || addingProduct" layout="total, prev, pager, next" @current-change="loadProducts" class="pager" />
      <div class="picked-products"><span class="hint">跨页已选 {{ productChoices.length }} 个商品；添加时重新读取来源规格。</span><el-tag v-for="item in productChoices" :key="item.product_id" :closable="!addingProduct" @close="removeProductChoice(item.product_id)">{{ item.store_name }} #{{ item.product_id }}</el-tag></div>
      <template #footer><el-button :disabled="addingProduct" @click="clearProductChoices">清空选择</el-button><el-button @click="closeProducts">取消</el-button><el-button type="primary" :disabled="!productChoices.length || productsLoading" :loading="addingProduct" @click="addSelectedProducts">{{ addingProduct ? `读取规格 ${productReadProgress}/${productChoices.length}` : `添加选中商品（${productChoices.length}）` }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="bulkVisible" title="批量设置所选商品" width="min(500px, calc(100vw - 24px))" append-to-body :close-on-click-modal="false" @closed="onBulkClosed"><p class="hint">应用到选中的 {{ bulkTargets.length }} 个商品的参与规格；不重新开启商品、已删除项或退役规格。留空的字段保留原值，保存活动后生效。</p><el-alert v-if="bulkError" :title="bulkError" type="error" :closable="false" show-icon /><el-form label-width="110px"><el-form-item label="秒杀价"><el-input v-model="bulkPrice" aria-label="跨商品批量秒杀价" placeholder="可留空，最多两位小数" inputmode="decimal" /></el-form-item><el-form-item label="配置总额度"><el-input v-model="bulkQuota" aria-label="跨商品批量总额度" placeholder="可留空，不得小于任一已消耗量" inputmode="numeric" /></el-form-item></el-form><template #footer><el-button @click="closeBulkSettings">取消</el-button><el-button type="primary" @click="applyBulkSettings">应用到参与规格</el-button></template></el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getToken, getAdminSession } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { apiSeckillActivityList, apiSeckillActivityDetail, apiSeckillActivityOptions, apiSeckillActivityProducts, apiSeckillActivityProduct, apiSeckillActivitySave, apiSeckillActivityStatus, apiSeckillActivityDelete, normalizeSeckillActivityInput, activityImagePreview, activityCategoryTree, activityPrice,
  type SeckillActivityRow, type SeckillActivityDetail, type SeckillActivityProduct, type SeckillActivityProductOption, type SeckillActivitySku, type SeckillActivityTime, type SeckillActivityPhase, type SeckillActivityInput, type SeckillActivitySave, type SeckillActivityMutationKey, type SeckillActivityCategoryNode, type SeckillActivityLabel } from '@/api/seckillActivity';
import SeckillActivityImagePicker from './SeckillActivityImagePicker.vue';
type Mode = 'create' | 'edit' | 'copy' | 'view';
type Editor = Pick<SeckillActivityDetail, 'name' | 'start_day' | 'end_day' | 'time_ids' | 'num' | 'once_num' | 'image' | 'status' | 'products'> & { revision: string };
type Stamp = { identity: string; generation: number; stored: string | null };
type Mutation = { kind: 'save'; id: number; body: SeckillActivitySave } | { kind: 'status'; id: number; body: SeckillActivityMutationKey & { status: 0 | 1 } } | { kind: 'delete'; id: number; body: SeckillActivityMutationKey };
const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('seckill_activity.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('seckill_activity.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
const PAGE_SIZE = 15, MAX_PAGE = Math.floor(10_000 / 15) + 1;
const draftKeyword = ref(''), keyword = ref(''), draftPhase = ref<'' | SeckillActivityPhase>(''), phase = ref<'' | SeckillActivityPhase>(''), draftStatus = ref<'' | 0 | 1>(''), status = ref<'' | 0 | 1>('');
const list = ref<SeckillActivityRow[]>([]), count = ref(0), page = ref(1), loading = ref(false), ready = ref(false), listError = ref(''), actionNotice = ref(''), uncertainOperation = ref<Mutation | null>(null), submitting = ref(false), confirming = ref(false);
const compact = ref(window.innerWidth <= 768), resize = () => { compact.value = window.innerWidth <= 768; };
const mode = ref<Mode>('view'), formId = ref(0), sourceId = ref(0), formVisible = ref(false), formLoading = ref(false), formError = ref(''), form = ref<Editor | null>(null), formTab = ref('base'), formIssues = ref<string[]>([]), raw = ref<Record<string, unknown> | null>(null), formPreview = ref('');
const editable = computed(() => canManage.value && mode.value !== 'view');
const formImage = computed(() => activityImagePreview(form.value?.image || '', formPreview.value));
const availableTimes = ref<SeckillActivityTime[]>([]), optionsLoading = ref(false), optionsError = ref('');
const missingTimes = computed(() => form.value?.time_ids.filter(id => !availableTimes.value.some(item => item.id === id)) ?? []);
const skuCount = computed(() => form.value?.products.reduce((total, product) => total + product.skus.length, 0) ?? 0);
const expandedProducts = ref<string[]>([]), productFilter = ref(''), batchPrice = ref(''), batchQuota = ref('');
const bulkProductKeys = ref<string[]>([]), bulkVisible = ref(false), bulkTargets = ref<string[]>([]), bulkPrice = ref(''), bulkQuota = ref(''), bulkError = ref(''), bulkRemoving = ref(false);
const bulkEligibleProducts = computed(() => form.value?.products.filter(product => !product.deleted && matchesProduct(product)) ?? []);
const allBulkSelected = computed(() => bulkEligibleProducts.value.length > 0 && bulkEligibleProducts.value.every(product => bulkProductKeys.value.includes(productKey(product))));
const someBulkSelected = computed(() => bulkEligibleProducts.value.some(product => bulkProductKeys.value.includes(productKey(product))));
const productsVisible = ref(false), productsLoading = ref(false), addingProduct = ref(false), productError = ref(''), productKeyword = ref(''), productOptions = ref<SeckillActivityProductOption[]>([]), productPage = ref(1), productCount = ref(0);
const categoryOptions = ref<SeckillActivityCategoryNode[]>([]), productLabels = ref<SeckillActivityLabel[]>([]), productCategory = ref<number | '' | null>(null), productLabel = ref<number | ''>('');
const productChoices = ref<SeckillActivityProductOption[]>([]), productReadProgress = ref(0);
const pageEligibleProducts = computed(() => productOptions.value.filter(product => product.valid && !selectedProduct(product.product_id)));
const allPageProductsSelected = computed(() => pageEligibleProducts.value.length > 0 && pageEligibleProducts.value.every(product => productChoices.value.some(item => item.product_id === product.product_id)));
const somePageProductsSelected = computed(() => pageEligibleProducts.value.some(product => productChoices.value.some(item => item.product_id === product.product_id)));
let mounted = false, syncing = false, generation = 0, formGeneration = 0, mutationId = 0, confirmationId = 0, productGeneration = 0, productRequest = 0;
let bulkScope: { stamp: Stamp; editor: number } | null = null, bulkRemovalId = 0;
let storedSession = localStorage.getItem('admin_session'), formScope: Stamp | null = null;
let listAbort: AbortController | null = null, formAbort: AbortController | null = null, optionsAbort: AbortController | null = null, mutationAbort: AbortController | null = null, productAbort: AbortController | null = null, productDetailAbort: AbortController | null = null;
function stamp(): Stamp { return { identity: sessionKey.value, generation, stored: storedSession }; }
function current(value: Stamp) { return mounted && canView.value && value.identity === sessionKey.value && value.generation === generation && auth.token === getToken() && value.stored === localStorage.getItem('admin_session'); }
function editorCurrent(value: Stamp, version: number) { return current(value) && version === formGeneration && formVisible.value; }
function canAct() { return current(stamp()) && ready.value && !loading.value && !submitting.value && !confirming.value; }
function currentRow(row: SeckillActivityRow) { return list.value.some(item => item.id === row.id && item.revision === row.revision); }
function phaseLabel(value: SeckillActivityPhase) { return { future: '未开始', active: '活动日期内', ended: '已结束', invalid: '日期损坏' }[value]; }
function createdAt(value: number | string) { if (typeof value !== 'number') return value; if (value <= 0 || !Number.isFinite(value)) return '—'; return new Date(value * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
function productKey(product: SeckillActivityProduct, _index?: number) { return product.child_id ? `child:${product.child_id}` : `base:${product.product_id}`; }
function skuKey(sku: SeckillActivitySku) { return sku.id ? `sku-${sku.id}` : `base-${sku.base_unique}-${sku.suk}`; }
function productImage(product: { image: string; image_preview: string }) { return activityImagePreview(product.image, product.image_preview); }
function skuImage(sku: SeckillActivitySku) { return activityImagePreview('', sku.image_preview); }
function productTypeLabel(value: number) { return ({ 0: '普通商品', 1: '卡密商品', 2: '优惠券商品', 3: '虚拟商品', 4: '次卡商品' } as Record<number, string>)[value] ?? `未知类型 #${value}`; }
function matchesProduct(product: SeckillActivityProduct) { return !productFilter.value || product.store_name.includes(productFilter.value) || String(product.product_id).includes(productFilter.value); }
function nextRemaining(sku: SeckillActivitySku) { return Number.isSafeInteger(sku.quota_total) && Number.isSafeInteger(sku.consumed) ? sku.quota_total - sku.consumed : '请填写整数'; }
function closeProducts() { productGeneration++; productRequest++; productAbort?.abort(); productDetailAbort?.abort(); productAbort = productDetailAbort = null; productsVisible.value = productsLoading.value = addingProduct.value = false; productOptions.value = []; productChoices.value = []; productReadProgress.value = 0; productError.value = ''; productCount.value = 0; }
function onProductsClosed() { if (!productsVisible.value) closeProducts(); }
function closeForm() { closeProducts(); closeBulkSettings(); bulkRemovalId++; if (bulkRemoving.value) ElMessageBox.close(); bulkRemoving.value = false; bulkProductKeys.value = []; formGeneration++; formAbort?.abort(); optionsAbort?.abort(); formAbort = optionsAbort = null; formVisible.value = formLoading.value = optionsLoading.value = false; form.value = null; formScope = null; formError.value = optionsError.value = ''; availableTimes.value = []; categoryOptions.value = []; productLabels.value = []; formPreview.value = ''; formIssues.value = []; raw.value = null; expandedProducts.value = []; }
function onFormClosed() { if (!formVisible.value) closeForm(); }
function clearList() { generation++; listAbort?.abort(); listAbort = null; ready.value = loading.value = false; list.value = []; count.value = 0; listError.value = ''; closeForm(); }
function invalidate() { clearList(); mutationId++; mutationAbort?.abort(); mutationAbort = null; confirmationId++; if (confirming.value) ElMessageBox.close(); submitting.value = confirming.value = false; actionNotice.value = ''; uncertainOperation.value = null; }
async function load(target = page.value) {
  if (!mounted || !canView.value || storedSession !== localStorage.getItem('admin_session') || !Number.isSafeInteger(target) || target < 1 || target > MAX_PAGE) return;
  clearList(); page.value = target; const value = stamp(), controller = new AbortController(); listAbort = controller; loading.value = true;
  try { const result = await apiSeckillActivityList({ page: target, limit: PAGE_SIZE, keyword: keyword.value, phase: phase.value, status: status.value }, controller.signal); if (!current(value)) return; if (!result.list.length && target > 1) { await load(Math.max(1, Math.min(target - 1, Math.ceil(result.count / PAGE_SIZE)))); return; } list.value = result.list; count.value = result.count; ready.value = true; }
  catch (reason) { if (current(value)) listError.value = reason instanceof Error ? reason.message : '活动列表读取失败'; }
  finally { if (listAbort === controller) { loading.value = false; listAbort = null; } }
}
function search() { if (submitting.value) return; keyword.value = draftKeyword.value.trim(); phase.value = draftPhase.value || ''; status.value = draftStatus.value ?? ''; actionNotice.value = ''; void load(1); }
function reset() { if (!submitting.value) { draftKeyword.value = ''; draftPhase.value = ''; draftStatus.value = ''; search(); } }
function newForm(): Editor { return { name: '', start_day: '', end_day: '', time_ids: [], num: 1, once_num: 1, image: '', status: 1, products: [], revision: '' }; }
async function openForm(id: number, nextMode: Mode) {
  if (!canAct() || (nextMode !== 'view' && !canManage.value) || (id !== 0 && !list.value.some(item => item.id === id))) return;
  closeForm(); sourceId.value = id; formId.value = nextMode === 'copy' ? 0 : id; mode.value = nextMode; formVisible.value = true; formLoading.value = true; formTab.value = 'base'; productFilter.value = ''; batchPrice.value = batchQuota.value = '';
  const value = stamp(), version = formGeneration, controller = new AbortController(); formScope = value; formAbort = controller;
  try {
    const result = id === 0 ? null : await apiSeckillActivityDetail(id, controller.signal);
    if (!editorCurrent(value, version) || (nextMode !== 'view' && !canManage.value)) return;
    if (!result) form.value = newForm();
    else {
      const products = structuredClone(result.products);
      if (nextMode === 'copy') for (const product of products) { product.child_id = null; if (product.deleted || !product.valid) product.status = 0; for (const sku of product.skus) { sku.id = null; sku.enabled = sku.enabled && sku.valid && !sku.retired && !product.deleted; sku.quota_total = Math.max(0, sku.remaining); sku.quota = sku.quota_show = sku.remaining = sku.quota_total; sku.consumed = 0; } }
      form.value = { name: result.name, start_day: result.start_day, end_day: result.end_day, time_ids: [...result.time_ids], num: result.num, once_num: result.once_num, image: result.image, status: result.status, products, revision: nextMode === 'copy' ? '' : result.revision };
      raw.value = result.raw ?? null; formIssues.value = [...result.issues]; formPreview.value = result.image_preview;
    }
    await loadOptions();
  } catch (reason) { if (editorCurrent(value, version)) formError.value = reason instanceof Error ? reason.message : '活动详情读取失败'; }
  finally { if (formAbort === controller) { formAbort = null; formLoading.value = false; } }
}
async function loadOptions() {
  if (!formScope || !current(formScope) || !formVisible.value) return;
  optionsAbort?.abort(); const value = stamp(), version = formGeneration, controller = new AbortController(); optionsAbort = controller; optionsLoading.value = true; optionsError.value = '';
  try { const result = await apiSeckillActivityOptions(controller.signal); if (editorCurrent(value, version)) { availableTimes.value = result.times; categoryOptions.value = activityCategoryTree(result.categories); productLabels.value = result.labels; } }
  catch (reason) { if (editorCurrent(value, version)) optionsError.value = reason instanceof Error ? reason.message : '场次读取失败'; }
  finally { if (optionsAbort === controller) { optionsAbort = null; optionsLoading.value = false; } }
}
function chooseImage(reference: string, preview: string) { if (form.value && formScope && current(formScope) && editable.value && !submitting.value) { form.value.image = reference; formPreview.value = preview; } }
function selectedProduct(id: number) { return !!form.value?.products.some(product => product.product_id === id); }
function pickerCurrent(value: Stamp, editor: number, picker: number) { return editorCurrent(value, editor) && editable.value && productsVisible.value && picker === productGeneration; }
async function openProducts() { if (!formScope || !current(formScope) || !editable.value || !form.value || submitting.value || optionsLoading.value || optionsError.value || form.value.products.length >= 100) return; closeProducts(); productsVisible.value = true; productKeyword.value = ''; productCategory.value = null; productLabel.value = ''; await loadProducts(1); }
async function loadProducts(target = productPage.value) {
  if (!formScope || !current(formScope) || !editable.value || !productsVisible.value || addingProduct.value || !Number.isSafeInteger(target) || target < 1 || target > MAX_PAGE) return;
  productAbort?.abort(); const value = stamp(), editor = formGeneration, picker = productGeneration, serial = ++productRequest, controller = new AbortController(); productAbort = controller; productPage.value = target; productsLoading.value = true; productError.value = ''; productOptions.value = [];
  try { const result = await apiSeckillActivityProducts({ page: target, limit: 15, keyword: productKeyword.value.trim(), category_id: productCategory.value || '', label_id: productLabel.value || '' }, controller.signal); if (pickerCurrent(value, editor, picker) && serial === productRequest) { productOptions.value = result.list; productCount.value = result.count; } }
  catch (reason) { if (pickerCurrent(value, editor, picker) && serial === productRequest) productError.value = reason instanceof Error ? reason.message : '商品搜索失败'; }
  finally { if (productAbort === controller) { productAbort = null; productsLoading.value = false; } }
}
function searchProducts() { if (!addingProduct.value) void loadProducts(1); }
function resetProducts() { if (!addingProduct.value) { productKeyword.value = ''; productCategory.value = null; productLabel.value = ''; searchProducts(); } }
function choiceCurrent() { return !!formScope && current(formScope) && editable.value && productsVisible.value && !!form.value && !submitting.value && !addingProduct.value; }
function toggleProductChoice(option: SeckillActivityProductOption, checked: unknown) {
  if (!choiceCurrent() || productsLoading.value || !option.valid || selectedProduct(option.product_id) || !productOptions.value.some(item => item.product_id === option.product_id && item.valid)) return;
  if (checked !== true) { removeProductChoice(option.product_id); return; }
  if (productChoices.value.some(item => item.product_id === option.product_id)) return;
  if (form.value!.products.length + productChoices.value.length >= 100) { productError.value = '活动最多100个商品，请减少选择'; return; }
  productChoices.value.push({ ...option }); productError.value = '';
}
function togglePageProducts(checked: unknown) {
  if (!choiceCurrent() || productsLoading.value) return;
  const eligible = pageEligibleProducts.value;
  if (checked !== true) { const ids = new Set(eligible.map(item => item.product_id)); productChoices.value = productChoices.value.filter(item => !ids.has(item.product_id)); return; }
  const extra = eligible.filter(item => !productChoices.value.some(selected => selected.product_id === item.product_id));
  if (form.value!.products.length + productChoices.value.length + extra.length > 100) { productError.value = '活动最多100个商品，本页选择未添加，请减少选择'; return; }
  productChoices.value.push(...extra.map(item => ({ ...item }))); productError.value = '';
}
function removeProductChoice(id: number) { if (choiceCurrent()) productChoices.value = productChoices.value.filter(item => item.product_id !== id); }
function clearProductChoices() { if (choiceCurrent()) productChoices.value = []; }
async function addSelectedProducts() {
  if (!choiceCurrent() || productsLoading.value || !productChoices.value.length || !form.value) return;
  const ids = productChoices.value.map(item => item.product_id);
  if (new Set(ids).size !== ids.length || ids.some(selectedProduct) || form.value.products.length + ids.length > 100) { productError.value = '所选商品重复或超过100个，请重新选择'; return; }
  const value = stamp(), editor = formGeneration, picker = productGeneration, controller = new AbortController(); productDetailAbort = controller; addingProduct.value = true; productError.value = '';
  productReadProgress.value = 0;
  try {
    const additions: SeckillActivityProduct[] = []; let total = skuCount.value;
    for (const id of ids) {
      const result = await apiSeckillActivityProduct(id, controller.signal); if (!pickerCurrent(value, editor, picker) || !form.value) return;
      if (!result.valid || !result.skus.some(sku => sku.valid && !sku.retired)) throw Error(`商品${id}没有可参与的有效规格，请取消该项或整理来源`);
      total += result.skus.length; if (total > 5000) throw Error('活动规格总数不能超过5000，本次选择未添加');
      additions.push({ child_id: null, product_id: result.product_id, store_name: result.store_name, image: result.image, image_preview: result.image_preview, product_type: result.product_type, category_name: result.category_name, status: 1, valid: result.valid, issues: result.issues,
        skus: result.skus.map(sku => ({ ...sku, id: null, unique: '', enabled: sku.valid && !sku.retired, consumed: 0, quota_total: Math.max(0, sku.base_stock), quota: Math.max(0, sku.base_stock), quota_show: Math.max(0, sku.base_stock), remaining: Math.max(0, sku.base_stock) })) });
      productReadProgress.value++;
    }
    if (!pickerCurrent(value, editor, picker) || !form.value) return;
    if (form.value.products.length + additions.length > 100 || additions.some(product => selectedProduct(product.product_id)) || skuCount.value + additions.reduce((total, product) => total + product.skus.length, 0) > 5000) throw Error('活动商品或规格配置已变化，本次选择未添加');
    form.value.products.push(...additions); formTab.value = 'products'; expandedProducts.value = additions.length === 1 ? [productKey(additions[0]!)] : [];
    closeProducts();
  } catch (reason) { if (pickerCurrent(value, editor, picker)) productError.value = reason instanceof Error ? reason.message : '商品规格读取失败'; }
  finally { if (productDetailAbort === controller) { productDetailAbort = null; addingProduct.value = false; } }
}
function draftCurrent() { return !!formScope && current(formScope) && formVisible.value && editable.value && !!form.value && !formLoading.value && !submitting.value && !addingProduct.value && !bulkRemoving.value; }
function removeProduct(product: SeckillActivityProduct) { if (!draftCurrent() || !form.value || !form.value.products.includes(product) || (product.deleted && product.child_id)) return; if (product.child_id) { product.status = 0; product.skus.forEach(sku => { sku.enabled = false; }); } else { form.value.products = form.value.products.filter(item => item !== product); expandedProducts.value = []; } bulkProductKeys.value = bulkProductKeys.value.filter(key => key !== productKey(product)); }
function selectSkus(product: SeckillActivityProduct) { if (draftCurrent() && form.value!.products.includes(product) && !product.deleted) product.skus.forEach(sku => { if (sku.valid && !sku.retired) sku.enabled = true; }); }
function clearSkus(product: SeckillActivityProduct) { if (draftCurrent() && form.value!.products.includes(product) && !product.deleted) product.skus.forEach(sku => { sku.enabled = false; }); }
function setProductBatch(products: SeckillActivityProduct[], priceText: string, quotaText: string) {
  const price = priceText.trim(), quota = quotaText.trim();
  if (!price && !quota) throw Error('请至少填写批量价格或总额度');
  const nextPrice = price ? activityPrice(price) : null, nextQuota = quota ? Number(quota) : null;
  if (quota && (!/^(?:0|[1-9]\d{0,9})$/u.test(quota) || !Number.isSafeInteger(nextQuota) || nextQuota! > 2147483647)) throw Error('批量总额度须为0–2147483647整数');
  const skus = products.filter(product => !product.deleted).flatMap(product => product.skus.filter(sku => sku.enabled && !sku.retired));
  if (!skus.length) throw Error('所选商品没有可修改的参与规格');
  if (nextQuota !== null && skus.some(sku => !Number.isSafeInteger(sku.consumed) || sku.consumed < 0 || nextQuota < sku.consumed)) throw Error('批量总额度不得小于任何参与规格的已消耗量；本次修改未应用');
  for (const sku of skus) { if (nextPrice !== null) sku.price = nextPrice; if (nextQuota !== null) sku.quota_total = nextQuota; }
}
function applyBatch(product: SeckillActivityProduct) {
  if (!draftCurrent() || !form.value!.products.includes(product) || product.deleted) return;
  try { setProductBatch([product], batchPrice.value, batchQuota.value); formError.value = ''; } catch (reason) { formError.value = reason instanceof Error ? reason.message : '批量设置无效'; }
}
function toggleBulkProduct(product: SeckillActivityProduct, checked: unknown) { if (!draftCurrent() || !form.value!.products.includes(product) || product.deleted) return; const key = productKey(product); if (checked === true) { if (!bulkProductKeys.value.includes(key)) bulkProductKeys.value.push(key); } else bulkProductKeys.value = bulkProductKeys.value.filter(value => value !== key); }
function toggleAllBulkProducts(checked: unknown) { if (!draftCurrent()) return; const keys = bulkEligibleProducts.value.map(product => productKey(product)); bulkProductKeys.value = checked === true ? [...new Set([...bulkProductKeys.value, ...keys])] : bulkProductKeys.value.filter(key => !keys.includes(key)); }
function clearBulkSelection() { if (draftCurrent()) bulkProductKeys.value = []; }
function closeBulkSettings() { bulkVisible.value = false; bulkScope = null; bulkTargets.value = []; bulkPrice.value = bulkQuota.value = bulkError.value = ''; }
function onBulkClosed() { if (!bulkVisible.value) closeBulkSettings(); }
function openBulkSettings() { if (!draftCurrent() || !bulkProductKeys.value.length) return; const targets = form.value!.products.filter(product => !product.deleted && bulkProductKeys.value.includes(productKey(product))).map(product => productKey(product)); if (!targets.length) return; closeBulkSettings(); bulkTargets.value = targets; bulkScope = { stamp: stamp(), editor: formGeneration }; bulkVisible.value = true; }
function applyBulkSettings() {
  if (!bulkScope || !editorCurrent(bulkScope.stamp, bulkScope.editor) || !draftCurrent() || !bulkVisible.value) return;
  const products = form.value!.products.filter(product => bulkTargets.value.includes(productKey(product)));
  try { if (products.length !== bulkTargets.value.length || products.some(product => product.deleted)) throw Error('所选商品已变化，请重新选择'); setProductBatch(products, bulkPrice.value, bulkQuota.value); closeBulkSettings(); formError.value = ''; } catch (reason) { bulkError.value = reason instanceof Error ? reason.message : '批量设置无效'; }
}
async function removeBulkProducts() {
  if (!draftCurrent() || bulkVisible.value || !bulkProductKeys.value.length) return;
  const value = stamp(), editor = formGeneration, serial = ++bulkRemovalId, keys = [...bulkProductKeys.value]; bulkRemoving.value = true;
  try { await ElMessageBox.confirm(`确认从本次配置移除所选${keys.length}个商品？已保存商品会关闭全部参与规格并保留历史身份，新商品从草稿移除。保存活动后生效。`, '批量移除商品', { type: 'warning', confirmButtonText: '确认移除', cancelButtonText: '取消' }); }
  catch { return; } finally { if (serial === bulkRemovalId) bulkRemoving.value = false; }
  if (!editorCurrent(value, editor) || !draftCurrent() || serial !== bulkRemovalId) return;
  const products = form.value!.products.filter(product => keys.includes(productKey(product)) && !product.deleted);
  products.forEach(removeProduct); bulkProductKeys.value = []; formError.value = '';
}
async function mutate(operation: Mutation, value: Stamp, editor?: number) {
  const active = () => current(value) && canManage.value && (editor === undefined || editor === formGeneration);
  if (!active() || submitting.value) return; const serial = ++mutationId, controller = new AbortController(); mutationAbort = controller; submitting.value = true; actionNotice.value = '';
  try { if (operation.kind === 'save') await apiSeckillActivitySave(operation.id, operation.body, controller.signal); else if (operation.kind === 'status') await apiSeckillActivityStatus(operation.id, operation.body, controller.signal); else await apiSeckillActivityDelete(operation.id, operation.body, controller.signal); if (!active() || serial !== mutationId) return; uncertainOperation.value = null; ElMessage.success(operation.kind === 'save' ? '活动已保存' : operation.kind === 'delete' ? '父活动及关联商品已删除' : '父活动及关联商品开关已更新'); }
  catch (reason) { if (!active() || serial !== mutationId) return; const rejected = reason instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(reason.status)); uncertainOperation.value = rejected ? null : operation; actionNotice.value = `${rejected ? '操作未完成' : '操作结果未确认'}：${reason instanceof Error ? reason.message : '请求失败'}。请重新读取活动核对，勿重复提交。`; }
  finally { if (serial === mutationId) { submitting.value = false; mutationAbort = null; } }
  if (active()) await load();
}
async function save() {
  if (!form.value || !formScope || !current(formScope) || !editable.value || !formVisible.value || formLoading.value || optionsLoading.value || optionsError.value || submitting.value || addingProduct.value || bulkRemoving.value || bulkVisible.value) return;
  let input: SeckillActivityInput;
  try {
    for (const product of form.value.products) for (const sku of product.skus) if (sku.enabled && (sku.retired || sku.quota_total < sku.consumed)) throw Error(`商品${product.product_id}规格${sku.suk || '默认规格'}已退役，或总额度小于已消耗量`);
    input = normalizeSeckillActivityInput({ ...form.value, products: form.value.products.map(product => ({ child_id: product.child_id, product_id: product.product_id, status: product.deleted ? 0 : product.status, skus: product.skus.map(sku => ({ id: sku.id, base_unique: sku.base_unique, price: sku.price, quota_total: sku.quota_total, enabled: product.deleted ? false : sku.enabled })) })) });
  } catch (reason) { formError.value = reason instanceof Error ? reason.message : '请检查活动配置'; return; }
  formError.value = '';
  await mutate({ kind: 'save', id: formId.value, body: { ...input, request_id: crypto.randomUUID(), ...(formId.value ? { revision: form.value.revision } : {}) } }, formScope, formGeneration);
}
async function confirmAction(row: SeckillActivityRow, action: 'status' | 'delete') {
  if (!canAct() || !canManage.value || !currentRow(row)) return;
  if (action === 'status' && row.status === 0 && !row.valid) { actionNotice.value = '活动配置无效，请先编辑修复后再开启。'; return; }
  row = { ...row }; const value = stamp(), serial = ++confirmationId; confirming.value = true;
  try { await ElMessageBox.confirm(action === 'delete' ? `确认删除父活动「${row.name || row.id}」及其全部关联商品？已有订单、退款和规格身份会保留。` : `确认${row.status === 1 ? '关闭' : '开启'}父活动「${row.name || row.id}」及全部关联商品？${row.status === 0 ? '之前单独关闭的商品也会被重新开启。' : '所有关联商品会同时关闭。'}`, action === 'delete' ? '删除父活动与商品' : '级联修改活动开关', { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' }); }
  catch { return; } finally { if (serial === confirmationId) confirming.value = false; }
  if (!current(value) || !canManage.value || serial !== confirmationId || !currentRow(row)) return;
  const body = { revision: row.revision, request_id: crypto.randomUUID() }; await mutate(action === 'delete' ? { kind: 'delete', id: row.id, body } : { kind: 'status', id: row.id, body: { ...body, status: row.status === 1 ? 0 : 1 } }, value);
}
function toggleStatus(row: SeckillActivityRow) { return confirmAction(row, 'status'); }
function remove(row: SeckillActivityRow) { return confirmAction(row, 'delete'); }
function syncSession() { syncing = true; invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); storedSession = localStorage.getItem('admin_session'); syncing = false; page.value = 1; draftKeyword.value = keyword.value = ''; draftPhase.value = phase.value = ''; draftStatus.value = status.value = ''; void load(1); }
function storage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(sessionKey, () => { if (mounted && !syncing) { invalidate(); page.value = 1; void load(1); } }, { flush: 'sync' });
onMounted(() => { mounted = true; window.addEventListener('resize', resize); window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', storage); syncSession(); });
onBeforeUnmount(() => { mounted = false; invalidate(); window.removeEventListener('resize', resize); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', storage); });
</script>

<style scoped>
.seckill-activities { min-width: 0; }.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }.heading h2 { margin: 0 0 8px; font-size: 19px; }.hint { font-size: 12px; line-height: 1.6; color: #737985; margin: 5px 0; }.filters { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }.filters label { display: grid; gap: 6px; flex: 1 1 150px; font-size: 13px; }.filters label:first-child { flex-basis: 250px; }.filters :deep(.el-select) { width: 100%; }.actions { display: flex; gap: 7px; flex-wrap: wrap; }.actions :deep(.el-button + .el-button) { margin-left: 0; }.notice { margin-bottom: 14px; }.table-scroll { max-width: 100%; overflow-x: auto; }.pager { margin-top: 18px; flex-wrap: wrap; justify-content: flex-end; }.date-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }.date-fields input { min-width: 0; padding: 7px; border: 1px solid #dcdfe6; border-radius: 4px; font: inherit; width: 100%; box-sizing: border-box; }.inset { margin: 0 0 18px 130px; }.image-field { display: flex; gap: 10px; flex-wrap: wrap; width: 100%; }.image-field :deep(.el-input) { flex: 1 1 240px; }.image-field :deep(.el-image) { width: 130px; height: 85px; }.legacy { margin-bottom: 12px; font-size: 12px; color: #737985; }.legacy pre { white-space: pre-wrap; overflow-wrap: anywhere; }.product-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }.product-toolbar :deep(.el-input) { flex: 1 1 210px; max-width: 420px; }.product-title { display: flex; align-items: center; gap: 9px; min-width: 0; flex-wrap: wrap; }.product-title :deep(.el-image) { width: 44px; height: 36px; }.product-actions { display: flex; gap: 12px; justify-content: space-between; align-items: center; flex-wrap: wrap; padding: 12px 0; }.batch { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }.batch :deep(.el-input) { width: 180px; }.bad { font-size: 12px; color: #c45656; margin: 3px 0; }
.product-toolbar :deep(.el-cascader), .product-toolbar :deep(.el-select) { flex: 1 1 180px; min-width: 0; max-width: 260px; }.picked-products { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }.picked-products > .hint { width: 100%; }.sku-info { display: flex; align-items: center; gap: 8px; }.sku-info :deep(.el-image) { width: 42px; height: 42px; flex: 0 0 42px; }
@media (max-width: 650px) { .filters { display: grid; grid-template-columns: minmax(0, 1fr); }.date-fields { grid-template-columns: minmax(0, 1fr); }.inset { margin-left: 0; }.pager { justify-content: center; }.product-actions { align-items: flex-start; }.batch :deep(.el-input) { flex: 1 1 160px; }.product-title strong { max-width: 230px; overflow-wrap: anywhere; }.product-toolbar :deep(.el-cascader), .product-toolbar :deep(.el-select) { max-width: 100%; } }
</style>
