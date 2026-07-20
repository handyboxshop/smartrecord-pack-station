import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { analyzeUserImportReadiness } from "./userImportReadiness.mjs";
import { normalizeSqliteEmail, normalizeUsername } from "../domain/userIdentity.mjs";

const PLAN_STATES = new WeakMap();
const PLAN_OPERATION = Symbol.for("smartrecord.userLegacyBackfill.operation.v1");
const MAX_NODES = 1_000_000;
const MAX_DEPTH = 128;
const MIGRATIONS = Object.freeze([
  [1, "001_storage_foundation.sql", "d8aea4002c75f72c3a4a7a1e9947263d5cdd59aa7e915eb013d745066b11b574"],
  [2, "002_pack_records.sql", "3814f6d4bb752702dcc7837b89323773aa3503a37e71c189b20012b667765391"],
  [3, "003_orders_labels.sql", "3be71e29cba5122402ad155da16dcca5ea71c1226a1ad927d08e126ec7cf23ae"],
  [4, "004_users.sql", "1e9ef42d02bcb6235221d2439b6bb25f7ed031bf4ad6eebd1bde1d5c655584d8"],
  [5, "005_usernames.sql", "5c4d3e9e892ec40b5bc9fc2d213e61e890100a4b280e0a7979c478c489321b0c"]
]);
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
const CRITICAL_SCHEMA_NAMES = new Set([
  "schema_migrations",
  ...[...USER_SCHEMA.keys()].flatMap((key) => {
    const [, name, table] = key.split(":");
    return [name, table];
  })
]);
const ERROR_MESSAGES = Object.freeze({
  USERS_BACKFILL_SCHEMA_REQUIRED: "Legacy Users backfill requires the approved SQLite schema.",
  USERS_BACKFILL_DATABASE_POLICY_FAILED: "Legacy Users backfill database policy validation failed.",
  USERS_BACKFILL_PLAN_INVALID: "Legacy Users backfill plan is invalid.",
  USERS_BACKFILL_DATABASE_CHANGED: "Legacy Users backfill database changed.",
  USERS_BACKFILL_TRANSACTION_FAILED: "Legacy Users backfill transaction failed safely.",
  USERS_BACKFILL_ROLLBACK_FAILED: "Legacy Users backfill rollback failed; inspect the database before retrying.",
  USERS_BACKFILL_COMMIT_OUTCOME_UNKNOWN: "Legacy Users backfill commit outcome is unknown; verify before retrying.",
  USERS_BACKFILL_STORED_DATA_INVALID: "Stored Users data is invalid.",
  USERS_BACKFILL_INTERNAL_FAILED: "Legacy Users backfill failed safely."
});

class SafeBackfillError extends Error {
  constructor(name, code, transactionState = "not-started") {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "USERS_BACKFILL_INTERNAL_FAILED";
    super(ERROR_MESSAGES[safeCode]);
    this.name = name;
    this.code = safeCode;
    Object.defineProperties(this, {
      stack: { value: `${name}: ${ERROR_MESSAGES[safeCode]}`, writable: false },
      transactionState: { value: transactionState, enumerable: false, writable: false }
    });
    Object.freeze(this);
  }
}

export class UserLegacyBackfillPlanError extends SafeBackfillError {
  constructor(code) { super("UserLegacyBackfillPlanError", code); }
}
class InternalUserLegacyBackfillError extends SafeBackfillError {
  constructor(code, transactionState) { super("UserLegacyBackfillError", code, transactionState); }
}
class InternalUserLegacyBackfillVerificationError extends SafeBackfillError {
  constructor(code) { super("UserLegacyBackfillVerificationError", code); }
}
const PLAN_PROTOTYPE = Object.freeze(Object.defineProperty({}, PLAN_OPERATION, {
  value(operation, database) { return executeUserLegacyBackfill(operation, database, this); }
}));

/**
 * Build an opaque aggregate plan for an exact schema-v5 legacy Users database.
 * @param {unknown} users Parsed synthetic Users source matching the Phase B/C1 contract.
 * @param {object} options Validated configuration, username map, and manifest expectation.
 * @param {object} database Open caller-owned SQLite handle; this function never closes it.
 * @returns {object} A deeply frozen, bounded, JSON-safe aggregate plan.
 * @throws {UserLegacyBackfillPlanError} A sanitized error with no raw source or SQLite detail.
 */
