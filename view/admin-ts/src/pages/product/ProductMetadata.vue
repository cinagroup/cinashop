<template>
  <div class="metadata-page">
    <div class="page-head">
      <div>
        <h2>商品基础资料</h2>
        <p>统一维护计量单位、保障服务、两类商品模板与平台搜索热词，避免混用旧字段语义。</p>
      </div>
      <el-button @click="$router.push('/product')">返回商品</el-button>
    </div>

    <el-alert
      title="两类模板用途不同"
      type="info"
      :closable="false"
      show-icon
      description="规格模板用于颜色、尺码等 SKU 维度；参数模板用于材质、产地等商品说明。两者不会互相覆盖。"
    />

    <el-card shadow="never">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="商品单位" name="units">
          <div class="toolbar">
            <el-input v-model="unitQuery.name" clearable placeholder="搜索单位" @keyup.enter="searchUnits" />
            <el-button type="primary" @click="openUnit()">新增单位</el-button>
          </div>
          <div class="table-scroll">
            <el-table :data="units" v-loading="unitLoading" min-width="520">
              <el-table-column prop="name" label="单位名称" min-width="180" />
              <el-table-column prop="sort" label="排序" width="100" />
              <el-table-column label="状态" width="100"><template #default><el-tag type="success">启用</el-tag></template></el-table-column>
              <el-table-column label="操作" width="150" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openUnit(row)">编辑</el-button>
                  <el-button link type="danger" @click="deleteUnit(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-empty v-if="!unitLoading && !units.length" description="暂无商品单位" />
          <el-pagination v-model:current-page="unitQuery.page" :page-size="unitQuery.limit" :total="unitTotal" layout="total, prev, pager, next" @current-change="loadUnits" />
        </el-tab-pane>

        <el-tab-pane label="保障服务" name="ensures">
          <div class="toolbar">
            <el-input v-model="ensureQuery.name" clearable placeholder="搜索保障条款" @keyup.enter="searchEnsures" />
            <el-button type="primary" @click="openEnsure()">新增保障</el-button>
          </div>
          <div class="table-scroll">
            <el-table :data="ensures" v-loading="ensureLoading" min-width="760">
              <el-table-column label="图标" width="78"><template #default="{ row }"><el-image v-if="row.image" :src="row.image" class="ensure-image" fit="cover" /><span v-else>—</span></template></el-table-column>
              <el-table-column prop="name" label="保障条款" min-width="150" />
              <el-table-column prop="desc" label="说明" min-width="240" show-overflow-tooltip />
              <el-table-column prop="sort" label="排序" width="80" />
              <el-table-column label="启用" width="90"><template #default="{ row }"><el-switch :model-value="row.status" :active-value="1" :inactive-value="0" @change="setEnsureStatus(row, Number($event))" /></template></el-table-column>
              <el-table-column label="操作" width="150" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openEnsure(row)">编辑</el-button>
                  <el-button link type="danger" @click="deleteEnsure(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-empty v-if="!ensureLoading && !ensures.length" description="暂无保障服务" />
          <el-pagination v-model:current-page="ensureQuery.page" :page-size="ensureQuery.limit" :total="ensureTotal" layout="total, prev, pager, next" @current-change="loadEnsures" />
        </el-tab-pane>

        <el-tab-pane label="SKU 规格模板" name="rules">
          <div class="semantic-note">用于颜色、尺码、容量等 SKU 组合维度；每个模板支持 1 至 3 个维度。</div>
          <div class="toolbar">
            <el-input v-model="ruleQuery.rule_name" clearable maxlength="32" placeholder="搜索规格模板" @keyup.enter="searchRules" />
            <el-button type="primary" @click="openRule()">新增规格模板</el-button>
          </div>
          <div class="table-scroll">
            <el-table :data="rules" v-loading="ruleLoading" min-width="760">
              <el-table-column prop="rule_name" label="模板名称" min-width="180" />
              <el-table-column label="规格内容" min-width="420">
                <template #default="{ row }">
                  <div class="dimension-summary">
                    <div v-for="dimension in row.spec" :key="dimension.value">
                      <strong>{{ dimension.value }}</strong>
                      <span><el-tag v-for="detail in dimension.detail" :key="detail" size="small" effect="plain">{{ detail }}</el-tag></span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="150" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openRule(row.id)">编辑</el-button>
                  <el-button link type="danger" @click="deleteRule(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-empty v-if="!ruleLoading && !rules.length" description="暂无 SKU 规格模板" />
          <el-pagination v-model:current-page="ruleQuery.page" :page-size="ruleQuery.limit" :total="ruleTotal" layout="total, prev, pager, next" @current-change="loadRules" />
        </el-tab-pane>

        <el-tab-pane label="商品参数模板" name="parameters">
          <div class="semantic-note">用于材质、产地、适用季节等说明字段，不参与 SKU 价格与库存组合。</div>
          <div class="toolbar">
            <el-input v-model="parameterQuery.name" clearable placeholder="搜索参数模板" @keyup.enter="searchParameterTemplates" />
            <el-button type="primary" @click="openParameterTemplate()">新增参数模板</el-button>
          </div>
          <div class="table-scroll">
            <el-table :data="parameterTemplates" v-loading="parameterLoading" min-width="700">
              <el-table-column prop="name" label="模板名称" min-width="180" />
              <el-table-column label="参数预览" min-width="320">
                <template #default="{ row }">
                  <div class="parameter-summary">
                    <el-tag v-for="item in row.specs.slice(0, 4)" :key="`${item.name}-${item.value}`" size="small" effect="plain">{{ item.name }}：{{ item.value }}</el-tag>
                    <span v-if="row.specs.length > 4">另 {{ row.specs.length - 4 }} 项</span>
                    <span v-if="!row.specs.length">暂无参数</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="sort" label="排序" width="90" />
              <el-table-column label="操作" width="150" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openParameterTemplate(row.id)">编辑</el-button>
                  <el-button link type="danger" @click="deleteParameterTemplate(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-empty v-if="!parameterLoading && !parameterTemplates.length" description="暂无商品参数模板" />
          <el-pagination v-model:current-page="parameterQuery.page" :page-size="parameterQuery.limit" :total="parameterTotal" layout="total, prev, pager, next" @current-change="loadParameterTemplates" />
        </el-tab-pane>

        <el-tab-pane label="搜索热词" name="words">
          <div class="semantic-note">这里只管理平台热词；供应商热词不会被读取或改写。隐藏或删除后，商城搜索页会立即停止展示。</div>
          <div class="toolbar">
            <el-input v-model="wordQuery.name" clearable maxlength="15" placeholder="搜索热词" @keyup.enter="searchWords" />
            <el-button type="primary" @click="openWord()">新增热词</el-button>
          </div>
          <div class="table-scroll">
            <el-table :data="words" v-loading="wordLoading" min-width="820">
              <el-table-column label="展示效果" min-width="170">
                <template #default="{ row }">
                  <span class="word-preview" :style="wordPreviewStyle(row)">
                    <img v-if="row.icon" :src="row.icon" alt="" />{{ row.name }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column prop="name" label="热词名称" min-width="150" />
              <el-table-column label="大家都在搜" width="120"><template #default="{ row }"><el-tag :type="row.is_search ? 'success' : 'info'">{{ row.is_search ? "是" : "否" }}</el-tag></template></el-table-column>
              <el-table-column prop="sort" label="排序" width="80" />
              <el-table-column label="显示" width="90"><template #default="{ row }"><el-switch :model-value="row.is_show" :active-value="1" :inactive-value="0" @change="setWordStatus(row, Number($event))" /></template></el-table-column>
              <el-table-column label="操作" width="150" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openWord(row)">编辑</el-button>
                  <el-button link type="danger" @click="deleteWord(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-empty v-if="!wordLoading && !words.length" description="暂无搜索热词" />
          <el-pagination v-model:current-page="wordQuery.page" :page-size="wordQuery.limit" :total="wordTotal" layout="total, prev, pager, next" @current-change="loadWords" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="unitDialog" :title="unitForm.id ? '编辑单位' : '新增单位'" width="min(440px, 92vw)">
      <el-form label-width="82px">
        <el-form-item label="单位名称" required><el-input v-model="unitForm.name" maxlength="50" placeholder="如：件、盒、千克" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="unitForm.sort" :min="0" :max="32767" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="unitDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveUnit">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="ensureDialog" :title="ensureForm.id ? '编辑保障' : '新增保障'" width="min(560px, 92vw)">
      <el-form label-width="92px">
        <el-form-item label="保障条款" required><el-input v-model="ensureForm.name" maxlength="255" /></el-form-item>
        <el-form-item label="图标地址" required><el-input v-model="ensureForm.image" maxlength="255" placeholder="HTTPS 或素材中心稳定地址" /></el-form-item>
        <el-form-item label="保障说明" required><el-input v-model="ensureForm.desc" type="textarea" :rows="3" maxlength="255" show-word-limit /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="ensureForm.sort" :min="0" :max="2147483647" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="ensureForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="ensureDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveEnsure">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="ruleDialog" :title="ruleForm.id ? '编辑 SKU 规格模板' : '新增 SKU 规格模板'" width="min(760px, 94vw)" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="模板名称" required><el-input v-model="ruleForm.rule_name" maxlength="32" show-word-limit placeholder="例如：服装颜色尺码" /></el-form-item>
        <section class="dimension-editor">
          <div class="editor-head"><div><h3>规格维度</h3><p>输入规格值后按回车；每个维度最多 50 个值。</p></div><el-button :disabled="ruleForm.spec.length >= 3" @click="addDimension">添加维度</el-button></div>
          <div v-for="(dimension, index) in ruleForm.spec" :key="index" class="dimension-row">
            <el-input v-model="dimension.value" maxlength="32" placeholder="规格名称，如颜色" />
            <el-select v-model="dimension.detail" multiple filterable allow-create default-first-option placeholder="输入规格值后回车" />
            <el-button text type="danger" aria-label="删除规格维度" @click="removeDimension(index)">删除</el-button>
          </div>
        </section>
      </el-form>
      <template #footer><el-button @click="ruleDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveRule">保存模板</el-button></template>
    </el-dialog>

    <el-dialog v-model="parameterDialog" :title="parameterForm.id ? '编辑商品参数模板' : '新增商品参数模板'" width="min(820px, 95vw)" destroy-on-close>
      <el-form label-position="top">
        <div class="parameter-basics">
          <el-form-item label="模板名称" required><el-input v-model="parameterForm.name" maxlength="255" placeholder="例如：服装基础参数" /></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="parameterForm.sort" :min="0" :max="2147483647" /></el-form-item>
        </div>
        <section class="parameter-editor">
          <div class="editor-head"><div><h3>参数项目</h3><p>参数名称与参数值均必填，最多 100 项。</p></div><el-button :disabled="parameterForm.specs.length >= 100" @click="addParameter">添加参数</el-button></div>
          <div v-for="(item, index) in parameterForm.specs" :key="index" class="parameter-row">
            <el-input v-model="item.name" maxlength="255" placeholder="参数名称，如材质" />
            <el-input v-model="item.value" maxlength="255" placeholder="参数值，如棉" />
            <el-input-number v-model="item.sort" :min="0" :max="2147483647" controls-position="right" />
            <el-switch v-model="item.status" :active-value="1" :inactive-value="0" inline-prompt active-text="启" inactive-text="停" />
            <el-button text type="danger" aria-label="删除参数" @click="removeParameter(index)">删除</el-button>
          </div>
        </section>
      </el-form>
      <template #footer><el-button @click="parameterDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveParameterTemplate">保存模板</el-button></template>
    </el-dialog>

    <el-dialog v-model="wordDialog" :title="wordForm.id ? '编辑搜索热词' : '新增搜索热词'" width="min(600px, 94vw)">
      <el-form label-width="104px">
        <el-form-item label="热词名称" required><el-input v-model="wordForm.name" maxlength="15" show-word-limit placeholder="例如：新品上市" /></el-form-item>
        <div class="color-grid">
          <el-form-item label="文字颜色"><el-color-picker v-model="wordForm.color" show-alpha /></el-form-item>
          <el-form-item label="背景颜色"><el-color-picker v-model="wordForm.bg_color" show-alpha /></el-form-item>
          <el-form-item label="边框颜色"><el-color-picker v-model="wordForm.border_color" show-alpha /></el-form-item>
        </div>
        <el-form-item label="图标地址"><el-input v-model="wordForm.icon" maxlength="128" placeholder="可留空；HTTPS 或站内绝对路径" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="wordForm.sort" :min="0" :max="999" /></el-form-item>
        <el-form-item label="大家都在搜"><el-switch v-model="wordForm.is_search" :active-value="1" :inactive-value="0" /></el-form-item>
        <el-form-item label="商城显示"><el-switch v-model="wordForm.is_show" :active-value="1" :inactive-value="0" /></el-form-item>
      </el-form>
      <div class="dialog-preview"><span>预览</span><span class="word-preview" :style="wordPreviewStyle(wordForm)"><img v-if="wordForm.icon" :src="wordForm.icon" alt="" />{{ wordForm.name || "搜索热词" }}</span></div>
      <template #footer><el-button @click="wordDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveWord">保存热词</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiProductEnsureDelete, apiProductEnsureList, apiProductEnsureSave, apiProductEnsureStatus,
  apiProductParameterTemplateDelete, apiProductParameterTemplateDetail, apiProductParameterTemplateList, apiProductParameterTemplateSave,
  apiProductRuleDelete, apiProductRuleDetail, apiProductRuleList, apiProductRuleSave,
  apiProductUnitDelete, apiProductUnitList, apiProductUnitSave,
  apiProductWordDelete, apiProductWordList, apiProductWordSave, apiProductWordStatus,
  type ProductEnsure, type ProductParameter, type ProductParameterTemplate,
  type ProductRuleDimension, type ProductRuleTemplate, type ProductUnit, type ProductWord,
} from "@/api/productMetadata";

