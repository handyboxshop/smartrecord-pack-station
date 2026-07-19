import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { closeSqliteDatabase, openInMemoryDatabase, openSqliteDatabase } from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import { createUserImportPlan } from "../src/storage/userImportPlan.mjs";
import { importUsers } from "../src/storage/userImporter.mjs";
import { bootstrapInitialAdmin } from "../src/domain/initialAdminBootstrap.mjs";

function modules() {
  return [
    { id: "pack", label: "Pack", section: "Ops", viewPermission: "pack:use", editPermission: "pack:use" },
    { id: "users", label: "Users", section: "Admin", viewPermission: "users:manage", editPermission: "users:manage" }
  ];
}
function permissions(pack = [true, true], users = [false, false]) {
  return [{ moduleId: "pack", canView: pack[0], canEdit: pack[1] }, { moduleId: "users", canView: users[0], canEdit: users[1] }];
}
function roles() {
  return [{ id: "packer", label: "Packer", modulePermissions: permissions() }, { id: "custom", label: "Custom", modulePermissions: permissions([false, false]) }];
}
function user(index = 1, overrides = {}) {
  return { id: `USR-${index}`, username: `user.${index}`, email: `User${index}@Example.test`, name: `User ${index}`, roleId: "packer", active: true, passwordSalt: `salt-${index}`, passwordHash: String(index).repeat(64), ...overrides };
}
function plan(users = [user()]) {
  return createUserImportPlan(users, { roles: roles(), modules: modules(), usernameAssignments: {}, sourceManifestSha256: "c".repeat(64) });
}
async function database(version = 5) {
  const db = await openInMemoryDatabase();
  await runSqliteMigrations(db, { maximumVersion: Math.min(version, 5) });
  if (version > 5) db.exec(`PRAGMA user_version = ${version}`);
  return db;
}

test("schema 5 import maps every field, sequence, credential, and canonical timestamp exactly", async () => {
  const db = await database();
  const users = [
    user(1, { email: "legacy.login", active: false, employeeName: "  Operator One  ", employeeId: "  E-1  " }),
    user(2, { roleId: "custom", roleName: "  Returns  ", modulePermissions: permissions([true, false], [true, true]), passwordSalt: "exact+salt/==" })
  ];
  const importedAt = "2026-06-01T02:03:04.005Z";
  const result = importUsers(db, plan(users), { now: () => new Date(importedAt) });
  assert.deepEqual({ ...result, verification: undefined }, {
    ok: true, status: "committed", committed: true, importedUserCount: 2,
    importedPermissionCount: 4, importedAt, verification: undefined
  });
  assert.equal(result.verification.ok, true);
  const stored = db.prepare("SELECT * FROM main.users ORDER BY user_sequence").all();
  assert.equal(stored[0].user_sequence, 1);
  assert.equal(stored[0].email, "legacy.login");
  assert.equal(stored[0].employee_name, "Operator One");
  assert.equal(stored[0].employee_id, "E-1");
  assert.equal(stored[0].active, 0);
  assert.equal(stored[1].user_sequence, 2);
  assert.equal(stored[1].role_name, "Returns");
  assert.equal(stored[1].password_salt, "exact+salt/==");
  assert.equal(stored[1].password_hash, "2".repeat(64));
  assert.ok(stored.every((row) => row.created_at === importedAt && row.updated_at === importedAt && row.deleted_at === null));
  assert.deepEqual(db.prepare("SELECT user_id,permission_sequence,module_id FROM main.user_module_permissions ORDER BY user_id,permission_sequence").all().map((row) => ({ ...row })), [
    { user_id: "USR-1", permission_sequence: 0, module_id: "pack" },
    { user_id: "USR-1", permission_sequence: 1, module_id: "users" },
    { user_id: "USR-2", permission_sequence: 0, module_id: "pack" },
    { user_id: "USR-2", permission_sequence: 1, module_id: "users" }
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.user_audit_logs").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.user_activity_logs").get().count, 0);
  assert.deepEqual({ ...db.prepare("SELECT name,seq FROM main.sqlite_sequence WHERE name LIKE 'user%' ORDER BY name").get() }, { name: "users", seq: 2 });
  assert.equal(db.prepare("SELECT 1 AS usable").get().usable, 1);
  closeSqliteDatabase(db);
});

