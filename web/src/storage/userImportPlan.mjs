import { createHash } from "node:crypto";
import { analyzeUserImportReadiness } from "./userImportReadiness.mjs";
import { normalizeSqliteEmail, normalizeUsername } from "../domain/userIdentity.mjs";

const PLAN_STATES = new WeakMap();
const USER_TABLES = Object.freeze([
  "users", "user_module_permissions", "user_audit_logs",
  "user_audit_log_fields", "user_activity_logs"
]);
const USER_SEQUENCE_TABLES = Object.freeze(["users", "user_audit_logs", "user_activity_logs"]);

const MIGRATIONS = Object.freeze([
  [1, "001_storage_foundation.sql", "d8aea4002c75f72c3a4a7a1e9947263d5cdd59aa7e915eb013d745066b11b574"],
  [2, "002_pack_records.sql", "3814f6d4bb752702dcc7837b89323773aa3503a37e71c189b20012b667765391"],
  [3, "003_orders_labels.sql", "3be71e29cba5122402ad155da16dcca5ea71c1226a1ad927d08e126ec7cf23ae"],
  [4, "004_users.sql", "1e9ef42d02bcb6235221d2439b6bb25f7ed031bf4ad6eebd1bde1d5c655584d8"],
  [5, "005_usernames.sql", "5c4d3e9e892ec40b5bc9fc2d213e61e890100a4b280e0a7979c478c489321b0c"]
]);

// Hashes are over SQLite's canonical sqlite_schema.sql text after migrations 001-005.
const USER_SCHEMA = new Map(Object.entries({
  "index:user_activity_logs_actor_index:user_activity_logs": "627a84cd0b32117b792777e81a84a21d3e3b76f9eeb557b6f065b2688e29ff8b",
  "index:user_activity_logs_subject_index:user_activity_logs": "d3187ef07aa8ba1c9f502cc915e784711c64aaf6dff6142a68b926c1ae8cc630",
  "index:user_audit_logs_actor_index:user_audit_logs": "0f4b7f6fb8d1c74d03c441d9f8e7edff8e7556581d7532d5d1fc2f000055fe38",
  "index:user_audit_logs_subject_index:user_audit_logs": "f729231daee7232d26029d5c8af07221d15e0fe1e541685444db26d2fc76555c",
  "index:users_username_normalized_unique:users": "1a0f898a76852f6a2ac8e471408e7fb65807998600d7bb8c303c87d69fad5f72",
  "table:user_activity_logs:user_activity_logs": "98e4e24f7a65d12235716bc2857de656f32244f14156261b0fb2e0fd03489b4d",
  "table:user_audit_log_fields:user_audit_log_fields": "ed436bda36583b764f98edefb60ed50c5647c90f5dd58b906689424744e297bc",
  "table:user_audit_logs:user_audit_logs": "9fe8eab3fc6d415e6f2728e5a88dbf835f24f20aa3c6be2e563056838d4c347a",
  "table:user_module_permissions:user_module_permissions": "b47554c26d6e7e810662bb765a64f9ac04dac28fa44c67518acae7de23385b30",
  "table:users:users": "878b3779ce8fd1cf5a4e09ea4bc0cf2fcd58c4c1c7ad24d4b2cdcf258fe2c6bd",
  "trigger:user_activity_logs_prevent_delete:user_activity_logs": "5fe303c36a02d52e959e9d0287da693191f61caca470939eea43e289d027521d",
  "trigger:user_activity_logs_prevent_update:user_activity_logs": "e93c53caf838d1f35d20d3b8bb782ff1947b365467fce51293b79646b11c2b3a",
  "trigger:user_audit_log_fields_prevent_delete:user_audit_log_fields": "dcb0a70c0c5600381376ec0c12ca2089806a7cbeb848593b192a8154c3a892ba",
  "trigger:user_audit_log_fields_prevent_update:user_audit_log_fields": "39322e384ac4fd99c93c915831af6ce6826a6ef5435db268d12a659e977ea957",
  "trigger:user_audit_logs_prevent_delete:user_audit_logs": "bb542ce9e4348e202786eb4d0687589d874214b40de212ec4b6db7daef3f06b3",
  "trigger:user_audit_logs_prevent_update:user_audit_logs": "ba3a96100a1fc98c1aad4bbd4547979865c2fca18e5e5f756202be9810edc0a3",
  "trigger:user_module_permissions_prevent_tombstone_delete:user_module_permissions": "7b41d0e9ff1817c9438544ba7486d51d0671fc1aa6ed9c41176b4aa5b6ac8cb6",
  "trigger:user_module_permissions_prevent_tombstone_insert:user_module_permissions": "d73b7cb617d626c274c10790340f1abb59c232115d30a36116cdf484c0e17c18",
  "trigger:user_module_permissions_prevent_tombstone_update:user_module_permissions": "079fffbc1cb85bcd7b4b2e8b26c3a7a8bb21681d1209208754ae331f870034a0",
  "trigger:users_prevent_identity_collision_on_insert:users": "0ffe0025ee5d5690a0db04660c50bea8d13a27a863fa45cf652c53736943c8e7",
  "trigger:users_prevent_identity_collision_on_username_assignment:users": "514f904244f513e450757f9c6107b0e5ed772a7868e4f9fef4fca3929174df94",
  "trigger:users_prevent_identity_update:users": "a3af481bbe26cc9bac187ff9f45d4a3528e8e6607fa5ad4bce80d776d20b2018",
  "trigger:users_prevent_physical_delete:users": "1720180a02bb9bf00856074d5d2fe022041c842e16172918cf33d8cbc2604787",
  "trigger:users_prevent_tombstone_mutation:users": "23ecfbfd16a9ea197311fa45e85fe207abf1730340cca00f2dc7fc9a63f7a2bc",
  "trigger:users_prevent_tombstone_username_assignment:users": "bc801b04be042a4d6b63561c0f3096f0ab4b32a699bfc3e6de4cd6eb384ebbfb",
  "trigger:users_prevent_username_change:users": "27688fa25e1bff9bf0dd35f571c2ab6c55f60806a13da5d86abac45209addd88",
  "trigger:users_require_username_on_insert:users": "b65c06a7020599539272187c7d52d44f0ca4c074f840168f240492a60d88531a"
}));

