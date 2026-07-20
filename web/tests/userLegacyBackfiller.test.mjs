import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { closeSqliteDatabase, openInMemoryDatabase } from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import { createUserLegacyBackfillPlan } from "../src/storage/userLegacyBackfillPlan.mjs";
import * as api from "../src/storage/userLegacyBackfiller.mjs";

const user = { id: "USR-ONE", email: "one@example.test", name: "One User", roleId: "packer", active: true, passwordSalt: "sensitive-salt", passwordHash: "a".repeat(64) };
const modules = [{ id: "pack", label: "Pack", section: "Ops", viewPermission: "pack:use", editPermission: "pack:use" }];
const permission = { moduleId: "pack", canView: true, canEdit: true };
const roles = [{ id: "packer", label: "Packer", modulePermissions: [permission] }];
const options = { roles, modules, passwordPolicy: undefined, usernameAssignments: { "USR-ONE": "one.user" }, sourceManifestSha256: "b".repeat(64) };

async function fixture() {
  const db = await openInMemoryDatabase();
  await runSqliteMigrations(db, { maximumVersion: 4, now: () => new Date("2026-01-01T00:00:00.000Z") });
  db.prepare(`INSERT INTO main.users (user_sequence,id,email,name,role_id,role_name,employee_name,employee_id,active,password_salt,password_hash,created_at,updated_at,deleted_at)
    VALUES (1,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?,NULL)`).run(user.id, user.email, user.name, user.roleId, 1, user.passwordSalt, user.passwordHash, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  db.prepare("INSERT INTO main.user_module_permissions(user_id,permission_sequence,module_id,can_view,can_edit) VALUES(?,0,'pack',1,1)").run(user.id);
  await runSqliteMigrations(db, { now: () => new Date("2026-01-03T00:00:00.000Z") });
  return db;
}

test("public API is exact and CAS backfill preserves every protected value", async () => {
  assert.deepEqual(Object.keys(api), ["UserLegacyBackfillError", "backfillLegacyUsernames"]);
  const db = await fixture();
  db.prepare("INSERT INTO main.user_audit_logs(audit_sequence,event_code,actor_user_id,subject_user_id,at) VALUES(1,'update_user',?,?,?)")
    .run(user.id, user.id, "2026-01-03T00:00:00.000Z");
  db.prepare("INSERT INTO main.user_audit_log_fields(audit_sequence,field_sequence,field_name) VALUES(1,0,'name')").run();
  db.prepare("INSERT INTO main.user_activity_logs(activity_sequence,event_code,actor_user_id,subject_user_id,module_id,at) VALUES(1,'login',?,NULL,'auth',?)")
    .run(user.id, "2026-01-03T00:00:00.000Z");
  const before = { ...db.prepare("SELECT * FROM main.users").get() };
  const permissionsBefore = JSON.stringify(db.prepare("SELECT user_id,permission_sequence,module_id,can_view,can_edit FROM main.user_module_permissions").all());
  const auditBefore = JSON.stringify(db.prepare("SELECT * FROM main.user_audit_logs ORDER BY audit_sequence").all());
  const auditFieldsBefore = JSON.stringify(db.prepare("SELECT * FROM main.user_audit_log_fields ORDER BY audit_sequence,field_sequence").all());
  const activityBefore = JSON.stringify(db.prepare("SELECT * FROM main.user_activity_logs ORDER BY activity_sequence").all());
  const sequencesBefore = JSON.stringify(db.prepare("SELECT name,seq FROM main.sqlite_sequence WHERE name LIKE 'user%' ORDER BY name").all());
  const plan = createUserLegacyBackfillPlan([user], options, db);
  const result = api.backfillLegacyUsernames(db, plan);
  assert.deepEqual({ ...result }, { status: "backfilled", committed: true, userCount: 1, requiredBackfillCount: 1, backfilledCount: 1 });
  assert.equal(Object.isFrozen(result), true);
  const after = { ...db.prepare("SELECT * FROM main.users").get() };
  assert.equal(after.username, "one.user");
  assert.equal(after.username_normalized, "one.user");
  delete before.username; delete before.username_normalized; delete after.username; delete after.username_normalized;
  assert.deepEqual(after, before);
  assert.equal(JSON.stringify(db.prepare("SELECT user_id,permission_sequence,module_id,can_view,can_edit FROM main.user_module_permissions").all()), permissionsBefore);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM main.user_audit_logs ORDER BY audit_sequence").all()), auditBefore);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM main.user_audit_log_fields ORDER BY audit_sequence,field_sequence").all()), auditFieldsBefore);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM main.user_activity_logs ORDER BY activity_sequence").all()), activityBefore);
  assert.equal(JSON.stringify(db.prepare("SELECT name,seq FROM main.sqlite_sequence WHERE name LIKE 'user%' ORDER BY name").all()), sequencesBefore);
  assert.equal(db.prepare("SELECT 1 AS open").get().open, 1);
  closeSqliteDatabase(db);
});