export function createUserLegacyBackfillPlan(users, options, database) {
  try {
    requireDatabase(database, UserLegacyBackfillPlanError);
    const source = snapshotInputs(users, options);
    const safeOptions = validateOptions(source.options);
    attestDatabase(database, UserLegacyBackfillPlanError);
    const readiness = analyzeUserImportReadiness(source.users, {
      roles: safeOptions.roles, modules: safeOptions.modules,
      passwordPolicy: safeOptions.passwordPolicy,
      usernameAssignments: safeOptions.usernameAssignments
    });
    if (!readiness.ok) throw new UserLegacyBackfillPlanError("USERS_BACKFILL_PLAN_INVALID");
    const expected = normalizeExpectedRows(source.users, safeOptions);
    const captured = captureDatabase(database, expected, UserLegacyBackfillPlanError);
    if (captured.invalid) throw new UserLegacyBackfillPlanError("USERS_BACKFILL_STORED_DATA_INVALID");
    if (captured.issues.length) throw new UserLegacyBackfillPlanError("USERS_BACKFILL_PLAN_INVALID");
    const required = captured.users.filter((row) => row.username === null);
    if (required.some((row) => row.deleted_at !== null)) {
      throw new UserLegacyBackfillPlanError("USERS_BACKFILL_PLAN_INVALID");
    }
    const plan = Object.create(PLAN_PROTOTYPE);
    Object.assign(plan, {
      status: required.length ? "ready" : "already-complete",
      sourceManifestSha256: safeOptions.sourceManifestSha256,
      userCount: expected.length,
      permissionCount: expected.reduce((sum, row) => sum + row.permissions.length, 0),
      requiredBackfillCount: required.length,
      alreadyAssignedCount: expected.length - required.length
    });
    deepFreeze(plan);
    PLAN_STATES.set(plan, {
      disposed: false,
      originalUsers: users,
      originalOptions: options,
      sourceDigest: hash(source),
      sourceManifestSha256: safeOptions.sourceManifestSha256,
      expected,
      protectedDigest: captured.protectedDigest,
      usernameDigest: captured.usernameDigest,
      fileIdentity: databaseFileIdentity(database)
    });
    return plan;
  } catch (error) {
    if (error instanceof UserLegacyBackfillPlanError) throw error;
    throw new UserLegacyBackfillPlanError("USERS_BACKFILL_INTERNAL_FAILED");
  }
}

/** Wipe a recognized plan's private state. Repeated disposal returns true. */
export function disposeUserLegacyBackfillPlan(plan) {
  const state = PLAN_STATES.get(plan);
  if (!state) return false;
  state.expected = null;
  state.originalUsers = null;
  state.originalOptions = null;
  state.sourceDigest = null;
  state.sourceManifestSha256 = null;
  state.protectedDigest = null;
  state.usernameDigest = null;
  state.fileIdentity = null;
  state.disposed = true;
  return true;
}

/* Internal operation gateway: never returns or exposes private rows. */
function executeUserLegacyBackfill(operation, database, plan) {
  const ErrorType = operation === "verify" ? InternalUserLegacyBackfillVerificationError : InternalUserLegacyBackfillError;
  const state = PLAN_STATES.get(plan);
  if (!state || state.disposed || !state.expected) throw new ErrorType("USERS_BACKFILL_PLAN_INVALID");
  requireDatabase(database, ErrorType);
  if (operation === "verify") return verifyDeferred(database, plan, state);
  if (operation === "backfill") return performBackfill(database, plan, state);
  throw new ErrorType("USERS_BACKFILL_PLAN_INVALID");
}