const ERROR_MESSAGES = Object.freeze({
  USERS_IMPORT_USAGE_INVALID: "Users import input is invalid.",
  USERS_IMPORT_READINESS_BLOCKED: "Users import readiness is blocked.",
  USERS_IMPORT_SCHEMA_REQUIRED: "Users import requires the approved SQLite schema.",
  USERS_IMPORT_DESTINATION_NOT_EMPTY: "Users import requires an empty Users destination.",
  USERS_IMPORT_IDENTITY_CONFLICT: "Users import identity planning failed.",
  USERS_IMPORT_PERMISSION_FAILED: "Users import permission planning failed.",
  USERS_IMPORT_CREDENTIAL_FAILED: "Users import credential planning failed.",
  USERS_IMPORT_TRANSACTION_FAILED: "Users import transaction failed safely.",
  USERS_IMPORT_ROLLBACK_FAILED: "Users import rollback failed; inspect the database before retrying.",
  USERS_IMPORT_IN_TRANSACTION_VERIFICATION_FAILED: "Users import verification failed before commit.",
  USERS_IMPORT_COMMIT_OUTCOME_UNKNOWN: "Users import commit outcome is unknown; verify before retrying.",
  USERS_IMPORT_STORED_DATA_INVALID: "Stored Users data is invalid.",
  USERS_IMPORT_INTERNAL_FAILED: "Users import failed safely."
});