const activeTab = ref("units");
const units = ref<ProductUnit[]>([]);
const ensures = ref<ProductEnsure[]>([]);
const rules = ref<ProductRuleTemplate[]>([]);
const parameterTemplates = ref<ProductParameterTemplate[]>([]);
const words = ref<ProductWord[]>([]);
const unitLoading = ref(false);
const ensureLoading = ref(false);
const ruleLoading = ref(false);
const parameterLoading = ref(false);
const wordLoading = ref(false);
const saving = ref(false);
const unitTotal = ref(0);
const ensureTotal = ref(0);
const ruleTotal = ref(0);
const parameterTotal = ref(0);
const wordTotal = ref(0);
const unitQuery = reactive({ page: 1, limit: 20, name: "" });
const ensureQuery = reactive({ page: 1, limit: 20, name: "" });
const ruleQuery = reactive({ page: 1, limit: 20, rule_name: "" });
const parameterQuery = reactive({ page: 1, limit: 20, name: "" });
const wordQuery = reactive({ page: 1, limit: 20, name: "" });
const unitDialog = ref(false);
const ensureDialog = ref(false);
const ruleDialog = ref(false);
const parameterDialog = ref(false);
const wordDialog = ref(false);
const unitForm = reactive({ id: 0, name: "", sort: 0 });
const ensureForm = reactive({ id: 0, name: "", image: "", desc: "", sort: 0, status: 1 });
const blankDimension = (): ProductRuleDimension => ({ value: "", detail: [] });
const ruleForm = reactive<{ id: number; rule_name: string; spec: ProductRuleDimension[] }>({ id: 0, rule_name: "", spec: [blankDimension()] });
const blankParameter = (): ProductParameter => ({ name: "", value: "", sort: 0, status: 1 });
const parameterForm = reactive<{ id: number; name: string; sort: number; specs: ProductParameter[] }>({ id: 0, name: "", sort: 0, specs: [blankParameter()] });
const emptyWord = () => ({ id: 0, name: "", color: "#303133", bg_color: "#ffffff", border_color: "#dcdfe6", icon: "", sort: 0, is_search: 1, is_show: 1 });
const wordForm = reactive(emptyWord());