function performBackfill(database, plan, state) {
  revalidateSource(state, plan, InternalUserLegacyBackfillError);
  revalidateFileIdentity(database, state, InternalUserLegacyBackfillError);
  if (plan.status === "already-complete") {
    const report = verifyDeferred(database, plan, state);
    if (!["verified", "already-complete"].includes(report.status)) {
      throw new InternalUserLegacyBackfillError(report.status === "stored-data-invalid"
        ? "USERS_BACKFILL_STORED_DATA_INVALID" : "USERS_BACKFILL_DATABASE_CHANGED");
    }
    return deepFreeze({ status: "already-complete", committed: false,
      userCount: plan.userCount, requiredBackfillCount: 0, backfilledCount: 0 });
  }
  let transactionState = "not-started";
  try {
    requireUnchangedDatabase(database, state, plan, InternalUserLegacyBackfillError);
    database.exec("BEGIN IMMEDIATE");
    transactionState = "active";
    const before = requireUnchangedDatabase(database, state, plan, InternalUserLegacyBackfillError, transactionState);
    const update = database.prepare(`
      UPDATE main.users SET username = ?
      WHERE user_sequence = ? AND id = ?
        AND username IS NULL AND username_normalized IS NULL AND deleted_at IS NULL
    `);
    let changed = 0;
    for (let index = 0; index < before.users.length; index += 1) {
      const actual = before.users[index];
      if (actual.username !== null) continue;
      const expected = state.expected[index];
      const result = update.run(expected.username, actual.user_sequence, actual.id);
      if (Number(result?.changes) !== 1) {
        throw new InternalUserLegacyBackfillError("USERS_BACKFILL_DATABASE_CHANGED", transactionState);
      }
      changed += 1;
    }
    if (changed !== plan.requiredBackfillCount) {
      throw new InternalUserLegacyBackfillError("USERS_BACKFILL_DATABASE_CHANGED", transactionState);
    }
    const after = captureDatabase(database, state.expected, InternalUserLegacyBackfillError);
    if (after.invalid || after.issues.length || after.protectedDigest !== state.protectedDigest
        || after.users.some((row, index) => row.username !== state.expected[index].username
          || row.username_normalized !== state.expected[index].usernameNormalized)) {
      throw new InternalUserLegacyBackfillError(after.invalid
        ? "USERS_BACKFILL_STORED_DATA_INVALID" : "USERS_BACKFILL_DATABASE_CHANGED", transactionState);
    }
    transactionState = "commit-attempted";
    try {
      database.exec("COMMIT");
      transactionState = "committed";
    } catch {
      if (database.isTransaction === true) {
        transactionState = rollback(database);
        throw new InternalUserLegacyBackfillError("USERS_BACKFILL_TRANSACTION_FAILED", transactionState);
      }
      throw new InternalUserLegacyBackfillError("USERS_BACKFILL_COMMIT_OUTCOME_UNKNOWN", "outcome-unknown");
    }
    return deepFreeze({ status: "backfilled", committed: true,
      userCount: plan.userCount, requiredBackfillCount: plan.requiredBackfillCount,
      backfilledCount: plan.requiredBackfillCount });
  } catch (error) {
    if (transactionState === "active") transactionState = rollback(database);
    if (transactionState === "rollback-failed") {
      throw new InternalUserLegacyBackfillError("USERS_BACKFILL_ROLLBACK_FAILED", transactionState);
    }
    if (error instanceof InternalUserLegacyBackfillError) {
      if (error.code === "USERS_BACKFILL_COMMIT_OUTCOME_UNKNOWN") throw error;
      throw new InternalUserLegacyBackfillError(error.code, transactionState === "not-started"
        ? error.transactionState : transactionState);
    }
    throw new InternalUserLegacyBackfillError("USERS_BACKFILL_TRANSACTION_FAILED", transactionState);
  }
}

