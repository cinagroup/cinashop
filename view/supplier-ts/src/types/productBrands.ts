export interface SupplierProductBrandNode {
  value: number;
  label: string;
  pid: number;
  children?: SupplierProductBrandNode[];
}
export interface SupplierProductBrandSelection {
  brand_id: number;
  brand_com: string;
  consistent: boolean;
  available: boolean;
}
export interface SupplierProductBrandAvailability { ready: boolean; valid: boolean }
