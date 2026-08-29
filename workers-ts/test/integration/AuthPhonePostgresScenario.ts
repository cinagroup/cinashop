import { and, eq, sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import type { Env } from "@/env";
import { user, wechatUser } from "@/models/schema";
import { LoginService } from "@/services/user/LoginService";
import { WechatAuthService } from "@/services/wechat/WechatAuthService";
import { ValidateException } from "@/utils/errors";
import { md5, verifyToken } from "@/utils/jwt";

const PREFIX = "codex_auth_phone_";
const IDS = {
  disabled: 1_801_000_001,
  duplicateA: 1_801_000_002,
  duplicateB: 1_801_000_003,
  occupied: 1_801_000_004,
  updateA: 1_801_000_005,
  updateB: 1_801_000_006,
  binding: 1_801_000_007,
  crossUpdate: 1_801_000_008,
  socialExisting: 1_801_000_014,
  socialPhoneOwner: 1_801_000_015,
} as const;

interface Fingerprint {
  users: { count: string; digest: string };
  system_config: { count: string; digest: string };
  wechat_users: { count: string; digest: string };
  user_sequence: string | null;
  wechat_user_sequence: string | null;
}

export interface AuthPhonePostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  registration: {
    verified_boundary_required_by_controller: true;
    password_hashed: boolean;
    default_password_rejected: boolean;
    concurrent_duplicate_rejected: boolean;
  };
  mobile: {
    existing_user_exact: boolean;
    missing_user_created_once: boolean;
    disabled_user_rejected: boolean;
    ambiguous_phone_rejected: boolean;
  };
  recovery: {
    password_reset_invalidates_old_auth: boolean;
    occupied_phone_rejected: boolean;
    account_tracks_phone_for_phone_accounts: boolean;
    concurrent_phone_claim_single_winner: boolean;
    registration_update_claim_single_winner: boolean;
    blank_phone_binding_exact: boolean;
  };
  social_binding: {
    concurrent_identity_phone_single_user: boolean;
    conflicting_existing_accounts_rejected: boolean;
    unionid_attaches_to_existing_user: boolean;
    random_password_preserved: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Auth phone integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function schemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `${PREFIX}${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

function auditEnv(): Env {
  const values = new Map<string, string>();
  return {
    APP_KEY: `audit-only-${crypto.randomUUID()}`,
    CONFIG_KV: {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    },
  } as unknown as Env;
}

async function fingerprint(db: DbClient): Promise<Fingerprint> {
  const rows = await db.$client.unsafe<Array<{
    users_count: string;
    users_digest: string;
    config_count: string;
    config_digest: string;
    wechat_count: string;
    wechat_digest: string;
    user_sequence: string | null;
    wechat_user_sequence: string | null;
  }>>(`
    SELECT
      (SELECT count(*)::text FROM public."user" WHERE random() >= 0) AS users_count,
      (SELECT md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, ''))
        FROM public."user" t WHERE random() >= 0) AS users_digest,
      (SELECT count(*)::text FROM public.system_config WHERE random() >= 0) AS config_count,
      (SELECT md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, ''))
        FROM public.system_config t WHERE random() >= 0) AS config_digest,
      (SELECT count(*)::text FROM public.wechat_user WHERE random() >= 0) AS wechat_count,
      (SELECT md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, ''))
        FROM public.wechat_user t WHERE random() >= 0) AS wechat_digest,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'user_uid_seq') AS user_sequence,
      (SELECT last_value::text FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = 'wechat_user_id_seq')
        AS wechat_user_sequence
  `);
  const row = rows[0];
  if (!row) throw new Error("production fingerprint returned no row");
  return {
    users: { count: row.users_count, digest: row.users_digest },
    system_config: { count: row.config_count, digest: row.config_digest },
    wechat_users: { count: row.wechat_count, digest: row.wechat_digest },
    user_sequence: row.user_sequence,
    wechat_user_sequence: row.wechat_user_sequence,
  };
}

async function setup(root: DbClient, name: string): Promise<void> {
  const schema = identifier(name);
  await root.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '20s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    await tx.unsafe(`CREATE TABLE ${schema}."user" (LIKE public."user" INCLUDING ALL)`);
    await tx.unsafe(`CREATE TABLE ${schema}.system_config (LIKE public.system_config INCLUDING ALL)`);
    await tx.unsafe(`CREATE TABLE ${schema}.wechat_user (LIKE public.wechat_user INCLUDING ALL)`);
    await tx.unsafe(`CREATE SEQUENCE ${schema}.user_uid_seq START WITH 1901000000`);
    await tx.unsafe(`CREATE SEQUENCE ${schema}.wechat_user_id_seq START WITH 1901000000`);
    await tx.unsafe(
      `ALTER TABLE ${schema}."user" ALTER COLUMN uid SET DEFAULT nextval('${name}.user_uid_seq'::regclass)`,
    );
    await tx.unsafe(
      `ALTER SEQUENCE ${schema}.user_uid_seq OWNED BY ${schema}."user".uid`,
    );
    await tx.unsafe(
      `ALTER TABLE ${schema}.wechat_user ALTER COLUMN id SET DEFAULT nextval('${name}.wechat_user_id_seq'::regclass)`,
    );
    await tx.unsafe(
      `ALTER SEQUENCE ${schema}.wechat_user_id_seq OWNED BY ${schema}.wechat_user.id`,
    );
  });
}

async function withSchema<T>(
  db: DbClient,
  name: string,
  callback: (container: Container) => Promise<T>,
): Promise<T> {
  return withTx(createContainerFromDb(db), async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(name)}`));
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    return callback(createContainerFromDb(tx));
  });
}