class SafeUsersImportError extends Error {
  constructor(name, code, transactionState = "not-started") {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "USERS_IMPORT_INTERNAL_FAILED";
    super(ERROR_MESSAGES[safeCode]);
    this.name = name;
    this.code = safeCode;
    Object.defineProperties(this, {
      stack: { value: `${name}: ${ERROR_MESSAGES[safeCode]}`, writable: false },
      transactionState: { value: transactionState, enumerable: false, writable: false }
    });
  }
}

export class UserImportPlanError extends SafeUsersImportError {
  constructor(code) { super("UserImportPlanError", code); }
}

export class UserImportError extends SafeUsersImportError {
  constructor(code, transactionState) { super("UserImportError", code, transactionState); }
}

export class UserImportVerificationError extends SafeUsersImportError {
  constructor(code) { super("UserImportVerificationError", code); }
}

/** Build a frozen plan whose sensitive material remains module-private. */
export function createUserImportPlan(users, options) {
  try {
    const snapshot = snapshotImportInput(users, options);
    const safeOptions = copyPlanOptions(snapshot.options);
    const report = analyzeUserImportReadiness(snapshot.users, safeOptions.readiness);
    if (!report.ok) throw classifyPlanningFailure(report);
    const rows = normalizeRows(snapshot.users, safeOptions);
    const permissionCount = rows.reduce((total, row) => total + row.permissions.length, 0);
    const plan = Object.freeze({
      status: "ready",
      sourceManifestSha256: safeOptions.sourceManifestSha256,
      userCount: rows.length,
      permissionCount
    });
    PLAN_STATES.set(plan, { rows, disposed: false });
    return plan;
  } catch (error) {
    if (error instanceof UserImportPlanError) throw error;
    throw new UserImportPlanError("USERS_IMPORT_INTERNAL_FAILED");
  }
}

export function disposeUserImportPlan(plan) {
  const state = PLAN_STATES.get(plan);
  if (!state) return false;
  state.rows = null;
  state.disposed = true;
  return true;
}

/** Atomically import through a caller-owned open synchronous SQLite database. */
export function importUsers(database, plan, { now = () => new Date() } = {}) {
  const state = requirePlan(plan, UserImportError);
  requireFunction(now, UserImportError);
  requireDestination(database, { requireEmpty: true });
  const importedAt = canonicalTimestamp(now(), UserImportError);
  let transactionState = "not-started";
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionState = "active";
    requireDestination(database, { requireEmpty: true });
    insertRows(database, state.rows, importedAt);
    let verification;
    try { verification = verifyCore(database, state.rows, importedAt); }
    catch { throw new UserImportError("USERS_IMPORT_IN_TRANSACTION_VERIFICATION_FAILED", transactionState); }
    if (!verification?.ok) throw new UserImportError("USERS_IMPORT_IN_TRANSACTION_VERIFICATION_FAILED", transactionState);
    transactionState = "commit-attempted";
    try {
      database.exec("COMMIT");
      transactionState = "committed";
    } catch {
      if (database.isTransaction === true) {
        transactionState = rollback(database, "active");
        throw new UserImportError("USERS_IMPORT_TRANSACTION_FAILED", transactionState);
      }
      throw new UserImportError("USERS_IMPORT_COMMIT_OUTCOME_UNKNOWN", "outcome-unknown");
    }
    return deepFreeze({
      ok: true,
      status: "committed",
      committed: true,
      importedUserCount: state.rows.length,
      importedPermissionCount: plan.permissionCount,
      importedAt,
      verification
    });
  } catch (error) {
    if (transactionState === "active") {
      transactionState = rollback(database, transactionState);
    }
    if (error instanceof UserImportError) {
      if (error.code === "USERS_IMPORT_COMMIT_OUTCOME_UNKNOWN") throw error;
      if (transactionState === "rollback-failed") {
        throw new UserImportError("USERS_IMPORT_ROLLBACK_FAILED", transactionState);
      }
      throw new UserImportError(error.code, transactionState === "not-started" ? error.transactionState : transactionState);
    }
    if (transactionState === "rollback-failed") {
      throw new UserImportError("USERS_IMPORT_ROLLBACK_FAILED", transactionState);
    }
    throw new UserImportError("USERS_IMPORT_TRANSACTION_FAILED", transactionState);
  }
}

