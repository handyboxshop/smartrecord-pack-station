import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  closeSqliteDatabase,
  openInMemoryDatabase
} from "../src/storage/sqliteDatabase.mjs";
import {
  SqliteMigrationError,
  readSqliteSchemaVersion,
  runSqliteMigrations
} from "../src/storage/migrate.mjs";
import {
  SqliteMetadataError,
  listStorageMetadata,
  readStorageMetadata,
  removeStorageMetadata,
  setStorageMetadata
} from "../src/storage/sqliteMetadata.mjs";

const defaultMigrationPath = fileURLToPath(
  new URL("../src/storage/migrations/001_storage_foundation.sql", import.meta.url)
);

test("default migrations apply storage schemas in numeric order", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const result = await runSqliteMigrations(database, {
    now: () => new Date("2026-07-14T10:00:00.000Z")
  });

  assert.deepEqual(result.applied.map(({ version, name, appliedAt }) => ({ version, name, appliedAt })), [
    {
      version: 1,
      name: "001_storage_foundation.sql",
      appliedAt: "2026-07-14T10:00:00.000Z"
    },
    {
      version: 2,
      name: "002_pack_records.sql",
      appliedAt: "2026-07-14T10:00:00.000Z"
    },
    {
      version: 3,
      name: "003_orders_labels.sql",
      appliedAt: "2026-07-14T10:00:00.000Z"
    },
    {
      version: 4,
      name: "004_users.sql",
      appliedAt: "2026-07-14T10:00:00.000Z"
    },
    {
      version: 5,
      name: "005_usernames.sql",
      appliedAt: "2026-07-14T10:00:00.000Z"
    }
  ]);
  assert.equal(result.applied.every(({ checksumSha256 }) => /^[a-f0-9]{64}$/.test(checksumSha256)), true);
  assert.equal(result.currentVersion, 5);
  assert.equal(readSqliteSchemaVersion(database), 5);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 5);

  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(tables, [
    "labels",
    "order_items",
    "orders",
    "pack_record_videos",
    "pack_records",
    "schema_migrations",
    "storage_metadata",
    "user_activity_logs",
    "user_audit_log_fields",
    "user_audit_logs",
    "user_module_permissions",
    "users"
  ]);

  const migrationRows = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(migrationRows.map(({ version, name, applied_at }) => ({ version, name, applied_at })), [
    { version: 1, name: "001_storage_foundation.sql", applied_at: "2026-07-14T10:00:00.000Z" },
    { version: 2, name: "002_pack_records.sql", applied_at: "2026-07-14T10:00:00.000Z" },
    { version: 3, name: "003_orders_labels.sql", applied_at: "2026-07-14T10:00:00.000Z" },
    { version: 4, name: "004_users.sql", applied_at: "2026-07-14T10:00:00.000Z" },
    { version: 5, name: "005_usernames.sql", applied_at: "2026-07-14T10:00:00.000Z" }
  ]);
  assert.deepEqual(
    migrationRows.map(({ checksum_sha256 }) => checksum_sha256),
    result.applied.map(({ checksumSha256 }) => checksumSha256)
  );
});

test("migration runner is safe to run repeatedly", async (t) => {
  const database = await managedInMemoryDatabase(t);
  await runSqliteMigrations(database);

  const repeated = await runSqliteMigrations(database);

  assert.deepEqual(repeated.applied, []);
  assert.equal(repeated.currentVersion, 5);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 5);
});

test("migration runner can preserve a workflow pinned to schema version 2", async (t) => {
  const database = await managedInMemoryDatabase(t);

  const result = await runSqliteMigrations(database, { maximumVersion: 2 });
  const repeated = await runSqliteMigrations(database, { maximumVersion: 2 });

  assert.deepEqual(result.applied.map((migration) => migration.version), [1, 2]);
  assert.equal(result.currentVersion, 2);
  assert.equal(result.latestSupportedVersion, 2);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'orders'
  `).get(), undefined);
  assert.equal(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'users'
  `).get(), undefined);
  assert.deepEqual(repeated, { applied: [], currentVersion: 2, latestSupportedVersion: 2 });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 2);
});