async function seed(container: Container): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rows = [
    { uid: IDS.disabled, account: "13910000002", phone: "13910000002", status: 0 },
    { uid: IDS.duplicateA, account: "dup-a", phone: "13910000003", status: 1 },
    { uid: IDS.duplicateB, account: "dup-b", phone: "13910000003", status: 1 },
    { uid: IDS.occupied, account: "13910000005", phone: "13910000005", status: 1 },
    { uid: IDS.updateA, account: "13910000006", phone: "13910000006", status: 1 },
    { uid: IDS.updateB, account: "13910000007", phone: "13910000007", status: 1 },
    { uid: IDS.binding, account: "oauth-audit-user", phone: "", status: 1 },
    { uid: IDS.crossUpdate, account: "13910000012", phone: "13910000012", status: 1 },
    { uid: IDS.socialExisting, account: "social-existing", phone: "", status: 1 },
    { uid: IDS.socialPhoneOwner, account: "13910000015", phone: "13910000015", status: 1 },
  ];
  await container.db.insert(user).values(rows.map((row) => ({
    ...row,
    pwd: md5("audit-Password-9"),
    nickname: `audit-${row.uid}`,
    isDel: 0,
    addTime: now,
    lastTime: now,
  })));
  await container.db.insert(wechatUser).values({
    uid: IDS.socialExisting,
    openid: "audit-existing-openid",
    unionid: "audit-union-1",
    userType: "wechat",
    isDel: 0,
    addTime: now,
    subscribeTime: now,
  });
}

async function oneUser(container: Container, uid: number) {
  const rows = await container.db.select({
    uid: user.uid,
    account: user.account,
    phone: user.phone,
    pwd: user.pwd,
    status: user.status,
  }).from(user).where(eq(user.uid, uid)).limit(1);
  return rows[0] ?? null;
}

async function rejectsValidation(action: () => Promise<unknown>, text?: string): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof ValidateException && (!text || error.message.includes(text));
  }
}

async function runCore(dbA: DbClient, dbB: DbClient, name: string): Promise<Omit<
  AuthPhonePostgresReport,
  "server_version" | "schema_created" | "schema_removed" | "temporary_schemas_after" | "public_state_unchanged"