/** Verify through a deferred snapshot without closing the caller's database. */
export function verifyUserImport(database, plan, { importedAt } = {}) {
  const state = requirePlan(plan, UserImportVerificationError);
  requireDatabase(database, UserImportVerificationError);
  const timestamp = canonicalTimestamp(importedAt, UserImportVerificationError);
  const ownsTransaction = database.isTransaction !== true;
  try {
    if (ownsTransaction) database.exec("BEGIN DEFERRED");
    // The first main-schema read establishes the deferred transaction snapshot.
    database.prepare("SELECT COUNT(*) AS count FROM main.users").get();
    const report = verifyCore(database, state.rows, timestamp);
    if (ownsTransaction) database.exec("COMMIT");
    return report;
  } catch (error) {
    if (ownsTransaction && database.isTransaction === true) {
      try { database.exec("ROLLBACK"); } catch { /* verification remains read-only */ }
    }
    if (error instanceof UserImportVerificationError) throw error;
    throw new UserImportVerificationError("USERS_IMPORT_STORED_DATA_INVALID");
  }
}

function copyPlanOptions(options) {
  const copied = directDataRecord(options);
  const allowed = new Set(["roles", "modules", "passwordPolicy", "usernameAssignments", "sourceManifestSha256"]);
  if (!copied || copied.keys.some((key) => !allowed.has(key))
      || !/^[0-9a-f]{64}$/.test(copied.values.sourceManifestSha256 ?? "")) {
    throw new UserImportPlanError("USERS_IMPORT_USAGE_INVALID");
  }
  return {
    roles: copied.values.roles,
    modules: copied.values.modules,
    passwordPolicy: copied.values.passwordPolicy,
    usernameAssignments: copied.values.usernameAssignments ?? {},
    sourceManifestSha256: copied.values.sourceManifestSha256,
    readiness: {
      roles: copied.values.roles,
      modules: copied.values.modules,
      passwordPolicy: copied.values.passwordPolicy,
      usernameAssignments: copied.values.usernameAssignments ?? {}
    }
  };
}

/* Copy the complete caller graph before any readiness or normalization access. */
function snapshotImportInput(users, options) {
  const state = { seen: new Set(), nodes: 0, maximumNodes: 1_000_000, maximumDepth: 128 };
  const copiedUsers = snapshotValue(users, state, 0);
  const copiedOptions = snapshotValue(options, state, 0);
  if (!Array.isArray(copiedUsers) || !directDataRecord(copiedOptions)) {
    throw new UserImportPlanError("USERS_IMPORT_USAGE_INVALID");
  }
  return { users: copiedUsers, options: copiedOptions };
}

function snapshotValue(value, state, depth) {
  if (++state.nodes > state.maximumNodes || depth > state.maximumDepth) throw new UserImportPlanError("USERS_IMPORT_USAGE_INVALID");
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || state.seen.has(value)) throw new UserImportPlanError("USERS_IMPORT_USAGE_INVALID");
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)
          || lengthDescriptor.enumerable || lengthDescriptor.configurable
          || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
          || lengthDescriptor.value > state.maximumNodes) throw new Error();
      const length = lengthDescriptor.value;
      if (keys.some((key) => typeof key === "symbol") || keys.length !== length + 1) throw new Error();
      const result = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const key = String(index); const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
        result[index] = snapshotValue(descriptor.value, state, depth + 1);
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      result[key] = snapshotValue(descriptor.value, state, depth + 1);
    }
    return result;
  } finally { state.seen.delete(value); }
}