test("maximumVersion rejects invalid or unavailable targets without mutation", async (t) => {
  const database = await managedInMemoryDatabase(t);
  for (const maximumVersion of [0, -1, 1.5, Number.NaN, "2", 6]) {
    await assert.rejects(
      runSqliteMigrations(database, { maximumVersion }),
      (error) => {
        assert.equal(error instanceof SqliteMigrationError, true);
        assert.equal(
          error.code,
          maximumVersion === 6
            ? "SQLITE_MIGRATION_TARGET_UNAVAILABLE"
            : "SQLITE_MIGRATION_TARGET_INVALID"
        );
        return true;
      }
    );
  }
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'
  `).get(), undefined);
});

test("maximumVersion accepts the exact latest target", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const result = await runSqliteMigrations(database, { maximumVersion: 5 });

  assert.deepEqual(result.applied.map((migration) => migration.version), [1, 2, 3, 4, 5]);
  assert.equal(result.currentVersion, 5);
  assert.equal(result.latestSupportedVersion, 5);
});

test("migration 005 preserves populated version-4 Users data and adds nullable usernames once", async (t) => {
  const database = await managedInMemoryDatabase(t);
  await runSqliteMigrations(database, { maximumVersion: 4 });
  insertVersion4User(database);
  database.prepare(`
    INSERT INTO main.user_module_permissions
      (user_id, permission_sequence, module_id, can_view, can_edit)
    VALUES ('USR-MIGRATION-1', 0, 'pack', 1, 1)
  `).run();
  database.prepare(`
    INSERT INTO main.user_audit_logs
      (audit_sequence, event_code, actor_user_id, subject_user_id, at)
    VALUES (7, 'create_user', 'USR-MIGRATION-1', 'USR-MIGRATION-1', '2026-07-14T10:00:00.000Z')
  `).run();
  database.prepare(`
    INSERT INTO main.user_audit_log_fields
      (audit_sequence, field_sequence, field_name)
    VALUES (7, 0, 'email')
  `).run();
  database.prepare(`
    INSERT INTO main.user_activity_logs
      (activity_sequence, event_code, actor_user_id, subject_user_id, module_id, at)
    VALUES (9, 'create_user', 'USR-MIGRATION-1', 'USR-MIGRATION-1', 'users', '2026-07-14T10:00:00.000Z')
  `).run();
  const preserved = snapshotUserStorage(database);

  const upgraded = await runSqliteMigrations(database, { maximumVersion: 5 });
  const repeated = await runSqliteMigrations(database, { maximumVersion: 5 });

  assert.deepEqual(upgraded.applied.map((migration) => migration.version), [5]);
  assert.deepEqual(repeated.applied, []);
  assert.equal(database.prepare("PRAGMA main.user_version").get().user_version, 5);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.schema_migrations").get().count, 5);
  const migratedUser = { ...database.prepare("SELECT * FROM main.users").get() };
  assert.equal(migratedUser.username, null);
  assert.equal(migratedUser.username_normalized, null);
  delete migratedUser.username;
  delete migratedUser.username_normalized;
  assert.deepEqual(migratedUser, preserved.users[0]);
  assert.deepEqual(snapshotUserStorage(database).permissions, preserved.permissions);
  assert.deepEqual(snapshotUserStorage(database).auditLogs, preserved.auditLogs);
  assert.deepEqual(snapshotUserStorage(database).auditFields, preserved.auditFields);
  assert.deepEqual(snapshotUserStorage(database).activityLogs, preserved.activityLogs);
  assert.throws(
    () => database.prepare("UPDATE main.user_audit_log_fields SET field_name = 'username'").run(),
    /append-only/
  );
  assert.throws(
    () => database.prepare("DELETE FROM main.user_audit_log_fields").run(),
    /append-only/
  );
});

test("migration 005 direct SQL enforces username syntax, reservation, and cross-namespace rules", async (t) => {
  const database = await migratedDatabase(t);
  insertVersion5User(database, { id: "USR-DIRECT-1", username: "Valid.User", email: "first@example.test" });
  assert.equal(database.prepare(`
    SELECT username_normalized FROM main.users WHERE id = 'USR-DIRECT-1'
  `).get().username_normalized, "valid.user");

  const invalidUsernames = [null, "ab", "_abc", "abc_", "has space", "has@at", "has/slash", "has\\slash", "has:colon", "ผู้ใช้", "a".repeat(65)];
  invalidUsernames.forEach((username, index) => {
    assert.throws(
      () => insertVersion5User(database, {
        id: `USR-INVALID-${index}`,
        username,
        email: `invalid-${index}@example.test`
      }),
      /username|required|CHECK constraint failed/
    );
  });
  assert.throws(
    () => insertVersion5User(database, { id: "USR-DUPLICATE", username: "VALID.user", email: "duplicate@example.test" }),
    /UNIQUE constraint failed/
  );
  database.prepare("UPDATE main.users SET active = 0 WHERE id = 'USR-DIRECT-1'").run();
  assert.throws(
    () => insertVersion5User(database, { id: "USR-INACTIVE-DUP", username: "valid.USER", email: "inactive@example.test" }),
    /UNIQUE constraint failed/
  );
  database.prepare(`
    UPDATE main.users SET deleted_at = '2026-07-14T10:00:00.000Z', updated_at = '2026-07-14T10:00:00.000Z'
    WHERE id = 'USR-DIRECT-1'
  `).run();
  assert.throws(
    () => insertVersion5User(database, { id: "USR-TOMBSTONE-DUP", username: "Valid.User", email: "tombstone@example.test" }),
    /UNIQUE constraint failed/
  );
  insertVersion5User(database, { id: "USR-NAMESPACE-1", username: "Second.User", email: "reserved.identity" });
  assert.throws(
    () => insertVersion5User(database, { id: "USR-NAMESPACE-2", username: "RESERVED.IDENTITY", email: "other@example.test" }),
    /identity collision/
  );
  assert.throws(
    () => insertVersion5User(database, { id: "USR-NAMESPACE-3", username: "Third.User", email: "second.user" }),
    /identity collision/
  );
  assert.throws(
    () => database.prepare("UPDATE main.users SET username = 'Assigned.User' WHERE id = 'USR-DIRECT-1'").run(),
    /tombstone|immutable/
  );
});

test("migration 005 identity collisions read main.users despite a compatible TEMP users shadow", async (t) => {
  const database = await managedInMemoryDatabase(t);
  await runSqliteMigrations(database, { maximumVersion: 4 });
  insertVersion4User(database, {
    id: "USR-LEGACY-1",
    email: "legacy.user",
    name: "Legacy User",
    password_salt: "legacy-salt",
    password_hash: "c".repeat(64)
  });
  const legacyBefore = database.prepare(`
    SELECT id, email, email_normalized, name, role_id, role_name, employee_name, employee_id,
           active, created_at, updated_at, deleted_at
    FROM main.users WHERE id = 'USR-LEGACY-1'
  `).get();
  const legacyCredentialFingerprint = createHash("sha256").update(
    `${database.prepare("SELECT password_salt FROM main.users WHERE id = 'USR-LEGACY-1'").get().password_salt}\u0000${database.prepare("SELECT password_hash FROM main.users WHERE id = 'USR-LEGACY-1'").get().password_hash}`
  ).digest("hex");

  await runSqliteMigrations(database, { maximumVersion: 5 });
  assert.equal(database.prepare("SELECT username FROM main.users WHERE id = 'USR-LEGACY-1'").get().username, null);
  assert.equal(database.prepare("SELECT username_normalized FROM main.users WHERE id = 'USR-LEGACY-1'").get().username_normalized, null);
  database.exec(`
    CREATE TEMP TABLE users (
      id TEXT,
      email_normalized TEXT,
      username_normalized TEXT
    ) STRICT;
  `);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM temp.users").get().count, 0);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM main.users WHERE username_normalized = lower('LEGACY.USER')
  `).get().count, 0);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM main.users WHERE email_normalized = lower('different@example.test')
  `).get().count, 0);

  assert.throws(
    () => insertVersion5User(database, {
      id: "USR-TEMP-SHADOW-2",
      username: "LEGACY.USER",
      email: "different@example.test"
    }),
    /identity collision/
  );

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.users").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.user_module_permissions").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.user_audit_logs").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.user_audit_log_fields").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.user_activity_logs").get().count, 0);
  assert.deepEqual(database.prepare(`
    SELECT id, email, email_normalized, name, role_id, role_name, employee_name, employee_id,
           active, created_at, updated_at, deleted_at
    FROM main.users WHERE id = 'USR-LEGACY-1'
  `).get(), legacyBefore);
  const legacyCredentialFingerprintAfter = createHash("sha256").update(
    `${database.prepare("SELECT password_salt FROM main.users WHERE id = 'USR-LEGACY-1'").get().password_salt}\u0000${database.prepare("SELECT password_hash FROM main.users WHERE id = 'USR-LEGACY-1'").get().password_hash}`
  ).digest("hex");
  assert.equal(legacyCredentialFingerprintAfter === legacyCredentialFingerprint, true);
});

test("migration 005 failure restores the exact populated version-4 schema and data", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const migrationsDirectory = await copyDefaultMigrations(t, "smartrecord-usernames-rollback-");
  await runSqliteMigrations(database, { migrationsDirectory, maximumVersion: 4 });
  insertVersion4User(database);
  const schemaBefore = snapshotMainSchema(database);
  const dataBefore = snapshotUserStorage(database);
  const fifthPath = path.join(migrationsDirectory, "005_usernames.sql");
  await writeFile(fifthPath, `${await readFile(fifthPath, "utf8")}\nINSERT INTO main.missing_migration_table VALUES (1);\n`);

  await assert.rejects(
    runSqliteMigrations(database, { migrationsDirectory, maximumVersion: 5 }),
    (error) => error instanceof SqliteMigrationError && error.code === "SQLITE_MIGRATION_APPLY_FAILED"
  );
  assert.equal(database.prepare("PRAGMA main.user_version").get().user_version, 4);
  assert.deepEqual(snapshotMainSchema(database), schemaBefore);
  assert.deepEqual(snapshotUserStorage(database), dataBefore);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.schema_migrations").get().count, 4);
});

test("migration source compatibility keeps 001-004 exact, has no 006, and detects an edited 005", async (t) => {
  const migrationDirectory = path.dirname(defaultMigrationPath);
  const expectedHashes = new Map([
    ["001_storage_foundation.sql", "d8aea4002c75f72c3a4a7a1e9947263d5cdd59aa7e915eb013d745066b11b574"],
    ["002_pack_records.sql", "3814f6d4bb752702dcc7837b89323773aa3503a37e71c189b20012b667765391"],
    ["003_orders_labels.sql", "3be71e29cba5122402ad155da16dcca5ea71c1226a1ad927d08e126ec7cf23ae"],
    ["004_users.sql", "1e9ef42d02bcb6235221d2439b6bb25f7ed031bf4ad6eebd1bde1d5c655584d8"]
  ]);
  for (const [name, hash] of expectedHashes) {
    assert.equal(await sha256File(path.join(migrationDirectory, name)), hash);
  }
  assert.equal((await readdir(migrationDirectory)).some((name) => /^006_.*\.sql$/u.test(name)), false);

  const database = await managedInMemoryDatabase(t);
  const migrationsDirectory = await copyDefaultMigrations(t, "smartrecord-usernames-checksum-");
  await runSqliteMigrations(database, { migrationsDirectory });
  const fifthPath = path.join(migrationsDirectory, "005_usernames.sql");
  await writeFile(fifthPath, `${await readFile(fifthPath, "utf8")}\n-- edited\n`);
  await assert.rejects(
    runSqliteMigrations(database, { migrationsDirectory }),
    (error) => error instanceof SqliteMigrationError && error.code === "SQLITE_MIGRATION_CHECKSUM_MISMATCH"
  );
});

test("maximumVersion 3 preserves the Orders and Labels schema without Users tables", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const result = await runSqliteMigrations(database, { maximumVersion: 3 });

  assert.deepEqual(result.applied.map((migration) => migration.version), [1, 2, 3]);
  assert.equal(result.currentVersion, 3);
  assert.equal(result.latestSupportedVersion, 3);
  assert.equal(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'orders'
  `).get().name, "orders");
  assert.equal(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'users'
  `).get(), undefined);
});

test("maximumVersion rejects a newer existing database explicitly without mutation", async (t) => {
  const database = await managedInMemoryDatabase(t);
  await runSqliteMigrations(database);
  const beforeRows = database.prepare(`
    SELECT version, name, checksum_sha256, applied_at
    FROM schema_migrations ORDER BY version
  `).all().map((row) => ({ ...row }));
  const beforeSchema = database.prepare(`
    SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name
  `).all().map((row) => ({ ...row }));

  await assert.rejects(
    runSqliteMigrations(database, { maximumVersion: 2 }),
    (error) => error instanceof SqliteMigrationError
      && error.code === "SQLITE_SCHEMA_VERSION_UNSUPPORTED"
  );

  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 5);
  assert.deepEqual(database.prepare(`
    SELECT version, name, checksum_sha256, applied_at
    FROM schema_migrations ORDER BY version
  `).all().map((row) => ({ ...row })), beforeRows);
  assert.deepEqual(database.prepare(`
    SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name
  `).all().map((row) => ({ ...row })), beforeSchema);
});

test("maximumVersion does not hide a checksum mismatch above its target", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const migrationsDirectory = await temporaryDirectory(t, "smartrecord-sqlite-maximum-checksum-");
  const migrationNames = [
    "001_storage_foundation.sql",
    "002_pack_records.sql",
    "003_orders_labels.sql"
  ];
  for (const name of migrationNames) {
    await writeFile(
      path.join(migrationsDirectory, name),
      await readFile(fileURLToPath(new URL(`../src/storage/migrations/${name}`, import.meta.url)))
    );
  }
  await runSqliteMigrations(database, { migrationsDirectory });
  const thirdMigrationPath = path.join(migrationsDirectory, "003_orders_labels.sql");
  await writeFile(thirdMigrationPath, `${await readFile(thirdMigrationPath, "utf8")}\n-- edited\n`);

  await assert.rejects(
    runSqliteMigrations(database, { migrationsDirectory, maximumVersion: 2 }),
    (error) => error instanceof SqliteMigrationError
      && error.code === "SQLITE_MIGRATION_CHECKSUM_MISMATCH"
  );
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 3);
});

test("pack record tables expose exactly the expected columns and AWB index", async (t) => {
  const database = await migratedDatabase(t);

  assert.deepEqual(tableColumns(database, "pack_records"), [
    "id",
    "record_sequence",
    "awb",
    "awb_normalized",
    "platform",
    "employee_id",
    "station_id",
    "started_at",
    "ended_at",
    "duration_seconds",
    "status",
    "item_summary",
    "size_mb",
    "storage_target_id",
    "storage_label",
    "storage_provider",
    "storage_host",
    "share_link",
    "force_close_reason",
    "source_payload_json",
    "created_at",
    "updated_at"
  ]);
  assert.deepEqual(tableColumns(database, "pack_record_videos"), [
    "record_id",
    "file_name",
    "relative_path",
    "bytes",
    "size_mb",
    "content_type",
    "storage_target_id",
    "storage_label",
    "storage_host",
    "storage_mode",
    "mounted_required",
    "simulated",
    "external_url",
    "custom_path",
    "share_link",
    "saved_at"
  ]);

  const awbIndex = database.prepare("PRAGMA index_info(pack_records_awb_normalized_unique)").all();
  assert.deepEqual(awbIndex.map(({ name }) => name), ["awb_normalized"]);
  const explicitIndexes = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'index' AND tbl_name IN ('pack_records', 'pack_record_videos')
      AND name NOT LIKE 'sqlite_autoindex_%'
    ORDER BY name
  `).all().map(({ name }) => name);
  assert.deepEqual(explicitIndexes, ["pack_records_awb_normalized_unique"]);
});

