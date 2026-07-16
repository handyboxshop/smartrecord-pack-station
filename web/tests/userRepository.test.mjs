import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  runInSqliteTransaction,
  runSqliteForeignKeyCheck,
  runSqliteQuickCheck
} from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import {
  UserRepositoryError,
  createUserRepository
} from "../src/storage/userRepository.mjs";

const FIXED_TIME = "2026-07-16T12:00:00.000Z";
const PASSWORD_HASH = "a".repeat(64);
const UPDATED_PASSWORD_HASH = "b".repeat(64);

test("migration 004 creates strict Users storage without an initial administrator", async (t) => {
  const { database, databasePath } = await migratedDatabase(t);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 4);
  assert.deepEqual(database.prepare(`
    SELECT version, name FROM schema_migrations ORDER BY version
  `).all().map((row) => [row.version, row.name]), [
    [1, "001_storage_foundation.sql"],
    [2, "002_pack_records.sql"],
    [3, "003_orders_labels.sql"],
    [4, "004_users.sql"]
  ]);
  const strictTables = new Map(database.prepare("PRAGMA table_list").all().map((row) => [row.name, row.strict]));
  for (const table of ["users", "user_module_permissions", "user_audit_logs", "user_activity_logs"]) {
    assert.equal(strictTables.get(table), 1);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  assert.deepEqual(runSqliteQuickCheck(database), { ok: true, messages: ["ok"] });
  assert.deepEqual(runSqliteForeignKeyCheck(database), { ok: true, violations: [] });
  assert.equal(databasePath.startsWith(path.resolve(tmpdir())), true);
});