function normalizeRows(users, options) {
  const roles = new Map(options.roles.map((role) => [role.id, role]));
  return users.map((user, sourceIndex) => {
    const role = roles.get(user.roleId);
    const username = Object.hasOwn(user, "username") ? user.username : options.usernameAssignments[user.id];
    const permissionSource = Object.hasOwn(user, "modulePermissions") ? user.modulePermissions : role.modulePermissions;
    const permissionByModule = new Map(permissionSource.map((permission) => [permission.moduleId, permission]));
    return {
      sourceIndex,
      id: user.id,
      username,
      usernameNormalized: username.toLowerCase(),
      email: user.email.trim(),
      emailNormalized: user.email.trim().toLowerCase(),
      name: user.name,
      roleId: user.roleId,
      roleName: user.roleId === "custom" ? user.roleName.trim() : null,
      employeeName: user.employeeName == null ? null : user.employeeName.trim(),
      employeeId: user.employeeId == null ? null : user.employeeId.trim(),
      active: user.active ? 1 : 0,
      passwordSalt: user.passwordSalt,
      passwordHash: user.passwordHash,
      permissions: options.modules.map((module, permissionSequence) => {
        const permission = permissionByModule.get(module.id);
        return {
          userId: user.id,
          permissionSequence,
          moduleId: module.id,
          canView: permission.canView ? 1 : 0,
          canEdit: permission.canEdit ? 1 : 0
        };
      })
    };
  });
}

function classifyPlanningFailure(report) {
  const codes = new Set(report.issues.map((issue) => issue.code));
  if (codes.has("USER_CREDENTIALS_INVALID")) return new UserImportPlanError("USERS_IMPORT_CREDENTIAL_FAILED");
  if ([...codes].some((code) => code.includes("PERMISSION"))) return new UserImportPlanError("USERS_IMPORT_PERMISSION_FAILED");
  if ([...codes].some((code) => code.includes("IDENTITY") || code.includes("DUPLICATE") || code.includes("USERNAME"))) {
    return new UserImportPlanError("USERS_IMPORT_IDENTITY_CONFLICT");
  }
  return new UserImportPlanError("USERS_IMPORT_READINESS_BLOCKED");
}

function requirePlan(plan, ErrorType) {
  const state = PLAN_STATES.get(plan);
  if (!state || state.disposed || !state.rows) throw new ErrorType("USERS_IMPORT_USAGE_INVALID");
  return state;
}

function requireDestination(database, { requireEmpty }) {
  requireDatabase(database, UserImportError);
  try {
    if (Number(database.prepare("PRAGMA main.foreign_keys").get()?.foreign_keys) !== 1
        || Number(database.prepare("PRAGMA main.user_version").get()?.user_version) !== 5) {
      throw new Error();
    }
    const migrations = database.prepare(`
      SELECT version, name, checksum_sha256
      FROM main.schema_migrations
      ORDER BY version
    `).all();
    if (migrations.length !== MIGRATIONS.length || migrations.some((row, index) => (
      Number(row.version) !== MIGRATIONS[index][0]
      || row.name !== MIGRATIONS[index][1]
      || row.checksum_sha256 !== MIGRATIONS[index][2]
    ))) throw new Error();

    const schemaRows = database.prepare(`
      SELECT type, name, tbl_name, sql
      FROM main.sqlite_schema
      WHERE (name LIKE 'user%' OR tbl_name LIKE 'user%')
        AND name NOT LIKE 'sqlite_autoindex%'
      ORDER BY type, name
    `).all();
    if (schemaRows.length !== USER_SCHEMA.size) throw new Error();
    for (const row of schemaRows) {
      const key = `${row.type}:${row.name}:${row.tbl_name}`;
      const expected = USER_SCHEMA.get(key);
      const actual = typeof row.sql === "string" ? createHash("sha256").update(row.sql).digest("hex") : "";
      if (!expected || actual !== expected) throw new Error();
    }
    const tempShadows = database.prepare(`
      SELECT name FROM temp.sqlite_schema
      WHERE name IN ('users','user_module_permissions','user_audit_logs','user_audit_log_fields','user_activity_logs')
    `).all();
    if (tempShadows.length) throw new Error();
    const quick = database.prepare("PRAGMA main.quick_check").all();
    if (quick.length !== 1 || quick[0].quick_check !== "ok") throw new Error();
    if (database.prepare("PRAGMA main.foreign_key_check").all().length) throw new Error();
    if (requireEmpty) requireEmptyDestination(database);
  } catch (error) {
    if (error instanceof UserImportError) throw error;
    throw new UserImportError("USERS_IMPORT_SCHEMA_REQUIRED", "not-started");
  }
}

