<template>
  <!-- 商品-商品规格 -->
  <div>
    <Card :bordered="false" dis-hover class="ivu-mt" :padding="0">
      <div class="new_card_pd">
        <!-- 筛选条件 -->
        <Form
            inline
            ref="artFrom"
            :model="artFrom"
            :label-width="labelWidth"
            :label-position="labelPosition"
            class="tabform"
            @submit.native.prevent
        >
          <Row :gutter="24" type="flex" justify="end">
            <Col span="24" class="ivu-text-left">
              <FormItem label="规格搜索：">
                <Input
                    v-model="artFrom.rule_name"
                    placeholder="请输入规格分类名称"
                    class="input-add"
                ></Input>
                <Button type="primary" @click="userSearchs">查询</Button>
              </FormItem>
            </Col>
          </Row>
        </Form>
      </div>
    </Card>
    <!-- 相关操作 -->
    <Card :bordered="false" dis-hover class="ivu-mt">
      <Button
          v-auth="['product-rule-save']"
          type="primary"
          @click="addAttr"
      >添加商品规格
      </Button
      >
      <!-- 商品规格表格 -->
      <Table
          class="mt25"
          ref="selection"
          :columns="columns4"
          :data="tableList"
          :loading="loading"
          highlight-row
          no-data-text="暂无数据"
          no-filtered-data-text="暂无筛选结果"
      >
        <template slot-scope="{ row }" slot="attr_value">
          <span
              v-for="(item, index) in row.attr_value"
              :key="index"
              v-text="item"
              style="display: block"
          ></span>
        </template>
        <template slot-scope="{ row, index }" slot="action">
          <a @click="edit(row)">编辑</a>
          <Divider type="vertical"/>
          <a @click="del(row, '删除规格', index)">删除</a>
        </template>
      </Table>
      <div class="acea-row row-right page">
        <Page
            :total="total"
            :current="artFrom.page"
            show-elevator
            show-total
            @on-change="pageChange"
            :page-size="artFrom.limit"
        />
      </div>
    </Card>
    <add-attr ref="addattr" @getList="userSearchs"></add-attr>
  </div>
</template>

<script>
import {mapState} from "vuex";
import addAttr from "./addAttr";
import {ruleListApi} from "@/api/product";

export default {
  name: "productAttr",
  components: {addAttr},
  data() {
    return {
      loading: false,
      artFrom: {
        page: 1,
        limit: 10,
        rule_name: "",
      },
      columns4: [
        {
          title: "ID",
          key: "id",
          width: 80,
        },
        {
          title: "分类",
          key: "rule_name",
          minWidth: 150,
        },
        {
          title: "规格名",
          key: "attr_name",
          minWidth: 250,
        },
        {
          title: "规格值",
          slot: "attr_value",
          minWidth: 300,
        },
        {
          title: "操作",
          slot: "action",
          fixed: "right",
          minWidth: 120,
        },
      ],
      tableList: [],
      total: 0,
      ids: "",
      selectionCopy: [],
      display: "none",
      isAll: 0,
      checkBox: false,
    };
  },
  computed: {
    ...mapState("admin/layout", ["isMobile"]),
    ...mapState("admin/order", ["orderChartType"]),
    labelWidth() {
      return this.isMobile ? undefined : 96;
    },
    labelPosition() {
      return this.isMobile ? "top" : "right";
    },
  },
  created() {
    this.getDataList();
  },
  methods: {
    // 删除
    del(row, tit, num) {
      let delfromData = {
        title: tit,
        num: 0,
        url: `product/product/rule/delete/${row.id}`,
        method: "DELETE",
        ids: '',
      };
      this.$modalSure(delfromData).then((res) => {
        this.$Message.success(res.msg);
        this.getDataList();
      }).catch((res) => {
        this.$Message.error(res.msg);
      });
    },
    addAttr() {
      this.$refs.addattr.ids = 0;
      this.$refs.addattr.modal = true;
    },
    // 编辑
    edit(row) {
      this.$refs.addattr.modal = true;
      this.$refs.addattr.getIofo(row);
    },
    // 列表；
    getDataList() {
      this.loading = true;
      ruleListApi(this.artFrom).then((res) => {
        let data = res.data;
        data.list.forEach(item => {
          item.checkBox = false;
        })
        this.tableList = data.list
        if (this.isAll == 1) {
          this.tableList = data.list.map((item) => {
            item.checkBox = true;
            return item;
          });
        }
        this.total = res.data.count;
        // this.isAll = -1;
        this.loading = false;
      })
          .catch((res) => {
            this.loading = false;
            this.$Message.error(res.msg);
          });
    },
    pageChange(status) {
      this.artFrom.page = status;
      this.getDataList();
    },
    // 表格搜索
    userSearchs() {
      this.artFrom.page = 1;
      this.getDataList();
    },
  },
};
</script>

<style scoped lang="stylus">
.input-add {
  width: 250px;
  margin-right: 14px;
}

/deep/ .ivu-table-header {
  // overflow visible
}

/deep/ .ivu-table th {
  overflow: visible;
}

/deep/ .select-item:hover {
  background-color: #f3f3f3;
}

/deep/ .select-on {
  display: block;
}

/deep/ .select-item.on {
  // background: #f3f3f3;
}
</style>