async function loadUnits() {
  unitLoading.value = true;
  try { const result = await apiProductUnitList(unitQuery); units.value = result.list; unitTotal.value = result.count; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "单位加载失败"); }
  finally { unitLoading.value = false; }
}
async function loadEnsures() {
  ensureLoading.value = true;
  try { const result = await apiProductEnsureList(ensureQuery); ensures.value = result.list; ensureTotal.value = result.count; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "保障服务加载失败"); }
  finally { ensureLoading.value = false; }
}
async function loadRules() {
  ruleLoading.value = true;
  try { const result = await apiProductRuleList(ruleQuery); rules.value = result.list; ruleTotal.value = result.count; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "规格模板加载失败"); }
  finally { ruleLoading.value = false; }
}
async function loadParameterTemplates() {
  parameterLoading.value = true;
  try { const result = await apiProductParameterTemplateList(parameterQuery); parameterTemplates.value = result.list; parameterTotal.value = result.count; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "参数模板加载失败"); }
  finally { parameterLoading.value = false; }
}
async function loadWords() {
  wordLoading.value = true;
  try { const result = await apiProductWordList(wordQuery); words.value = result.list; wordTotal.value = result.count; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "搜索热词加载失败"); }
  finally { wordLoading.value = false; }
}
function searchUnits() { unitQuery.page = 1; void loadUnits(); }
function searchEnsures() { ensureQuery.page = 1; void loadEnsures(); }
function searchRules() { ruleQuery.page = 1; void loadRules(); }
function searchParameterTemplates() { parameterQuery.page = 1; void loadParameterTemplates(); }
function searchWords() { wordQuery.page = 1; void loadWords(); }