function requireEmptyDestination(database) {
  for (const table of USER_TABLES) {
    if (Number(database.prepare(`SELECT COUNT(*) AS count FROM main.${table}`).get()?.count) !== 0) {
      throw new UserImportError("USERS_IMPORT_DESTINATION_NOT_EMPTY", "not-started");
    }
  }
  const sequences = database.prepare(`
    SELECT name FROM main.sqlite_sequence
    WHERE name IN ('users','user_audit_logs','user_activity_logs')
  `).all();
  if (sequences.length) throw new UserImportError("USERS_IMPORT_DESTINATION_NOT_EMPTY", "not-started");
}

function insertRows(database, rows, importedAt) {
  const insertUser = database.prepare(`
    INSERT INTO main.users (
      user_sequence,id,username,email,name,role_id,role_name,employee_name,employee_id,
      active,password_salt,password_hash,created_at,updated_at,deleted_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
  `);
  const insertPermission = database.prepare(`
    INSERT INTO main.user_module_permissions (
      user_id,permission_sequence,module_id,can_view,can_edit
    ) VALUES (?,?,?,?,?)
  `);
  for (const row of rows) {
    insertUser.run(
      row.sourceIndex + 1, row.id, row.username, row.email, row.name, row.roleId,
      row.roleName, row.employeeName, row.employeeId, row.active, row.passwordSalt,
      row.passwordHash, importedAt, importedAt
    );
    for (const permission of row.permissions) {
      insertPermission.run(
        permission.userId, permission.permissionSequence, permission.moduleId,
        permission.canView, permission.canEdit
      );
    }
  }
}