test("migration 004 enforces User identity, credential, and permission constraints directly", async (t) => {
  const { database } = await migratedDatabase(t);
  insertDirectUser(database, { id: "USR-DIRECT-1", email: "Direct@Example.Local" });

  assert.throws(
    () => insertDirectUser(database, { id: "USR-DIRECT-2", email: "direct@example.local" }),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO users (
        id, email, email_normalized, name, role_id, role_name,
        employee_name, employee_id, active, password_salt, password_hash,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "USR-DIRECT-2", "other@example.local", "mismatch@example.local", "Direct User",
      "packer", null, null, null, 1, "direct-salt", PASSWORD_HASH, FIXED_TIME, FIXED_TIME, null
    ),
    /generated column/
  );
  assert.throws(
    () => insertDirectUser(database, { id: "invalid-id", email: "invalid@example.local" }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertDirectUser(database, { id: "USR-DIRECT-3", email: "hash@example.local", passwordHash: "A".repeat(64) }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertDirectUser(database, { id: "USR-DIRECT-4", email: " spaced@example.local " }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_module_permissions (
        user_id, permission_sequence, module_id, can_view, can_edit
      ) VALUES (?, ?, ?, ?, ?)
    `).run("USR-DIRECT-1", 0, "users", 0, 1),
    /CHECK constraint failed/
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_module_permissions").get().count, 0);
  assert.deepEqual(runSqliteForeignKeyCheck(database), { ok: true, violations: [] });
});

test("migration 004 exposes only structured log columns and rejects generic payload storage", async (t) => {
  const { database } = await migratedDatabase(t);
  insertDirectUser(database, { id: "USR-ACTOR", email: "actor@example.local" });

  const auditColumns = database.prepare("PRAGMA table_info(user_audit_logs)").all().map((row) => row.name);
  const activityColumns = database.prepare("PRAGMA table_info(user_activity_logs)").all().map((row) => row.name);
  for (const forbidden of [
    "id", "details", "changes_json", "before", "after", "password_hash", "password_salt",
    "token", "session", "authorization", "payload", "raw_json"
  ]) {
    assert.equal(auditColumns.includes(forbidden), false);
    assert.equal(activityColumns.includes(forbidden), false);
  }
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_audit_logs (
        event_code, actor_user_id, subject_user_id, at, details
      ) VALUES (?, ?, ?, ?, ?)
    `).run("update_user", "USR-ACTOR", "USR-ACTOR", FIXED_TIME, PASSWORD_HASH),
    /no column named details/
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_activity_logs (
        event_code, actor_user_id, subject_user_id, module_id, at, payload
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("reports_view", "USR-ACTOR", "USR-ACTOR", "reports", FIXED_TIME, "opaque-secret"),
    /no column named payload/
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_audit_logs (
        audit_sequence, event_code, actor_user_id, subject_user_id, at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(PASSWORD_HASH, "update_user", "USR-ACTOR", "USR-ACTOR", FIXED_TIME),
    /datatype mismatch|cannot store TEXT/
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_activity_logs (
        activity_sequence, event_code, actor_user_id, subject_user_id, module_id, at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("raw-salt-marker", "reports_view", "USR-ACTOR", "USR-ACTOR", "reports", FIXED_TIME),
    /datatype mismatch|cannot store TEXT/
  );
  const audit = database.prepare(`
    INSERT INTO user_audit_logs (event_code, actor_user_id, subject_user_id, at)
    VALUES (?, ?, ?, ?)
  `).run("update_user", "USR-ACTOR", "USR-ACTOR", FIXED_TIME);
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_audit_log_fields (audit_sequence, field_sequence, field_name)
      VALUES (?, ?, ?)
    `).run(Number(audit.lastInsertRowid), 0, PASSWORD_HASH),
    /CHECK constraint failed/
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_log_fields").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_activity_logs").get().count, 0);
});

test("migration 004 rejects NUL length bypasses across every Users table", async (t) => {
  const { database } = await migratedDatabase(t);
  insertDirectUser(database, { id: "USR-ACTOR", email: "actor@example.local" });
  const hiddenTail = `\0${"x".repeat(10000)}`;

  assert.throws(
    () => insertDirectUser(database, { id: "USR-NUL-1", email: "nul@example.local", name: `Name${hiddenTail}` }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertDirectUser(database, {
      id: "USR-NUL-2",
      email: "nul-hash@example.local",
      passwordHash: `${PASSWORD_HASH}${hiddenTail}`
    }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_module_permissions (
        user_id, permission_sequence, module_id, can_view, can_edit
      ) VALUES (?, ?, ?, ?, ?)
    `).run("USR-ACTOR", 0, `pack${hiddenTail}`, 1, 1),
    /CHECK constraint failed/
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_audit_logs (event_code, actor_user_id, subject_user_id, at)
      VALUES (?, ?, ?, ?)
    `).run("update_user", `USR-ACTOR${hiddenTail}`, "USR-ACTOR", FIXED_TIME),
    /CHECK constraint failed/
  );
  const audit = database.prepare(`
    INSERT INTO user_audit_logs (event_code, actor_user_id, subject_user_id, at)
    VALUES (?, ?, ?, ?)
  `).run("update_user", "USR-ACTOR", "USR-ACTOR", FIXED_TIME);
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_audit_log_fields (audit_sequence, field_sequence, field_name)
      VALUES (?, ?, ?)
    `).run(Number(audit.lastInsertRowid), 0, `name${hiddenTail}`),
    /CHECK constraint failed/
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_activity_logs (
        event_code, actor_user_id, subject_user_id, module_id, at
      ) VALUES (?, ?, ?, ?, ?)
    `).run("reports_view", "USR-ACTOR", "USR-ACTOR", `reports${hiddenTail}`, FIXED_TIME),
    /CHECK constraint failed/
  );
});

test("every User-ID reference enforces canonical structure without relying on foreign keys", async (t) => {
  const { database } = await migratedDatabase(t);
  insertDirectUser(database, { id: "USR-ACTOR", email: "actor@example.local" });
  database.exec("PRAGMA foreign_keys = OFF");
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 0);

  const insertPermission = database.prepare(`
    INSERT INTO user_module_permissions (
      user_id, permission_sequence, module_id, can_view, can_edit
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertAudit = database.prepare(`
    INSERT INTO user_audit_logs (event_code, actor_user_id, subject_user_id, at)
    VALUES (?, ?, ?, ?)
  `);
  const insertActivity = database.prepare(`
    INSERT INTO user_activity_logs (
      event_code, actor_user_id, subject_user_id, module_id, at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const malformedIds = [`USR-ACTOR\0${"x".repeat(1000)}`, PASSWORD_HASH, "USR-BAD@ID"];

  for (const malformedId of malformedIds) {
    assert.throws(
      () => insertPermission.run(malformedId, 0, "pack", 1, 1),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertAudit.run("update_user", malformedId, "USR-ACTOR", FIXED_TIME),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertAudit.run("update_user", "USR-ACTOR", malformedId, FIXED_TIME),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertActivity.run("reports_view", malformedId, "USR-ACTOR", "reports", FIXED_TIME),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertActivity.run("reports_view", "USR-ACTOR", malformedId, "reports", FIXED_TIME),
      /CHECK constraint failed/
    );
  }

  insertPermission.run("USR-ACTOR", 0, "pack", 1, 1);
  insertAudit.run("update_user", "USR-ACTOR", "USR-ACTOR", FIXED_TIME);
  insertActivity.run("reports_view", "USR-ACTOR", null, "reports", FIXED_TIME);
  database.exec("PRAGMA foreign_keys = ON");
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(runSqliteForeignKeyCheck(database), { ok: true, violations: [] });
});

test("migration 004 accepts only canonical UTC millisecond timestamps", async (t) => {
  const { database } = await migratedDatabase(t);
  insertDirectUser(database, { id: "USR-ACTOR", email: "actor@example.local" });
  for (const [index, invalidTimestamp] of [
    "not-a-timestamp",
    "2026-07-16T12:00:00Z",
    "2026-07-16T12:00:00.0000Z",
    "2026-07-16T12:00:00.000+00:00",
    "2026-07-16T12:00:00.000",
    "2026-13-16T12:00:00.000Z",
    "2026-07-32T12:00:00.000Z",
    "2025-02-29T12:00:00.000Z",
    "2026-02-30T12:00:00.000Z",
    "2026-07-16T24:00:00.000Z",
    "2026-07-16T25:00:00.000Z",
    "2026-07-16T12:99:00.000Z",
    "2026-07-16T12:00:60.000Z",
    "2026-07-16 12:00:00.000Z"
  ].entries()) {
    assert.throws(
      () => insertDirectUser(database, {
        id: `USR-TIME-${index}`,
        email: `time-${index}@example.local`,
        createdAt: invalidTimestamp,
        updatedAt: invalidTimestamp
      }),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertDirectUser(database, {
        id: `USR-DELTIME-${index}`,
        email: `delete-time-${index}@example.local`,
        active: false,
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
        deletedAt: invalidTimestamp
      }),
      /CHECK constraint failed/
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO user_audit_logs (event_code, actor_user_id, subject_user_id, at)
        VALUES (?, ?, ?, ?)
      `).run("update_user", "USR-ACTOR", "USR-ACTOR", invalidTimestamp),
      /CHECK constraint failed/
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO user_activity_logs (
          event_code, actor_user_id, subject_user_id, module_id, at
        ) VALUES (?, ?, ?, ?, ?)
      `).run("reports_view", "USR-ACTOR", "USR-ACTOR", "reports", invalidTimestamp),
      /CHECK constraint failed/
    );
  }

  const validBoundary = "2026-07-16T23:59:59.999Z";
  const validLeapDay = "2024-02-29T23:59:59.999Z";
  insertDirectUser(database, {
    id: "USR-TIME-BOUNDARY",
    email: "time-boundary@example.local",
    createdAt: validBoundary,
    updatedAt: validBoundary
  });
  insertDirectUser(database, {
    id: "USR-TIME-LEAP",
    email: "time-leap@example.local",
    createdAt: validLeapDay,
    updatedAt: validLeapDay
  });
  insertDirectUser(database, {
    id: "USR-TIME-DELETED",
    email: "time-deleted@example.local",
    active: false,
    createdAt: validLeapDay,
    updatedAt: validBoundary,
    deletedAt: validBoundary
  });
  for (const validTimestamp of [validBoundary, validLeapDay]) {
    database.prepare(`
      INSERT INTO user_audit_logs (event_code, actor_user_id, subject_user_id, at)
      VALUES (?, ?, ?, ?)
    `).run("update_user", "USR-ACTOR", "USR-ACTOR", validTimestamp);
    database.prepare(`
      INSERT INTO user_activity_logs (
        event_code, actor_user_id, subject_user_id, module_id, at
      ) VALUES (?, ?, ?, ?, ?)
    `).run("reports_view", "USR-ACTOR", "USR-ACTOR", "reports", validTimestamp);
  }
  assert.throws(
    () => insertDirectUser(database, {
      id: "USR-TIME-ORDER",
      email: "time-order@example.local",
      createdAt: FIXED_TIME,
      updatedAt: "2026-07-15T12:00:00.000Z"
    }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertDirectUser(database, {
      id: "USR-TIME-DELETE",
      email: "time-delete@example.local",
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      deletedAt: "2026-07-17T12:00:00.000Z"
    }),
    /CHECK constraint failed/
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 4);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_activity_logs").get().count, 2);
});

test("repository timestamp failures are sanitized and leave no partial rows", async (t) => {
  const { database } = await migratedDatabase(t);
  const repository = createUserRepository(database, {
    now: () => "invalid timestamp private marker"
  });
  const error = expectRepositoryError(
    () => createUser(repository),
    "USER_TIMESTAMP_INVALID"
  );
  assertSanitized(error, ["invalid timestamp private marker", PASSWORD_HASH, "test-salt"]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_activity_logs").get().count, 0);
});

test("caller-controlled identifier factories are rejected without storing credential-shaped values", async (t) => {
  const { database } = await migratedDatabase(t);
  for (const marker of [PASSWORD_HASH, "raw-salt-marker"]) {
    const error = expectRepositoryError(
      () => createUserRepository(database, { idFactory: () => marker }),
      "USER_REPOSITORY_OPTIONS_INVALID"
    );
    assertSanitized(error, [marker]);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_activity_logs").get().count, 0);
});

test("public log reads reject sequences outside the JavaScript safe-integer range", async (t) => {
  const { database } = await migratedDatabase(t);
  insertDirectUser(database, { id: "USR-ACTOR", email: "actor@example.local" });
  database.prepare(`
    INSERT INTO user_audit_logs (
      audit_sequence, event_code, actor_user_id, subject_user_id, at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(9007199254740992n, "update_user", "USR-ACTOR", "USR-ACTOR", FIXED_TIME);
  const repository = createUserRepository(database, { now: fixedNow });

  const error = expectRepositoryError(() => repository.listAuditLogs(), "USER_AUDIT_READ_FAILED");
  assertSanitized(error, ["9007199254740992"]);
});

test("complete User round-trip preserves original email and normalizes lookup once", async (t) => {
  const { repository } = await repositoryFixture(t);
  const created = createUser(repository, sampleUser({ email: "  Mixed.Case@Example.Local  " }));

  assert.deepEqual(created, {
    id: "USR-TEST-1",
    email: "Mixed.Case@Example.Local",
    name: "Test User",
    roleId: "packer",
    roleName: null,
    modulePermissions: [
      { moduleId: "pack", canView: true, canEdit: true },
      { moduleId: "reports", canView: false, canEdit: false }
    ],
    employeeName: "พนักงานทดสอบ",
    employeeId: "EMP-0099",
    active: true,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME
  });
  assert.deepEqual(repository.getUserByEmail(" MIXED.CASE@example.local "), created);
  assert.deepEqual(repository.getUserById(created.id), created);
  assert.equal("passwordSalt" in created, false);
  assert.equal("passwordHash" in created, false);
  assert.equal("emailNormalized" in created, false);
});

test("authentication lookup is the only read that returns credential metadata", async (t) => {
  const { repository } = await repositoryFixture(t);
  const created = createUser(repository);
  const authentication = repository.getUserForAuthenticationByEmail("TEST@EXAMPLE.LOCAL");

  assert.deepEqual(authentication, {
    id: created.id,
    email: created.email,
    emailNormalized: "test@example.local",
    active: true,
    passwordSalt: "test-salt",
    passwordHash: PASSWORD_HASH
  });
  for (const result of [created, repository.getUserById(created.id), repository.getUserByEmail(created.email), ...repository.listUsers()]) {
    assert.equal(result.passwordSalt, undefined);
    assert.equal(result.passwordHash, undefined);
  }
});

test("credential markers stay confined to the explicit internal authentication lookup", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const saltMarker = "SALT_SECRET_MARKER";
  const hashMarker = "c".repeat(64);
  const created = createUser(repository, sampleUser({
    passwordSalt: saltMarker,
    passwordHash: hashMarker
  }));
  const publicSerialization = JSON.stringify({
    created,
    byId: repository.getUserById(created.id),
    byEmail: repository.getUserByEmail(created.email),
    listed: repository.listUsers()
  });
  assert.equal(publicSerialization.includes(saltMarker), false);
  assert.equal(publicSerialization.includes(hashMarker), false);
  assert.equal(repository.getUserForAuthenticationByEmail(created.email).passwordSalt, saltMarker);
  assert.equal(repository.getUserForAuthenticationByEmail(created.email).passwordHash, hashMarker);

  for (const [field, marker] of [
    ["password", "PLAINTEXT_PASSWORD_MARKER"],
    ["token", "TOKEN_MARKER"],
    ["cookie", "COOKIE_MARKER"]
  ]) {
    const error = expectRepositoryError(
      () => createUser(repository, sampleUser({ id: `USR-${field.toUpperCase()}`, email: `${field}@example.local`, [field]: marker })),
      "USER_INPUT_INVALID"
    );
    assertSanitized(error, [marker]);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
});

test("normalized email uniqueness includes inactive Users and uses a stable code", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const created = createUser(repository);
  repository.setUserActive(created.id, false, mutationContext());

  const error = expectRepositoryError(
    () => createUser(repository, sampleUser({ id: "USR-TEST-2", email: " TEST@example.local " })),
    "USER_EMAIL_EXISTS"
  );
  assertSanitized(error, ["TEST@example.local", "test-salt", PASSWORD_HASH]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, 2);
});

test("inactive Users stay listable but active reads and authentication exclude them", async (t) => {
  const { repository } = await repositoryFixture(t);
  const first = createUser(repository);
  createUser(repository, sampleUser({ id: "USR-TEST-2", email: "second@example.local", name: "Second" }));

  const inactive = repository.setUserActive(first.id, false, mutationContext());
  assert.equal(inactive.active, false);
  assert.equal(repository.getUserById(first.id), null);
  assert.equal(repository.getUserByEmail(first.email), null);
  assert.equal(repository.getUserForAuthenticationByEmail(first.email), null);
  assert.equal(repository.getUserById(first.id, { includeInactive: true }).active, false);
  assert.deepEqual(repository.listUsers().map((user) => user.id), ["USR-TEST-1", "USR-TEST-2"]);
  assert.deepEqual(repository.listUsers({ includeInactive: false }).map((user) => user.id), ["USR-TEST-2"]);

  const active = repository.setUserActive(first.id, true, mutationContext());
  assert.equal(active.active, true);
  assert.equal(repository.getUserForAuthenticationByEmail(first.email).id, first.id);
});

test("profile, role, permission, and employee updates round-trip atomically", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const created = createUser(repository);
  const updated = repository.updateUser(created.id, {
    name: "Custom Auditor",
    roleId: "custom",
    roleName: "ผู้ตรวจสอบ",
    employeeName: "ผู้ตรวจ",
    employeeId: "EMP-0100",
    modulePermissions: [
      { moduleId: "reports", canView: false, canEdit: true },
      { moduleId: "users", canView: true, canEdit: false }
    ]
  }, mutationContext());

  assert.equal(updated.name, "Custom Auditor");
  assert.equal(updated.roleId, "custom");
  assert.equal(updated.roleName, "ผู้ตรวจสอบ");
  assert.equal(updated.employeeName, "ผู้ตรวจ");
  assert.equal(updated.employeeId, "EMP-0100");
  assert.deepEqual(updated.modulePermissions, [
    { moduleId: "reports", canView: true, canEdit: true },
    { moduleId: "users", canView: true, canEdit: false }
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_module_permissions").get().count, 2);
  assert.equal(repository.listAuditLogs()[0].action, "update_user");
  assert.equal(repository.listActivityLogs()[0].action, "update_user");
});

test("role changes require and atomically replace the complete permission snapshot", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const created = createUser(repository, sampleUser({
    roleId: "admin",
    modulePermissions: [
      { moduleId: "pack", canView: true, canEdit: true },
      { moduleId: "users", canView: true, canEdit: true }
    ]
  }));

  const missingSnapshot = expectRepositoryError(
    () => repository.updateUser(created.id, { roleId: "packer" }, mutationContext()),
    "USER_ROLE_PERMISSIONS_REQUIRED"
  );
  assertSanitized(missingSnapshot, [created.email]);
  assert.equal(repository.getUserById(created.id).roleId, "admin");
  assert.equal(repository.getUserById(created.id).modulePermissions[1].canEdit, true);
  assert.equal(repository.listAuditLogs().length, 1);

  const demoted = repository.updateUser(created.id, {
    roleId: "packer",
    modulePermissions: [
      { moduleId: "pack", canView: true, canEdit: true },
      { moduleId: "users", canView: false, canEdit: false }
    ]
  }, mutationContext());
  assert.equal(demoted.roleId, "packer");
  assert.equal(demoted.modulePermissions.find((permission) => permission.moduleId === "users").canEdit, false);
  assert.equal(database.prepare(`
    SELECT can_edit FROM user_module_permissions WHERE user_id = ? AND module_id = 'users'
  `).get(created.id).can_edit, 0);
  assert.equal(repository.listAuditLogs()[0].action, "update_user");
  assert.deepEqual(repository.listAuditLogs()[0].changedFields, ["role", "permissions"]);
});

test("permission-only updates cannot contradict packer or admin roles", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const packer = createUser(repository);
  const admin = createUser(repository, sampleUser({
    id: "USR-ADMIN-1",
    email: "admin@example.local",
    roleId: "admin",
    modulePermissions: [
      { moduleId: "pack", canView: true, canEdit: true },
      { moduleId: "users", canView: true, canEdit: true }
    ]
  }));
  const beforeUsers = database.prepare(`
    SELECT id, role_id, role_name, updated_at FROM users ORDER BY user_sequence
  `).all();
  const beforePermissions = database.prepare(`
    SELECT * FROM user_module_permissions ORDER BY user_id, permission_sequence
  `).all();
  const beforeAuditCount = database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count;
  const beforeActivityCount = database.prepare("SELECT COUNT(*) AS count FROM user_activity_logs").get().count;

  for (const [userId, permissions] of [
    [packer.id, [{ moduleId: "users", canView: true, canEdit: true }]],
    [admin.id, [{ moduleId: "users", canView: false, canEdit: false }]]
  ]) {
    const error = expectRepositoryError(
      () => repository.updateUser(userId, { modulePermissions: permissions }, mutationContext(userId)),
      "USER_PERMISSION_UPDATE_PATH_REQUIRED"
    );
    assertSanitized(error, [userId, PASSWORD_HASH, "test-salt"]);
  }

  assert.deepEqual(database.prepare(`
    SELECT id, role_id, role_name, updated_at FROM users ORDER BY user_sequence
  `).all(), beforeUsers);
  assert.deepEqual(database.prepare(`
    SELECT * FROM user_module_permissions ORDER BY user_id, permission_sequence
  `).all(), beforePermissions);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, beforeAuditCount);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_activity_logs").get().count, beforeActivityCount);
});

test("permission, audit, and activity failures each roll back role and permissions", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const created = createUser(repository, sampleUser({
    roleId: "admin",
    modulePermissions: [{ moduleId: "users", canView: true, canEdit: true }]
  }));
  const demotion = {
    roleId: "packer",
    modulePermissions: [{ moduleId: "pack", canView: true, canEdit: true }]
  };

  for (const [triggerName, tableName] of [
    ["reject_permission_insert", "user_module_permissions"],
    ["reject_audit_insert", "user_audit_logs"],
    ["reject_activity_insert", "user_activity_logs"]
  ]) {
    database.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, 'private rollback marker');
      END;
    `);
    const error = expectRepositoryError(
      () => repository.updateUser(created.id, demotion, mutationContext()),
      "USER_UPDATE_FAILED"
    );
    assertSanitized(error, ["private rollback marker", created.email]);
    database.exec(`DROP TRIGGER ${triggerName}`);
    const stored = repository.getUserById(created.id);
    assert.equal(stored.roleId, "admin");
    assert.deepEqual(stored.modulePermissions, [{ moduleId: "users", canView: true, canEdit: true }]);
    assert.equal(repository.listAuditLogs().length, 1);
    assert.equal(repository.listActivityLogs().length, 1);
  }
});

test("custom permission transition rolls back role, permissions, and logs on failure", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const created = createUser(repository);
  database.exec(`
    CREATE TRIGGER reject_custom_transition_activity
    BEFORE INSERT ON user_activity_logs
    BEGIN
      SELECT RAISE(ABORT, 'private custom transition marker');
    END;
  `);

  const error = expectRepositoryError(
    () => repository.replaceUserPermissions(created.id, [
      { moduleId: "users", canView: true, canEdit: true }
    ], mutationContext()),
    "USER_PERMISSIONS_UPDATE_FAILED"
  );
  assertSanitized(error, ["private custom transition marker", created.email]);
  assert.equal(repository.getUserById(created.id).roleId, "packer");
  assert.equal(repository.getUserById(created.id).roleName, null);
  assert.deepEqual(repository.getUserById(created.id).modulePermissions, created.modulePermissions);
  assert.equal(repository.listAuditLogs().length, 1);
  assert.equal(repository.listActivityLogs().length, 1);
});

test("permission replacement and password metadata update expose no credentials publicly", async (t) => {
  const { repository } = await repositoryFixture(t);
  const created = createUser(repository);
  repository.updateUser(created.id, {
    roleId: "custom",
    roleName: "Temporary custom name",
    modulePermissions: created.modulePermissions
  }, mutationContext());
  const permissions = repository.replaceUserPermissions(created.id, [
    { moduleId: "users", canView: false, canEdit: true }
  ], mutationContext());
  assert.deepEqual(permissions.modulePermissions, [
    { moduleId: "users", canView: true, canEdit: true }
  ]);
  assert.equal(permissions.roleId, "custom");
  assert.equal(permissions.roleName, "Custom");

  const updated = repository.updateUserPasswordMetadata(created.id, {
    passwordSalt: "updated-salt",
    passwordHash: UPDATED_PASSWORD_HASH
  }, mutationContext());
  assert.equal(updated.passwordSalt, undefined);
  assert.equal(updated.passwordHash, undefined);
  assert.equal(repository.getUserForAuthenticationByEmail(created.email).passwordSalt, "updated-salt");
  assert.equal(repository.getUserForAuthenticationByEmail(created.email).passwordHash, UPDATED_PASSWORD_HASH);
  assert.deepEqual(repository.listAuditLogs()[0].changedFields, ["password"]);
});

test("plaintext password, unknown fields, malformed permissions, and unbounded input are rejected", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  for (const [input, code] of [
    [{ ...sampleUser(), password: "plaintext" }, "USER_INPUT_INVALID"],
    [{ ...sampleUser(), token: "token-value" }, "USER_INPUT_INVALID"],
    [{ ...sampleUser(), name: "x".repeat(201) }, "USER_INPUT_INVALID"],
    [{ ...sampleUser(), name: `safe\0${"x".repeat(1000)}` }, "USER_INPUT_INVALID"],
    [{ ...sampleUser(), email: "ผู้ใช้@example.local" }, "USER_EMAIL_REQUIRED"],
    [{ ...sampleUser(), passwordSalt: undefined }, "USER_PASSWORD_METADATA_INVALID"],
    [{ ...sampleUser(), passwordHash: undefined }, "USER_PASSWORD_METADATA_INVALID"],
    [{ ...sampleUser(), passwordSalt: `salt\0${"x".repeat(1000)}` }, "USER_PASSWORD_METADATA_INVALID"],
    [{ ...sampleUser(), passwordHash: "not-a-hash" }, "USER_PASSWORD_METADATA_INVALID"],
    [{ ...sampleUser(), modulePermissions: [{ moduleId: "pack", canView: "yes", canEdit: false }] }, "USER_PERMISSIONS_INVALID"],
    [{ ...sampleUser(), modulePermissions: [
      { moduleId: "pack", canView: true, canEdit: false },
      { moduleId: "pack", canView: false, canEdit: false }
    ] }, "USER_PERMISSIONS_INVALID"],
    [{ ...sampleUser(), modulePermissions: [{ moduleId: "pack", canView: true, canEdit: false, raw: {} }] }, "USER_PERMISSIONS_INVALID"]
  ]) {
    expectRepositoryError(() => createUser(repository, input), code);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, 0);
});

test("a real audit insert failure rolls back User creation and update", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  database.exec(`
    CREATE TRIGGER reject_user_audit
    BEFORE INSERT ON user_audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'private database marker');
    END;
  `);
  const createError = expectRepositoryError(
    () => createUser(repository),
    "USER_CREATE_FAILED"
  );
  assertSanitized(createError, ["private database marker", "test@example.local"]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  database.exec("DROP TRIGGER reject_user_audit");

  const created = createUser(repository);
  database.exec(`
    CREATE TRIGGER reject_user_audit
    BEFORE INSERT ON user_audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'private update marker');
    END;
  `);
  expectRepositoryError(
    () => repository.updateUser(created.id, { name: "Must Roll Back" }, mutationContext()),
    "USER_UPDATE_FAILED"
  );
  assert.equal(repository.getUserById(created.id).name, "Test User");
  assert.equal(repository.listAuditLogs().length, 1);
});

test("activity failure is atomic alone and when attached to a User mutation", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  database.exec(`
    CREATE TRIGGER reject_user_activity
    BEFORE INSERT ON user_activity_logs
    BEGIN
      SELECT RAISE(ABORT, 'private activity marker');
    END;
  `);
  expectRepositoryError(
    () => repository.appendActivityLog(activityEntry("reports_view")),
    "USER_ACTIVITY_APPEND_FAILED"
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_activity_logs").get().count, 0);
  expectRepositoryError(() => createUser(repository), "USER_CREATE_FAILED");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, 0);
});

test("standalone structured audit parent and field rows append atomically", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  createUser(repository);
  database.exec(`
    CREATE TRIGGER reject_audit_field
    BEFORE INSERT ON user_audit_log_fields
    BEGIN
      SELECT RAISE(ABORT, 'private audit field marker');
    END;
  `);
  const error = expectRepositoryError(
    () => repository.appendAuditLog(auditEntry("update_user", { changedFields: ["name"] })),
    "USER_AUDIT_APPEND_FAILED"
  );
  assertSanitized(error, ["private audit field marker", PASSWORD_HASH]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_log_fields").get().count, 6);
});

test("structured audit and activity logs are append-only, newest-first, and ID-filtered", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const created = createUser(repository);
  const audit = repository.appendAuditLog(auditEntry("update_user", {
    changedFields: ["name", "active"]
  }));
  const activity = repository.appendActivityLog(activityEntry("reports_view", {
    moduleId: "reports"
  }));

  assert.equal(repository.listAuditLogs()[0].sequence, audit.sequence);
  assert.equal(repository.listActivityLogs()[0].sequence, activity.sequence);
  assert.equal(repository.listActivityLogs({ userId: created.id })[0].sequence, activity.sequence);
  assert.equal(Number.isSafeInteger(audit.sequence), true);
  assert.equal(Number.isSafeInteger(activity.sequence), true);
  assert.equal("id" in audit, false);
  assert.equal("id" in activity, false);
  assert.equal(repository.listActivityLogs({ userId: "USR-MISSING" }).length, 0);
  assert.deepEqual(audit.changedFields, ["name", "active"]);
  assert.equal(audit.details, "update_user:name,active");
  assert.equal(activity.details, "reports_view:reports");
  assert.throws(
    () => database.prepare("UPDATE user_audit_logs SET event_code = 'delete_user' WHERE audit_sequence = ?").run(audit.sequence),
    /append-only/
  );
  assert.throws(
    () => database.prepare("DELETE FROM user_activity_logs WHERE activity_sequence = ?").run(activity.sequence),
    /append-only/
  );
  assert.equal("updateAuditLog" in repository, false);
  assert.equal("deleteAuditLog" in repository, false);
  assert.equal("updateActivityLog" in repository, false);
  assert.equal("deleteActivityLog" in repository, false);
  expectRepositoryError(
    () => repository.appendActivityLog(activityEntry("reports_view", { details: "arbitrary" })),
    "USER_ACTIVITY_INVALID"
  );
});

test("audit and activity pagination is bounded, cursor-based, and deterministic", async (t) => {
  const { repository } = await repositoryFixture(t);
  const created = createUser(repository);
  for (let index = 0; index < 120; index += 1) {
    repository.appendAuditLog(auditEntry("update_user", { changedFields: ["name"] }));
    repository.appendActivityLog(activityEntry("reports_view", { moduleId: "reports" }));
  }

  const defaultAudit = repository.listAuditLogs();
  const defaultActivity = repository.listActivityLogs();
  assert.equal(defaultAudit.length, 100);
  assert.equal(defaultActivity.length, 100);
  assert.equal(defaultAudit.every((row, index) => index === 0 || defaultAudit[index - 1].sequence > row.sequence), true);
  assert.equal(defaultActivity.every((row, index) => index === 0 || defaultActivity[index - 1].sequence > row.sequence), true);
  assert.equal(repository.listAuditLogs({ limit: 500 }).length, 121);
  assert.equal(repository.listActivityLogs({ limit: 500 }).length, 121);
  assert.equal(repository.listAuditLogs({ userId: created.id, limit: 500 }).length, 121);

  const firstPage = repository.listAuditLogs({ limit: 25 });
  const secondPage = repository.listAuditLogs({ limit: 25, beforeSequence: firstPage.at(-1).sequence });
  assert.equal(firstPage.length, 25);
  assert.equal(secondPage.length, 25);
  assert.equal(firstPage.some((row) => secondPage.some((next) => next.sequence === row.sequence)), false);
  assert.equal(secondPage[0].sequence < firstPage.at(-1).sequence, true);
  assert.deepEqual(repository.listAuditLogs({ beforeSequence: 1 }), []);

  for (const invalidLimit of [0, -1, 1.5, "10", Number.NaN, 501]) {
    expectRepositoryError(
      () => repository.listAuditLogs({ limit: invalidLimit }),
      "USER_LOG_PAGE_INVALID"
    );
  }
  for (const invalidCursor of [0, -1, 1.5, "10", Number.NaN]) {
    expectRepositoryError(
      () => repository.listActivityLogs({ beforeSequence: invalidCursor }),
      "USER_LOG_PAGE_INVALID"
    );
  }
});

test("sensitive values never reach logs or repository error serialization", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const markers = [
    "passwordHash=HASH_MARKER",
    "passwordSalt=SALT_MARKER",
    "token=TOKEN_MARKER",
    "cookie=COOKIE_MARKER",
    "rawPayload=RAW_MARKER",
    "customerData=CUSTOMER_MARKER",
    PASSWORD_HASH,
    "test-salt"
  ];
  for (const marker of markers) {
    const auditError = expectRepositoryError(
      () => repository.appendAuditLog({
        ...auditEntry("update_user"),
        targetEmail: "target@example.local",
        details: marker
      }),
      "USER_AUDIT_INVALID"
    );
    const activityError = expectRepositoryError(
      () => repository.appendActivityLog(activityEntry("reports_view", { details: marker })),
      "USER_ACTIVITY_INVALID"
    );
    assertSanitized(auditError, [marker]);
    assertSanitized(activityError, [marker]);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_activity_logs").get().count, 0);
});

test("soft deletion preserves immutable identity, permissions, and structured history", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const created = createUser(repository);
  const deleted = repository.deleteUser(created.id, mutationContext());
  assert.deepEqual(deleted, { id: created.id, email: created.email });
  assert.equal(repository.getUserById(created.id, { includeInactive: true }), null);
  assert.equal(repository.getUserForAuthenticationByEmail(created.email), null);
  const tombstone = database.prepare(`
    SELECT active, deleted_at FROM users WHERE id = ?
  `).get(created.id);
  assert.equal(tombstone.active, 0);
  assert.equal(tombstone.deleted_at, FIXED_TIME);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_module_permissions").get().count, 2);
  assert.equal(repository.listAuditLogs().length, 2);
  assert.equal(repository.listActivityLogs().length, 2);
  assert.equal(repository.listAuditLogs({ userId: created.id }).length, 2);
  expectRepositoryError(
    () => createUser(repository, sampleUser({ id: "USR-TEST-2" })),
    "USER_EMAIL_EXISTS"
  );
  expectRepositoryError(
    () => createUser(repository, sampleUser({ email: "other@example.local" })),
    "USER_ID_EXISTS"
  );
  expectRepositoryError(() => repository.deleteUser(created.id, mutationContext()), "USER_NOT_FOUND");

  const retainedBefore = {
    user: database.prepare("SELECT * FROM users WHERE id = ?").get(created.id),
    permissions: database.prepare(`
      SELECT * FROM user_module_permissions WHERE user_id = ? ORDER BY permission_sequence
    `).all(created.id),
    audits: database.prepare("SELECT * FROM user_audit_logs ORDER BY audit_sequence").all(),
    auditFields: database.prepare(`
      SELECT * FROM user_audit_log_fields ORDER BY audit_sequence, field_sequence
    `).all(),
    activities: database.prepare("SELECT * FROM user_activity_logs ORDER BY activity_sequence").all()
  };

  assert.throws(() => database.prepare("DELETE FROM users WHERE id = ?").run(created.id), /soft-deleted/);
  for (const [sql, values] of [
    ["UPDATE users SET name = ? WHERE id = ?", ["Mutated", created.id]],
    ["UPDATE users SET email = ? WHERE id = ?", ["reassigned@example.local", created.id]],
    ["UPDATE users SET role_id = ? WHERE id = ?", ["admin", created.id]],
    ["UPDATE users SET active = ? WHERE id = ?", [1, created.id]],
    ["UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?", ["new-salt", UPDATED_PASSWORD_HASH, created.id]],
    ["UPDATE users SET created_at = ? WHERE id = ?", ["2026-07-15T12:00:00.000Z", created.id]],
    ["UPDATE users SET updated_at = ? WHERE id = ?", ["2026-07-17T12:00:00.000Z", created.id]],
    ["UPDATE users SET deleted_at = NULL WHERE id = ?", [created.id]],
    ["UPDATE users SET deleted_at = ? WHERE id = ?", ["2026-07-17T12:00:00.000Z", created.id]]
  ]) {
    assert.throws(() => database.prepare(sql).run(...values), /immutable/);
  }
  assert.throws(
    () => database.prepare(`
      INSERT INTO user_module_permissions (
        user_id, permission_sequence, module_id, can_view, can_edit
      ) VALUES (?, ?, ?, ?, ?)
    `).run(created.id, 2, "users", 1, 1),
    /permissions are immutable/
  );
  assert.throws(
    () => database.prepare(`
      UPDATE user_module_permissions SET can_view = 1
      WHERE user_id = ? AND module_id = 'reports'
    `).run(created.id),
    /permissions are immutable/
  );
  assert.throws(
    () => database.prepare(`
      UPDATE user_module_permissions SET user_id = ?
      WHERE user_id = ? AND module_id = 'pack'
    `).run("USR-OTHER-1", created.id),
    /permissions are immutable/
  );
  insertDirectUser(database, { id: "USR-OTHER-1", email: "other-active@example.local" });
  database.prepare(`
    INSERT INTO user_module_permissions (
      user_id, permission_sequence, module_id, can_view, can_edit
    ) VALUES (?, ?, ?, ?, ?)
  `).run("USR-OTHER-1", 0, "pack", 1, 1);
  assert.throws(
    () => database.prepare(`
      UPDATE user_module_permissions SET user_id = ?
      WHERE user_id = ? AND module_id = 'pack'
    `).run(created.id, "USR-OTHER-1"),
    /permissions are immutable/
  );
  assert.throws(
    () => database.prepare("DELETE FROM user_module_permissions WHERE user_id = ?").run(created.id),
    /permissions are immutable/
  );

  const retainedAfter = {
    user: database.prepare("SELECT * FROM users WHERE id = ?").get(created.id),
    permissions: database.prepare(`
      SELECT * FROM user_module_permissions WHERE user_id = ? ORDER BY permission_sequence
    `).all(created.id),
    audits: database.prepare("SELECT * FROM user_audit_logs ORDER BY audit_sequence").all(),
    auditFields: database.prepare(`
      SELECT * FROM user_audit_log_fields ORDER BY audit_sequence, field_sequence
    `).all(),
    activities: database.prepare("SELECT * FROM user_activity_logs ORDER BY activity_sequence").all()
  };
  assert.deepEqual(retainedAfter, retainedBefore);
  assert.deepEqual(runSqliteForeignKeyCheck(database), { ok: true, violations: [] });
});

test("structured log failure rolls back the complete soft delete", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  const created = createUser(repository);
  database.exec(`
    CREATE TRIGGER reject_delete_activity
    BEFORE INSERT ON user_activity_logs
    BEGIN
      SELECT RAISE(ABORT, 'private delete marker');
    END;
  `);
  const error = expectRepositoryError(
    () => repository.deleteUser(created.id, mutationContext()),
    "USER_DELETE_FAILED"
  );
  assertSanitized(error, ["private delete marker", created.email, PASSWORD_HASH]);
  const stored = database.prepare(`
    SELECT active, deleted_at FROM users WHERE id = ?
  `).get(created.id);
  assert.equal(stored.active, 1);
  assert.equal(stored.deleted_at, null);
  assert.equal(repository.getUserForAuthenticationByEmail(created.email).id, created.id);
  assert.equal(repository.listAuditLogs().length, 1);
  assert.equal(repository.listActivityLogs().length, 1);
});

test("missing Users and unsupported nested transactions produce no false audit entries", async (t) => {
  const { repository, database } = await repositoryFixture(t);
  expectRepositoryError(
    () => repository.updateUser("USR-MISSING", { name: "Missing" }, mutationContext()),
    "USER_NOT_FOUND"
  );
  assert.equal(repository.listAuditLogs().length, 0);
  assert.throws(
    () => runInSqliteTransaction(database, () => createUser(repository)),
    (error) => error instanceof UserRepositoryError && error.code === "USER_CREATE_FAILED"
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_audit_logs").get().count, 0);
});

test("schema stores no plaintext password, sessions, tokens, or generic User payload", async (t) => {
  const { database } = await migratedDatabase(t);
  const columns = database.prepare("PRAGMA table_info(users)").all().map((row) => row.name);
  assert.equal(columns.includes("password"), false);
  assert.equal(columns.includes("payload_json"), false);
  assert.equal(columns.includes("raw_json"), false);
  assert.equal(columns.includes("token"), false);
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
  `).all().map((row) => row.name);
  assert.equal(tables.some((name) => /session|token|connection/i.test(name)), false);
  for (const table of ["user_audit_logs", "user_activity_logs"]) {
    const logColumns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert.equal(logColumns.some((name) => /details|changes|before|after|payload|password|salt|hash|token|session|authorization/i.test(name)), false);
  }
});

