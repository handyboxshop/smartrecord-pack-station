import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  checkSqliteRuntimeCompatibility,
  loadNodeSqlite
} from "./sqliteRuntimeCompatibility.mjs";

const SQLITE_MEMORY_PATH = ":memory:";
const REQUIRED_BUSY_TIMEOUT_MS = 5000;
const REQUIRED_SYNCHRONOUS_MODE = 2;
const databaseState = new WeakMap();
const closedDatabases = new WeakSet();
let sqliteRuntimePromise;

export class SqliteStorageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "SqliteStorageError";
    this.code = code;
  }
}

export class SqliteDatabaseError extends SqliteStorageError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = "SqliteDatabaseError";
  }
}

export async function openSqliteDatabase(databasePath, { createParentDirectory = false } = {}) {
  const resolvedPath = validateFileDatabasePath(databasePath);

  if (createParentDirectory) {
    try {
      await mkdir(path.dirname(resolvedPath), { recursive: true });
    } catch (cause) {
      throw databaseError(
        "SQLITE_PARENT_DIRECTORY_FAILED",
        `Unable to create the SQLite parent directory for ${resolvedPath}.`,
        cause
      );
    }
  }

  return openConfiguredDatabase(resolvedPath, false);
}

export async function openInMemoryDatabase() {
  return openConfiguredDatabase(SQLITE_MEMORY_PATH, true);
}

export function getSqliteDatabaseConfiguration(database) {
  requireOpenDatabase(database);
  const state = databaseState.get(database);
  if (!state) {
    throw databaseError(
      "SQLITE_DATABASE_NOT_MANAGED",
      "The SQLite database was not opened by the SmartRecord storage module."
    );
  }

  return { ...state };
}

export function getSqliteRuntimeVersion(database) {
  requireOpenDatabase(database);
  const version = String(database.prepare("SELECT sqlite_version() AS version").get()?.version || "").trim();
  if (!version) {
    throw databaseError("SQLITE_VERSION_UNAVAILABLE", "SQLite did not report a runtime version.");
  }
  return version;
}

export function runSqliteQuickCheck(database) {
  requireOpenDatabase(database);
  const messages = database.prepare("PRAGMA quick_check").all().map((row) => String(row.quick_check));
  return {
    ok: messages.length === 1 && messages[0] === "ok",
    messages
  };
}

export function runSqliteForeignKeyCheck(database) {
  requireOpenDatabase(database);
  const violations = database.prepare("PRAGMA foreign_key_check").all().map((row) => ({ ...row }));
  return {
    ok: violations.length === 0,
    violations
  };
}

export function runInSqliteTransaction(database, callback) {
  requireOpenDatabase(database);
  if (typeof callback !== "function") {
    throw databaseError("SQLITE_TRANSACTION_CALLBACK_INVALID", "A synchronous transaction callback is required.");
  }

  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (cause) {
    throw databaseError("SQLITE_TRANSACTION_BEGIN_FAILED", "Unable to begin SQLite transaction.", cause);
  }
  try {
    const result = callback(database);
    if (result && typeof result.then === "function") {
      throw databaseError(
        "SQLITE_TRANSACTION_CALLBACK_ASYNC",
        "SQLite transaction callbacks must be synchronous."
      );
    }
    database.exec("COMMIT");
    return result;
  } catch (cause) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackCause) {
      throw databaseError(
        "SQLITE_TRANSACTION_ROLLBACK_FAILED",
        "SQLite transaction failed and could not be rolled back safely.",
        new AggregateError([cause, rollbackCause])
      );
    }

    if (cause instanceof SqliteStorageError) throw cause;
    throw databaseError("SQLITE_TRANSACTION_FAILED", "SQLite transaction failed and was rolled back.", cause);
  }
}