function verifyCore(database, expectedRows, importedAt) {
  requireDatabase(database, UserImportVerificationError);
  const storedUsers = database.prepare(`
    SELECT user_sequence,id,username,username_normalized,email,email_normalized,name,
      role_id,role_name,employee_name,employee_id,active,password_salt,password_hash,
      created_at,updated_at,deleted_at
    FROM main.users ORDER BY user_sequence
  `).all();
  const storedPermissions = database.prepare(`
    SELECT user_id,permission_sequence,module_id,can_view,can_edit
    FROM main.user_module_permissions ORDER BY user_id,permission_sequence
  `).all();
  const expectedPermissions = expectedRows.flatMap((row) => row.permissions)
    .sort((left, right) => left.userId.localeCompare(right.userId) || left.permissionSequence - right.permissionSequence);
  const auditRowCount = countRows(database, "user_audit_logs");
  const auditFieldRowCount = countRows(database, "user_audit_log_fields");
  const activityRowCount = countRows(database, "user_activity_logs");
  const issues = [];
  let storedInvalid = false;
  let verifiedUserCount = 0;
  for (const row of storedUsers) {
    if (!validStoredUser(row)) storedInvalid = true;
  }
  for (const row of storedPermissions) {
    if (!validStoredPermission(row)) storedInvalid = true;
  }
  if (storedUsers.length !== expectedRows.length) issues.push("USER_COUNT_MISMATCH");
  if (storedPermissions.length !== expectedPermissions.length) issues.push("PERMISSION_COUNT_MISMATCH");
  for (let index = 0; index < expectedRows.length; index += 1) {
    const actual = storedUsers[index];
    const expected = expectedRows[index];
    if (actual && equalUser(actual, expected, importedAt)) verifiedUserCount += 1;
    else issues.push("USER_ROW_MISMATCH");
  }
  for (let index = 0; index < expectedPermissions.length; index += 1) {
    if (!storedPermissions[index] || !equalPermission(storedPermissions[index], expectedPermissions[index])) {
      issues.push("PERMISSION_ROW_MISMATCH");
    }
  }
  if (auditRowCount || auditFieldRowCount || activityRowCount) issues.push("AUDIT_ACTIVITY_NOT_EMPTY");
  const sequenceRows = database.prepare(`
    SELECT name, seq FROM main.sqlite_sequence
    WHERE name IN ('users','user_audit_logs','user_activity_logs') ORDER BY name
  `).all();
  if (sequenceRows.length !== 1 || sequenceRows[0].name !== "users"
      || Number(sequenceRows[0].seq) !== expectedRows.length) issues.push("SEQUENCE_MISMATCH");
  const quick = database.prepare("PRAGMA main.quick_check").all();
  const quickCheckStatus = quick.length === 1 && quick[0].quick_check === "ok" ? "ok" : "failed";
  const foreignKeyViolationCount = database.prepare("PRAGMA main.foreign_key_check").all().length;
  if (quickCheckStatus !== "ok") { issues.push("QUICK_CHECK_FAILED"); storedInvalid = true; }
  if (foreignKeyViolationCount) { issues.push("FOREIGN_KEY_VIOLATION"); storedInvalid = true; }
  const status = storedInvalid ? "stored-data-invalid" : issues.length ? "mismatch" : "verified";
  return deepFreeze({
    ok: status === "verified",
    status,
    expectedUserCount: expectedRows.length,
    actualUserCount: storedUsers.length,
    expectedPermissionCount: expectedPermissions.length,
    actualPermissionCount: storedPermissions.length,
    verifiedUserCount,
    mismatchedUserCount: expectedRows.length - verifiedUserCount,
    auditRowCount,
    auditFieldRowCount,
    activityRowCount,
    issueCodeCounts: countIssueCodes(issues),
    quickCheckStatus,
    foreignKeyViolationCount,
    importedAt
  });
}

function equalUser(actual, expected, importedAt) {
  return Number(actual.user_sequence) === expected.sourceIndex + 1
    && actual.id === expected.id
    && actual.username === expected.username
    && actual.username_normalized === expected.usernameNormalized
    && actual.email === expected.email
    && actual.email_normalized === expected.emailNormalized
    && actual.name === expected.name
    && actual.role_id === expected.roleId
    && actual.role_name === expected.roleName
    && actual.employee_name === expected.employeeName
    && actual.employee_id === expected.employeeId
    && Number(actual.active) === expected.active
    && actual.password_salt === expected.passwordSalt
    && actual.password_hash === expected.passwordHash
    && actual.created_at === importedAt
    && actual.updated_at === importedAt
    && actual.deleted_at === null;
}

function equalPermission(actual, expected) {
  return actual.user_id === expected.userId
    && Number(actual.permission_sequence) === expected.permissionSequence
    && actual.module_id === expected.moduleId
    && Number(actual.can_view) === expected.canView
    && Number(actual.can_edit) === expected.canEdit;
}