test("repository module has no filesystem or runtime JSON dependency", async () => {
  const source = await readFile(new URL("../src/storage/userRepository.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:fs|readFile|writeFile|runtime|app-config|SMARTRECORD_SQLITE_DATABASE_PATH/);
});

async function migratedDatabase(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "smartrecord-users-repository-"));
  const databasePath = path.join(directory, "users.sqlite");
  const database = await openSqliteDatabase(databasePath);
  t.after(async () => {
    closeSqliteDatabase(database);
    await rm(directory, { recursive: true, force: true });
  });
  await runSqliteMigrations(database, { now: fixedNow });
  return { database, databasePath, directory };
}

async function repositoryFixture(t) {
  const fixture = await migratedDatabase(t);
  return {
    ...fixture,
    repository: createUserRepository(fixture.database, {
      now: fixedNow
    })
  };
}

function sampleUser(overrides = {}) {
  return {
    id: "USR-TEST-1",
    email: "test@example.local",
    name: "Test User",
    roleId: "packer",
    roleName: null,
    modulePermissions: [
      { moduleId: "pack", canView: true, canEdit: true },
      { moduleId: "reports", canView: false, canEdit: false }
    ],
    employeeName: "พนักงานทดสอบ",
    employeeId: "EMP-0099",
    active: true,
    passwordSalt: "test-salt",
    passwordHash: PASSWORD_HASH,
    ...overrides
  };
}