function openUnit(row?: ProductUnit) {
  Object.assign(unitForm, row ? { id: row.id, name: row.name, sort: row.sort } : { id: 0, name: "", sort: 0 });
  unitDialog.value = true;
}
async function saveUnit() {
  const name = unitForm.name.trim();
  if (!name) return ElMessage.warning("请输入单位名称");
  saving.value = true;
  try { await apiProductUnitSave(unitForm.id, { name, sort: unitForm.sort }); unitDialog.value = false; ElMessage.success(unitForm.id ? "单位已更新" : "单位已创建"); await loadUnits(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "单位保存失败"); }
  finally { saving.value = false; }
}
async function deleteUnit(row: ProductUnit) {
  try { await ElMessageBox.confirm(`确认删除单位「${row.name}」？正在使用的单位会被服务端拒绝。`, "删除单位", { type: "warning" }); }
  catch { return; }
  try { await apiProductUnitDelete(row.id); ElMessage.success("单位已删除"); await loadUnits(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "单位删除失败"); }
}

function openEnsure(row?: ProductEnsure) {
  Object.assign(ensureForm, row ? { id: row.id, name: row.name, image: row.image, desc: row.desc, sort: row.sort, status: row.status } : { id: 0, name: "", image: "", desc: "", sort: 0, status: 1 });
  ensureDialog.value = true;
}
async function saveEnsure() {
  const payload = { name: ensureForm.name.trim(), image: ensureForm.image.trim(), desc: ensureForm.desc.trim(), sort: ensureForm.sort, status: ensureForm.status };
  if (!payload.name || !payload.image || !payload.desc) return ElMessage.warning("请完整填写保障条款、图标和说明");
  saving.value = true;
  try { await apiProductEnsureSave(ensureForm.id, payload); ensureDialog.value = false; ElMessage.success(ensureForm.id ? "保障服务已更新" : "保障服务已创建"); await loadEnsures(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "保障服务保存失败"); }
  finally { saving.value = false; }
}
async function setEnsureStatus(row: ProductEnsure, status: number) {
  try { await apiProductEnsureStatus(row.id, status); row.status = status; ElMessage.success(status ? "保障服务已启用" : "保障服务已停用"); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "状态更新失败"); }
}
async function deleteEnsure(row: ProductEnsure) {
  try { await ElMessageBox.confirm(`确认删除保障服务「${row.name}」？被商品引用时服务端会拒绝。`, "删除保障", { type: "warning" }); }
  catch { return; }
  try { await apiProductEnsureDelete(row.id); ElMessage.success("保障服务已删除"); await loadEnsures(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "保障服务删除失败"); }
}

