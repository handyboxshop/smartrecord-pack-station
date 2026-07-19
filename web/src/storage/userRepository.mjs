import {
  SqliteStorageError,
  runInSqliteTransaction
} from "./sqliteDatabase.mjs";
import {
  UserIdentityError,
  normalizeLoginIdentity,
  normalizeSqliteEmail,
  normalizeUsername
} from "../domain/userIdentity.mjs";
import {
  INITIAL_OWNER_ROLE_ID,
  INITIAL_OWNER_ROLE_NAME,
  createInitialOwnerModulePermissions
} from "../domain/userAccessPolicy.mjs";

const MINIMUM_SCHEMA_VERSION = 5;
const MAX_PERMISSIONS = 64;
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 500;
const CUSTOM_ROLE_ID = "custom";
const DEFAULT_CUSTOM_ROLE_NAME = "Custom";
const USER_CREATE_FIELDS = new Set([
  "id", "username", "email", "name", "roleId", "roleName", "modulePermissions",
  "employeeName", "employeeId", "active", "password", "passwordSalt", "passwordHash"
]);
const INITIAL_USER_FIELDS = new Set([
  "id", "username", "email", "name", "passwordSalt", "passwordHash"
]);
const USER_UPDATE_FIELDS = new Set([
  "name", "roleId", "roleName", "modulePermissions", "employeeName", "employeeId", "active"
]);
const PERMISSION_FIELDS = new Set(["moduleId", "canView", "canEdit"]);
const MUTATION_CONTEXT_FIELDS = new Set(["actorUserId"]);
const AUDIT_FIELDS = new Set(["actorUserId", "subjectUserId", "eventCode", "changedFields"]);
const ACTIVITY_FIELDS = new Set(["actorUserId", "subjectUserId", "eventCode", "moduleId"]);
const LOG_PAGE_FIELDS = new Set(["userId", "limit", "beforeSequence"]);
const ALLOWED_CHANGE_NAMES = new Set([
  "username", "name", "email", "role", "employee", "active", "permissions", "password", "deleted"
]);
const AUDIT_EVENT_CODES = new Set(["create_user", "update_user", "update_permission", "delete_user"]);
const ACTIVITY_EVENT_CODES = new Set([
  "login", "logout", "create_user", "update_user", "update_permission", "delete_user",
  "storage_test", "settings_prepack_image_update", "pack_start", "pack_scan",
  "pack_scan_rejected", "pack_close_pass", "pack_force_close", "reports_view",
  "video_upload", "connection_test", "connection_save", "orders_sync", "orders_import",
  "orders_manual_create", "orders_label_import", "orders_manual_update",
  "orders_manual_delete", "label_save"
]);
const ACTIVITY_MODULE_IDS = new Set(["auth", "users", "settings", "pack", "reports", "connect", "labels"]);
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const USER_ID_PATTERN = /^USR-[A-Z0-9-]{1,60}$/;
const PASSWORD_HASH_PATTERN = /^[0-9a-f]{64}$/;
const ASCII_PRINTABLE_PATTERN = /^[\x20-\x7E]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

export class UserRepositoryError extends SqliteStorageError {
  constructor(code, message) {
    super(code, message);
    this.name = "UserRepositoryError";
  }
}