function validStoredUser(row) {
  return Number.isSafeInteger(Number(row.user_sequence)) && Number(row.user_sequence) > 0
    && typeof row.id === "string" && /^USR-[A-Z0-9-]{1,60}$/.test(row.id)
    && validStoredUsername(row.username, row.username_normalized)
    && validStoredEmail(row.email, row.email_normalized)
    && requiredStoredText(row.name, 200)
    && validIdentifier(row.role_id)
    && ((row.role_id === "custom" && requiredStoredText(row.role_name, 200))
      || (row.role_id !== "custom" && row.role_name === null))
    && optionalStoredText(row.employee_name, 200) && optionalStoredText(row.employee_id, 128)
    && (Number(row.active) === 0 || Number(row.active) === 1)
    && typeof row.password_salt === "string"
    && /^[\x20-\x7e]{1,512}$/.test(row.password_salt)
    && typeof row.password_hash === "string" && /^[0-9a-f]{64}$/.test(row.password_hash)
    && isCanonicalTimestamp(row.created_at) && isCanonicalTimestamp(row.updated_at)
    && row.updated_at >= row.created_at
    && (row.deleted_at === null || (Number(row.active) === 0
      && isCanonicalTimestamp(row.deleted_at)
      && row.deleted_at >= row.created_at
      && row.updated_at >= row.deleted_at));
}

function validStoredUsername(username, normalized) {
  try {
    const value = normalizeUsername(username);
    return username === username.trim() && value.username === username
      && value.usernameNormalized === normalized;
  } catch { return false; }
}

function validStoredEmail(email, normalized) {
  if (typeof email !== "string" || email !== email.trim()) return false;
  if (!email.includes("@")) {
    return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(email)
      && !email.startsWith(".") && !email.endsWith(".") && !email.includes("..")
      && normalized === email.toLowerCase();
  }
  try {
    const value = normalizeSqliteEmail(email);
    return value.email === email && value.emailNormalized === normalized;
  } catch { return false; }
}

function validStoredPermission(row) {
  return typeof row.user_id === "string" && /^USR-[A-Z0-9-]{1,60}$/.test(row.user_id)
    && Number.isSafeInteger(Number(row.permission_sequence)) && Number(row.permission_sequence) >= 0
    && validIdentifier(row.module_id)
    && (Number(row.can_view) === 0 || Number(row.can_view) === 1)
    && (Number(row.can_edit) === 0 || Number(row.can_edit) === 1)
    && (Number(row.can_edit) === 0 || Number(row.can_view) === 1);
}

function rollback(database, state) {
  if (state !== "active" || database.isTransaction !== true) return "rolled-back";
  try { database.exec("ROLLBACK"); return "rolled-back"; }
  catch { return "rollback-failed"; }
}

function requireDatabase(database, ErrorType) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw new ErrorType("USERS_IMPORT_SCHEMA_REQUIRED");
  }
}

function requireFunction(value, ErrorType) {
  if (typeof value !== "function") throw new ErrorType("USERS_IMPORT_USAGE_INVALID");
}

function canonicalTimestamp(value, ErrorType) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ErrorType("USERS_IMPORT_USAGE_INVALID");
  const result = date.toISOString();
  if (!isCanonicalTimestamp(result)) throw new ErrorType("USERS_IMPORT_USAGE_INVALID");
  return result;
}

function isCanonicalTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value;
}

function validIdentifier(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value); }
function requiredStoredText(value, maximumLength) { return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= maximumLength && !/[\u0000-\u001f\u007f]/.test(value); }
function optionalStoredText(value, maximumLength) { return value === null || requiredStoredText(value, maximumLength); }
function countRows(database, table) { return Number(database.prepare(`SELECT COUNT(*) AS count FROM main.${table}`).get()?.count); }
function countIssueCodes(issues) { return [...new Set(issues)].sort().map((code) => ({ code, count: issues.filter((value) => value === code).length })); }
function isPlainRecord(value) { if (!value || Array.isArray(value) || typeof value !== "object") return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function directDataRecord(value) {
  try {
    if (!isPlainRecord(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string" || !("value" in descriptors[key]))) return null;
    const values = Object.create(null);
    for (const key of keys) values[key] = descriptors[key].value;
    return { keys, values };
  } catch { return null; }
}
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