test("pack records enforce sequence, normalized AWB, and status constraints", async (t) => {
  const database = await migratedDatabase(t);
  insertPackRecord(database, { id: "record-pass", record_sequence: 0, awb: "AWB-PASS", awb_normalized: "AWB-PASS" });
  insertPackRecord(database, {
    id: "record-warn",
    record_sequence: 1,
    awb: " AWB-WARN ",
    awb_normalized: "AWB-WARN",
    status: "warn"
  });

  assert.throws(
    () => insertPackRecord(database, { id: "duplicate-awb", record_sequence: 2, awb_normalized: "AWB-PASS" }),
    /UNIQUE constraint failed: pack_records\.awb_normalized/
  );
  assert.throws(
    () => insertPackRecord(database, { id: "duplicate-sequence", record_sequence: 1, awb_normalized: "AWB-OTHER" }),
    /UNIQUE constraint failed: pack_records\.record_sequence/
  );
  assert.throws(
    () => insertPackRecord(database, { id: "unsupported-status", record_sequence: 3, awb_normalized: "AWB-BAD", status: "failed" }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertPackRecord(database, { id: "negative-sequence", record_sequence: -1, awb_normalized: "AWB-NEGATIVE" }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertPackRecord(database, { id: "empty-awb", record_sequence: 4, awb_normalized: "" }),
    /CHECK constraint failed/
  );
  assert.deepEqual(
    database.prepare("SELECT status FROM pack_records ORDER BY record_sequence").all().map(({ status }) => status),
    ["pass", "warn"]
  );
});

test("pack records enforce non-negative metrics and valid optional source JSON", async (t) => {
  const database = await migratedDatabase(t);
  insertPackRecord(database, { id: "null-source", record_sequence: 0, awb_normalized: "AWB-NULL" });
  insertPackRecord(database, {
    id: "json-source",
    record_sequence: 1,
    awb_normalized: "AWB-JSON",
    source_payload_json: '{"awb":"AWB-JSON"}'
  });

  assert.throws(
    () => insertPackRecord(database, { id: "negative-duration", record_sequence: 2, awb_normalized: "AWB-DURATION", duration_seconds: -1 }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertPackRecord(database, { id: "negative-size", record_sequence: 3, awb_normalized: "AWB-SIZE", size_mb: -0.1 }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertPackRecord(database, { id: "invalid-json", record_sequence: 4, awb_normalized: "AWB-JSON-BAD", source_payload_json: "{bad-json" }),
    /CHECK constraint failed/
  );
  assert.equal(database.prepare("SELECT source_payload_json FROM pack_records WHERE id = 'null-source'").get().source_payload_json, null);
});

test("historical storage fields remain nullable and a pack record needs no video", async (t) => {
  const database = await migratedDatabase(t);
  insertPackRecord(database, { id: "historical-record", record_sequence: 0, awb_normalized: "AWB-HISTORICAL" });

  const record = database.prepare(`
    SELECT storage_target_id, storage_label, storage_provider, storage_host,
           share_link, force_close_reason, source_payload_json
    FROM pack_records WHERE id = ?
  `).get("historical-record");
  assert.deepEqual({ ...record }, {
    storage_target_id: null,
    storage_label: null,
    storage_provider: null,
    storage_host: null,
    share_link: null,
    force_close_reason: null,
    source_payload_json: null
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pack_record_videos").get().count, 0);
});

test("pack record videos enforce one-to-one ownership, foreign keys, and cascade deletion", async (t) => {
  const database = await migratedDatabase(t);
  insertPackRecord(database, { id: "video-parent", record_sequence: 0, awb_normalized: "AWB-VIDEO" });
  insertVideo(database, { record_id: "video-parent", file_name: "packing.mp4" });

  assert.throws(
    () => insertVideo(database, { record_id: "video-parent", file_name: "second.mp4" }),
    /UNIQUE constraint failed: pack_record_videos\.record_id/
  );
  assert.throws(
    () => insertVideo(database, { record_id: "missing-parent" }),
    /FOREIGN KEY constraint failed/
  );

  database.prepare("DELETE FROM pack_records WHERE id = ?").run("video-parent");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pack_record_videos").get().count, 0);
});

test("pack record videos enforce metrics and nullable boolean flags", async (t) => {
  const database = await migratedDatabase(t);
  const cases = [
    { id: "flags-null", mounted_required: null, simulated: null },
    { id: "flags-zero", mounted_required: 0, simulated: 0 },
    { id: "flags-one", mounted_required: 1, simulated: 1 }
  ];
  for (const [recordSequence, values] of cases.entries()) {
    const { id, mounted_required, simulated } = values;
    insertPackRecord(database, {
      id,
      record_sequence: recordSequence,
      awb_normalized: `AWB-FLAGS-${recordSequence}`
    });
    insertVideo(database, { record_id: id, mounted_required, simulated });
  }

  for (const [offset, overrides] of [
    { bytes: -1 },
    { size_mb: -0.1 },
    { mounted_required: -1 },
    { mounted_required: 2 },
    { simulated: -1 },
    { simulated: 2 }
  ].entries()) {
    const recordId = `invalid-video-${offset}`;
    insertPackRecord(database, {
      id: recordId,
      record_sequence: cases.length + offset,
      awb_normalized: `AWB-INVALID-VIDEO-${offset}`
    });
    assert.throws(() => insertVideo(database, { record_id: recordId, ...overrides }), /CHECK constraint failed/);
  }
});

test("video path, share-link, and storage fields are not unique", async (t) => {
  const database = await migratedDatabase(t);
  const sharedVideoFields = {
    file_name: "shared-name.mp4",
    relative_path: "folder/../lossless/shared-name.mp4",
    storage_target_id: "target-1",
    storage_label: "Shared storage",
    storage_host: "storage.local",
    share_link: "https://example.test/shared"
  };

  for (const recordSequence of [0, 1]) {
    const recordId = `shared-fields-${recordSequence}`;
    insertPackRecord(database, {
      id: recordId,
      record_sequence: recordSequence,
      awb_normalized: `AWB-SHARED-${recordSequence}`
    });
    insertVideo(database, { record_id: recordId, ...sharedVideoFields });
  }

  const videos = database.prepare(`
    SELECT file_name, relative_path, storage_target_id, storage_label, storage_host, share_link
    FROM pack_record_videos ORDER BY record_id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(videos, [sharedVideoFields, sharedVideoFields]);
});

test("migration runner applies files in numeric order", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const migrationsDirectory = await temporaryDirectory(t, "smartrecord-sqlite-ordering-");
  await writeFile(
    path.join(migrationsDirectory, "010_tenth.sql"),
    "INSERT INTO migration_order (version) VALUES (10);\n"
  );
  await writeFile(
    path.join(migrationsDirectory, "002_second.sql"),
    "CREATE TABLE migration_order (position INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO migration_order (version) VALUES (2);\n"
  );

  const result = await runSqliteMigrations(database, { migrationsDirectory });

  assert.deepEqual(result.applied.map((migration) => migration.version), [2, 10]);
  assert.deepEqual(
    database.prepare("SELECT version FROM migration_order ORDER BY position").all().map((row) => row.version),
    [2, 10]
  );
});

test("migration runner applies only the new migration during forward progression", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const migrationsDirectory = await temporaryDirectory(t, "smartrecord-sqlite-forward-");
  const firstMigrationPath = path.join(migrationsDirectory, "001_storage_foundation.sql");
  const secondMigrationPath = path.join(migrationsDirectory, "002_forward_progress.sql");
  await writeFile(firstMigrationPath, await readFile(defaultMigrationPath));

  const initial = await runSqliteMigrations(database, { migrationsDirectory });
  assert.deepEqual(initial.applied.map((migration) => migration.name), ["001_storage_foundation.sql"]);

  await writeFile(secondMigrationPath, "CREATE TABLE forward_progress (id INTEGER PRIMARY KEY);\n");
  const upgraded = await runSqliteMigrations(database, { migrationsDirectory });

  assert.deepEqual(upgraded.applied.map((migration) => migration.name), ["002_forward_progress.sql"]);
  assert.equal(upgraded.currentVersion, 2);
  assert.equal(readSqliteSchemaVersion(database), 2);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);

  const migrationRows = database.prepare(`
    SELECT version, name, checksum_sha256
    FROM schema_migrations
    ORDER BY version
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(migrationRows, [
    {
      version: 1,
      name: "001_storage_foundation.sql",
      checksum_sha256: await sha256File(firstMigrationPath)
    },
    {
      version: 2,
      name: "002_forward_progress.sql",
      checksum_sha256: await sha256File(secondMigrationPath)
    }
  ]);
});

test("a failed migration rolls back its schema changes and migration record", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const migrationsDirectory = await temporaryDirectory(t, "smartrecord-sqlite-rollback-");
  await writeFile(
    path.join(migrationsDirectory, "001_failing.sql"),
    "CREATE TABLE should_roll_back (id INTEGER PRIMARY KEY); INSERT INTO missing_table (id) VALUES (1);\n"
  );

  await assert.rejects(
    runSqliteMigrations(database, { migrationsDirectory }),
    (error) => {
      assert.equal(error instanceof SqliteMigrationError, true);
      assert.equal(error.code, "SQLITE_MIGRATION_APPLY_FAILED");
      assert.match(error.message, /001_failing\.sql/);
      return true;
    }
  );

  const rolledBackTable = database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'should_roll_back'
  `).get();
  const migrationsTable = database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  assert.equal(rolledBackTable, undefined);
  assert.equal(migrationsTable, undefined);
  assert.equal(readSqliteSchemaVersion(database), 0);
});

test("migration runner rejects an edited applied migration checksum", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const migrationsDirectory = await temporaryDirectory(t, "smartrecord-sqlite-checksum-");
  const migrationCopyPath = path.join(migrationsDirectory, "001_storage_foundation.sql");
  await writeFile(migrationCopyPath, await readFile(defaultMigrationPath));
  await runSqliteMigrations(database, { migrationsDirectory });
  await writeFile(migrationCopyPath, `${await readFile(migrationCopyPath, "utf8")}\n-- edited\n`);

  await assert.rejects(
    runSqliteMigrations(database, { migrationsDirectory }),
    (error) => {
      assert.equal(error instanceof SqliteMigrationError, true);
      assert.equal(error.code, "SQLITE_MIGRATION_CHECKSUM_MISMATCH");
      assert.match(error.message, /must never be edited/);
      return true;
    }
  );
});

test("migration runner rejects an applied migration renamed at the same version", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const migrationsDirectory = await temporaryDirectory(t, "smartrecord-sqlite-name-mismatch-");
  const originalPath = path.join(migrationsDirectory, "001_original.sql");
  const renamedPath = path.join(migrationsDirectory, "001_renamed.sql");
  await writeFile(originalPath, "CREATE TABLE name_mismatch_probe (id INTEGER PRIMARY KEY);\n");
  await runSqliteMigrations(database, { migrationsDirectory });
  await rename(originalPath, renamedPath);

  await assert.rejects(
    runSqliteMigrations(database, { migrationsDirectory }),
    (error) => {
      assert.equal(error instanceof SqliteMigrationError, true);
      assert.equal(error.code, "SQLITE_MIGRATION_NAME_MISMATCH");
      return true;
    }
  );
});

test("migration runner rejects a missing already-applied migration file", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const migrationsDirectory = await temporaryDirectory(t, "smartrecord-sqlite-missing-file-");
  const migrationPath = path.join(migrationsDirectory, "001_temporary.sql");
  await writeFile(migrationPath, "CREATE TABLE missing_file_probe (id INTEGER PRIMARY KEY);\n");
  await runSqliteMigrations(database, { migrationsDirectory });
  await unlink(migrationPath);

  await assert.rejects(
    runSqliteMigrations(database, { migrationsDirectory }),
    (error) => {
      assert.equal(error instanceof SqliteMigrationError, true);
      assert.equal(error.code, "SQLITE_MIGRATION_FILE_MISSING");
      return true;
    }
  );
});

test("migration runner refuses unsupported future schema versions", async (t) => {
  const database = await managedInMemoryDatabase(t);
  database.exec("PRAGMA user_version = 6");

  await assert.rejects(
    runSqliteMigrations(database),
    (error) => {
      assert.equal(error instanceof SqliteMigrationError, true);
      assert.equal(error.code, "SQLITE_SCHEMA_VERSION_UNSUPPORTED");
      return true;
    }
  );
  const migrationTable = database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  assert.equal(migrationTable, undefined);
});

test("migration runner mirrors the latest applied migration to PRAGMA user_version", async (t) => {
  const database = await managedInMemoryDatabase(t);

  await runSqliteMigrations(database);

  assert.equal(readSqliteSchemaVersion(database), 5);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 5);
});

test("metadata helpers create, read, update, list, and delete JSON values", async (t) => {
  const database = await migratedDatabase(t);
  const created = setStorageMetadata(database, "station.profile", { station: "A1", enabled: true }, {
    now: () => new Date("2026-07-14T11:00:00.000Z")
  });

  assert.deepEqual(created, {
    key: "station.profile",
    value: { station: "A1", enabled: true },
    updatedAt: "2026-07-14T11:00:00.000Z"
  });
  assert.deepEqual(readStorageMetadata(database, "station.profile"), created);

  const updated = setStorageMetadata(database, "station.profile", ["A1", "A2"], {
    now: () => new Date("2026-07-14T12:00:00.000Z")
  });
  setStorageMetadata(database, "application.mode", "foundation");
  assert.deepEqual(readStorageMetadata(database, "station.profile"), updated);
  assert.deepEqual(listStorageMetadata(database).map((entry) => entry.key), ["application.mode", "station.profile"]);
  assert.equal(removeStorageMetadata(database, "station.profile"), true);
  assert.equal(removeStorageMetadata(database, "station.profile"), false);
  assert.equal(readStorageMetadata(database, "station.profile"), null);
});

test("storage_metadata rejects invalid JSON and helpers report corrupt stored JSON clearly", async (t) => {
  const database = await migratedDatabase(t);

  assert.throws(
    () => database.prepare(`
      INSERT INTO storage_metadata (key, value_json, updated_at) VALUES (?, ?, ?)
    `).run("invalid.direct", "{not-json", "2026-07-14T00:00:00.000Z"),
    /CHECK constraint failed/
  );
  assert.throws(
    () => setStorageMetadata(database, "invalid.value", 1n),
    (error) => error instanceof SqliteMetadataError && error.code === "SQLITE_METADATA_VALUE_INVALID"
  );

  database.exec("PRAGMA ignore_check_constraints = ON");
  database.prepare(`
    INSERT INTO storage_metadata (key, value_json, updated_at) VALUES (?, ?, ?)
  `).run("corrupt.value", "{not-json", "2026-07-14T00:00:00.000Z");
  database.exec("PRAGMA ignore_check_constraints = OFF");

  assert.throws(
    () => readStorageMetadata(database, "corrupt.value"),
    (error) => error instanceof SqliteMetadataError && error.code === "SQLITE_METADATA_JSON_INVALID"
  );
});

test("metadata helpers reject invalid keys before preparing writes", async (t) => {
  const database = await migratedDatabase(t);

  for (const invalidKey of ["", " leading", "1starts-with-number", "contains space", "../sql"]) {
    assert.throws(
      () => setStorageMetadata(database, invalidKey, true),
      (error) => error instanceof SqliteMetadataError && error.code === "SQLITE_METADATA_KEY_INVALID"
    );
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM storage_metadata").get().count, 0);
});

async function migratedDatabase(t) {
  const database = await managedInMemoryDatabase(t);
  await runSqliteMigrations(database);
  return database;
}

function tableColumns(database, tableName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all().map(({ name }) => name);
}

function insertPackRecord(database, overrides = {}) {
  const record = {
    id: "record-default",
    record_sequence: 0,
    awb: "AWB-DEFAULT",
    awb_normalized: "AWB-DEFAULT",
    platform: null,
    employee_id: null,
    station_id: null,
    started_at: null,
    ended_at: null,
    duration_seconds: null,
    status: "pass",
    item_summary: null,
    size_mb: null,
    storage_target_id: null,
    storage_label: null,
    storage_provider: null,
    storage_host: null,
    share_link: null,
    force_close_reason: null,
    source_payload_json: null,
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
  const columns = Object.keys(record);
  return database.prepare(`
    INSERT INTO pack_records (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => record[column]));
}

function insertVideo(database, overrides = {}) {
  const video = {
    record_id: "record-default",
    file_name: null,
    relative_path: null,
    bytes: null,
    size_mb: null,
    content_type: null,
    storage_target_id: null,
    storage_label: null,
    storage_host: null,
    storage_mode: null,
    mounted_required: null,
    simulated: null,
    external_url: null,
    custom_path: null,
    share_link: null,
    saved_at: null,
    ...overrides
  };
  const columns = Object.keys(video);
  return database.prepare(`
    INSERT INTO pack_record_videos (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => video[column]));
}

function insertVersion4User(database, overrides = {}) {
  const user = {
    id: "USR-MIGRATION-1",
    email: "Migration.User@Example.Test",
    name: "Migration User",
    role_id: "packer",
    role_name: null,
    employee_name: "Existing Employee",
    employee_id: "EMP-005",
    active: 1,
    password_salt: "existing-salt",
    password_hash: "a".repeat(64),
    created_at: "2026-07-14T10:00:00.000Z",
    updated_at: "2026-07-14T10:00:00.000Z",
    deleted_at: null,
    ...overrides
  };
  const columns = Object.keys(user);
  return database.prepare(`
    INSERT INTO main.users (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => user[column]));
}

function insertVersion5User(database, { id, username, email }) {
  return database.prepare(`
    INSERT INTO main.users (
      id, username, email, name, role_id, role_name, employee_name, employee_id,
      active, password_salt, password_hash, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, username, email, "Direct User", "packer", null, null, null, 1,
    "direct-salt", "b".repeat(64), "2026-07-14T10:00:00.000Z",
    "2026-07-14T10:00:00.000Z", null
  );
}

function snapshotUserStorage(database) {
  const rows = (table, order) => database.prepare(`
    SELECT * FROM main.${table} ORDER BY ${order}
  `).all().map((row) => ({ ...row }));
  return {
    users: rows("users", "user_sequence"),
    permissions: rows("user_module_permissions", "user_id, permission_sequence"),
    auditLogs: rows("user_audit_logs", "audit_sequence"),
    auditFields: rows("user_audit_log_fields", "audit_sequence, field_sequence"),
    activityLogs: rows("user_activity_logs", "activity_sequence")
  };
}

function snapshotMainSchema(database) {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM main.sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all().map((row) => ({ ...row }));
}

async function copyDefaultMigrations(t, prefix) {
  const directory = await temporaryDirectory(t, prefix);
  const sourceDirectory = path.dirname(defaultMigrationPath);
  for (const name of [
    "001_storage_foundation.sql",
    "002_pack_records.sql",
    "003_orders_labels.sql",
    "004_users.sql",
    "005_usernames.sql"
  ]) {
    await writeFile(path.join(directory, name), await readFile(path.join(sourceDirectory, name)));
  }
  return directory;
}

async function managedInMemoryDatabase(t) {
  const database = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(database));
  return database;
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
