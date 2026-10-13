export interface SupplierProductLabelRow {
  id: number; type: 2; relation_id: number; label_cate: number; label_name: string;
  style_type: number; color: string; bg_color: string; border_color: string; icon: string;
  is_show: number; status: number; sort: number; add_time: string;
  group_name: string; group_valid: boolean; selectable: boolean; revision: string;
}
export interface SupplierProductLabelGroup { id: number; name: string; type: 0 | 2; relation_id: number; is_show: number }
export interface SupplierProductLabelCatalog { count: number; revision: string; groups: SupplierProductLabelGroup[]; list: SupplierProductLabelRow[] }
export interface SupplierProductLabelPayload { label_cate: number; label_name: string; expected_revision?: string }
export interface SupplierProductLabelReceipt { id: number; revision: string }
export interface SupplierProductLabelForm {
  title: string; method: 'POST'; action: 'product/label/0';
  rules: [
    { type: 'select'; field: 'label_cate'; title: string; value: ''; options: { label: string; value: number }[] },
    { type: 'input'; field: 'label_name'; title: string; value: ''; props: { maxlength: 20 } },
  ];
}
export interface SupplierProductLabelTreeLeaf {
  id: number; value: number; label: string; label_name: string; label_cate: number; type: 0 | 2; relation_id: number;
}
export interface SupplierProductLabelTreeGroup {
  id: number; value: number; label: string; label_name: string; label_cate: 0; type: 0 | 2; relation_id: number; children: SupplierProductLabelTreeLeaf[];
}