test("already-complete returns without a write transaction", async () => {
  const db = await fixture();
  db.prepare("UPDATE main.users SET username='one.user' WHERE id='USR-ONE'").run();
  const plan = createUserLegacyBackfillPlan([user], options, db);
  let immediate = 0;
  const wrapper = { get isTransaction() { return db.isTransaction; }, prepare: (sql) => db.prepare(sql), exec(sql) { if (sql === "BEGIN IMMEDIATE") immediate += 1; return db.exec(sql); } };
  const result = api.backfillLegacyUsernames(wrapper, plan);
  assert.equal(result.status, "already-complete");
  assert.equal(result.committed, false);
  assert.equal(immediate, 0);
  closeSqliteDatabase(db);
});

test("stale protected data and source changes are rejected before mutation", async () => {
  const db = await fixture();
  const source = { ...user };
  const plan = createUserLegacyBackfillPlan([source], options, db);
  db.prepare("UPDATE main.users SET name='Changed' WHERE id='USR-ONE'").run();
  assert.throws(() => api.backfillLegacyUsernames(db, plan), { code: "USERS_BACKFILL_DATABASE_CHANGED" });
  assert.equal(db.prepare("SELECT username FROM main.users").get().username, null);
  closeSqliteDatabase(db);

  const sourceDb = await fixture();
  const mutable = { ...user };
  const sourcePlan = createUserLegacyBackfillPlan([mutable], options, sourceDb);
  mutable.name = "Changed source";
  assert.throws(() => api.backfillLegacyUsernames(sourceDb, sourcePlan), { code: "USERS_BACKFILL_PLAN_INVALID" });
  closeSqliteDatabase(sourceDb);
});

test("stored state is checked before BEGIN and source state is repeated inside the transaction", async () => {
  const staleDb = await fixture();
  const stalePlan = createUserLegacyBackfillPlan([user], options, staleDb);
  staleDb.prepare("UPDATE main.users SET name='Changed' WHERE id='USR-ONE'").run();
  let begins = 0;
  const staleWrapper = { get isTransaction() { return staleDb.isTransaction; }, prepare: (sql) => staleDb.prepare(sql), exec(sql) {
    if (sql === "BEGIN IMMEDIATE") begins += 1;
    return staleDb.exec(sql);
  } };
  assert.throws(() => api.backfillLegacyUsernames(staleWrapper, stalePlan), { code: "USERS_BACKFILL_DATABASE_CHANGED" });
  assert.equal(begins, 0);
  closeSqliteDatabase(staleDb);

  const sourceDb = await fixture();
  const source = { ...user };
  const sourcePlan = createUserLegacyBackfillPlan([source], options, sourceDb);
  const sourceWrapper = { get isTransaction() { return sourceDb.isTransaction; }, prepare: (sql) => sourceDb.prepare(sql), exec(sql) {
    const result = sourceDb.exec(sql);
    if (sql === "BEGIN IMMEDIATE") source.name = "Changed after lock";
    return result;
  } };
  assert.throws(() => api.backfillLegacyUsernames(sourceWrapper, sourcePlan), { code: "USERS_BACKFILL_PLAN_INVALID" });
  assert.equal(sourceDb.isTransaction, false);
  assert.equal(sourceDb.prepare("SELECT username FROM main.users").get().username, null);
  closeSqliteDatabase(sourceDb);
});

