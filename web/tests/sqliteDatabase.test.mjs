import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  SqliteDatabaseError,
  closeSqliteDatabase,
  getSqliteDatabaseConfiguration,
  getSqliteRuntimeVersion,
  openInMemoryDatabase,
  openReadOnlySqliteDatabase,
  openSqliteDatabase,
  runInSqliteTransaction,
  runSqliteForeignKeyCheck,
  runSqliteQuickCheck
} from "../src/storage/sqliteDatabase.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

test("opens and configures an in-memory SQLite database", async (t) => {
  const database = await managedInMemoryDatabase(t);

  assert.deepEqual(getSqliteDatabaseConfiguration(database), {
    path: ":memory:",
    isMemory: true,
    foreignKeys: true,
    journalMode: "memory",
    synchronous: "full",
    busyTimeoutMs: 5000
  });
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(database.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  assert.match(getSqliteRuntimeVersion(database), /^\d+\.\d+\.\d+$/);
});

test("opens a temporary file database with WAL and required PRAGMA settings", async (t) => {
  const { database, databasePath } = await managedTemporaryFileDatabase(t);

  assert.deepEqual(getSqliteDatabaseConfiguration(database), {
    path: databasePath,
    isMemory: false,
    foreignKeys: true,
    journalMode: "wal",
    synchronous: "full",
    busyTimeoutMs: 5000
  });
  assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(database.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  await access(databasePath);
});

test("opens an existing file read-only without changing bytes, metadata, or journal mode", async (t) => {
  const fixture = await closedTemporaryDeleteJournalDatabase(t);
  const beforeBytes = await readFile(fixture.databasePath);
  const beforeHash = sha256(beforeBytes);
  const beforeStat = await lstat(fixture.databasePath);
  const beforeEntries = await readdir(fixture.directory);

  const database = await openReadOnlySqliteDatabase(fixture.databasePath);
  assert.deepEqual(getSqliteDatabaseConfiguration(database), {
    path: fixture.databasePath,
    isMemory: false,
    readOnly: true,
    queryOnly: true,
    foreignKeys: true,
    journalMode: "delete",
    busyTimeoutMs: 5000
  });
  assert.equal(database.prepare("SELECT value FROM sample").get().value, "unchanged");
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(database.prepare("PRAGMA query_only").get().query_only, 1);
  const actualJournalMode = database.prepare("PRAGMA journal_mode").get().journal_mode;
  assert.equal(actualJournalMode, "delete");
  assert.equal(getSqliteDatabaseConfiguration(database).journalMode, actualJournalMode);
  assert.equal(closeSqliteDatabase(database), true);
  assert.equal(closeSqliteDatabase(database), false);

  const afterBytes = await readFile(fixture.databasePath);
  const afterStat = await lstat(fixture.databasePath);
  assert.equal(sha256(afterBytes), beforeHash);
  assert.deepEqual(afterBytes, beforeBytes);
  assert.deepEqual(stableMetadata(afterStat), stableMetadata(beforeStat));
  assert.deepEqual(await readdir(fixture.directory), beforeEntries);
});

test("read-only opening never creates a missing database or parent", async (t) => {
  const directory = await temporaryDirectory(t, "smartrecord-sqlite-read-only-missing-");
  const missingDatabase = path.join(directory, "missing.sqlite");
  await assert.rejects(openReadOnlySqliteDatabase(missingDatabase), typedReadOnlyPathError);
  await assert.rejects(access(missingDatabase), { code: "ENOENT" });

  const missingParentDatabase = path.join(directory, "missing", "database.sqlite");
  await assert.rejects(openReadOnlySqliteDatabase(missingParentDatabase), typedReadOnlyPathError);
  await assert.rejects(access(path.dirname(missingParentDatabase)), { code: "ENOENT" });
});

test("read-only handles reject mutations and preserve all stored values", async (t) => {
  const fixture = await closedTemporaryDeleteJournalDatabase(t);
  const before = await readFile(fixture.databasePath);
  const database = await openReadOnlySqliteDatabase(fixture.databasePath);
  t.after(() => closeSqliteDatabase(database));

  const statements = [
    "INSERT INTO sample (value) VALUES ('inserted')",
    "UPDATE sample SET value = 'updated'",
    "DELETE FROM sample",
    "CREATE TABLE created (id INTEGER)",
    "DROP TABLE sample",
    "ALTER TABLE sample ADD COLUMN added TEXT",
    "VACUUM"
  ];
  for (const statement of statements) assert.throws(() => database.exec(statement));
  assert.throws(() => database.exec("PRAGMA user_version = 99"));
  assert.throws(() => database.exec("PRAGMA application_id = 99"));
  try {
    assert.equal(database.prepare("PRAGMA journal_mode = WAL").get().journal_mode, "delete");
  } catch (error) {
    assert.match(String(error?.message), /readonly|write/i);
  }
  let beganImmediate = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    beganImmediate = true;
    assert.throws(() => database.exec("UPDATE sample SET value = 'transaction-update'"));
  } catch (error) {
    assert.equal(beganImmediate, false);
    assert.match(String(error?.message), /readonly|write/i);
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK");
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sample").get().count, 1);
  assert.equal(database.prepare("SELECT value FROM sample").get().value, "unchanged");
  closeSqliteDatabase(database);
  assert.deepEqual(await readFile(fixture.databasePath), before);
  assert.deepEqual(await readdir(fixture.directory), ["database.sqlite"]);
});

test("read-only opening fails closed when a SQLite sidecar exists", async (t) => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const fixture = await closedTemporaryDeleteJournalDatabase(t, `smartrecord-sqlite-sidecar-${suffix.slice(1)}-`);
    await writeFile(`${fixture.databasePath}${suffix}`, "synthetic-sidecar");
    await assert.rejects(
      openReadOnlySqliteDatabase(fixture.databasePath),
      (error) => error instanceof SqliteDatabaseError && error.code === "SQLITE_READ_ONLY_SIDECAR_PRESENT"
    );
  }
});