function verifyDeferred(database, plan, state) {
  const ownsTransaction = database.isTransaction !== true;
  try {
    if (ownsTransaction) database.exec("BEGIN DEFERRED");
    database.prepare("SELECT COUNT(*) AS count FROM main.users").get();
    revalidateSource(state, plan, InternalUserLegacyBackfillVerificationError);
    attestDatabase(database, InternalUserLegacyBackfillVerificationError);
    revalidateFileIdentity(database, state, InternalUserLegacyBackfillVerificationError);
    const captured = captureDatabase(database, state.expected, InternalUserLegacyBackfillVerificationError);
    const issues = [...captured.issues];
    if (captured.protectedDigest !== state.protectedDigest) issues.push("PROTECTED_DATA_CHANGED");
    let verifiedUserCount = 0;
    for (let index = 0; index < state.expected.length; index += 1) {
      const actual = captured.users[index];
      const expected = state.expected[index];
      if (actual?.username === expected.username
          && actual?.username_normalized === expected.usernameNormalized) verifiedUserCount += 1;
      else issues.push("USERNAME_MISMATCH");
    }
    if (ownsTransaction) database.exec("COMMIT");
    const complete = verifiedUserCount === state.expected.length && issues.length === 0;
    const status = captured.invalid ? "stored-data-invalid" : complete
      ? (plan.status === "already-complete" ? "already-complete" : "verified") : "mismatch";
    return deepFreeze({ status, expectedUserCount: state.expected.length,
      actualUserCount: captured.users.length, verifiedUserCount,
      mismatchedUserCount: Math.max(0, state.expected.length - verifiedUserCount),
      issueCodeCounts: countCodes(issues) });
  } catch (error) {
    if (ownsTransaction && database.isTransaction === true) {
      try { database.exec("ROLLBACK"); } catch { /* read-only cleanup */ }
    }
    if (error instanceof InternalUserLegacyBackfillVerificationError) throw error;
    throw new InternalUserLegacyBackfillVerificationError("USERS_BACKFILL_STORED_DATA_INVALID");
  }
}

function captureDatabase(database, expected, ErrorType) {
  try {
    const users = database.prepare(`
      SELECT user_sequence,id,username,username_normalized,email,email_normalized,name,
        role_id,role_name,employee_name,employee_id,active,password_salt,password_hash,
        created_at,updated_at,deleted_at
      FROM main.users ORDER BY user_sequence
    `).all().map(plainRow);
    const permissions = database.prepare(`
      SELECT user_id,permission_sequence,module_id,can_view,can_edit
      FROM main.user_module_permissions ORDER BY user_id,permission_sequence
    `).all().map(plainRow);
    const auditLogs = database.prepare(`
      SELECT audit_sequence,event_code,actor_user_id,subject_user_id,at
      FROM main.user_audit_logs ORDER BY audit_sequence
    `).all().map(plainRow);
    const auditFields = database.prepare(`
      SELECT audit_sequence,field_sequence,field_name
      FROM main.user_audit_log_fields ORDER BY audit_sequence,field_sequence
    `).all().map(plainRow);
    const activityLogs = database.prepare(`
      SELECT activity_sequence,event_code,actor_user_id,subject_user_id,module_id,at
      FROM main.user_activity_logs ORDER BY activity_sequence
    `).all().map(plainRow);
    const sequences = database.prepare(`
      SELECT name,seq FROM main.sqlite_sequence
      WHERE name IN ('users','user_audit_logs','user_activity_logs') ORDER BY name
    `).all().map(plainRow);
    const issues = compareStored(users, permissions, expected);
    const invalid = users.some((row) => !validStoredUser(row))
      || permissions.some((row) => !validStoredPermission(row))
      || auditLogs.some((row) => !validAuditLog(row))
      || auditFields.some((row) => !validAuditField(row))
      || activityLogs.some((row) => !validActivityLog(row))
      || !validSequences(sequences, { users, auditLogs, activityLogs });
    const protectedUsers = users.map(({ username, username_normalized, ...row }) => row);
    return {
      users, issues, invalid,
      protectedDigest: hash({ users: protectedUsers, permissions, auditLogs, auditFields, activityLogs, sequences }),
      usernameDigest: hash(users.map(({ user_sequence, id, username, username_normalized, deleted_at }) => (
        { user_sequence, id, username, username_normalized, deleted_at }
      )))
    };
  } catch (error) {
    if (error instanceof ErrorType) throw error;
    throw new ErrorType("USERS_BACKFILL_STORED_DATA_INVALID");
  }
}