export function createUserRepository(database, options = {}) {
  validateDatabase(database);
  validateSchema(database);
  if (!isPlainRecord(options) || Reflect.ownKeys(options).some((key) => key !== "now")) {
    throw repositoryError("USER_REPOSITORY_OPTIONS_INVALID", "Only supported repository options are accepted.");
  }
  const now = options.now ?? (() => new Date());
  if (typeof now !== "function") {
    throw repositoryError("USER_REPOSITORY_OPTIONS_INVALID", "Valid repository factories are required.");
  }

  const statements = prepareStatements(database);

  function getUserById(id, { includeInactive = false } = {}) {
    const userId = normalizeUserId(id);
    return readSafely("USER_READ_FAILED", () => {
      const row = includeInactive
        ? statements.selectCurrentUserById.get(userId)
        : statements.selectActiveUserById.get(userId);
      return row ? hydratePublicUser(row) : null;
    });
  }

  function getUserByEmail(email, { includeInactive = false } = {}) {
    const normalizedEmail = normalizeEmail(email, { allowEmpty: true });
    if (!normalizedEmail) return null;
    return readSafely("USER_READ_FAILED", () => {
      const row = includeInactive
        ? statements.selectUserByEmailIncludingInactive.get(normalizedEmail)
        : statements.selectActiveUserByEmail.get(normalizedEmail);
      return row ? hydratePublicUser(row) : null;
    });
  }

  function getUserByUsername(username, options = {}) {
    const { includeInactive } = normalizeLookupOptions(options, "USER_READ_OPTIONS_INVALID");
    const normalized = normalizeIdentityForRepository(() => normalizeUsername(username));
    return readSafely("USER_READ_FAILED", () => {
      const row = includeInactive
        ? statements.selectUserByUsernameIncludingInactive.get(normalized.usernameNormalized)
        : statements.selectActiveUserByUsername.get(normalized.usernameNormalized);
      return row ? hydratePublicUser(row) : null;
    });
  }

  function getUserForAuthenticationByEmail(email) {
    const normalizedEmail = normalizeEmail(email, { allowEmpty: true });
    if (!normalizedEmail) return null;
    return readSafely("USER_AUTH_LOOKUP_FAILED", () => {
      const row = statements.selectActiveUserByEmail.get(normalizedEmail);
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        emailNormalized: row.email_normalized,
        active: Boolean(row.active),
        passwordSalt: row.password_salt,
        passwordHash: row.password_hash
      };
    });
  }

  function getUserForAuthenticationByIdentity(identity) {
    const normalizedIdentity = normalizeIdentityForRepository(() => normalizeLoginIdentity(identity));
    return readSafely("USER_AUTH_LOOKUP_FAILED", () => {
      const rows = statements.selectUserForAuthenticationByIdentity.all(
        normalizedIdentity,
        normalizedIdentity
      );
      if (rows.length !== 1) return null;
      const [row] = rows;
      return {
        id: row.id,
        username: row.username,
        email: row.email,
        active: Boolean(row.active),
        passwordSalt: row.password_salt,
        passwordHash: row.password_hash
      };
    });
  }

  function listUsers({ includeInactive = true } = {}) {
    if (typeof includeInactive !== "boolean") {
      throw repositoryError("USER_LIST_OPTIONS_INVALID", "User list options are invalid.");
    }
    return readSafely("USER_LIST_FAILED", () => {
      const rows = includeInactive ? statements.selectUsers.all() : statements.selectActiveUsers.all();
      return rows.map(hydratePublicUser);
    });
  }

  function createUser(input, context = {}) {
    const user = normalizeNewUser(input);
    return inTransaction("USER_CREATE_FAILED", () => {
      if (statements.selectReservedUserById.get(user.id)) {
        throw repositoryError("USER_ID_EXISTS", "The User id already exists.");
      }
      assertIdentityAvailable(user, statements);
      if (statements.selectReservedUserByEmail.get(user.emailNormalized)) {
        throw repositoryError("USER_EMAIL_EXISTS", "The normalized email already exists.");
      }
      const createdAt = timestamp();
      const stored = { ...user, createdAt, updatedAt: createdAt, deletedAt: null };
      const mutationLogs = normalizeMutationLogs(context, {
        subjectUserId: stored.id,
        eventCode: "create_user",
        changedFields: ["username", "name", "email", "role", "employee", "active", "permissions"],
        at: createdAt
      });
      statements.insertUser.run(
        stored.id,
        stored.username,
        stored.email,
        stored.name,
        stored.roleId,
        stored.roleName,
        stored.employeeName,
        stored.employeeId,
        stored.active ? 1 : 0,
        stored.passwordSalt,
        stored.passwordHash,
        stored.createdAt,
        stored.updatedAt
      );
      insertPermissions(stored.id, stored.modulePermissions);
      insertAudit(mutationLogs.audit);
      insertActivity(mutationLogs.activity);
      return toPublicUser(stored);
    });
  }

  function assignLegacyUsername(id, username, context = {}) {
    const userId = normalizeUserId(id);
    const normalizedUsername = normalizeIdentityForRepository(() => normalizeUsername(username));
    return inTransaction("USER_USERNAME_ASSIGN_FAILED", () => {
      const existing = requireStoredUser(userId);
      if (existing.username !== null) {
        throw repositoryError("USER_USERNAME_IMMUTABLE", "The username is immutable.");
      }
      assertUsernameAvailable(normalizedUsername.usernameNormalized, existing.emailNormalized, statements, userId);
      const updatedAt = timestamp();
      const mutationLogs = normalizeMutationLogs(context, {
        subjectUserId: existing.id,
        eventCode: "update_user",
        changedFields: ["username"],
        at: updatedAt
      });
      statements.assignUsername.run(normalizedUsername.username, updatedAt, existing.id);
      insertAudit(mutationLogs.audit);
      insertActivity(mutationLogs.activity);
      return toPublicUser({
        ...existing,
        username: normalizedUsername.username,
        usernameNormalized: normalizedUsername.usernameNormalized,
        updatedAt
      });
    });
  }

  function createInitialUser(input) {
    const user = normalizeInitialUser(input);
    return inTransaction("USER_BOOTSTRAP_FAILED", () => {
      if (statements.selectAnyUser.get()) {
        throw repositoryError("USER_BOOTSTRAP_NOT_ALLOWED", "Initial User bootstrap is not allowed.");
      }
      if (statements.selectReservedUserById.get(user.id)) {
        throw repositoryError("USER_ID_EXISTS", "The User id already exists.");
      }
      assertIdentityAvailable(user, statements);
      const createdAt = timestamp();
      const stored = { ...user, createdAt, updatedAt: createdAt, deletedAt: null };
      statements.insertUser.run(
        stored.id,
        stored.username,
        stored.email,
        stored.name,
        stored.roleId,
        stored.roleName,
        stored.employeeName,
        stored.employeeId,
        stored.active ? 1 : 0,
        stored.passwordSalt,
        stored.passwordHash,
        stored.createdAt,
        stored.updatedAt
      );
      insertPermissions(stored.id, stored.modulePermissions);
      try {
        insertAudit({
          at: createdAt,
          actorUserId: stored.id,
          subjectUserId: stored.id,
          eventCode: "create_user",
          changedFields: ["username", "email", "name", "role", "active", "permissions"]
        });
      } catch {
        throw repositoryError("USER_AUDIT_APPEND_FAILED", "The initial User audit event could not be stored.");
      }
      try {
        insertActivity({
          at: createdAt,
          actorUserId: stored.id,
          subjectUserId: stored.id,
          eventCode: "create_user",
          moduleId: "users"
        });
      } catch {
        throw repositoryError("USER_ACTIVITY_APPEND_FAILED", "The initial User activity event could not be stored.");
      }
      return toPublicUser(stored);
    });
  }

  function updateUser(id, updates, context = {}) {
    const userId = normalizeUserId(id);
    assertPlainObject(updates, "USER_INPUT_INVALID", "User updates must be a plain object.");
    assertAllowedFields(updates, USER_UPDATE_FIELDS, "USER_INPUT_INVALID", "User updates contain an unsupported field.");
    if (Object.keys(updates).length === 0) {
      throw repositoryError("USER_INPUT_INVALID", "At least one User update is required.");
    }

    return inTransaction("USER_UPDATE_FAILED", () => {
      const existing = requireStoredUser(userId);
      const updatedAt = timestamp();
      const next = normalizeUpdatedUser(existing, updates, updatedAt);
      const mutationLogs = normalizeMutationLogs(context, {
        subjectUserId: existing.id,
        eventCode: "update_user",
        changedFields: changedFieldsForUpdate(existing, next),
        at: updatedAt
      });
      statements.updateUser.run(
        next.name,
        next.roleId,
        next.roleName,
        next.employeeName,
        next.employeeId,
        next.active ? 1 : 0,
        next.updatedAt,
        next.id
      );
      if (Object.hasOwn(updates, "modulePermissions")) {
        replacePermissionsWithinTransaction(next.id, next.modulePermissions);
      }
      insertAudit(mutationLogs.audit);
      insertActivity(mutationLogs.activity);
      return toPublicUser(next);
    });
  }

  function replaceUserPermissions(id, modulePermissions, context = {}) {
    const userId = normalizeUserId(id);
    const permissions = normalizePermissions(modulePermissions);
    return inTransaction("USER_PERMISSIONS_UPDATE_FAILED", () => {
      const existing = requireStoredUser(userId);
      const updatedAt = timestamp();
      const roleName = DEFAULT_CUSTOM_ROLE_NAME;
      const mutationLogs = normalizeMutationLogs(context, {
        subjectUserId: existing.id,
        eventCode: "update_permission",
        changedFields: ["role", "permissions"],
        at: updatedAt
      });
      statements.updateRole.run(CUSTOM_ROLE_ID, roleName, updatedAt, userId);
      replacePermissionsWithinTransaction(userId, permissions);
      insertAudit(mutationLogs.audit);
      insertActivity(mutationLogs.activity);
      return toPublicUser({
        ...existing,
        roleId: CUSTOM_ROLE_ID,
        roleName,
        modulePermissions: permissions,
        updatedAt
      });
    });
  }

  function setUserActive(id, active, context = {}) {
    if (typeof active !== "boolean") {
      throw repositoryError("USER_INPUT_INVALID", "User active state must be boolean.");
    }
    return updateUser(id, { active }, context);
  }

  function updateUserPasswordMetadata(id, metadata, context = {}) {
    const userId = normalizeUserId(id);
    assertPlainObject(metadata, "USER_PASSWORD_METADATA_INVALID", "Password metadata must be a plain object.");
    assertAllowedFields(
      metadata,
      new Set(["passwordSalt", "passwordHash"]),
      "USER_PASSWORD_METADATA_INVALID",
      "Password metadata contains an unsupported field."
    );
    const password = normalizePasswordMetadata(metadata);

    return inTransaction("USER_PASSWORD_UPDATE_FAILED", () => {
      const existing = requireStoredUser(userId);
      const updatedAt = timestamp();
      const mutationLogs = normalizeMutationLogs(context, {
        subjectUserId: existing.id,
        eventCode: "update_user",
        changedFields: ["password"],
        at: updatedAt
      });
      statements.updatePassword.run(password.passwordSalt, password.passwordHash, updatedAt, userId);
      insertAudit(mutationLogs.audit);
      insertActivity(mutationLogs.activity);
      return toPublicUser({ ...existing, updatedAt });
    });
  }

  function deleteUser(id, context = {}) {
    const userId = normalizeUserId(id);
    return inTransaction("USER_DELETE_FAILED", () => {
      const existing = requireStoredUser(userId);
      const deletedAt = timestamp();
      const mutationLogs = normalizeMutationLogs(context, {
        subjectUserId: existing.id,
        eventCode: "delete_user",
        changedFields: ["deleted"],
        at: deletedAt
      });
      statements.softDeleteUser.run(deletedAt, deletedAt, userId);
      insertAudit(mutationLogs.audit);
      insertActivity(mutationLogs.activity);
      return { id: existing.id, email: existing.email };
    });
  }

  function appendAuditLog(input) {
    return inTransaction("USER_AUDIT_APPEND_FAILED", () => {
      const audit = normalizeStandaloneAudit(input);
      insertAudit(audit);
      return mapAudit(audit);
    });
  }

  function appendActivityLog(input) {
    return inTransaction("USER_ACTIVITY_APPEND_FAILED", () => {
      const activity = normalizeActivity(input);
      insertActivity(activity);
      return mapActivity(activity);
    });
  }

  function listAuditLogs(options = {}) {
    const page = normalizeLogPage(options);
    return readSafely("USER_AUDIT_READ_FAILED", () => {
      return selectLogPage(statements, "audit", page).map((row) => {
        return mapAuditRow(row, statements.selectAuditFields.all(row.audit_sequence));
      });
    });
  }

  function listActivityLogs(options = {}) {
    const page = normalizeLogPage(options);
    return readSafely("USER_ACTIVITY_READ_FAILED", () => {
      return selectLogPage(statements, "activity", page).map(mapActivityRow);
    });
  }

  function timestamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw repositoryError("USER_TIMESTAMP_INVALID", "A valid repository timestamp is required.");
    }
    return date.toISOString();
  }

  function hydrateStoredUser(row) {
    return {
      id: row.id,
      username: row.username,
      usernameNormalized: row.username_normalized,
      email: row.email,
      emailNormalized: row.email_normalized,
      name: row.name,
      roleId: row.role_id,
      roleName: row.role_name,
      modulePermissions: statements.selectPermissions.all(row.id).map(mapPermission),
      employeeName: row.employee_name,
      employeeId: row.employee_id,
      active: Boolean(row.active),
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    };
  }

  function hydratePublicUser(row) {
    return toPublicUser(hydrateStoredUser(row));
  }

  function requireStoredUser(id) {
    const row = statements.selectCurrentUserById.get(id);
    if (!row) throw repositoryError("USER_NOT_FOUND", "The User was not found.");
    return hydrateStoredUser(row);
  }

  function insertPermissions(userId, permissions) {
    permissions.forEach((permission, index) => {
      statements.insertPermission.run(
        userId,
        index,
        permission.moduleId,
        permission.canView ? 1 : 0,
        permission.canEdit ? 1 : 0
      );
    });
  }

  function replacePermissionsWithinTransaction(userId, permissions) {
    statements.deletePermissions.run(userId);
    insertPermissions(userId, permissions);
  }

  function normalizeMutationLogs(context, { subjectUserId, eventCode, changedFields, at }) {
    assertPlainObject(context, "USER_AUDIT_INVALID", "User mutation context must be a plain object.");
    assertAllowedFields(
      context,
      MUTATION_CONTEXT_FIELDS,
      "USER_AUDIT_INVALID",
      "User mutation context contains an unsupported field."
    );
    const actorUserId = normalizeUserId(context.actorUserId);
    const normalizedSubject = normalizeUserId(subjectUserId);
    const normalizedFields = normalizeChangedFields(changedFields);
    return {
      audit: {
        at,
        actorUserId,
        subjectUserId: normalizedSubject,
        eventCode: normalizeAuditEventCode(eventCode),
        changedFields: normalizedFields
      },
      activity: {
        at,
        actorUserId,
        subjectUserId: normalizedSubject,
        eventCode: normalizeActivityEventCode(eventCode),
        moduleId: "users"
      }
    };
  }

  function normalizeStandaloneAudit(input) {
    assertPlainObject(input, "USER_AUDIT_INVALID", "An audit entry must be a plain object.");
    assertAllowedFields(input, AUDIT_FIELDS, "USER_AUDIT_INVALID", "The audit entry contains an unsupported field.");
    return {
      at: timestamp(),
      actorUserId: normalizeUserId(input.actorUserId),
      subjectUserId: normalizeUserId(input.subjectUserId),
      eventCode: normalizeAuditEventCode(input.eventCode),
      changedFields: normalizeChangedFields(input.changedFields)
    };
  }

  function normalizeActivity(input) {
    assertPlainObject(input, "USER_ACTIVITY_INVALID", "An activity entry must be a plain object.");
    assertAllowedFields(input, ACTIVITY_FIELDS, "USER_ACTIVITY_INVALID", "The activity entry contains an unsupported field.");
    return {
      at: timestamp(),
      actorUserId: normalizeUserId(input.actorUserId),
      subjectUserId: normalizeOptionalUserId(input.subjectUserId, "USER_ACTIVITY_INVALID"),
      eventCode: normalizeActivityEventCode(input.eventCode),
      moduleId: normalizeActivityModuleId(input.moduleId)
    };
  }

  function normalizeChangedFields(fields) {
    if (!Array.isArray(fields) || fields.length > ALLOWED_CHANGE_NAMES.size) {
      throw repositoryError("USER_AUDIT_INVALID", "Audit changed fields must be a bounded array.");
    }
    const seen = new Set();
    return fields.map((field) => {
      if (typeof field !== "string" || !ALLOWED_CHANGE_NAMES.has(field) || seen.has(field)) {
        throw repositoryError("USER_AUDIT_INVALID", "An audit changed field is unsupported.");
      }
      seen.add(field);
      return field;
    });
  }

  function normalizeAuditEventCode(value) {
    if (typeof value !== "string" || !AUDIT_EVENT_CODES.has(value)) {
      throw repositoryError("USER_AUDIT_INVALID", "The audit event code is unsupported.");
    }
    return value;
  }

  function normalizeActivityEventCode(value) {
    if (typeof value !== "string" || !ACTIVITY_EVENT_CODES.has(value)) {
      throw repositoryError("USER_ACTIVITY_INVALID", "The activity event code is unsupported.");
    }
    return value;
  }

  function normalizeActivityModuleId(value) {
    if (typeof value !== "string" || !ACTIVITY_MODULE_IDS.has(value)) {
      throw repositoryError("USER_ACTIVITY_INVALID", "The activity module is unsupported.");
    }
    return value;
  }

  function insertAudit(audit) {
    const result = statements.insertAudit.run(
      audit.eventCode,
      audit.actorUserId,
      audit.subjectUserId,
      audit.at
    );
    audit.sequence = safeLogSequence(result.lastInsertRowid);
    audit.changedFields.forEach((field, index) => {
      statements.insertAuditField.run(audit.sequence, index, field);
    });
  }

  function insertActivity(activity) {
    const result = statements.insertActivity.run(
      activity.eventCode,
      activity.actorUserId,
      activity.subjectUserId,
      activity.moduleId,
      activity.at
    );
    activity.sequence = safeLogSequence(result.lastInsertRowid);
  }

  function readSafely(code, callback) {
    try {
      return callback();
    } catch (cause) {
      if (cause instanceof UserRepositoryError) throw cause;
      throw repositoryError(code, "The User repository read failed safely.");
    }
  }

  function inTransaction(code, callback) {
    try {
      return runInSqliteTransaction(database, callback);
    } catch (cause) {
      if (cause instanceof UserRepositoryError) throw cause;
      throw repositoryError(code, "The User repository transaction failed and was rolled back.");
    }
  }

  return {
    getUserById,
    getUserByEmail,
    getUserByUsername,
    getUserForAuthenticationByEmail,
    getUserForAuthenticationByIdentity,
    listUsers,
    createUser,
    assignLegacyUsername,
    createInitialUser,
    updateUser,
    replaceUserPermissions,
    setUserActive,
    updateUserPasswordMetadata,
    deleteUser,
    appendAuditLog,
    appendActivityLog,
    listAuditLogs,
    listActivityLogs
  };
}

