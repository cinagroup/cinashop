export interface SupplierProductParameterRow { id: number; temp_id: number; name: string; value: string; sort: number }
export interface SupplierProductParameterDraft { specs_id: number; specs: SupplierProductParameterRow[] }
export interface SupplierProductParameterTemplate { id: number; name: string; specs: SupplierProductParameterRow[] }
export interface SupplierProductParameterSelection {
  specs_id: number;
  specs: string | null;
  consistent: boolean;
  available: boolean;
  truncated: boolean;
}
export interface SupplierProductParameterAvailability { ready: boolean; valid: boolean }
