export interface CustomerCashierCapabilityReadiness { ready: boolean; reason: string }
export interface CustomerCashierCapabilities {
  version: 'customer-cashier-capabilities-v1';
  actor_uid: number;
  principal: { kind: 'customer-order-manager'; service_id: number; scope: 'global' };
  scope_key: string;
  consistency_key: string;
  data: {
    capabilities: { cashier_second_card: boolean; cashier_form_images: boolean };
    readiness: Record<'origin' | 'form_base' | 'abandon' | 'conditional' | 'form_images', CustomerCashierCapabilityReadiness>;
    runtime_revision: string;
    lease: { issued_at: number; expires_at: number; session_expires_at: number };
  };
}