function prepareStatements(database) {
  try {
    return {
      insertUser: database.prepare(`
        INSERT INTO main.users (
          id, username, email, name, role_id, role_name,
          employee_name, employee_id, active, password_salt, password_hash,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateUser: database.prepare(`
        UPDATE main.users SET
          name = ?, role_id = ?, role_name = ?, employee_name = ?,
          employee_id = ?, active = ?, updated_at = ?
        WHERE id = ?
      `),
      updateRole: database.prepare(`
        UPDATE main.users SET role_id = ?, role_name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL
      `),
      updatePassword: database.prepare(`
        UPDATE main.users SET password_salt = ?, password_hash = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `),
      softDeleteUser: database.prepare(`
        UPDATE main.users SET active = 0, deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `),
      assignUsername: database.prepare(`
        UPDATE main.users SET username = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL AND username IS NULL
      `),
      selectActiveUserById: database.prepare(`
        SELECT * FROM main.users WHERE id = ? AND active = 1 AND deleted_at IS NULL
      `),
      selectCurrentUserById: database.prepare(`SELECT * FROM main.users WHERE id = ? AND deleted_at IS NULL`),
      selectReservedUserById: database.prepare(`SELECT id FROM main.users WHERE id = ?`),
      selectAnyUser: database.prepare(`SELECT 1 AS present FROM main.users LIMIT 1`),
      selectActiveUserByEmail: database.prepare(`
        SELECT * FROM main.users WHERE email_normalized = ? AND active = 1 AND deleted_at IS NULL
      `),
      selectUserByEmailIncludingInactive: database.prepare(`
        SELECT * FROM main.users WHERE email_normalized = ? AND deleted_at IS NULL
      `),
      selectActiveUserByUsername: database.prepare(`
        SELECT * FROM main.users WHERE username_normalized = ? AND active = 1 AND deleted_at IS NULL
      `),
      selectUserByUsernameIncludingInactive: database.prepare(`
        SELECT * FROM main.users WHERE username_normalized = ? AND deleted_at IS NULL
      `),
      selectUserForAuthenticationByIdentity: database.prepare(`
        SELECT * FROM main.users
        WHERE deleted_at IS NULL AND (email_normalized = ? OR username_normalized = ?)
        LIMIT 2
      `),
      selectReservedUserByEmail: database.prepare(`SELECT id FROM main.users WHERE email_normalized = ?`),
      selectReservedUserByUsername: database.prepare(`SELECT id FROM main.users WHERE username_normalized = ?`),
      selectUsers: database.prepare(`SELECT * FROM main.users WHERE deleted_at IS NULL ORDER BY user_sequence`),
      selectActiveUsers: database.prepare(`
        SELECT * FROM main.users WHERE active = 1 AND deleted_at IS NULL ORDER BY user_sequence
      `),
      insertPermission: database.prepare(`
        INSERT INTO main.user_module_permissions (
          user_id, permission_sequence, module_id, can_view, can_edit
        ) VALUES (?, ?, ?, ?, ?)
      `),
      deletePermissions: database.prepare(`DELETE FROM main.user_module_permissions WHERE user_id = ?`),
      selectPermissions: database.prepare(`
        SELECT module_id, can_view, can_edit
        FROM main.user_module_permissions
        WHERE user_id = ?
        ORDER BY permission_sequence
      `),
      insertAudit: database.prepare(`
        INSERT INTO main.user_audit_logs (
          event_code, actor_user_id, subject_user_id, at
        ) VALUES (?, ?, ?, ?)
      `),
      insertAuditField: database.prepare(`
        INSERT INTO main.user_audit_log_fields (audit_sequence, field_sequence, field_name)
        VALUES (?, ?, ?)
      `),
      selectAuditFields: database.prepare(`
        SELECT field_name FROM main.user_audit_log_fields
        WHERE audit_sequence = ? ORDER BY field_sequence
      `),
      selectAuditPage: database.prepare(`
        SELECT * FROM main.user_audit_logs ORDER BY audit_sequence DESC LIMIT ?
      `),
      selectAuditPageBefore: database.prepare(`
        SELECT * FROM main.user_audit_logs
        WHERE audit_sequence < ? ORDER BY audit_sequence DESC LIMIT ?
      `),
      selectAuditPageByUser: database.prepare(`
        SELECT * FROM main.user_audit_logs
        WHERE actor_user_id = ? OR subject_user_id = ?
        ORDER BY audit_sequence DESC LIMIT ?
      `),
      selectAuditPageByUserBefore: database.prepare(`
        SELECT * FROM main.user_audit_logs
        WHERE (actor_user_id = ? OR subject_user_id = ?) AND audit_sequence < ?
        ORDER BY audit_sequence DESC LIMIT ?
      `),
      insertActivity: database.prepare(`
        INSERT INTO main.user_activity_logs (
          event_code, actor_user_id, subject_user_id, module_id, at
        ) VALUES (?, ?, ?, ?, ?)
      `),
      selectActivityPage: database.prepare(`
        SELECT * FROM main.user_activity_logs ORDER BY activity_sequence DESC LIMIT ?
      `),
      selectActivityPageBefore: database.prepare(`
        SELECT * FROM main.user_activity_logs
        WHERE activity_sequence < ? ORDER BY activity_sequence DESC LIMIT ?
      `),
      selectActivityPageByUser: database.prepare(`
        SELECT * FROM main.user_activity_logs
        WHERE actor_user_id = ? OR subject_user_id = ?
        ORDER BY activity_sequence DESC LIMIT ?
      `),
      selectActivityPageByUserBefore: database.prepare(`
        SELECT * FROM main.user_activity_logs
        WHERE (actor_user_id = ? OR subject_user_id = ?) AND activity_sequence < ?
        ORDER BY activity_sequence DESC LIMIT ?
      `)
    };
  } catch {
    throw repositoryError("USER_REPOSITORY_PREPARE_FAILED", "The User repository could not be prepared.");
  }
}

function normalizeNewUser(input) {
  assertPlainObject(input, "USER_INPUT_INVALID", "A User must be a plain object.");
  assertAllowedFields(input, USER_CREATE_FIELDS, "USER_INPUT_INVALID", "The User contains an unsupported field.");
  const username = normalizeIdentityForRepository(() => normalizeUsername(input.username));
  const email = normalizeIdentityForRepository(() => normalizeSqliteEmail(input.email));
  const roleId = safeIdentifier(input.roleId, "USER_INPUT_INVALID");
  const roleName = normalizeRoleName(roleId, input.roleName);
  const password = normalizePasswordMetadata(input);
  if (Object.hasOwn(input, "password")) {
    throw repositoryError("USER_INPUT_INVALID", "Plaintext password fields are not accepted.");
  }
  if (input.active != null && typeof input.active !== "boolean") {
    throw repositoryError("USER_INPUT_INVALID", "User active state must be boolean.");
  }
  return {
    id: normalizeUserId(input.id),
    ...username,
    ...email,
    name: optionalBoundedText(input.name, 200) || email.email,
    roleId,
    roleName,
    modulePermissions: normalizePermissions(input.modulePermissions),
    employeeName: optionalBoundedText(input.employeeName, 200),
    employeeId: optionalBoundedText(input.employeeId, 128),
    active: input.active !== false,
    ...password
  };
}

function normalizeInitialUser(input) {
  assertPlainObject(input, "USER_INPUT_INVALID", "An initial User must be a plain object.");
  assertAllowedFields(input, INITIAL_USER_FIELDS, "USER_INPUT_INVALID", "The initial User contains an unsupported field.");
  const username = normalizeIdentityForRepository(() => normalizeUsername(input.username));
  const email = normalizeIdentityForRepository(() => normalizeSqliteEmail(input.email));
  return {
    id: normalizeUserId(input.id),
    ...username,
    ...email,
    name: boundedText(input.name, 200, "USER_INPUT_INVALID", "A User name is required."),
    roleId: INITIAL_OWNER_ROLE_ID,
    roleName: INITIAL_OWNER_ROLE_NAME,
    modulePermissions: createInitialOwnerModulePermissions(),
    employeeName: null,
    employeeId: null,
    active: true,
    ...normalizePasswordMetadata(input)
  };
}

function normalizeUpdatedUser(existing, updates, updatedAt) {
  const roleId = Object.hasOwn(updates, "roleId")
    ? safeIdentifier(updates.roleId, "USER_INPUT_INVALID")
    : existing.roleId;
  const roleNameInput = Object.hasOwn(updates, "roleName")
    ? updates.roleName
    : (roleId === existing.roleId ? existing.roleName : null);
  if (roleId !== existing.roleId && !Object.hasOwn(updates, "modulePermissions")) {
    throw repositoryError(
      "USER_ROLE_PERMISSIONS_REQUIRED",
      "A complete permission snapshot is required when changing a User role."
    );
  }
  if (roleId === existing.roleId && Object.hasOwn(updates, "modulePermissions")) {
    throw repositoryError(
      "USER_PERMISSION_UPDATE_PATH_REQUIRED",
      "Permission-only changes must use the dedicated permission replacement operation."
    );
  }
  const roleName = normalizeRoleName(roleId, roleNameInput);
  if (Object.hasOwn(updates, "active") && typeof updates.active !== "boolean") {
    throw repositoryError("USER_INPUT_INVALID", "User active state must be boolean.");
  }
  return {
    ...existing,
    name: Object.hasOwn(updates, "name")
      ? boundedText(updates.name, 200, "USER_INPUT_INVALID", "A User name is required.")
      : existing.name,
    roleId,
    roleName,
    modulePermissions: Object.hasOwn(updates, "modulePermissions")
      ? normalizePermissions(updates.modulePermissions)
      : existing.modulePermissions,
    employeeName: Object.hasOwn(updates, "employeeName")
      ? optionalBoundedText(updates.employeeName, 200)
      : existing.employeeName,
    employeeId: Object.hasOwn(updates, "employeeId")
      ? optionalBoundedText(updates.employeeId, 128)
      : existing.employeeId,
    active: Object.hasOwn(updates, "active") ? updates.active : existing.active,
    updatedAt
  };
}

function changedFieldsForUpdate(existing, next) {
  const fields = [];
  if (existing.name !== next.name) fields.push("name");
  if (existing.roleId !== next.roleId || existing.roleName !== next.roleName) fields.push("role");
  if (!permissionsEqual(existing.modulePermissions, next.modulePermissions)) fields.push("permissions");
  if (existing.employeeName !== next.employeeName || existing.employeeId !== next.employeeId) fields.push("employee");
  if (existing.active !== next.active) fields.push("active");
  return fields;
}

function permissionsEqual(left, right) {
  return left.length === right.length && left.every((permission, index) => {
    const candidate = right[index];
    return permission.moduleId === candidate.moduleId
      && permission.canView === candidate.canView
      && permission.canEdit === candidate.canEdit;
  });
}

function normalizeLogPage(options) {
  assertPlainObject(options, "USER_LOG_PAGE_INVALID", "Log page options must be a plain object.");
  assertAllowedFields(options, LOG_PAGE_FIELDS, "USER_LOG_PAGE_INVALID", "Log page options contain an unsupported field.");
  const limit = options.limit == null ? DEFAULT_LOG_LIMIT : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
    throw repositoryError("USER_LOG_PAGE_INVALID", "The log page limit is invalid.");
  }
  const beforeSequence = options.beforeSequence == null ? null : options.beforeSequence;
  if (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) {
    throw repositoryError("USER_LOG_PAGE_INVALID", "The log page cursor is invalid.");
  }
  const userId = normalizeOptionalUserId(options.userId, "USER_LOG_PAGE_INVALID");
  return { userId, limit, beforeSequence };
}

function selectLogPage(statements, kind, { userId, limit, beforeSequence }) {
  const prefix = kind === "audit" ? "selectAuditPage" : "selectActivityPage";
  if (userId && beforeSequence !== null) {
    return statements[`${prefix}ByUserBefore`].all(userId, userId, beforeSequence, limit);
  }
  if (userId) return statements[`${prefix}ByUser`].all(userId, userId, limit);
  if (beforeSequence !== null) return statements[`${prefix}Before`].all(beforeSequence, limit);
  return statements[prefix].all(limit);
}

function normalizeOptionalUserId(value, code) {
  if (value == null || value === "") return null;
  try {
    return normalizeUserId(value);
  } catch {
    throw repositoryError(code, "A valid optional User id is required.");
  }
}

function normalizePermissions(input) {
  if (!Array.isArray(input) || input.length > MAX_PERMISSIONS) {
    throw repositoryError("USER_PERMISSIONS_INVALID", "Module permissions must be a bounded array.");
  }
  const seen = new Set();
  return input.map((permission) => {
    assertPlainObject(permission, "USER_PERMISSIONS_INVALID", "Each module permission must be a plain object.");
    assertAllowedFields(
      permission,
      PERMISSION_FIELDS,
      "USER_PERMISSIONS_INVALID",
      "A module permission contains an unsupported field."
    );
    const moduleId = safeIdentifier(permission.moduleId, "USER_PERMISSIONS_INVALID");
    if (seen.has(moduleId)) {
      throw repositoryError("USER_PERMISSIONS_INVALID", "Module permission identifiers must be unique.");
    }
    seen.add(moduleId);
    if (typeof permission.canView !== "boolean" || typeof permission.canEdit !== "boolean") {
      throw repositoryError("USER_PERMISSIONS_INVALID", "Module permission flags must be boolean.");
    }
    const canEdit = permission.canEdit;
    return { moduleId, canView: permission.canView || canEdit, canEdit };
  });
}

function normalizePasswordMetadata(input) {
  const passwordSalt = boundedText(
    input.passwordSalt,
    512,
    "USER_PASSWORD_METADATA_INVALID",
    "Valid password metadata is required."
  );
  if (typeof input.passwordHash !== "string" || !PASSWORD_HASH_PATTERN.test(input.passwordHash)) {
    throw repositoryError("USER_PASSWORD_METADATA_INVALID", "Valid password metadata is required.");
  }
  return { passwordSalt, passwordHash: input.passwordHash };
}

function normalizeRoleName(roleId, value) {
  const roleName = optionalBoundedText(value, 200);
  if (roleId === CUSTOM_ROLE_ID && !roleName) {
    throw repositoryError("CUSTOM_ROLE_NAME_REQUIRED", "A custom role name is required.");
  }
  return roleId === CUSTOM_ROLE_ID ? roleName : null;
}

function normalizeUserId(value) {
  if (typeof value !== "string" || !USER_ID_PATTERN.test(value)) {
    throw repositoryError("USER_ID_INVALID", "A valid User id is required.");
  }
  return value;
}

function normalizeEmail(value, { allowEmpty = false } = {}) {
  if (value == null && allowEmpty) return "";
  if (typeof value !== "string") {
    throw repositoryError("USER_EMAIL_REQUIRED", "A valid User email is required.");
  }
  const email = value.trim().toLowerCase();
  if (!email && allowEmpty) return "";
  if (!email || email.length > 320 || CONTROL_CHARACTER_PATTERN.test(email) || !ASCII_PRINTABLE_PATTERN.test(email)) {
    throw repositoryError("USER_EMAIL_REQUIRED", "A valid User email is required.");
  }
  return email;
}

function normalizeIdentityForRepository(callback) {
  try {
    return callback();
  } catch (cause) {
    if (cause instanceof UserIdentityError) {
      throw repositoryError(cause.code, cause.message);
    }
    throw repositoryError("USER_INPUT_INVALID", "User identity input is invalid.");
  }
}

function normalizeLookupOptions(options, code) {
  assertPlainObject(options, code, "User lookup options are invalid.");
  assertAllowedFields(options, new Set(["includeInactive"]), code, "User lookup options contain an unsupported field.");
  const includeInactive = options.includeInactive ?? false;
  if (typeof includeInactive !== "boolean") {
    throw repositoryError(code, "User lookup options are invalid.");
  }
  return { includeInactive };
}

function assertIdentityAvailable(user, statements) {
  if (statements.selectReservedUserByUsername.get(user.usernameNormalized)) {
    throw repositoryError("USER_USERNAME_EXISTS", "The normalized username already exists.");
  }
  if (statements.selectReservedUserByEmail.get(user.emailNormalized)) {
    throw repositoryError("USER_EMAIL_EXISTS", "The normalized email already exists.");
  }
  assertUsernameAvailable(user.usernameNormalized, user.emailNormalized, statements);
}

function assertUsernameAvailable(usernameNormalized, emailNormalized, statements, excludedUserId = null) {
  if (usernameNormalized === emailNormalized) {
    throw repositoryError("USER_IDENTITY_CONFLICT", "The login identity is already reserved.");
  }
  const emailOwner = statements.selectReservedUserByEmail.get(usernameNormalized);
  if (emailOwner && emailOwner.id !== excludedUserId) {
    throw repositoryError("USER_IDENTITY_CONFLICT", "The login identity is already reserved.");
  }
  const duplicateUsername = statements.selectReservedUserByUsername.get(usernameNormalized);
  if (duplicateUsername && duplicateUsername.id !== excludedUserId) {
    throw repositoryError("USER_USERNAME_EXISTS", "The normalized username already exists.");
  }
  const usernameOwnerForEmail = statements.selectReservedUserByUsername.get(emailNormalized);
  if (usernameOwnerForEmail && usernameOwnerForEmail.id !== excludedUserId) {
    throw repositoryError("USER_IDENTITY_CONFLICT", "The login identity is already reserved.");
  }
}

function safeIdentifier(value, code) {
  if (typeof value !== "string" || value.length > 64 || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw repositoryError(code, "A valid bounded identifier is required.");
  }
  return value;
}

function boundedText(value, maximumLength, code, message) {
  if (typeof value !== "string") throw repositoryError(code, message);
  const text = value.trim();
  if (!text || text.length > maximumLength || CONTROL_CHARACTER_PATTERN.test(text)) {
    throw repositoryError(code, message);
  }
  return text;
}

function optionalBoundedText(value, maximumLength) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw repositoryError("USER_INPUT_INVALID", "Optional User fields must be strings.");
  }
  const text = value.trim();
  if (!text) return null;
  if (text.length > maximumLength || CONTROL_CHARACTER_PATTERN.test(text)) {
    throw repositoryError("USER_INPUT_INVALID", "A User field exceeds its storage boundary.");
  }
  return text;
}

function assertPlainObject(value, code, message) {
  if (!isPlainRecord(value)) throw repositoryError(code, message);
}

function assertAllowedFields(value, allowed, code, message) {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw repositoryError(code, message);
  }
}

function isPlainRecord(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username ?? null,
    email: user.email,
    name: user.name,
    roleId: user.roleId,
    roleName: user.roleName,
    modulePermissions: user.modulePermissions.map((permission) => ({ ...permission })),
    employeeName: user.employeeName,
    employeeId: user.employeeId,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function mapPermission(row) {
  return {
    moduleId: row.module_id,
    canView: Boolean(row.can_view),
    canEdit: Boolean(row.can_edit)
  };
}

function mapAudit(audit) {
  const changedFields = audit.changedFields.map((field) => field);
  return {
    sequence: safeLogSequence(audit.sequence),
    at: audit.at,
    actorUserId: audit.actorUserId,
    subjectUserId: audit.subjectUserId,
    action: audit.eventCode,
    changedFields,
    details: `${audit.eventCode}:${changedFields.join(",")}`
  };
}

function mapAuditRow(row, fieldRows) {
  return mapAudit({
    sequence: safeLogSequence(row.audit_sequence),
    at: row.at,
    actorUserId: row.actor_user_id,
    subjectUserId: row.subject_user_id,
    eventCode: row.event_code,
    changedFields: fieldRows.map((fieldRow) => fieldRow.field_name)
  });
}

function mapActivity(activity) {
  return {
    sequence: safeLogSequence(activity.sequence),
    at: activity.at,
    actorUserId: activity.actorUserId,
    subjectUserId: activity.subjectUserId,
    moduleId: activity.moduleId,
    action: activity.eventCode,
    details: `${activity.eventCode}:${activity.moduleId}`
  };
}

function mapActivityRow(row) {
  return mapActivity({
    sequence: safeLogSequence(row.activity_sequence),
    at: row.at,
    actorUserId: row.actor_user_id,
    subjectUserId: row.subject_user_id,
    moduleId: row.module_id,
    eventCode: row.event_code
  });
}

function safeLogSequence(value) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw repositoryError("USER_LOG_SEQUENCE_INVALID", "A valid log sequence is required.");
  }
  return sequence;
}

function validateDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw repositoryError("USER_DATABASE_INVALID", "A valid SQLite database is required.");
  }
}

function validateSchema(database) {
  try {
    const version = Number(database.prepare("PRAGMA main.user_version").get()?.user_version);
    const foreignKeys = Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys);
    const tables = new Set(database.prepare(`
      SELECT name FROM main.sqlite_schema
      WHERE type = 'table' AND name IN (
        'users', 'user_module_permissions', 'user_audit_logs',
        'user_audit_log_fields', 'user_activity_logs'
      )
    `).all().map((row) => row.name));
    const userColumns = new Set(
      database.prepare("PRAGMA main.table_xinfo(users)").all().map((row) => row.name)
    );
    if (!Number.isInteger(version) || version < MINIMUM_SCHEMA_VERSION) {
      throw repositoryError("USER_SCHEMA_REQUIRED", "SQLite schema version 5 or later is required.");
    }
    if (foreignKeys !== 1) {
      throw repositoryError("USER_FOREIGN_KEYS_REQUIRED", "SQLite foreign keys must be enabled.");
    }
    if (
      tables.size !== 5
      || !userColumns.has("username")
      || !userColumns.has("username_normalized")
    ) {
      throw repositoryError("USER_SCHEMA_REQUIRED", "The required User schema is unavailable.");
    }
  } catch (cause) {
    if (cause instanceof UserRepositoryError) throw cause;
    throw repositoryError("USER_SCHEMA_CHECK_FAILED", "The User schema could not be verified.");
  }
}

function repositoryError(code, message) {
  return new UserRepositoryError(code, message);
}