test("read-only opening rejects a closed WAL database without changing it or creating sidecars", async (t) => {
  const fixture = await closedTemporaryWalDatabase(t);
  const beforeBytes = await readFile(fixture.databasePath);
  const beforeStat = await lstat(fixture.databasePath);
  const beforeEntries = await readdir(fixture.directory);

  await assert.rejects(
    openReadOnlySqliteDatabase(fixture.databasePath),
    (error) => error instanceof SqliteDatabaseError && error.code === "SQLITE_READ_ONLY_JOURNAL_UNSAFE"
  );

  const afterBytes = await readFile(fixture.databasePath);
  assert.deepEqual(afterBytes, beforeBytes);
  assert.equal(sha256(afterBytes), sha256(beforeBytes));
  assert.deepEqual(stableMetadata(await lstat(fixture.databasePath)), stableMetadata(beforeStat));
  assert.deepEqual(await readdir(fixture.directory), beforeEntries);
});

test("read-only opening rejects corrupt, truncated, mixed, and invalid SQLite headers", async (t) => {
  const corruptDirectory = await temporaryDirectory(t, "smartrecord-sqlite-read-only-corrupt-");
  const corruptPath = path.join(corruptDirectory, "corrupt.sqlite");
  await writeFile(corruptPath, "not a sqlite database");
  await assert.rejects(openReadOnlySqliteDatabase(corruptPath), typedHeaderError);

  const truncatedDirectory = await temporaryDirectory(t, "smartrecord-sqlite-read-only-truncated-");
  const truncatedPath = path.join(truncatedDirectory, "truncated.sqlite");
  await writeFile(truncatedPath, Buffer.from("SQLite format 3\0\x10\x00\x01\x01", "binary"));
  await assert.rejects(openReadOnlySqliteDatabase(truncatedPath), typedHeaderError);

  const mixed = await closedTemporaryDeleteJournalDatabase(t, "smartrecord-sqlite-read-only-mixed-");
  const mixedBytes = await readFile(mixed.databasePath);
  mixedBytes[18] = 1;
  mixedBytes[19] = 2;
  await writeFile(mixed.databasePath, mixedBytes);
  await assert.rejects(
    openReadOnlySqliteDatabase(mixed.databasePath),
    (error) => error instanceof SqliteDatabaseError && error.code === "SQLITE_READ_ONLY_JOURNAL_UNSAFE"
  );

  const invalid = await closedTemporaryDeleteJournalDatabase(t, "smartrecord-sqlite-read-only-invalid-");
  const invalidBytes = await readFile(invalid.databasePath);
  invalidBytes[16] = 0;
  invalidBytes[17] = 0;
  await writeFile(invalid.databasePath, invalidBytes);
  await assert.rejects(openReadOnlySqliteDatabase(invalid.databasePath), typedHeaderError);
});