function createUser(repository, user = sampleUser()) {
  return repository.createUser(
    user,
    mutationContext(user.id)
  );
}

function mutationContext(actorUserId = "USR-TEST-1") {
  return { actorUserId };
}

function auditEntry(eventCode = "update_user", overrides = {}) {
  return {
    actorUserId: "USR-TEST-1",
    subjectUserId: "USR-TEST-1",
    eventCode,
    changedFields: ["name"],
    ...overrides
  };
}

function activityEntry(eventCode = "reports_view", overrides = {}) {
  return {
    actorUserId: "USR-TEST-1",
    subjectUserId: "USR-TEST-1",
    eventCode,
    moduleId: "users",
    ...overrides
  };
}

function fixedNow() {
  return new Date(FIXED_TIME);
}

function insertDirectUser(database, {
  id,
  email,
  name = "Direct User",
  passwordSalt = "direct-salt",
  passwordHash = PASSWORD_HASH,
  active = true,
  createdAt = FIXED_TIME,
  updatedAt = FIXED_TIME,
  deletedAt = null
}) {
  database.prepare(`
    INSERT INTO users (
      id, email, name, role_id, role_name,
      employee_name, employee_id, active, password_salt, password_hash,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    email,
    name,
    "packer",
    null,
    null,
    null,
    active ? 1 : 0,
    passwordSalt,
    passwordHash,
    createdAt,
    updatedAt,
    deletedAt
  );
}

function expectRepositoryError(callback, code) {
  let caught;
  assert.throws(() => {
    try {
      callback();
    } catch (error) {
      caught = error;
      throw error;
    }
  }, (error) => {
    assert.equal(error instanceof UserRepositoryError, true);
    assert.equal(error.code, code);
    return true;
  });
  return caught;
}

function assertSanitized(error, markers) {
  const serialized = [
    error.message,
    error.stack,
    String(error.cause || ""),
    JSON.stringify(error),
    inspect(error, { depth: 8 })
  ].join("\n");
  for (const marker of markers) assert.equal(serialized.includes(marker), false);
  assert.equal(error.cause, undefined);
}
