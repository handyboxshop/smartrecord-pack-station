import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { closeSqliteDatabase, openInMemoryDatabase } from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import { createUserImportPlan, disposeUserImportPlan } from "../src/storage/userImportPlan.mjs";
import { importUsers } from "../src/storage/userImporter.mjs";
import { verifyUserImport } from "../src/storage/userImportVerifier.mjs";

const IMPORTED_AT = "2026-02-03T04:05:06.007Z";
function configuration() {
  const modules = [
    { id: "pack", label: "Pack", section: "Ops", viewPermission: "pack:use", editPermission: "pack:use" },
    { id: "users", label: "Users", section: "Admin", viewPermission: "users:manage", editPermission: "users:manage" }
  ];
  const permissions = [{ moduleId: "pack", canView: true, canEdit: true }, { moduleId: "users", canView: false, canEdit: false }];
  return { modules, roles: [{ id: "packer", label: "Packer", modulePermissions: permissions }] };
}
function user(overrides = {}) {
  return { id: "USR-ONE", username: "one.user", email: "One@Example.test", name: "One User", roleId: "packer", active: true, passwordSalt: "SENSITIVE-VERIFY-SALT", passwordHash: "a".repeat(64), ...overrides };
}
async function fixture() {
  const database = await openInMemoryDatabase();
  await runSqliteMigrations(database);
  const config = configuration();
  const plan = createUserImportPlan([user()], { ...config, usernameAssignments: {}, sourceManifestSha256: "d".repeat(64) });
  importUsers(database, plan, { now: () => new Date(IMPORTED_AT) });
  return { database, plan };
}

test("standalone verification uses and closes its own deferred snapshot", async () => {
  const { database, plan } = await fixture();
  assert.equal(database.isTransaction, false);
  const report = verifyUserImport(database, plan, { importedAt: IMPORTED_AT });
  assert.equal(report.ok, true);
  assert.equal(report.status, "verified");
  assert.equal(database.isTransaction, false);
  assert.equal(database.prepare("SELECT 1 usable").get().usable, 1);
  closeSqliteDatabase(database);
});

test("verification does not commit or roll back a caller-owned transaction", async () => {
  const { database, plan } = await fixture();
  database.exec("BEGIN");
  const report = verifyUserImport(database, plan, { importedAt: IMPORTED_AT });
  assert.equal(report.ok, true);
  assert.equal(database.isTransaction, true);
  database.exec("ROLLBACK");
  closeSqliteDatabase(database);
});

test("all stored user, generated identity, credential, permission, and sequence fields participate in parity", async () => {
  const mutations = [
    "UPDATE main.users SET name='Different Valid Name' WHERE id='USR-ONE'",
    `UPDATE main.users SET password_hash='${"b".repeat(64)}' WHERE id='USR-ONE'`,
    "UPDATE main.user_module_permissions SET can_edit=0 WHERE user_id='USR-ONE' AND module_id='pack'",
    "UPDATE main.sqlite_sequence SET seq=99 WHERE name='users'"
  ];
  for (const mutation of mutations) {
    const { database, plan } = await fixture();
    database.exec(mutation);
    const report = verifyUserImport(database, plan, { importedAt: IMPORTED_AT });
    assert.equal(report.ok, false);
    assert.equal(report.status, "mismatch");
    assert.ok(report.issueCodeCounts.length > 0);
    closeSqliteDatabase(database);
  }
});

test("missing and extra valid rows are aggregate mismatches", async () => {
  const missing = await fixture();
  missing.database.prepare("DELETE FROM main.user_module_permissions WHERE user_id=? AND module_id=?").run("USR-ONE", "users");
  let report = verifyUserImport(missing.database, missing.plan, { importedAt: IMPORTED_AT });
  assert.equal(report.status, "mismatch");
  assert.equal(report.actualPermissionCount, 1);
  closeSqliteDatabase(missing.database);

  const extra = await fixture();
  extra.database.prepare("INSERT INTO main.user_module_permissions(user_id,permission_sequence,module_id,can_view,can_edit) VALUES(?,?,?,?,?)")
    .run("USR-ONE", 2, "extra", 0, 0);
  report = verifyUserImport(extra.database, extra.plan, { importedAt: IMPORTED_AT });
  assert.equal(report.status, "mismatch");
  assert.equal(report.actualPermissionCount, 3);
  closeSqliteDatabase(extra.database);
});

test("standalone verification rolls back its owned snapshot after a read failure", async () => {
  const { database, plan } = await fixture();
  const wrapper = {
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      if (sql.includes("FROM main.users ORDER BY user_sequence")) throw new Error("RAW READ FAILURE");
      return database.prepare(sql);
    },
    get isTransaction() { return database.isTransaction; }
  };
  assert.throws(() => verifyUserImport(wrapper, plan, { importedAt: IMPORTED_AT }), {
    code: "USERS_IMPORT_STORED_DATA_INVALID"
  });
  assert.equal(database.isTransaction, false);
  assert.equal(database.prepare("SELECT 1 usable").get().usable, 1);
  closeSqliteDatabase(database);
});