export function closeSqliteDatabase(database) {
  if (!database || typeof database.close !== "function") {
    throw databaseError("SQLITE_DATABASE_INVALID", "A valid SQLite database is required.");
  }
  if (closedDatabases.has(database)) return false;

  try {
    database.close();
    closedDatabases.add(database);
    return true;
  } catch (cause) {
    throw databaseError("SQLITE_CLOSE_FAILED", "Unable to close the SQLite database safely.", cause);
  }
}

async function openConfiguredDatabase(databasePath, isMemory) {
  const runtime = await getCompatibleSqliteRuntime();
  let database;

  try {
    database = new runtime.DatabaseSync(databasePath);
    configureDatabase(database, { isMemory });
    databaseState.set(database, {
      path: databasePath,
      isMemory,
      foreignKeys: true,
      journalMode: isMemory ? "memory" : "wal",
      synchronous: "full",
      busyTimeoutMs: REQUIRED_BUSY_TIMEOUT_MS
    });
    return database;
  } catch (cause) {
    if (database) {
      try {
        database.close();
      } catch {
        // The original open/configuration failure is the actionable error.
      }
    }
    if (cause instanceof SqliteStorageError) throw cause;
    throw databaseError("SQLITE_OPEN_FAILED", `Unable to open SQLite database at ${databasePath}.`, cause);
  }
}

async function getCompatibleSqliteRuntime() {
  sqliteRuntimePromise ??= (async () => {
    const runtime = await loadNodeSqlite();
    await checkSqliteRuntimeCompatibility({ sqliteModule: runtime });
    return runtime;
  })();
  return sqliteRuntimePromise;
}

function configureDatabase(database, { isMemory }) {
  database.exec("PRAGMA foreign_keys = ON");
  validatePragmaNumber(database, "foreign_keys", 1);

  if (!isMemory) {
    const journalMode = String(database.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode || "").toLowerCase();
    if (journalMode !== "wal") {
      throw databaseError(
        "SQLITE_JOURNAL_MODE_INVALID",
        `SQLite journal_mode must be WAL for file databases; received ${journalMode || "unknown"}.`
      );
    }
  }

  database.exec("PRAGMA synchronous = FULL");
  validatePragmaNumber(database, "synchronous", REQUIRED_SYNCHRONOUS_MODE);

  database.exec(`PRAGMA busy_timeout = ${REQUIRED_BUSY_TIMEOUT_MS}`);
  validatePragmaNumber(database, "busy_timeout", REQUIRED_BUSY_TIMEOUT_MS);
}

function validatePragmaNumber(database, pragmaName, expected) {
  const row = database.prepare(`PRAGMA ${pragmaName}`).get();
  const actual = Number(row ? Object.values(row)[0] : Number.NaN);
  if (actual !== expected) {
    throw databaseError(
      "SQLITE_PRAGMA_INVALID",
      `SQLite PRAGMA ${pragmaName} must be ${expected}; received ${Number.isFinite(actual) ? actual : "unknown"}.`
    );
  }
}

function validateFileDatabasePath(databasePath) {
  if (typeof databasePath !== "string" || !databasePath.trim()) {
    throw databaseError("SQLITE_PATH_REQUIRED", "An explicit SQLite database path is required.");
  }
  if (databasePath.includes("\0")) {
    throw databaseError("SQLITE_PATH_INVALID", "The SQLite database path contains an invalid null byte.");
  }
  if (databasePath.trim() === SQLITE_MEMORY_PATH) {
    throw databaseError(
      "SQLITE_PATH_MEMORY_RESERVED",
      "Use openInMemoryDatabase() when an in-memory SQLite database is required."
    );
  }
  return path.resolve(databasePath);
}

function requireOpenDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw databaseError("SQLITE_DATABASE_INVALID", "A valid SQLite database is required.");
  }
  if (closedDatabases.has(database)) {
    throw databaseError("SQLITE_DATABASE_CLOSED", "The SQLite database is already closed.");
  }
}

function databaseError(code, message, cause) {
  return new SqliteDatabaseError(code, message, cause ? { cause } : undefined);
}