>> {
  const envA = auditEnv();
  const envB = auditEnv();
  await withSchema(dbA, name, seed);

  const registration = await withSchema(dbA, name, async (container) => {
    const registered = await new LoginService(container, envA).register(
      "13910000001",
      "AuditPass-901",
      0,
      "127.0.0.1",
      "audit",
    );
    const rows = await container.db.select().from(user)
      .where(eq(user.phone, "13910000001")).limit(1);
    return { registered, user: rows[0] ?? null };
  });
  const registeredUser = registration.user;
  assertCondition(registeredUser, "registration did not create a user");
  const passwordHashed = registeredUser.pwd === md5("AuditPass-901")
    && registeredUser.pwd !== "AuditPass-901" && Boolean(registration.registered.token);
  assertCondition(passwordHashed, "registration password/token contract diverged");

  const defaultPasswordRejected = await rejectsValidation(
    () => withSchema(dbA, name, (container) => new LoginService(container, envA)
      .loginByPassword("13910000001", "123456", 0, "127.0.0.1")),
  );
  assertCondition(defaultPasswordRejected, "default password was accepted");

  const concurrentRegistration = await Promise.allSettled([
    withSchema(dbA, name, (container) => new LoginService(container, envA)
      .register("13910000004", "AuditPass-904", 0)),
    withSchema(dbB, name, (container) => new LoginService(container, envB)
      .register("13910000004", "AuditPass-904", 0)),
  ]);
  const registrationCount = await withSchema(dbA, name, (container) =>
    container.db.select({ uid: user.uid }).from(user).where(eq(user.phone, "13910000004")));
  const concurrentDuplicateRejected = concurrentRegistration.filter(
    (result) => result.status === "fulfilled",
  ).length === 1 && registrationCount.length === 1;
  assertCondition(concurrentDuplicateRejected, "concurrent registration created duplicate users");

  const existingBefore = registeredUser.uid;
  const existingLogin = await withSchema(dbA, name, (container) =>
    new LoginService(container, envA).loginByMobile("13910000001", 0, "127.0.0.1"));
  const existingAfter = await withSchema(dbA, name, (container) =>
    container.db.select({ uid: user.uid }).from(user).where(eq(user.phone, "13910000001")));
  const existingUserExact = Boolean(existingLogin.token)
    && existingAfter.length === 1 && existingAfter[0]?.uid === existingBefore;
  assertCondition(existingUserExact, "existing mobile login changed identity");

  const missingPhone = "13910000009";
  const mobileCreates = await Promise.all([
    withSchema(dbA, name, (container) => new LoginService(container, envA)
      .loginByMobile(missingPhone, 0, "127.0.0.1")),
    withSchema(dbB, name, (container) => new LoginService(container, envB)
      .loginByMobile(missingPhone, 0, "127.0.0.2")),
  ]);
  const missingRows = await withSchema(dbA, name, (container) =>
    container.db.select({ uid: user.uid, pwd: user.pwd }).from(user)
      .where(eq(user.phone, missingPhone)));
  const missingUserCreatedOnce = mobileCreates.every((result) => Boolean(result.token))
    && missingRows.length === 1 && missingRows[0]?.pwd !== md5("123456");
  assertCondition(missingUserCreatedOnce, "mobile auto-registration was not single/random-password");

  const disabledUserRejected = await rejectsValidation(
    () => withSchema(dbA, name, (container) => new LoginService(container, envA)
      .loginByMobile("13910000002", 0, "127.0.0.1")),
    "禁止",
  );
  assertCondition(disabledUserRejected, "disabled user logged in by mobile");
  const ambiguousPhoneRejected = await rejectsValidation(
    () => withSchema(dbA, name, (container) => new LoginService(container, envA)
      .loginByMobile("13910000003", 0, "127.0.0.1")),
    "多个账号",
  );
  assertCondition(ambiguousPhoneRejected, "ambiguous phone selected an arbitrary account");

  const oldClaims = await verifyToken(existingLogin.token, envA.APP_KEY);
  await withSchema(dbA, name, (container) => new LoginService(container, envA)
    .resetPassword("13910000001", "ResetPass-901"));
  const resetUser = await withSchema(dbA, name, (container) => oneUser(container, registeredUser.uid));
  const passwordResetInvalidatesOldAuth = resetUser?.pwd === md5("ResetPass-901")
    && oldClaims.auth !== md5(resetUser.pwd);
  assertCondition(passwordResetInvalidatesOldAuth, "password reset did not invalidate old auth claim");

  const occupiedPhoneRejected = await rejectsValidation(
    () => withSchema(dbA, name, (container) => new LoginService(container, envA)
      .updatePhone(registeredUser.uid, "13910000005")),
    "已经注册",
  );
  assertCondition(occupiedPhoneRejected, "occupied phone was accepted");
  await withSchema(dbA, name, (container) => new LoginService(container, envA)
    .updatePhone(registeredUser.uid, "13910000011"));
  const updated = await withSchema(dbA, name, (container) => oneUser(container, registeredUser.uid));
  const accountTracksPhone = updated?.account === "13910000011" && updated.phone === "13910000011";
  assertCondition(accountTracksPhone, "phone-account identity did not move together");

  const concurrentClaim = await Promise.allSettled([
    withSchema(dbA, name, (container) => new LoginService(container, envA)
      .updatePhone(IDS.updateA, "13910000008")),
    withSchema(dbB, name, (container) => new LoginService(container, envB)
      .updatePhone(IDS.updateB, "13910000008")),
  ]);
  const claimed = await withSchema(dbA, name, (container) =>
    container.db.select({ uid: user.uid }).from(user)
      .where(and(eq(user.isDel, 0), eq(user.phone, "13910000008"))));
  const concurrentPhoneClaimSingleWinner = concurrentClaim.filter(
    (result) => result.status === "fulfilled",
  ).length === 1 && claimed.length === 1;
  assertCondition(concurrentPhoneClaimSingleWinner, "concurrent phone claim had multiple winners");

  const crossClaim = await Promise.allSettled([
    withSchema(dbA, name, (container) => new LoginService(container, envA)
      .register("13910000013", "AuditPass-913", 0)),
    withSchema(dbB, name, (container) => new LoginService(container, envB)
      .updatePhone(IDS.crossUpdate, "13910000013")),
  ]);
  const crossClaimed = await withSchema(dbA, name, (container) =>
    container.db.select({ uid: user.uid }).from(user)
      .where(and(eq(user.isDel, 0), eq(user.phone, "13910000013"))));
  const registrationUpdateClaimSingleWinner = crossClaim.filter(
    (result) => result.status === "fulfilled",
  ).length === 1 && crossClaimed.length === 1;
  assertCondition(
    registrationUpdateClaimSingleWinner,
    "registration/update phone claim had multiple winners",
  );

  await withSchema(dbA, name, (container) => new LoginService(container, envA)
    .bindPhone(IDS.binding, "13910000010"));
  const bound = await withSchema(dbA, name, (container) => oneUser(container, IDS.binding));
  const blankPhoneBindingExact = bound?.phone === "13910000010"
    && bound.account === "oauth-audit-user";
  assertCondition(blankPhoneBindingExact, "blank-phone binding overwrote social account identity");

  const conflictingExistingAccountsRejected = await rejectsValidation(
    () => withSchema(dbA, name, (container) => new WechatAuthService(container, envA)
      .reconcileVerifiedIdentity({
        openid: "audit-existing-openid",
        unionid: "audit-union-1",
        userType: "wechat",
        phone: "13910000015",
      })),
    "不同账号",
  );
  assertCondition(conflictingExistingAccountsRejected, "social and phone identities were silently merged");

  const concurrentSocial = await Promise.all([
    withSchema(dbA, name, (container) => new WechatAuthService(container, envA)
      .reconcileVerifiedIdentity({
        openid: "audit-concurrent-openid",
        userType: "wechat",
        nickname: "audit-social",
        phone: "13910000016",
      })),
    withSchema(dbB, name, (container) => new WechatAuthService(container, envB)
      .reconcileVerifiedIdentity({
        openid: "audit-concurrent-openid",
        userType: "wechat",
        nickname: "audit-social",
        phone: "13910000016",
      })),
  ]);
  const concurrentRows = await withSchema(dbA, name, async (container) => ({
    users: await container.db.select({ uid: user.uid, pwd: user.pwd }).from(user)
      .where(eq(user.phone, "13910000016")),
    identities: await container.db.select({ uid: wechatUser.uid }).from(wechatUser)
      .where(eq(wechatUser.openid, "audit-concurrent-openid")),
  }));
  const concurrentIdentityPhoneSingleUser = concurrentSocial[0] === concurrentSocial[1]
    && concurrentRows.users.length === 1
    && concurrentRows.identities.length === 1
    && concurrentRows.users[0]?.uid === concurrentRows.identities[0]?.uid;
  assertCondition(concurrentIdentityPhoneSingleUser, "concurrent social binding created duplicate identities");
  const randomPasswordPreserved = Boolean(concurrentRows.users[0]?.pwd)
    && concurrentRows.users[0]?.pwd !== md5("123456");
  assertCondition(randomPasswordPreserved, "social binding inherited the legacy default password");

  const unionUid = await withSchema(dbA, name, (container) =>
    new WechatAuthService(container, envA).reconcileVerifiedIdentity({
      openid: "audit-union-second-openid",
      unionid: "audit-union-1",
      userType: "routine",
      phone: "13910000017",
    }));
  const unionState = await withSchema(dbA, name, async (container) => ({
    user: await oneUser(container, IDS.socialExisting),
    identities: await container.db.select({ uid: wechatUser.uid }).from(wechatUser)
      .where(eq(wechatUser.unionid, "audit-union-1")),
  }));
  const unionidAttachesToExistingUser = unionUid === IDS.socialExisting
    && unionState.user?.phone === "13910000017"
    && unionState.identities.length === 2
    && unionState.identities.every((row) => row.uid === IDS.socialExisting);
  assertCondition(unionidAttachesToExistingUser, "unionid did not converge on the existing user");

  return {
    registration: {
      verified_boundary_required_by_controller: true,
      password_hashed: passwordHashed,
      default_password_rejected: defaultPasswordRejected,
      concurrent_duplicate_rejected: concurrentDuplicateRejected,
    },
    mobile: {
      existing_user_exact: existingUserExact,
      missing_user_created_once: missingUserCreatedOnce,
      disabled_user_rejected: disabledUserRejected,
      ambiguous_phone_rejected: ambiguousPhoneRejected,
    },
    recovery: {
      password_reset_invalidates_old_auth: passwordResetInvalidatesOldAuth,
      occupied_phone_rejected: occupiedPhoneRejected,
      account_tracks_phone_for_phone_accounts: accountTracksPhone,
      concurrent_phone_claim_single_winner: concurrentPhoneClaimSingleWinner,
      registration_update_claim_single_winner: registrationUpdateClaimSingleWinner,
      blank_phone_binding_exact: blankPhoneBindingExact,
    },
    social_binding: {
      concurrent_identity_phone_single_user: concurrentIdentityPhoneSingleUser,
      conflicting_existing_accounts_rejected: conflictingExistingAccountsRejected,
      unionid_attaches_to_existing_user: unionidAttachesToExistingUser,
      random_password_preserved: randomPasswordPreserved,
    },
  };
}