async function openRule(id = 0) {
  if (!id) { Object.assign(ruleForm, { id: 0, rule_name: "", spec: [blankDimension()] }); ruleDialog.value = true; return; }
  try {
    const detail = await apiProductRuleDetail(id);
    Object.assign(ruleForm, { id: detail.id, rule_name: detail.rule_name, spec: detail.spec.length ? structuredClone(detail.spec) : [blankDimension()] });
    ruleDialog.value = true;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "规格模板详情加载失败"); }
}
function addDimension() {
  if (ruleForm.spec.length >= 3) return ElMessage.warning("最多支持 3 个规格维度");
  ruleForm.spec.push(blankDimension());
}
function removeDimension(index: number) {
  if (ruleForm.spec.length === 1) return ElMessage.warning("至少保留一个规格维度");
  ruleForm.spec.splice(index, 1);
}
function validateRule() {
  if (!ruleForm.rule_name.trim()) return "请填写规格模板名称";
  const names: string[] = [];
  for (const dimension of ruleForm.spec) {
    const name = dimension.value.trim();
    const details = dimension.detail.map((item) => item.trim());
    if (!name) return "请填写规格名称";
    if (!details.length || details.length > 50) return `规格“${name}”需包含 1 至 50 个规格值`;
    if (details.some((item) => !item || item.length > 64)) return `规格“${name}”包含空值或超长规格值`;
    if (new Set(details).size !== details.length) return `规格“${name}”的规格值不能重复`;
    names.push(name);
  }
  if (new Set(names).size !== names.length) return "规格名称不能重复";
  return "";
}
async function saveRule() {
  const message = validateRule();
  if (message) return ElMessage.warning(message);
  saving.value = true;
  try {
    await apiProductRuleSave(ruleForm.id, { rule_name: ruleForm.rule_name.trim(), spec: ruleForm.spec.map((item) => ({ value: item.value.trim(), detail: item.detail.map((value) => value.trim()) })) });
    ruleDialog.value = false; ElMessage.success(ruleForm.id ? "规格模板已更新" : "规格模板已创建"); await loadRules();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "规格模板保存失败"); }
  finally { saving.value = false; }
}
async function deleteRule(row: ProductRuleTemplate) {
  try { await ElMessageBox.confirm(`确认删除「${row.rule_name}」？已套用到商品的数据不会被改写，但模板无法恢复。`, "删除规格模板", { type: "warning" }); }
  catch { return; }
  try { await apiProductRuleDelete(row.id); ElMessage.success("规格模板已删除"); if (rules.value.length === 1 && ruleQuery.page > 1) ruleQuery.page -= 1; await loadRules(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "规格模板删除失败"); }
}