test("malformed semantic stored data is classified separately from ordinary mismatch", async () => {
  const { database, plan } = await fixture();
  database.exec("PRAGMA ignore_check_constraints=ON");
  database.exec("UPDATE main.users SET active=2 WHERE id='USR-ONE'");
  const report = verifyUserImport(database, plan, { importedAt: IMPORTED_AT });
  assert.equal(report.ok, false);
  assert.equal(report.status, "stored-data-invalid");
  closeSqliteDatabase(database);
});

test("multiple malformed stored scalar categories are never reported as ordinary mismatch", async () => {
  for (const mutation of [
    "UPDATE main.users SET name=' bad ' WHERE id='USR-ONE'",
    "UPDATE main.users SET updated_at='2020-01-01T00:00:00.000Z' WHERE id='USR-ONE'",
    "UPDATE main.user_module_permissions SET can_view=0, can_edit=1 WHERE user_id='USR-ONE' AND module_id='pack'"
  ]) {
    const { database, plan } = await fixture();
    database.exec("PRAGMA ignore_check_constraints=ON");
    database.exec(mutation);
    assert.equal(verifyUserImport(database, plan, { importedAt: IMPORTED_AT }).status, "stored-data-invalid");
    closeSqliteDatabase(database);
  }
});

test("stored tombstones enforce active state and forward timestamp chronology", async () => {
  const cases = [
    { active: 0, deletedAt: "2026-02-03T04:05:07.000Z", updatedAt: "2026-02-03T04:05:08.000Z", status: "mismatch" },
    { active: 1, deletedAt: "2026-02-03T04:05:07.000Z", updatedAt: "2026-02-03T04:05:08.000Z", status: "stored-data-invalid" },
    { active: 0, deletedAt: "2026-02-03T04:05:05.000Z", updatedAt: "2026-02-03T04:05:08.000Z", status: "stored-data-invalid" },
    { active: 0, deletedAt: "2026-02-03T04:05:08.000Z", updatedAt: "2026-02-03T04:05:07.000Z", status: "stored-data-invalid" }
  ];
  for (const entry of cases) {
    const { database, plan } = await fixture();
    database.exec("PRAGMA ignore_check_constraints=ON");
    database.prepare("UPDATE main.users SET active=?, deleted_at=?, updated_at=? WHERE id='USR-ONE'")
      .run(entry.active, entry.deletedAt, entry.updatedAt);
    const report = verifyUserImport(database, plan, { importedAt: IMPORTED_AT });
    assert.equal(report.status, entry.status);
    assert.doesNotMatch(`${JSON.stringify(report)}\n${inspect(report)}`, /USR-ONE|2026-02-03T04:05:0[578]\.000Z|SENSITIVE/i);
    closeSqliteDatabase(database);
  }
});

test("audit and activity contamination is reported without exposing its values", async () => {
  const { database, plan } = await fixture();
  database.prepare("INSERT INTO main.user_audit_logs(event_code,actor_user_id,subject_user_id,at) VALUES(?,?,?,?)")
    .run("update_user", "USR-ONE", "USR-ONE", IMPORTED_AT);
  const report = verifyUserImport(database, plan, { importedAt: IMPORTED_AT });
  assert.equal(report.status, "mismatch");
  assert.equal(report.auditRowCount, 1);
  assert.doesNotMatch(`${JSON.stringify(report)}\n${inspect(report)}`, /USR-ONE|SENSITIVE|password|salt/i);
  closeSqliteDatabase(database);
});

test("safe report is recursively frozen and contains only aggregate fields", async () => {
  const { database, plan } = await fixture();
  const report = verifyUserImport(database, plan, { importedAt: IMPORTED_AT });
  const expectedKeys = [
    "ok", "status", "expectedUserCount", "actualUserCount", "expectedPermissionCount",
    "actualPermissionCount", "verifiedUserCount", "mismatchedUserCount", "auditRowCount",
    "auditFieldRowCount", "activityRowCount", "issueCodeCounts", "quickCheckStatus",
    "foreignKeyViolationCount", "importedAt"
  ];
  assert.deepEqual(Object.keys(report), expectedKeys);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.issueCodeCounts), true);
  assert.doesNotMatch(`${JSON.stringify(report)}\n${inspect(report)}`, /USR-ONE|One@|SENSITIVE|aaaaaaaa/);
  closeSqliteDatabase(database);
});

test("disposed plans and invalid timestamps fail with fixed sanitized errors and leave database open", async () => {
  const { database, plan } = await fixture();
  disposeUserImportPlan(plan);
  assert.throws(() => verifyUserImport(database, plan, { importedAt: IMPORTED_AT }), (error) => {
    assert.equal(error.code, "USERS_IMPORT_USAGE_INVALID");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(`${error.message}\n${error.stack}\n${inspect(error)}`, /USR-ONE|SENSITIVE|sqlite/i);
    return true;
  });
  assert.equal(database.prepare("SELECT 1 usable").get().usable, 1);
  closeSqliteDatabase(database);
});
