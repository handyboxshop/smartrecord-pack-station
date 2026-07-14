const SQLITE_RUNTIME_ERROR_CODE = "SQLITE_RUNTIME_INCOMPATIBLE";

export class SqliteRuntimeCompatibilityError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "SqliteRuntimeCompatibilityError";
    this.code = SQLITE_RUNTIME_ERROR_CODE;
  }
}

export async function loadNodeSqlite(importer = () => import("node:sqlite")) {
  try {
    return await importer();
  } catch (cause) {
    throw new SqliteRuntimeCompatibilityError(
      `Unable to load node:sqlite on Node ${process.version}. The pinned SQLite runtime is unavailable.`,
      { cause }
    );
  }
}

export async function checkSqliteRuntimeCompatibility({
  sqliteModule,
  importer,
  nodeVersion = process.version
} = {}) {
  const runtime = sqliteModule ?? await loadNodeSqlite(importer);
  requireFunction(runtime, "DatabaseSync", nodeVersion);
  requireFunction(runtime, "backup", nodeVersion);

  let database;
  let result;
  let compatibilityError;

  try {
    database = new runtime.DatabaseSync(":memory:");
    requireFunction(database, "prepare", nodeVersion, "DatabaseSync instance");
    requireFunction(database, "close", nodeVersion, "DatabaseSync instance");

    const statement = database.prepare("SELECT sqlite_version() AS version");
    const hasStatementSync = typeof runtime.StatementSync === "function";
    const hasEquivalentStatementApi = typeof statement?.get === "function" && typeof statement?.run === "function";
    if (!hasStatementSync && !hasEquivalentStatementApi) {
      throw incompatible(
        `node:sqlite on Node ${nodeVersion} does not provide StatementSync or an equivalent prepared statement API.`
      );
    }
    if (typeof statement?.get !== "function") {
      throw incompatible(`node:sqlite on Node ${nodeVersion} does not provide StatementSync.get().`);
    }
    if (typeof statement?.run !== "function") {
      throw incompatible(`node:sqlite on Node ${nodeVersion} does not provide StatementSync.run().`);
    }

    const sqliteVersion = String(statement.get()?.version || "").trim();
    if (!sqliteVersion) {
      throw incompatible(`node:sqlite on Node ${nodeVersion} did not report a SQLite runtime version.`);
    }

    result = {
      compatible: true,
      nodeVersion,
      sqliteVersion,
      database: ":memory:",
      apis: {
        DatabaseSync: true,
        StatementSync: hasStatementSync,
        preparedStatementEquivalent: hasEquivalentStatementApi,
        backup: true
      }
    };
  } catch (cause) {
    compatibilityError = cause instanceof SqliteRuntimeCompatibilityError
      ? cause
      : incompatible(`node:sqlite compatibility check failed on Node ${nodeVersion}: ${cause.message}`, cause);
  } finally {
    if (database) {
      try {
        database.close();
      } catch (cause) {
        compatibilityError ??= incompatible(
          `node:sqlite opened an in-memory database on Node ${nodeVersion} but could not close it safely: ${cause.message}`,
          cause
        );
      }
    }
  }

  if (compatibilityError) throw compatibilityError;
  return result;
}

function requireFunction(target, name, nodeVersion, targetLabel = "node:sqlite") {
  if (typeof target?.[name] === "function") return;
  throw incompatible(`${targetLabel} on Node ${nodeVersion} is missing required API ${name}().`);
}

function incompatible(message, cause) {
  return new SqliteRuntimeCompatibilityError(message, cause ? { cause } : undefined);
}