async function openParameterTemplate(id = 0) {
  if (!id) { Object.assign(parameterForm, { id: 0, name: "", sort: 0, specs: [blankParameter()] }); parameterDialog.value = true; return; }
  try {
    const detail = await apiProductParameterTemplateDetail(id);
    Object.assign(parameterForm, { id: detail.id, name: detail.name, sort: detail.sort, specs: detail.specs.length ? structuredClone(detail.specs) : [blankParameter()] });
    parameterDialog.value = true;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "参数模板详情加载失败"); }
}
function addParameter() {
  if (parameterForm.specs.length >= 100) return ElMessage.warning("最多支持 100 个参数");
  parameterForm.specs.push(blankParameter());
}
function removeParameter(index: number) {
  if (parameterForm.specs.length === 1) return ElMessage.warning("至少保留一个参数");
  parameterForm.specs.splice(index, 1);
}
async function saveParameterTemplate() {
  const name = parameterForm.name.trim();
  if (!name) return ElMessage.warning("请填写参数模板名称");
  const specs = parameterForm.specs.map((item) => ({ name: item.name.trim(), value: item.value.trim(), sort: item.sort, status: item.status }));
  if (specs.some((item) => !item.name || !item.value)) return ElMessage.warning("请完整填写每一项参数名称与参数值");
  saving.value = true;
  try {
    await apiProductParameterTemplateSave(parameterForm.id, { name, sort: parameterForm.sort, specs });
    parameterDialog.value = false; ElMessage.success(parameterForm.id ? "参数模板已更新" : "参数模板已创建"); await loadParameterTemplates();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "参数模板保存失败"); }
  finally { saving.value = false; }
}
async function deleteParameterTemplate(row: ProductParameterTemplate) {
  try { await ElMessageBox.confirm(`确认删除「${row.name}」及其中 ${row.specs.length} 项参数？`, "删除参数模板", { type: "warning" }); }
  catch { return; }
  try { await apiProductParameterTemplateDelete(row.id); ElMessage.success("参数模板已删除"); if (parameterTemplates.value.length === 1 && parameterQuery.page > 1) parameterQuery.page -= 1; await loadParameterTemplates(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "参数模板删除失败"); }
}

