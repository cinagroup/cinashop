export interface SupplierRuleDimension { value: string; detail: string[] }
export interface SupplierProductRuleRow {
  id: number; type: 2; relation_id: number; rule_name: string; rule_value: string | null;
  attr_name: string; attr_value: string[]; spec: SupplierRuleDimension[]; revision: string;
}
export interface SupplierProductRuleCatalog { list: SupplierProductRuleRow[]; count: number; page: number; limit: number; revision: string }
export interface SupplierProductRulePayload { rule_name: string; spec: SupplierRuleDimension[]; expected_revision?: string }
export interface SupplierProductRuleReceipt { id: number; revision: string }
export type SupplierProductRuleTemplate = Omit<SupplierProductRuleRow, 'rule_value'> & { rule_value: SupplierRuleDimension[] };
