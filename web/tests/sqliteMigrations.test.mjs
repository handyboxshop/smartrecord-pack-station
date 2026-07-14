import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
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

test("initial migration creates only the storage foundation schema and records its checksum", async (t) => {
  const database = await managedInMemoryDatabase(t);
  const result = await runSqliteMigrations(database, {
    now: () => new Date("2026-07-14T10:00:00.000Z")
  });

  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.applied[0], {
    version: 1,
    name: "001_storage_foundation.sql",
    checksumSha256: result.applied[0].checksumSha256,
    appliedAt: "2026-07-14T10:00:00.000Z"
  });
  assert.match(result.applied[0].checksumSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.currentVersion, 1);

  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(tables, ["schema_migrations", "storage_metadata"]);

  const migrationRow = database.prepare("SELECT * FROM schema_migrations").get();
  assert.equal(migrationRow.version, 1);
  assert.equal(migrationRow.name, "001_storage_foundation.sql");
  assert.equal(migrationRow.checksum_sha256, result.applied[0].checksumSha256);
  assert.equal(migrationRow.applied_at, "2026-07-14T10:00:00.000Z");
});

test("migration runner is safe to run repeatedly", async (t) => {
  const database = await managedInMemoryDatabase(t);
  await runSqliteMigrations(database);

  const repeated = await runSqliteMigrations(database);

  assert.deepEqual(repeated.applied, []);
  assert.equal(repeated.currentVersion, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 1);
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
  database.exec("PRAGMA user_version = 2");

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

  assert.equal(readSqliteSchemaVersion(database), 1);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
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