function wordPreviewStyle(row: Pick<ProductWord, "color" | "bg_color" | "border_color"> | typeof wordForm) {
  return {
    color: row.color || undefined,
    backgroundColor: row.bg_color || undefined,
    borderColor: row.border_color || undefined,
  };
}
function openWord(row?: ProductWord) {
  Object.assign(wordForm, row ? {
    id: row.id,
    name: row.name,
    color: row.color,
    bg_color: row.bg_color,
    border_color: row.border_color,
    icon: row.icon,
    sort: row.sort,
    is_search: row.is_search,
    is_show: row.is_show,
  } : emptyWord());
  wordDialog.value = true;
}
async function saveWord() {
  const name = wordForm.name.trim();
  if (!name) return ElMessage.warning("请填写热词名称");
  saving.value = true;
  try {
    await apiProductWordSave(wordForm.id, {
      name,
      color: wordForm.color || "",
      bg_color: wordForm.bg_color || "",
      border_color: wordForm.border_color || "",
      icon: wordForm.icon.trim(),
      sort: wordForm.sort,
      is_search: wordForm.is_search,
      is_show: wordForm.is_show,
    });
    wordDialog.value = false;
    ElMessage.success(wordForm.id ? "搜索热词已更新" : "搜索热词已创建");
    await loadWords();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "搜索热词保存失败"); }
  finally { saving.value = false; }
}
async function setWordStatus(row: ProductWord, isShow: number) {
  try {
    await apiProductWordStatus(row.id, isShow);
    row.is_show = isShow;
    ElMessage.success(isShow ? "热词已显示" : "热词已隐藏");
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "热词状态更新失败"); }
}
async function deleteWord(row: ProductWord) {
  try { await ElMessageBox.confirm(`确认删除搜索热词「${row.name}」？删除后不会在商城展示。`, "删除搜索热词", { type: "warning" }); }
  catch { return; }
  try {
    await apiProductWordDelete(row.id);
    ElMessage.success("搜索热词已删除");
    if (words.value.length === 1 && wordQuery.page > 1) wordQuery.page -= 1;
    await loadWords();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "搜索热词删除失败"); }
}

onMounted(() => void Promise.all([loadUnits(), loadEnsures(), loadRules(), loadParameterTemplates(), loadWords()]));
</script>

<style scoped>
.metadata-page { display: grid; gap: 16px; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.page-head h2 { margin: 0 0 6px; font-size: 20px; }
.page-head p, .editor-head p { margin: 0; color: #667085; }
.toolbar { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.toolbar .el-input { width: min(320px, 100%); }
.semantic-note { margin-bottom: 14px; padding: 10px 12px; border-left: 3px solid #409eff; background: #f4f8ff; color: #475467; font-size: 13px; }
.table-scroll { width: 100%; overflow-x: auto; }
.ensure-image { width: 42px; height: 42px; border-radius: 8px; }
.el-pagination { margin-top: 16px; justify-content: flex-end; }
.dimension-summary { display: grid; gap: 8px; padding: 4px 0; }
.dimension-summary > div { display: grid; grid-template-columns: minmax(70px, 100px) 1fr; gap: 8px; }
.dimension-summary span, .parameter-summary { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dimension-editor, .parameter-editor { padding-top: 16px; border-top: 1px solid #e4e7ed; }
.editor-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.editor-head h3 { margin: 0 0 4px; font-size: 16px; }
.dimension-row { display: grid; grid-template-columns: minmax(150px, .7fr) minmax(280px, 1.6fr) 64px; gap: 12px; margin-bottom: 12px; }
.dimension-row .el-select { width: 100%; }
.parameter-basics { display: grid; grid-template-columns: 1fr 150px; gap: 16px; }
.parameter-row { display: grid; grid-template-columns: 1fr 1.4fr 120px 48px 64px; align-items: center; gap: 10px; margin-bottom: 10px; }
.word-preview { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 5px 10px; border: 1px solid #dcdfe6; border-radius: 999px; overflow: hidden; }
.word-preview img { width: 16px; height: 16px; object-fit: contain; }
.color-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.color-grid .el-form-item { margin-right: 0; }
.dialog-preview { display: flex; align-items: center; gap: 12px; margin: 4px 0 0 104px; color: #667085; }
@media (max-width: 720px) {
  .page-head { align-items: flex-start; }
  .page-head p { font-size: 13px; }
  .toolbar, .editor-head { align-items: stretch; flex-direction: column; }
  .toolbar .el-input, .toolbar .el-button { width: 100%; }
  .el-pagination { justify-content: center; overflow-x: auto; }
  .dimension-row { grid-template-columns: 1fr 64px; }
  .dimension-row .el-select { grid-column: 1 / -1; grid-row: 2; }
  .parameter-basics { grid-template-columns: 1fr; }
  .parameter-row { grid-template-columns: 1fr 64px; padding: 12px; border: 1px solid #ebeef5; border-radius: 8px; }
  .parameter-row > :nth-child(2), .parameter-row > :nth-child(3) { grid-column: 1 / -1; }
  .parameter-row > :nth-child(4) { grid-column: 1; }
  .parameter-row > :nth-child(5) { grid-column: 2; grid-row: 1; }
  .color-grid { grid-template-columns: 1fr; }
  .dialog-preview { margin-left: 0; }
}
</style>
