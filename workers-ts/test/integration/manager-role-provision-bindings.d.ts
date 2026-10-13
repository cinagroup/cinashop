/** Module-scoped temporary maintenance bindings. Never application Env. */
export interface ManagerRoleProvisionEnv {
  HYPERDRIVE: Hyperdrive;
  HYPERDRIVE_MANAGER?: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
  AUDIT_EXPIRES_AT: string;
  CREDENTIALS_BODY_SHA256: string;
  PROVISION_DISABLED: string;
}
