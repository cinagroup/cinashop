export interface SupplierProductEnsureOption { id: number; name: string }
export interface SupplierProductEnsureSelection {
  ensure_id: string | null;
  consistent: boolean;
  available: boolean;
  retained_ids: number[];
  truncated: boolean;
}
export interface SupplierProductEnsureAvailability { ready: boolean; valid: boolean }