test("CAS failure rolls back the whole transaction", async () => {
  const db = await fixture();
  const plan = createUserLegacyBackfillPlan([user], options, db);
  const wrapper = { get isTransaction() { return db.isTransaction; }, exec: (sql) => db.exec(sql), prepare(sql) {
    const statement = db.prepare(sql);
    if (!sql.includes("UPDATE main.users SET username")) return statement;
    return { run() { return { changes: 0 }; } };
  } };
  assert.throws(() => api.backfillLegacyUsernames(wrapper, plan), { code: "USERS_BACKFILL_DATABASE_CHANGED" });
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT username FROM main.users").get().username, null);
  closeSqliteDatabase(db);
});

test("rollback failure and ambiguous COMMIT have distinct sanitized outcomes", async () => {
  const rollbackDb = await fixture();
  const rollbackPlan = createUserLegacyBackfillPlan([user], options, rollbackDb);
  const rollbackWrapper = { get isTransaction() { return rollbackDb.isTransaction; }, prepare(sql) {
    if (sql.includes("UPDATE main.users SET username")) return { run() { throw new Error("raw update"); } };
    return rollbackDb.prepare(sql);
  }, exec(sql) { if (sql === "ROLLBACK") throw new Error("raw rollback"); return rollbackDb.exec(sql); } };
  assert.throws(() => api.backfillLegacyUsernames(rollbackWrapper, rollbackPlan), { code: "USERS_BACKFILL_ROLLBACK_FAILED" });
  closeSqliteDatabase(rollbackDb);

  const commitDb = await fixture();
  const commitPlan = createUserLegacyBackfillPlan([user], options, commitDb);
  let rollbacks = 0;
  const commitWrapper = { get isTransaction() { return commitDb.isTransaction; }, prepare: (sql) => commitDb.prepare(sql), exec(sql) {
    if (sql === "COMMIT") { commitDb.exec(sql); throw new Error("raw ambiguous"); }
    if (sql === "ROLLBACK") rollbacks += 1;
    return commitDb.exec(sql);
  } };
  assert.throws(() => api.backfillLegacyUsernames(commitWrapper, commitPlan), { code: "USERS_BACKFILL_COMMIT_OUTCOME_UNKNOWN" });
  assert.equal(rollbacks, 0);
  assert.equal(commitDb.prepare("SELECT username FROM main.users").get().username, "one.user");
  closeSqliteDatabase(commitDb);
});

test("public backfill errors are frozen, stable, and inspection-safe", () => {
  const error = new api.UserLegacyBackfillError("USERS_BACKFILL_ROLLBACK_FAILED", "rollback-failed");
  assert.equal(error instanceof api.UserLegacyBackfillError, true);
  assert.equal(error instanceof Error, true);
  assert.equal(Object.isFrozen(error), true);
  assert.equal(error.name, "UserLegacyBackfillError");
  assert.equal(error.code, "USERS_BACKFILL_ROLLBACK_FAILED");
  assert.equal(error.message, "Legacy Users backfill rollback failed; inspect the database before retrying.");
  assert.equal(error.stack, "UserLegacyBackfillError: Legacy Users backfill rollback failed; inspect the database before retrying.");
  assert.equal(error.transactionState, "rollback-failed");
  assert.equal(Object.getOwnPropertyDescriptor(error, "transactionState").enumerable, false);
  assert.throws(() => { error.name = "sensitive-user.one"; }, TypeError);
  assert.throws(() => { error.transactionState = "sensitive-path"; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), { name: "UserLegacyBackfillError", code: "USERS_BACKFILL_ROLLBACK_FAILED" });
  assert.doesNotMatch(`${JSON.stringify(error)}${inspect(error, { showHidden: true })}`, /sensitive-user|sensitive-path/);
});
