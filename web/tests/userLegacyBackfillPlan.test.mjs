import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { closeSqliteDatabase, openInMemoryDatabase } from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import * as planApi from "../src/storage/userLegacyBackfillPlan.mjs";
import { verifyUserLegacyBackfill } from "../src/storage/userLegacyBackfillVerifier.mjs";

function modules() { return [{ id: "pack", label: "Pack", section: "Ops", viewPermission: "pack:use", editPermission: "pack:use" }]; }
function permissions() { return [{ moduleId: "pack", canView: true, canEdit: true }]; }
function roles() { return [{ id: "packer", label: "Packer", modulePermissions: permissions() }, { id: "custom", label: "Custom", modulePermissions: permissions() }]; }
function user(index = 1, overrides = {}) { return { id: `USR-${index}`, email: `user${index}@example.test`, name: `User ${index}`, roleId: "packer", active: true, passwordSalt: `salt-${index}`, passwordHash: String(index).repeat(64), ...overrides }; }
function options(assignments = { "USR-1": "user.one" }) { return { roles: roles(), modules: modules(), passwordPolicy: undefined, usernameAssignments: assignments, sourceManifestSha256: "a".repeat(64) }; }
async function legacyDatabase(users = [user()]) {
  const db = await openInMemoryDatabase();
  await runSqliteMigrations(db, { maximumVersion: 4, now: () => new Date("2026-01-01T00:00:00.000Z") });
  const insertUser = db.prepare(`INSERT INTO main.users
    (user_sequence,id,email,name,role_id,role_name,employee_name,employee_id,active,password_salt,password_hash,created_at,updated_at,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);
  const insertPermission = db.prepare(`INSERT INTO main.user_module_permissions
    (user_id,permission_sequence,module_id,can_view,can_edit) VALUES (?,?,?,?,?)`);
  users.forEach((value, index) => {
    insertUser.run(index + 1, value.id, value.email.trim(), value.name, value.roleId,
      value.roleId === "custom" ? value.roleName.trim() : null,
      value.employeeName?.trim() ?? null, value.employeeId?.trim() ?? null,
      value.active ? 1 : 0, value.passwordSalt, value.passwordHash,
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insertPermission.run(value.id, 0, "pack", 1, 1);
  });
  await runSqliteMigrations(db, { now: () => new Date("2026-01-02T00:00:00.000Z") });
  return db;
}

test("plan exposes only frozen aggregate fields for schema-v5 legacy rows", async () => {
  assert.deepEqual(Object.keys(planApi), ["UserLegacyBackfillPlanError", "createUserLegacyBackfillPlan", "disposeUserLegacyBackfillPlan"]);
  const db = await legacyDatabase();
  const plan = planApi.createUserLegacyBackfillPlan([user()], options(), db);
  assert.deepEqual(Reflect.ownKeys(plan), ["status", "sourceManifestSha256", "userCount", "permissionCount", "requiredBackfillCount", "alreadyAssignedCount"]);
  assert.deepEqual({ ...plan }, { status: "ready", sourceManifestSha256: "a".repeat(64), userCount: 1, permissionCount: 1, requiredBackfillCount: 1, alreadyAssignedCount: 0 });
  assert.equal(Object.isFrozen(plan), true);
  assert.doesNotMatch(`${JSON.stringify(plan)}${inspect(plan, { showHidden: true })}`, /USR-1|user\.one|salt-1/);
  assert.equal(db.prepare("SELECT 1 AS open").get().open, 1);
  closeSqliteDatabase(db);
});

test("mixed matching assignments and already-complete databases are planned", async () => {
  const source = [user(1), user(2)];
  const db = await legacyDatabase(source);
  db.prepare("UPDATE main.users SET username=? WHERE id=?").run("user.one", "USR-1");
  const mixed = planApi.createUserLegacyBackfillPlan(source, options({ "USR-1": "user.one", "USR-2": "user.two" }), db);
  assert.equal(mixed.requiredBackfillCount, 1);
  assert.equal(mixed.alreadyAssignedCount, 1);
  db.prepare("UPDATE main.users SET username=? WHERE id=?").run("user.two", "USR-2");
  const complete = planApi.createUserLegacyBackfillPlan(source, options({ "USR-1": "user.one", "USR-2": "user.two" }), db);
  assert.equal(complete.status, "already-complete");
  closeSqliteDatabase(db);
});

test("wrong assigned username, missing rows, schema v4, and TEMP shadows fail closed", async () => {
  const wrong = await legacyDatabase();
  wrong.prepare("UPDATE main.users SET username='wrong.user' WHERE id='USR-1'").run();
  assert.throws(() => planApi.createUserLegacyBackfillPlan([user()], options(), wrong), { code: "USERS_BACKFILL_PLAN_INVALID" });
  closeSqliteDatabase(wrong);

  const missing = await legacyDatabase();
  assert.throws(() => planApi.createUserLegacyBackfillPlan([user(), user(2)], options({ "USR-1": "user.one", "USR-2": "user.two" }), missing), { code: "USERS_BACKFILL_PLAN_INVALID" });
  closeSqliteDatabase(missing);

  const v4 = await openInMemoryDatabase();
  await runSqliteMigrations(v4, { maximumVersion: 4 });
  assert.throws(() => planApi.createUserLegacyBackfillPlan([], options({}), v4), { code: "USERS_BACKFILL_SCHEMA_REQUIRED" });
  closeSqliteDatabase(v4);

  const shadow = await legacyDatabase();
  shadow.exec("CREATE TEMP VIEW users AS SELECT 1");
  assert.throws(() => planApi.createUserLegacyBackfillPlan([user()], options(), shadow), { code: "USERS_BACKFILL_SCHEMA_REQUIRED" });
  closeSqliteDatabase(shadow);

  const migrationShadow = await legacyDatabase();
  migrationShadow.exec("CREATE TEMP TABLE schema_migrations(version INTEGER)");
  assert.throws(() => planApi.createUserLegacyBackfillPlan([user()], options(), migrationShadow), { code: "USERS_BACKFILL_SCHEMA_REQUIRED" });
  closeSqliteDatabase(migrationShadow);

  const checksum = await legacyDatabase();
  checksum.prepare("UPDATE main.schema_migrations SET checksum_sha256=? WHERE version=5").run("0".repeat(64));
  assert.throws(() => planApi.createUserLegacyBackfillPlan([user()], options(), checksum), { code: "USERS_BACKFILL_SCHEMA_REQUIRED" });
  closeSqliteDatabase(checksum);
});

test("active, inactive, custom-role, and descriptor-only inputs reuse readiness contracts", async () => {
  const source = [user(1, { active: false }), user(2, { roleId: "custom", roleName: "Returns", modulePermissions: permissions() })];
  const db = await legacyDatabase(source);
  let reads = 0;
  const guard = (value) => new Proxy(value, { get() { reads += 1; throw new Error("property read"); } });
  const plan = planApi.createUserLegacyBackfillPlan(guard(source), guard(options({ "USR-1": "inactive.one", "USR-2": "custom.two" })), db);
  assert.equal(plan.userCount, 2);
  assert.equal(reads, 0);
  closeSqliteDatabase(db);
});

test("collisions, sparse arrays, accessors, unknown keys, cycles, and tombstones are rejected", async () => {
  const db = await legacyDatabase();
  const collision = options({ "USR-1": "user1@example.test" });
  assert.throws(() => planApi.createUserLegacyBackfillPlan([user()], collision, db), { code: "USERS_BACKFILL_PLAN_INVALID" });
  const sparse = new Array(1);
  assert.throws(() => planApi.createUserLegacyBackfillPlan(sparse, options(), db), { code: "USERS_BACKFILL_INTERNAL_FAILED" });
  const accessor = { ...options() }; Object.defineProperty(accessor, "secret", { enumerable: true, get() { return 1; } });
  assert.throws(() => planApi.createUserLegacyBackfillPlan([user()], accessor, db), { code: "USERS_BACKFILL_INTERNAL_FAILED" });
  const unknown = { ...options(), extra: true };
  assert.throws(() => planApi.createUserLegacyBackfillPlan([user()], unknown, db), { code: "USERS_BACKFILL_PLAN_INVALID" });
  const cyclic = user(); cyclic.self = cyclic;
  assert.throws(() => planApi.createUserLegacyBackfillPlan([cyclic], options(), db), { code: "USERS_BACKFILL_INTERNAL_FAILED" });
  db.exec("DROP TRIGGER main.users_prevent_tombstone_mutation; DROP TRIGGER main.users_prevent_tombstone_username_assignment");
  db.prepare("UPDATE main.users SET active=0,deleted_at='2026-01-01T00:00:00.000Z' WHERE id='USR-1'").run();
  assert.throws(() => planApi.createUserLegacyBackfillPlan([user(1, { active: false })], options(), db));
  closeSqliteDatabase(db);
});

test("disposal is idempotent and sanitized errors reveal no input", async () => {
  const db = await legacyDatabase();
  const plan = planApi.createUserLegacyBackfillPlan([user()], options(), db);
  assert.equal(planApi.disposeUserLegacyBackfillPlan(plan), true);
  assert.equal(planApi.disposeUserLegacyBackfillPlan(plan), true);
  assert.equal(planApi.disposeUserLegacyBackfillPlan({}), false);
  assert.throws(() => verifyUserLegacyBackfill(db, plan), (error) => {
    assert.equal(error.code, "USERS_BACKFILL_PLAN_INVALID");
    assert.deepEqual(Object.keys(error), ["name", "code"]);
    assert.doesNotMatch(`${error.message}${error.stack}${JSON.stringify(error)}${inspect(error)}`, /USR-1|user\.one|salt-1/);
    return true;
  });
  closeSqliteDatabase(db);
});

test("public plan errors are frozen, stable, and inspection-safe", () => {
  const error = new planApi.UserLegacyBackfillPlanError("USERS_BACKFILL_PLAN_INVALID");
  assert.equal(error instanceof planApi.UserLegacyBackfillPlanError, true);
  assert.equal(error instanceof Error, true);
  assert.equal(Object.isFrozen(error), true);
  assert.equal(error.name, "UserLegacyBackfillPlanError");
  assert.equal(error.code, "USERS_BACKFILL_PLAN_INVALID");
  assert.equal(error.message, "Legacy Users backfill plan is invalid.");
  assert.equal(error.stack, "UserLegacyBackfillPlanError: Legacy Users backfill plan is invalid.");
  assert.equal(error.transactionState, "not-started");
  assert.equal(Object.getOwnPropertyDescriptor(error, "transactionState").enumerable, false);
  assert.throws(() => { error.code = "sensitive-user.one"; }, TypeError);
  assert.throws(() => { error.transactionState = "sensitive-path"; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), { name: "UserLegacyBackfillPlanError", code: "USERS_BACKFILL_PLAN_INVALID" });
  assert.doesNotMatch(`${JSON.stringify(error)}${inspect(error, { showHidden: true })}`, /sensitive-user|sensitive-path/);
});