test("read-only configuration failures return typed errors and release partial handles", async (t) => {
  const fixture = await closedTemporaryDeleteJournalDatabase(t, "smartrecord-sqlite-read-only-open-failure-");
  const blocker = new DatabaseSync(fixture.databasePath);
  blocker.exec("BEGIN EXCLUSIVE");
  try {
    await assert.rejects(
      openReadOnlySqliteDatabase(fixture.databasePath),
      (error) => error instanceof SqliteDatabaseError && error.code === "SQLITE_OPEN_FAILED"
    );
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }
  const database = await openReadOnlySqliteDatabase(fixture.databasePath);
  closeSqliteDatabase(database);
  assert.deepEqual(await readdir(fixture.directory), ["database.sqlite"]);
});

test("creates a missing parent directory only when explicitly requested", async (t) => {
  const directory = await temporaryDirectory(t, "smartrecord-sqlite-parent-");
  const databasePath = path.join(directory, "missing", "nested", "database.sqlite");

  await assert.rejects(
    openSqliteDatabase(databasePath),
    (error) => error instanceof SqliteDatabaseError && error.code === "SQLITE_OPEN_FAILED"
  );
  await assert.rejects(access(path.dirname(databasePath)), { code: "ENOENT" });

  const database = await openSqliteDatabase(databasePath, { createParentDirectory: true });
  t.after(() => closeSqliteDatabase(database));
  await access(databasePath);
});

test("file database API reserves :memory: for the dedicated in-memory opener", async (t) => {
  await assert.rejects(
    openSqliteDatabase(":memory:"),
    (error) => error instanceof SqliteDatabaseError && error.code === "SQLITE_PATH_MEMORY_RESERVED"
  );

  const database = await managedInMemoryDatabase(t);
  assert.equal(getSqliteDatabaseConfiguration(database).path, ":memory:");
});

test("commits successful transaction callbacks", async (t) => {
  const database = await managedInMemoryDatabase(t);
  database.exec("CREATE TABLE events (value TEXT NOT NULL)");

  const result = runInSqliteTransaction(database, () => {
    database.prepare("INSERT INTO events (value) VALUES (?)").run("committed");
    return "complete";
  });

  assert.equal(result, "complete");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
});