test("schema versions 4 and 6 are rejected without mutation", async () => {
  for (const version of [4, 6]) {
    const db = await database(version);
    assert.throws(() => importUsers(db, plan()), { code: "USERS_IMPORT_SCHEMA_REQUIRED" });
    if (version === 4) assert.equal(db.prepare("SELECT COUNT(*) count FROM main.users").get().count, 0);
    closeSqliteDatabase(db);
  }
});

test("missing, forged, and checksum-mismatched migration histories fail closed", async () => {
  for (const mutation of [
    "DELETE FROM main.schema_migrations WHERE version=5",
    "UPDATE main.schema_migrations SET name='forged.sql' WHERE version=5",
    "UPDATE main.schema_migrations SET checksum_sha256='0' WHERE version=5"
  ]) {
    const db = await database();
    db.exec(mutation);
    assert.throws(() => importUsers(db, plan()), { code: "USERS_IMPORT_SCHEMA_REQUIRED" });
    assert.equal(db.prepare("SELECT COUNT(*) count FROM main.users").get().count, 0);
    closeSqliteDatabase(db);
  }
});

test("malformed required indexes or triggers and TEMP shadows fail exact schema validation", async () => {
  const mutations = [
    "DROP INDEX main.users_username_normalized_unique",
    "DROP TRIGGER main.users_require_username_on_insert",
    "CREATE TEMP VIEW users AS SELECT 1"
  ];
  for (const mutation of mutations) {
    const db = await database();
    db.exec(mutation);
    assert.throws(() => importUsers(db, plan()), { code: "USERS_IMPORT_SCHEMA_REQUIRED" });
    closeSqliteDatabase(db);
  }
});

test("foreign keys disabled, nonempty destination, and stale sequence state are rejected", async () => {
  const disabled = await database();
  disabled.exec("PRAGMA foreign_keys=OFF");
  assert.throws(() => importUsers(disabled, plan()), { code: "USERS_IMPORT_SCHEMA_REQUIRED" });
  closeSqliteDatabase(disabled);

  const nonempty = await database();
  importUsers(nonempty, plan());
  assert.throws(() => importUsers(nonempty, plan([user(2)])), { code: "USERS_IMPORT_DESTINATION_NOT_EMPTY" });
  closeSqliteDatabase(nonempty);

  const stale = await database();
  stale.prepare("INSERT INTO main.sqlite_sequence(name,seq) VALUES('users',0)").run();
  assert.throws(() => importUsers(stale, plan()), { code: "USERS_IMPORT_DESTINATION_NOT_EMPTY" });
  closeSqliteDatabase(stale);
});

