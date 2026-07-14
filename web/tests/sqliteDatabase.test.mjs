import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SqliteDatabaseError,
  closeSqliteDatabase,
  getSqliteDatabaseConfiguration,
  getSqliteRuntimeVersion,
  openInMemoryDatabase,
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

  assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(database.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  await access(databasePath);
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

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