function compareStored(users, permissions, expected) {
  const issues = [];
  if (users.length !== expected.length) issues.push("USER_COUNT_MISMATCH");
  const expectedPermissions = expected.flatMap((row) => row.permissions)
    .sort((a, b) => a.userId.localeCompare(b.userId) || a.permissionSequence - b.permissionSequence);
  if (permissions.length !== expectedPermissions.length) issues.push("PERMISSION_COUNT_MISMATCH");
  for (let index = 0; index < expected.length; index += 1) {
    const a = users[index]; const e = expected[index];
    if (!a) { issues.push("USER_ROW_MISMATCH"); continue; }
    if (Number(a.user_sequence) !== index + 1 || a.id !== e.id
        || a.email !== e.email || a.email_normalized !== e.emailNormalized
        || a.name !== e.name || a.role_id !== e.roleId || a.role_name !== e.roleName
        || a.employee_name !== e.employeeName || a.employee_id !== e.employeeId
        || Number(a.active) !== e.active || a.password_salt !== e.passwordSalt
        || a.password_hash !== e.passwordHash) issues.push("USER_ROW_MISMATCH");
    if (a?.username !== null && (a.username !== e.username
        || a.username_normalized !== e.usernameNormalized)) issues.push("ASSIGNED_USERNAME_MISMATCH");
  }
  for (let index = 0; index < expectedPermissions.length; index += 1) {
    const a = permissions[index]; const e = expectedPermissions[index];
    if (!a || a.user_id !== e.userId || Number(a.permission_sequence) !== e.permissionSequence
        || a.module_id !== e.moduleId || Number(a.can_view) !== e.canView
        || Number(a.can_edit) !== e.canEdit) issues.push("PERMISSION_ROW_MISMATCH");
  }
  return issues;
}

