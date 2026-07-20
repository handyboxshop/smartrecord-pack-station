import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { closeSqliteDatabase, openInMemoryDatabase } from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import { createUserLegacyBackfillPlan } from "../src/storage/userLegacyBackfillPlan.mjs";
import { backfillLegacyUsernames } from "../src/storage/userLegacyBackfiller.mjs";
import * as api from "../src/storage/userLegacyBackfillVerifier.mjs";

const user = { id: "USR-ONE", email: "one@example.test", name: "One User", roleId: "packer", active: true, passwordSalt: "salt", passwordHash: "a".repeat(64) };
const modules = [{ id: "pack", label: "Pack", section: "Ops", viewPermission: "pack:use", editPermission: "pack:use" }];
const options = { roles: [{ id: "packer", label: "Packer", modulePermissions: [{ moduleId: "pack", canView: true, canEdit: true }] }], modules, passwordPolicy: undefined, usernameAssignments: { "USR-ONE": "one.user" }, sourceManifestSha256: "c".repeat(64) };
async function fixture() {
  const db = await openInMemoryDatabase(); await runSqliteMigrations(db, { maximumVersion: 4 });
  db.prepare(`INSERT INTO main.users(user_sequence,id,email,name,role_id,role_name,employee_name,employee_id,active,password_salt,password_hash,created_at,updated_at,deleted_at)
    VALUES(1,?,?,?,?,NULL,NULL,NULL,1,?,?,?, ?,NULL)`).run(user.id, user.email, user.name, user.roleId, user.passwordSalt, user.passwordHash, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO main.user_module_permissions VALUES(?,0,'pack',1,1)").run(user.id);
  await runSqliteMigrations(db); return db;
}

test("public API is exact and verification reports frozen bounded aggregates", async () => {
  assert.deepEqual(Object.keys(api), ["UserLegacyBackfillVerificationError", "verifyUserLegacyBackfill"]);
  const db = await fixture(); const plan = createUserLegacyBackfillPlan([user], options, db);
  backfillLegacyUsernames(db, plan);
  const report = api.verifyUserLegacyBackfill(db, plan);
  assert.deepEqual({ ...report }, { status: "verified", expectedUserCount: 1, actualUserCount: 1, verifiedUserCount: 1, mismatchedUserCount: 0, issueCodeCounts: [] });
  assert.equal(Object.isFrozen(report), true); assert.equal(Object.isFrozen(report.issueCodeCounts), true);
  assert.equal(db.prepare("SELECT 1 open").get().open, 1); closeSqliteDatabase(db);
});

test("already-complete plan reports already-complete", async () => {
  const db = await fixture(); db.prepare("UPDATE main.users SET username='one.user'").run();
  const plan = createUserLegacyBackfillPlan([user], options, db);
  assert.equal(api.verifyUserLegacyBackfill(db, plan).status, "already-complete"); closeSqliteDatabase(db);
});

test("standalone verification detects protected and username mismatches", async () => {
  const db = await fixture(); const plan = createUserLegacyBackfillPlan([user], options, db);
  backfillLegacyUsernames(db, plan);
  db.prepare("UPDATE main.users SET name='Changed'").run();
  const report = api.verifyUserLegacyBackfill(db, plan);
  assert.equal(report.status, "mismatch");
  assert.ok(report.issueCodeCounts.some(({ code }) => code === "PROTECTED_DATA_CHANGED")); closeSqliteDatabase(db);
});

test("invalid stored data is classified without exposing rows", async () => {
  const db = await fixture(); const plan = createUserLegacyBackfillPlan([user], options, db);
  db.exec("PRAGMA foreign_keys=OFF; DROP TRIGGER main.users_prevent_identity_update");
  assert.throws(() => api.verifyUserLegacyBackfill(db, plan), { code: "USERS_BACKFILL_SCHEMA_REQUIRED" });
  closeSqliteDatabase(db);
});

test("public verification errors are frozen, stable, and inspection-safe", () => {
  const error = new api.UserLegacyBackfillVerificationError("USERS_BACKFILL_STORED_DATA_INVALID");
  assert.equal(error instanceof api.UserLegacyBackfillVerificationError, true);
  assert.equal(error instanceof Error, true);
  assert.equal(Object.isFrozen(error), true);
  assert.equal(error.name, "UserLegacyBackfillVerificationError");
  assert.equal(error.code, "USERS_BACKFILL_STORED_DATA_INVALID");
  assert.equal(error.message, "Stored Users data is invalid.");
  assert.equal(error.stack, "UserLegacyBackfillVerificationError: Stored Users data is invalid.");
  assert.equal(error.transactionState, undefined);
  assert.equal(Object.hasOwn(error, "transactionState"), false);
  assert.throws(() => { error.message = "sensitive-user.one"; }, TypeError);
  assert.throws(() => { error.code = "sensitive-path"; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), { name: "UserLegacyBackfillVerificationError", code: "USERS_BACKFILL_STORED_DATA_INVALID" });
  assert.doesNotMatch(`${JSON.stringify(error)}${inspect(error, { showHidden: true })}`, /sensitive-user|sensitive-path/);
});
