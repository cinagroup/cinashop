export interface SupplierProductSystemFormOption { id: number; name: string }
export interface SupplierProductSystemFormSelection { system_form_id: number; available: boolean }
export interface SupplierProductSystemFormField { title: string; type: string; required: boolean }
export interface SupplierProductSystemFormPreview { id: number; name: string; fields: SupplierProductSystemFormField[] }
export interface SupplierProductSystemFormAvailability { ready: boolean; valid: boolean }
