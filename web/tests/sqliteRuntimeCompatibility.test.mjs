import assert from "node:assert/strict";
import test from "node:test";
import {
  SqliteRuntimeCompatibilityError,
  checkSqliteRuntimeCompatibility,
  loadNodeSqlite
} from "../src/storage/sqliteRuntimeCompatibility.mjs";

test("node:sqlite can be imported with the required top-level APIs", async () => {
  const sqlite = await loadNodeSqlite();

  assert.equal(typeof sqlite.DatabaseSync, "function");
  assert.equal(typeof sqlite.StatementSync, "function");
  assert.equal(typeof sqlite.backup, "function");
});

test("node:sqlite opens an in-memory database and creates a table", async () => {
  const { DatabaseSync } = await loadNodeSqlite();
  const database = new DatabaseSync(":memory:");

  try {
    database.exec("CREATE TABLE compatibility_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("compatibility_probe");
    assert.equal(table.name, "compatibility_probe");
  } finally {
    database.close();
  }
});

test("node:sqlite commits an in-memory transaction", async () => {
  const database = await createTransactionDatabase();

  try {
    database.exec("BEGIN");
    database.prepare("INSERT INTO events (value) VALUES (?)").run("committed");
    database.exec("COMMIT");

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
  } finally {
    database.close();
  }
});

test("node:sqlite rolls back an in-memory transaction", async () => {
  const database = await createTransactionDatabase();

  try {
    database.exec("BEGIN");
    database.prepare("INSERT INTO events (value) VALUES (?)").run("rolled-back");
    database.exec("ROLLBACK");

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
  } finally {
    database.close();
  }
});

test("node:sqlite enables foreign key enforcement in memory", async () => {
  const { DatabaseSync } = await loadNodeSqlite();
  const database = new DatabaseSync(":memory:");

  try {
    database.exec("PRAGMA foreign_keys = ON");
    assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  } finally {
    database.close();
  }
});

test("node:sqlite reports its SQLite runtime version", async () => {
  const { DatabaseSync } = await loadNodeSqlite();
  const database = new DatabaseSync(":memory:");

  try {
    const version = database.prepare("SELECT sqlite_version() AS version").get().version;
    assert.match(version, /^\d+\.\d+\.\d+$/);
  } finally {
    database.close();
  }
});

test("node:sqlite closes an in-memory database safely", async () => {
  const { DatabaseSync } = await loadNodeSqlite();
  const database = new DatabaseSync(":memory:");

  assert.doesNotThrow(() => database.close());
});

test("compatibility check reports Node, SQLite, and required APIs", async () => {
  const result = await checkSqliteRuntimeCompatibility();

  assert.equal(result.compatible, true);
  assert.equal(result.nodeVersion, process.version);
  assert.match(result.sqliteVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(result.database, ":memory:");
  assert.deepEqual(result.apis, {
    DatabaseSync: true,
    StatementSync: true,
    preparedStatementEquivalent: true,
    backup: true
  });
});

test("compatibility check clearly reports a missing required API", async () => {
  await assert.rejects(
    checkSqliteRuntimeCompatibility({ sqliteModule: {} }),
    (error) => {
      assert.equal(error instanceof SqliteRuntimeCompatibilityError, true);
      assert.equal(error.code, "SQLITE_RUNTIME_INCOMPATIBLE");
      assert.match(error.message, /missing required API DatabaseSync\(\)/);
      return true;
    }
  );
});

test("compatibility check clearly reports a missing backup API", async () => {
  const sqlite = await loadNodeSqlite();

  await assert.rejects(
    checkSqliteRuntimeCompatibility({
      sqliteModule: {
        DatabaseSync: sqlite.DatabaseSync,
        StatementSync: sqlite.StatementSync
      }
    }),
    (error) => {
      assert.equal(error.code, "SQLITE_RUNTIME_INCOMPATIBLE");
      assert.match(error.message, /missing required API backup\(\)/);
      return true;
    }
  );
});

test("compatibility check accepts an equivalent prepared statement API", async () => {
  const sqlite = await loadNodeSqlite();
  const result = await checkSqliteRuntimeCompatibility({
    sqliteModule: {
      DatabaseSync: sqlite.DatabaseSync,
      backup: sqlite.backup
    }
  });

  assert.equal(result.apis.StatementSync, false);
  assert.equal(result.apis.preparedStatementEquivalent, true);
});

test("node:sqlite import failures are wrapped as compatibility errors", async () => {
  await assert.rejects(
    loadNodeSqlite(async () => {
      throw new Error("synthetic missing built-in module");
    }),
    (error) => {
      assert.equal(error instanceof SqliteRuntimeCompatibilityError, true);
      assert.equal(error.code, "SQLITE_RUNTIME_INCOMPATIBLE");
      assert.match(error.message, /Unable to load node:sqlite/);
      assert.equal(error.cause.message, "synthetic missing built-in module");
      return true;
    }
  );
});

async function createTransactionDatabase() {
  const { DatabaseSync } = await loadNodeSqlite();
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  return database;
}
