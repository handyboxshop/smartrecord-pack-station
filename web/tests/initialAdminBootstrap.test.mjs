import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import {
  InitialAdminBootstrapError,
  bootstrapInitialAdmin
} from "../src/domain/initialAdminBootstrap.mjs";
import { verifyPasswordCredentials } from "../src/domain/passwordCredentials.mjs";
import {
  closeSqliteDatabase,
  openSqliteDatabase
} from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";

const FIXED_TIME = "2026-07-19T10:00:00.000Z";
const FIXED_UUID = "00112233-4455-6677-8899-aabbccddeeff";

test("bootstrap creates exactly one complete owner and keeps credentials private", async (t) => {
  const fixture = await databaseFixture(t);
  const input = Object.freeze({
    username: "Initial.Owner",
    email: "Owner@Example.Test",
    displayName: "Initial Owner",
    password: "Correct-Horse-🔐"
  });
  const owner = bootstrapInitialAdmin(fixture.database, input, fixedOptions());

  assert.deepEqual(owner, {
    id: "USR-00112233445566778899AABBCCDDEEFF",
    username: "Initial.Owner",
    email: "Owner@Example.Test",
    name: "Initial Owner",
    roleId: "owner",
    roleName: null,
    modulePermissions: ["pack", "reports", "connect", "labels", "settings", "users"].map((moduleId) => ({
      moduleId, canView: true, canEdit: true
    })),
    employeeName: null,
    employeeId: null,
    active: true,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME
  });
  assert.equal(input.password, "Correct-Horse-🔐");
  assert.equal(JSON.stringify(owner).includes("password"), false);

  const stored = fixture.database.prepare("SELECT * FROM main.users").get();
  assert.equal(stored.username_normalized, "initial.owner");
  assert.equal(stored.email_normalized, "owner@example.test");
  assert.equal(verifyPasswordCredentials(input.password, {
    passwordSalt: stored.password_salt,
    passwordHash: stored.password_hash
  }), true);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM main.user_module_permissions").get().count, 6);
  assert.deepEqual(
    fixture.database.prepare("SELECT field_name FROM main.user_audit_log_fields ORDER BY field_sequence").all().map((row) => row.field_name),
    ["username", "email", "name", "role", "active", "permissions"]
  );
  assert.deepEqual({ ...fixture.database.prepare("SELECT event_code, actor_user_id, subject_user_id FROM main.user_audit_logs").get() }, {
    event_code: "create_user",
    actor_user_id: owner.id,
    subject_user_id: owner.id
  });
  assert.deepEqual({ ...fixture.database.prepare("SELECT event_code, actor_user_id, subject_user_id, module_id FROM main.user_activity_logs").get() }, {
    event_code: "create_user",
    actor_user_id: owner.id,
    subject_user_id: owner.id,
    module_id: "users"
  });
  assert.doesNotThrow(() => fixture.database.prepare("SELECT 1").get());
});

test("any existing active, inactive, or tombstoned user blocks normal bootstrap", async (t) => {
  for (const state of ["active", "inactive", "tombstone"]) {
    const fixture = await databaseFixture(t, `smartrecord-bootstrap-${state}-`);
    insertExistingUser(fixture.database, state);
    assert.throws(
      () => bootstrapInitialAdmin(fixture.database, validInput(), fixedOptions()),
      (error) => error instanceof InitialAdminBootstrapError && error.code === "BOOTSTRAP_NOT_ALLOWED"
    );
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM main.users").get().count, 1);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM main.user_audit_logs").get().count, 0);
  }
});

test("two independent connections produce one complete bootstrap winner", async (t) => {
  const fixture = await databaseFixture(t);
  const second = await openSqliteDatabase(fixture.databasePath);
  t.after(() => closeSqliteDatabase(second));
  const first = bootstrapInitialAdmin(fixture.database, validInput(), fixedOptions());
  assert.equal(first.roleId, "owner");
  assert.throws(
    () => bootstrapInitialAdmin(second, { ...validInput(), username: "Second.Owner", email: "second@example.test" }, {
      ...fixedOptions(), randomUUID: () => "11112222-3333-4444-5555-666677778888"
    }),
    (error) => error.code === "BOOTSTRAP_NOT_ALLOWED"
  );
  assert.equal(second.prepare("SELECT COUNT(*) AS count FROM main.users").get().count, 1);
  assert.equal(second.prepare("SELECT COUNT(*) AS count FROM main.user_module_permissions").get().count, 6);
});