function attestDatabase(database, ErrorType) {
  try {
    if (Number(database.prepare("PRAGMA main.foreign_keys").get()?.foreign_keys) !== 1
        || Number(database.prepare("PRAGMA main.user_version").get()?.user_version) !== 5) throw new Error();
    const migrations = database.prepare(`SELECT version,name,checksum_sha256
      FROM main.schema_migrations ORDER BY version`).all();
    if (migrations.length !== MIGRATIONS.length || migrations.some((row, index) => (
      Number(row.version) !== MIGRATIONS[index][0] || row.name !== MIGRATIONS[index][1]
      || row.checksum_sha256 !== MIGRATIONS[index][2]))) throw new Error();
    const schemaRows = database.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_schema
      WHERE (name LIKE 'user%' OR tbl_name LIKE 'user%') AND name NOT LIKE 'sqlite_autoindex%'
      ORDER BY type,name`).all();
    if (schemaRows.length !== USER_SCHEMA.size) throw new Error();
    for (const row of schemaRows) {
      const expected = USER_SCHEMA.get(`${row.type}:${row.name}:${row.tbl_name}`);
      const actual = typeof row.sql === "string" ? createHash("sha256").update(row.sql).digest("hex") : "";
      if (!expected || actual !== expected) throw new Error();
    }
    const tempRows = database.prepare("SELECT name,tbl_name FROM temp.sqlite_schema").all();
    if (tempRows.some((row) => CRITICAL_SCHEMA_NAMES.has(row.name)
        || CRITICAL_SCHEMA_NAMES.has(row.tbl_name))) throw new Error();
    const quick = database.prepare("PRAGMA main.quick_check").all();
    if (quick.length !== 1 || quick[0].quick_check !== "ok"
        || database.prepare("PRAGMA main.foreign_key_check").all().length) throw new Error();
  } catch {
    throw new ErrorType("USERS_BACKFILL_SCHEMA_REQUIRED");
  }
}

function normalizeExpectedRows(users, options) {
  const roles = new Map(options.roles.map((role) => [role.id, role]));
  return users.map((user, index) => {
    const role = roles.get(user.roleId);
    const username = Object.hasOwn(user, "username") ? user.username : options.usernameAssignments[user.id];
    const permissionSource = Object.hasOwn(user, "modulePermissions") ? user.modulePermissions : role.modulePermissions;
    const byModule = new Map(permissionSource.map((permission) => [permission.moduleId, permission]));
    return {
      id: user.id, username, usernameNormalized: username.toLowerCase(),
      email: user.email.trim(), emailNormalized: user.email.trim().toLowerCase(), name: user.name,
      roleId: user.roleId, roleName: user.roleId === "custom" ? user.roleName.trim() : null,
      employeeName: user.employeeName == null ? null : user.employeeName.trim(),
      employeeId: user.employeeId == null ? null : user.employeeId.trim(), active: user.active ? 1 : 0,
      passwordSalt: user.passwordSalt, passwordHash: user.passwordHash,
      permissions: options.modules.map((module, permissionSequence) => {
        const permission = byModule.get(module.id);
        return { userId: user.id, permissionSequence, moduleId: module.id,
          canView: permission.canView ? 1 : 0, canEdit: permission.canEdit ? 1 : 0 };
      }), sourceIndex: index
    };
  });
}

function snapshotInputs(users, options) {
  const state = { seen: new Set(), nodes: 0 };
  const copiedUsers = snapshotValue(users, state, 0);
  const copiedOptions = snapshotValue(options, state, 0);
  if (!Array.isArray(copiedUsers) || !plainRecord(copiedOptions)) {
    throw new UserLegacyBackfillPlanError("USERS_BACKFILL_PLAN_INVALID");
  }
  return { users: copiedUsers, options: copiedOptions };
}

function snapshotValue(value, state, depth) {
  if (++state.nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error();
  if (value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (!value || typeof value !== "object" || state.seen.has(value)) throw new Error();
  state.seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
      const length = descriptors.length?.value;
      const keys = Reflect.ownKeys(descriptors);
      if (!Number.isSafeInteger(length) || length < 0 || keys.some((key) => typeof key === "symbol")
          || keys.length !== length + 1) throw new Error();
      const result = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
        result[index] = snapshotValue(descriptor.value, state, depth + 1);
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      result[key] = snapshotValue(descriptor.value, state, depth + 1);
    }
    return result;
  } finally { state.seen.delete(value); }
}

function validateOptions(options) {
  const allowed = new Set(["roles", "modules", "passwordPolicy", "usernameAssignments", "sourceManifestSha256"]);
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
      || keys.length !== 5 || !Array.isArray(options.roles) || !Array.isArray(options.modules)
      || !plainRecord(options.usernameAssignments)
      || !/^[0-9a-f]{64}$/.test(options.sourceManifestSha256 ?? "")) {
    throw new UserLegacyBackfillPlanError("USERS_BACKFILL_PLAN_INVALID");
  }
  return options;
}

function revalidateSource(state, plan, ErrorType) {
  try {
    const current = snapshotInputs(state.originalUsers, state.originalOptions);
    if (hash(current) !== state.sourceDigest
        || plan.sourceManifestSha256 !== state.sourceManifestSha256
        || current.options.sourceManifestSha256 !== state.sourceManifestSha256) throw new Error();
  } catch { throw new ErrorType("USERS_BACKFILL_PLAN_INVALID"); }
}

function requireUnchangedDatabase(database, state, plan, ErrorType, transactionState = "not-started") {
  revalidateSource(state, plan, ErrorType);
  attestDatabase(database, ErrorType);
  revalidateFileIdentity(database, state, ErrorType);
  const captured = captureDatabase(database, state.expected, ErrorType);
  if (captured.invalid) throw new ErrorType("USERS_BACKFILL_STORED_DATA_INVALID", transactionState);
  if (captured.issues.length || captured.protectedDigest !== state.protectedDigest
      || captured.usernameDigest !== state.usernameDigest) {
    throw new ErrorType("USERS_BACKFILL_DATABASE_CHANGED", transactionState);
  }
  return captured;
}

function databaseFileIdentity(database) {
  const file = database.prepare("PRAGMA main.database_list").all()
    .find((row) => row.name === "main")?.file;
  if (!file) return null;
  const stat = statSync(file);
  return { file, dev: stat.dev, ino: stat.ino };
}
function revalidateFileIdentity(database, state, ErrorType) {
  try {
    const current = databaseFileIdentity(database);
    if ((current === null) !== (state.fileIdentity === null)
        || (current && (current.file !== state.fileIdentity.file || current.dev !== state.fileIdentity.dev
          || current.ino !== state.fileIdentity.ino))) throw new Error();
  } catch { throw new ErrorType("USERS_BACKFILL_DATABASE_CHANGED"); }
}

function validStoredUser(row) {
  return Number.isSafeInteger(Number(row.user_sequence)) && Number(row.user_sequence) > 0
    && typeof row.id === "string" && /^USR-[A-Z0-9-]{1,60}$/.test(row.id)
    && (row.username === null ? row.username_normalized === null : validUsername(row.username, row.username_normalized))
    && validEmail(row.email, row.email_normalized) && requiredText(row.name, 200)
    && identifier(row.role_id) && ((row.role_id === "custom" && requiredText(row.role_name, 200))
      || (row.role_id !== "custom" && row.role_name === null))
    && optionalText(row.employee_name, 200) && optionalText(row.employee_id, 128)
    && [0, 1].includes(Number(row.active)) && typeof row.password_salt === "string"
    && /^[\x20-\x7e]{1,512}$/.test(row.password_salt)
    && typeof row.password_hash === "string" && /^[0-9a-f]{64}$/.test(row.password_hash)
    && timestamp(row.created_at) && timestamp(row.updated_at) && row.updated_at >= row.created_at
    && (row.deleted_at === null || (Number(row.active) === 0 && timestamp(row.deleted_at)
      && row.deleted_at >= row.created_at && row.updated_at >= row.deleted_at));
}
function validStoredPermission(row) {
  return typeof row.user_id === "string" && /^USR-[A-Z0-9-]{1,60}$/.test(row.user_id)
    && Number.isSafeInteger(Number(row.permission_sequence)) && Number(row.permission_sequence) >= 0
    && identifier(row.module_id) && [0, 1].includes(Number(row.can_view))
    && [0, 1].includes(Number(row.can_edit)) && (Number(row.can_edit) === 0 || Number(row.can_view) === 1);
}
function validAuditLog(row) {
  return positiveInteger(row.audit_sequence)
    && ["create_user", "update_user", "update_permission", "delete_user"].includes(row.event_code)
    && userId(row.actor_user_id) && userId(row.subject_user_id) && timestamp(row.at);
}
function validAuditField(row) {
  return positiveInteger(row.audit_sequence) && nonnegativeInteger(row.field_sequence)
    && ["username", "name", "email", "role", "employee", "active", "permissions", "password", "deleted"].includes(row.field_name);
}
function validActivityLog(row) {
  return positiveInteger(row.activity_sequence) && requiredText(row.event_code, 128)
    && userId(row.actor_user_id) && (row.subject_user_id === null || userId(row.subject_user_id))
    && identifier(row.module_id) && timestamp(row.at);
}
function validSequences(sequences, tables) {
  const maximums = new Map([
    ["users", maximumInteger(tables.users, "user_sequence")],
    ["user_audit_logs", maximumInteger(tables.auditLogs, "audit_sequence")],
    ["user_activity_logs", maximumInteger(tables.activityLogs, "activity_sequence")]
  ]);
  const names = new Set();
  return sequences.every((row) => maximums.has(row.name) && !names.has(row.name)
    && names.add(row.name) && nonnegativeInteger(row.seq) && Number(row.seq) >= maximums.get(row.name));
}
function maximumInteger(rows, key) { return rows.reduce((maximum, row) => Math.max(maximum, Number(row[key]) || 0), 0); }
function positiveInteger(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0; }
function nonnegativeInteger(value) { return Number.isSafeInteger(Number(value)) && Number(value) >= 0; }
function userId(value) { return typeof value === "string" && /^USR-[A-Z0-9-]{1,60}$/.test(value); }
function validUsername(value, normalized) { try { const result = normalizeUsername(value); return result.username === value && result.usernameNormalized === normalized; } catch { return false; } }
function validEmail(value, normalized) { if (typeof value !== "string" || value !== value.trim()) return false; if (!value.includes("@")) return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(value) && normalized === value.toLowerCase(); try { const result = normalizeSqliteEmail(value); return result.email === value && result.emailNormalized === normalized; } catch { return false; } }
function timestamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value; }
function identifier(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value); }
function requiredText(value, maximum) { return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value); }
function optionalText(value, maximum) { return value === null || requiredText(value, maximum); }
function rollback(database) { try { database.exec("ROLLBACK"); return "rolled-back"; } catch { return "rollback-failed"; } }
function requireDatabase(database, ErrorType) { if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") throw new ErrorType("USERS_BACKFILL_SCHEMA_REQUIRED"); }
function plainRecord(value) { if (!value || Array.isArray(value) || typeof value !== "object") return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function plainRow(row) { return Object.fromEntries(Object.entries(row)); }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function countCodes(codes) { return [...new Set(codes)].sort().slice(0, 64).map((code) => ({ code, count: Math.min(1_000_000, codes.filter((item) => item === code).length) })); }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