export async function runAuthPhonePostgresScenario(
  connectionString: string,
): Promise<AuthPhonePostgresReport> {
  const name = schemaName();
  const schema = identifier(name);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_auth_phone_audit_root",
  });
  const dbA = createDbFromConnectionString(connectionString, 1, {
    searchPath: name,
    applicationName: "cinashop_auth_phone_audit_a",
  });
  const dbB = createDbFromConnectionString(connectionString, 1, {
    searchPath: name,
    applicationName: "cinashop_auth_phone_audit_b",
  });
  let created = false;
  let removed = false;
  let temporarySchemasAfter = -1;
  let before: Fingerprint | undefined;
  let after: Fingerprint | undefined;
  let core: Awaited<ReturnType<typeof runCore>> | undefined;
  let serverVersion = "unknown";
  let scenarioError: unknown;
  try {
    const version = await root.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    serverVersion = version[0]?.server_version ?? "unknown";
    before = await fingerprint(root);
    await setup(root, name);
    created = true;
    core = await runCore(dbA, dbB, name);
  } catch (error) {
    scenarioError = error;
  } finally {
    try {
      if (created) {
        await root.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '20s'`;
          await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        });
      }
      const state = await root.$client<{ schema_removed: boolean; prefix_count: number }[]>`
        SELECT to_regnamespace(${name}) IS NULL AS schema_removed,
          (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_auth_phone_%')
            AS prefix_count
      `;
      removed = state[0]?.schema_removed === true;
      temporarySchemasAfter = state[0]?.prefix_count ?? -1;
      after = await fingerprint(root);
    } finally {
      await Promise.all([
        root.$client.end({ timeout: 1 }),
        dbA.$client.end({ timeout: 1 }),
        dbB.$client.end({ timeout: 1 }),
      ]);
    }
  }
  const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(removed, "temporary schema was not removed");
  assertCondition(temporarySchemasAfter === 0, "temporary auth schemas remain");
  assertCondition(publicStateUnchanged, "public business data or user sequence changed");
  if (scenarioError) throw scenarioError;
  assertCondition(core, "scenario report was not produced");
  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: temporarySchemasAfter,
    public_state_unchanged: publicStateUnchanged,
    ...core,
  };
}