test("bootstrap persistence, permission, audit-parent, audit-field, and activity failures roll back every row", async (t) => {
  const scenarios = [
    ["users", "users", "BOOTSTRAP_PERSIST_FAILED"],
    ["permissions", "user_module_permissions", "BOOTSTRAP_PERSIST_FAILED"],
    ["audit-parent", "user_audit_logs", "BOOTSTRAP_AUDIT_FAILED"],
    ["audit-field", "user_audit_log_fields", "BOOTSTRAP_AUDIT_FAILED"],
    ["activity", "user_activity_logs", "BOOTSTRAP_ACTIVITY_FAILED"]
  ];
  for (const [name, table, code] of scenarios) {
    const fixture = await databaseFixture(t, `smartrecord-bootstrap-rollback-${name}-`);
    fixture.database.exec(`
      CREATE TRIGGER main.bootstrap_failure_${name.replaceAll("-", "_")}
      BEFORE INSERT ON ${table}
      BEGIN
        SELECT RAISE(ABORT, 'private bootstrap failure');
      END
    `);
    assert.throws(
      () => bootstrapInitialAdmin(fixture.database, validInput(), fixedOptions()),
      (error) => error instanceof InitialAdminBootstrapError && error.code === code
    );
    for (const persistentTable of [
      "users", "user_module_permissions", "user_audit_logs",
      "user_audit_log_fields", "user_activity_logs"
    ]) {
      assert.equal(
        fixture.database.prepare(`SELECT COUNT(*) AS count FROM main.${persistentTable}`).get().count,
        0
      );
    }
    assert.doesNotThrow(() => fixture.database.prepare("SELECT 1").get());
  }
});

test("input, option, identity, display-name, password, UUID, and hashing failures create no rows", async (t) => {
  const scenarios = [
    [{ ...validInput(), extra: true }, fixedOptions(), "BOOTSTRAP_PERSIST_FAILED"],
    [{ ...validInput(), username: "bad@name" }, fixedOptions(), "BOOTSTRAP_USERNAME_INVALID"],
    [{ ...validInput(), email: "not-an-email" }, fixedOptions(), "BOOTSTRAP_EMAIL_INVALID"],
    [{ ...validInput(), displayName: "\0" }, fixedOptions(), "BOOTSTRAP_DISPLAY_NAME_INVALID"],
    [{ ...validInput(), password: " short " }, fixedOptions(), "BOOTSTRAP_PASSWORD_INVALID"],
    [validInput(), { ...fixedOptions(), randomUUID: () => "bad" }, "BOOTSTRAP_PERSIST_FAILED"],
    [validInput(), { ...fixedOptions(), createPasswordCredentials: () => { throw new Error("private"); } }, "BOOTSTRAP_HASH_FAILED"]
  ];
  for (const [input, options, code] of scenarios) {
    const fixture = await databaseFixture(t, `smartrecord-bootstrap-${code}-`);
    assert.throws(
      () => bootstrapInitialAdmin(fixture.database, input, options),
      (error) => error instanceof InitialAdminBootstrapError && error.code === code
    );
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM main.users").get().count, 0);
  }
});

test("bootstrap password validation preserves valid Unicode and rejects every storage boundary", async (t) => {
  const fixture = await databaseFixture(t, "smartrecord-bootstrap-password-boundaries-");
  for (const password of [
    null,
    "1234567",
    " leading-password",
    "trailing-password ",
    "control\npassword",
    "nul\0password",
    "x".repeat(1025)
  ]) {
    assert.throws(
      () => bootstrapInitialAdmin(fixture.database, { ...validInput(), password }, fixedOptions()),
      (error) => error instanceof InitialAdminBootstrapError && error.code === "BOOTSTRAP_PASSWORD_INVALID"
    );
  }
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM main.users").get().count, 0);
  const owner = bootstrapInitialAdmin(fixture.database, {
    ...validInput(), password: "รหัสผ่าน-🔐-Unicode"
  }, fixedOptions());
  const credentials = fixture.database.prepare(`
    SELECT password_salt, password_hash FROM main.users WHERE id = ?
  `).get(owner.id);
  assert.equal(verifyPasswordCredentials("รหัสผ่าน-🔐-Unicode", {
    passwordSalt: credentials.password_salt,
    passwordHash: credentials.password_hash
  }), true);
});

test("all service error surfaces are sanitized", async (t) => {
  const fixture = await databaseFixture(t);
  const marker = "SENSITIVE_BOOTSTRAP_MARKER";
  assert.throws(
    () => bootstrapInitialAdmin(fixture.database, {
      ...validInput(), username: `${marker}@`, password: `${marker}🔐`
    }, fixedOptions()),
    (error) => {
      const surface = `${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${inspect(error)}`;
      assert.equal(surface.includes(marker), false);
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});

function validInput() {
  return {
    username: "Initial.Owner",
    email: "owner@example.test",
    displayName: "Initial Owner",
    password: "Correct-Horse-🔐"
  };
}

function fixedOptions() {
  return {
    now: () => new Date(FIXED_TIME),
    randomUUID: () => FIXED_UUID
  };
}

async function databaseFixture(t, prefix = "smartrecord-bootstrap-service-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(directory, "bootstrap.sqlite");
  const database = await openSqliteDatabase(databasePath);
  t.after(async () => {
    closeSqliteDatabase(database);
    await rm(directory, { recursive: true, force: true });
  });
  await runSqliteMigrations(database, { maximumVersion: 5, now: () => new Date(FIXED_TIME) });
  return { directory, databasePath, database };
}

function insertExistingUser(database, state) {
  const deletedAt = state === "tombstone" ? FIXED_TIME : null;
  database.prepare(`
    INSERT INTO main.users (
      id, username, email, name, role_id, role_name, employee_name, employee_id,
      active, password_salt, password_hash, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "USR-EXISTING", "Existing.User", "existing@example.test", "Existing", "owner", null, null, null,
    state === "active" ? 1 : 0, "00".repeat(12), "0".repeat(64), FIXED_TIME, FIXED_TIME, deletedAt
  );
}