test("invalid clocks fail before BEGIN and preserve all five empty tables", async () => {
  const db = await database();
  assert.throws(() => importUsers(db, plan(), { now: () => new Date("invalid") }), { code: "USERS_IMPORT_USAGE_INVALID" });
  for (const table of ["users", "user_module_permissions", "user_audit_logs", "user_audit_log_fields", "user_activity_logs"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM main.${table}`).get().count, 0);
  }
  assert.equal(db.isTransaction, false);
  closeSqliteDatabase(db);
});

test("unrelated valid storage metadata may coexist with a fresh Users import", async () => {
  const db = await database();
  db.prepare("INSERT INTO main.storage_metadata(key,value_json,updated_at) VALUES(?,?,?)")
    .run("unrelated", "{\"ok\":true}", "2026-01-01T00:00:00.000Z");
  const result = importUsers(db, plan());
  assert.equal(result.committed, true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.storage_metadata").get().count, 1);
  closeSqliteDatabase(db);
});

test("insert failure rolls back users, permissions, and sequence state", async () => {
  const db = await database();
  const wrapper = wrapDatabase(db, {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes("INSERT INTO main.user_module_permissions")) return statement;
      return { run() { throw new Error("SENSITIVE SQLITE FAILURE"); } };
    }
  });
  assert.throws(() => importUsers(wrapper, plan()), { code: "USERS_IMPORT_TRANSACTION_FAILED" });
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.users").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.user_module_permissions").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.sqlite_sequence WHERE name='users'").get().count, 0);
  closeSqliteDatabase(db);
});

test("an in-transaction verifier mismatch rolls back the complete import", async () => {
  const db = await database();
  const wrapper = wrapDatabase(db, {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes("FROM main.users ORDER BY user_sequence")) return statement;
      return { all() { return []; } };
    }
  });
  assert.throws(() => importUsers(wrapper, plan()), { code: "USERS_IMPORT_IN_TRANSACTION_VERIFICATION_FAILED" });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.users").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.sqlite_sequence WHERE name='users'").get().count, 0);
  closeSqliteDatabase(db);
});

test("an in-transaction verifier read failure is classified and rolls back", async () => {
  const db = await database();
  const wrapper = wrapDatabase(db, {
    prepare(sql) { if (sql.includes("FROM main.users ORDER BY user_sequence")) throw new Error("RAW VERIFY"); return db.prepare(sql); }
  });
  assert.throws(() => importUsers(wrapper, plan()), { code: "USERS_IMPORT_IN_TRANSACTION_VERIFICATION_FAILED" });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.users").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.sqlite_sequence WHERE name='users'").get().count, 0);
  closeSqliteDatabase(db);
});

test("rollback failure is distinguished with a stable sanitized code", async () => {
  const db = await database();
  const wrapper = wrapDatabase(db, {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes("INSERT INTO main.users")) return statement;
      return { run() { throw new Error("RAW INSERT FAILURE"); } };
    },
    exec(sql) {
      if (sql === "ROLLBACK") throw new Error("RAW ROLLBACK FAILURE");
      return db.exec(sql);
    }
  });
  assert.throws(() => importUsers(wrapper, plan()), (error) => {
    assert.equal(error.code, "USERS_IMPORT_ROLLBACK_FAILED");
    assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /RAW|INSERT FAILURE|ROLLBACK FAILURE/);
    return true;
  });
  closeSqliteDatabase(db);
});

test("a thrown COMMIT after the real commit is outcome-unknown and is never rolled back", async () => {
  const db = await database();
  let rollbackCalls = 0;
  const wrapper = wrapDatabase(db, {
    exec(sql) {
      if (sql === "COMMIT") { db.exec(sql); throw new Error("ambiguous transport"); }
      if (sql === "ROLLBACK") rollbackCalls += 1;
      return db.exec(sql);
    }
  });
  assert.throws(() => importUsers(wrapper, plan()), (error) => {
    assert.equal(error.code, "USERS_IMPORT_COMMIT_OUTCOME_UNKNOWN");
    assert.equal(error.transactionState, "outcome-unknown");
    return true;
  });
  assert.equal(rollbackCalls, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM main.users").get().count, 1);
  closeSqliteDatabase(db);
});

test("two file-backed connections have at most one fresh-import winner", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "user-import-concurrency-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "users.sqlite");
  const first = await openSqliteDatabase(databasePath);
  await runSqliteMigrations(first);
  closeSqliteDatabase(first);
  const left = await openSqliteDatabase(databasePath);
  const right = await openSqliteDatabase(databasePath);
  const successes = [];
  const failures = [];
  for (const db of [left, right]) {
    try { successes.push(importUsers(db, plan())); }
    catch (error) { failures.push(error); }
  }
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "USERS_IMPORT_DESTINATION_NOT_EMPTY");
  closeSqliteDatabase(left);
  closeSqliteDatabase(right);
});

test("initial-admin bootstrap and fresh import are mutually exclusive", async () => {
  const db = await database();
  bootstrapInitialAdmin(db, {
    username: "Initial.Owner", email: "owner@example.test",
    displayName: "Initial Owner", password: "synthetic-password"
  }, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    randomUUID: () => "00112233-4455-6677-8899-aabbccddeeff",
    createPasswordCredentials: () => ({ passwordSalt: "bootstrap-salt", passwordHash: "f".repeat(64) })
  });
  assert.throws(() => importUsers(db, plan()), { code: "USERS_IMPORT_DESTINATION_NOT_EMPTY" });
  closeSqliteDatabase(db);
});

function wrapDatabase(database, overrides) {
  return {
    prepare: overrides.prepare ?? ((sql) => database.prepare(sql)),
    exec: overrides.exec ?? ((sql) => database.exec(sql)),
    get isTransaction() { return database.isTransaction; }
  };
}