test("rolls back failed transaction callbacks and returns a typed error", async (t) => {
  const database = await managedInMemoryDatabase(t);
  database.exec("CREATE TABLE events (value TEXT NOT NULL)");

  assert.throws(
    () => runInSqliteTransaction(database, () => {
      database.prepare("INSERT INTO events (value) VALUES (?)").run("rolled-back");
      throw new Error("synthetic failure");
    }),
    (error) => {
      assert.equal(error instanceof SqliteDatabaseError, true);
      assert.equal(error.code, "SQLITE_TRANSACTION_FAILED");
      assert.equal(error.cause.message, "synthetic failure");
      return true;
    }
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
});

test("rejects asynchronous transaction callbacks and rolls back partial writes", async (t) => {
  const database = await managedInMemoryDatabase(t);
  database.exec("CREATE TABLE events (value TEXT NOT NULL)");

  assert.throws(
    () => runInSqliteTransaction(database, () => {
      database.prepare("INSERT INTO events (value) VALUES (?)").run("must-roll-back");
      return Promise.resolve("unsupported");
    }),
    (error) => {
      assert.equal(error instanceof SqliteDatabaseError, true);
      assert.equal(error.code, "SQLITE_TRANSACTION_CALLBACK_ASYNC");
      return true;
    }
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
});

test("quick_check reports a healthy temporary database", async (t) => {
  const { database } = await managedTemporaryFileDatabase(t);

  assert.deepEqual(runSqliteQuickCheck(database), { ok: true, messages: ["ok"] });
});

test("foreign_key_check reports violations without disabling configured enforcement permanently", async (t) => {
  const database = await managedInMemoryDatabase(t);
  database.exec(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY);
    CREATE TABLE children (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parents(id)
    );
    PRAGMA foreign_keys = OFF;
    INSERT INTO children (id, parent_id) VALUES (1, 999);
    PRAGMA foreign_keys = ON;
  `);

  const result = runSqliteForeignKeyCheck(database);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].table, "children");
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
});

test("closes a managed database safely and idempotently", async () => {
  const database = await openInMemoryDatabase();

  assert.equal(closeSqliteDatabase(database), true);
  assert.equal(closeSqliteDatabase(database), false);
  assert.throws(
    () => getSqliteRuntimeVersion(database),
    (error) => error.code === "SQLITE_DATABASE_CLOSED"
  );
});

test("temporary file databases are created outside the repository", async (t) => {
  const { databasePath } = await managedTemporaryFileDatabase(t);
  const relativeToRepository = path.relative(webRoot, databasePath);

  assert.equal(relativeToRepository.startsWith(".."), true);
  assert.equal(path.isAbsolute(relativeToRepository), false);
});

async function managedInMemoryDatabase(t) {
  const database = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(database));
  return database;
}

async function managedTemporaryFileDatabase(t) {
  const directory = await temporaryDirectory(t, "smartrecord-sqlite-database-");
  const databasePath = path.join(directory, "database.sqlite");
  const database = await openSqliteDatabase(databasePath);
  t.after(() => closeSqliteDatabase(database));
  return { database, databasePath, directory };
}

async function closedTemporaryDeleteJournalDatabase(t, prefix = "smartrecord-sqlite-read-only-") {
  const directory = await temporaryDirectory(t, prefix);
  const databasePath = path.join(directory, "database.sqlite");
  const database = await openSqliteDatabase(databasePath);
  database.exec("CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample (value) VALUES ('unchanged')");
  assert.equal(database.prepare("PRAGMA journal_mode = DELETE").get().journal_mode, "delete");
  closeSqliteDatabase(database);
  assert.deepEqual(await readdir(directory), ["database.sqlite"]);
  return { directory, databasePath };
}

async function closedTemporaryWalDatabase(t) {
  const directory = await temporaryDirectory(t, "smartrecord-sqlite-read-only-wal-");
  const databasePath = path.join(directory, "database.sqlite");
  const database = await openSqliteDatabase(databasePath);
  database.exec("CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample (value) VALUES ('unchanged')");
  closeSqliteDatabase(database);
  assert.deepEqual(await readdir(directory), ["database.sqlite"]);
  return { directory, databasePath };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableMetadata(value) {
  return {
    size: value.size,
    mode: value.mode,
    uid: value.uid,
    gid: value.gid,
    nlink: value.nlink,
    dev: value.dev,
    ino: value.ino,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs
  };
}

function typedReadOnlyPathError(error) {
  return error instanceof SqliteDatabaseError && error.code === "SQLITE_READ_ONLY_PATH_INVALID";
}

function typedHeaderError(error) {
  return error instanceof SqliteDatabaseError && error.code === "SQLITE_READ_ONLY_HEADER_INVALID";
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
