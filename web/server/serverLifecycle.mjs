import { stat } from "node:fs/promises";
import { Server } from "node:http";
import path from "node:path";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  runSqliteForeignKeyCheck,
  runSqliteQuickCheck
} from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";

const TARGET_SCHEMA_VERSION = 4;
const MAX_SHUTDOWN_REASON_LENGTH = 128;
const OPTION_KEYS = new Set([
  "server",
  "databasePath",
  "host",
  "port",
  "flushRuntimeState",
  "shutdownTimeoutMs",
  "dependencies"
]);
const DEPENDENCY_KEYS = new Set([
  "openDatabase",
  "runMigrations",
  "runQuickCheck",
  "runForeignKeyCheck",
  "closeDatabase"
]);
const claimedServers = new WeakSet();

const ERROR_MESSAGES = Object.freeze({
  SERVER_LIFECYCLE_OPTIONS_INVALID: "Server lifecycle options are invalid.",
  SERVER_SQLITE_PATH_INVALID: "SQLite database path is invalid.",
  SERVER_LIFECYCLE_ALREADY_STARTED: "HTTP server lifecycle has already started.",
  SERVER_SQLITE_OPEN_FAILED: "SQLite database could not be opened.",
  SERVER_SQLITE_MIGRATION_FAILED: "SQLite database migration failed.",
  SERVER_SQLITE_INTEGRITY_FAILED: "SQLite database integrity validation failed.",
  SERVER_LISTEN_FAILED: "HTTP server failed to start.",
  SERVER_SHUTDOWN_TIMEOUT: "HTTP server shutdown timed out.",
  SERVER_SQLITE_CLOSE_FAILED: "SQLite database could not be closed.",
  SERVER_SHUTDOWN_FAILED: "Server shutdown failed."
});

const defaultDependencies = Object.freeze({
  openDatabase: (databasePath) => openSqliteDatabase(databasePath, { createParentDirectory: false }),
  runMigrations: (database) => runSqliteMigrations(database, { maximumVersion: TARGET_SCHEMA_VERSION }),
  runQuickCheck: (database) => runSqliteQuickCheck(database),
  runForeignKeyCheck: (database) => runSqliteForeignKeyCheck(database),
  closeDatabase: (database) => closeSqliteDatabase(database)
});

/**
 * Owns SQLite readiness and orderly shutdown for a caller-supplied HTTP server.
 *
 * @param {object} options
 * @param {import("node:http").Server} options.server A not-yet-listening HTTP server.
 * @param {string} options.databasePath Explicit absolute SQLite database path.
 * @param {string} options.host Host passed to server.listen().
 * @param {number} options.port TCP port, including 0 for an ephemeral port.
 * @param {() => void | Promise<void>} options.flushRuntimeState Flushes authoritative JSON state during shutdown.
 * @param {number} [options.shutdownTimeoutMs=10000] Maximum HTTP drain period.
 * @param {object} [options.dependencies] Deterministic test seams for SQLite operations.
 * @returns {Promise<{
 *   server: import("node:http").Server,
 *   address: {address: string, family: string, port: number},
 *   schemaVersion: number,
 *   migrationsApplied: number,
 *   close: (reason?: string) => Promise<void>
 * }>} A ready lifecycle controller whose close method returns one memoized Promise.
 */
export async function startServerLifecycle(options) {
  const validated = await validateOptions(options);
  claimServer(validated.server);

  let database;
  try {
    database = await validated.dependencies.openDatabase(validated.databasePath, {
      createParentDirectory: false
    });
  } catch {
    throw lifecycleError("SERVER_SQLITE_OPEN_FAILED");
  }

  let migrationResult;
  try {
    migrationResult = await validated.dependencies.runMigrations(database, {
      maximumVersion: TARGET_SCHEMA_VERSION
    });
    validateMigrationResult(migrationResult);
  } catch {
    await attemptDatabaseClose(validated.dependencies.closeDatabase, database);
    throw lifecycleError("SERVER_SQLITE_MIGRATION_FAILED");
  }

  try {
    const quickCheck = await validated.dependencies.runQuickCheck(database);
    if (quickCheck?.ok !== true) throw new Error("integrity check failed");
    const foreignKeyCheck = await validated.dependencies.runForeignKeyCheck(database);
    if (foreignKeyCheck?.ok !== true) throw new Error("integrity check failed");
  } catch {
    await attemptDatabaseClose(validated.dependencies.closeDatabase, database);
    throw lifecycleError("SERVER_SQLITE_INTEGRITY_FAILED");
  }

  let address;
  try {
    address = await listenForReadiness(validated.server, validated.port, validated.host);
  } catch {
    await attemptServerRollback(validated.server);
    await attemptDatabaseClose(validated.dependencies.closeDatabase, database);
    throw lifecycleError("SERVER_LISTEN_FAILED");
  }

  let shutdownPromise;
  const close = (reason = "programmatic") => {
    if (shutdownPromise) return shutdownPromise;
    const reasonError = isValidShutdownReason(reason)
      ? null
      : lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
    shutdownPromise = performShutdown({ ...validated, database }).then(() => {
      if (reasonError) throw reasonError;
    });
    return shutdownPromise;
  };

  return {
    server: validated.server,
    address,
    schemaVersion: TARGET_SCHEMA_VERSION,
    migrationsApplied: migrationResult.applied.length,
    close
  };
}

async function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
  }
  if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !OPTION_KEYS.has(key))) {
    throw lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
  }

  const {
    server,
    databasePath,
    host,
    port,
    flushRuntimeState,
    shutdownTimeoutMs = 10000,
    dependencies = {}
  } = options;

  if (!(server instanceof Server)) throw lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
  if (typeof host !== "string" || !host.trim() || /[\u0000-\u001f\u007f]/u.test(host)) {
    throw lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
  }
  if (typeof flushRuntimeState !== "function") {
    throw lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
  }
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) {
    throw lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
  }
  const resolvedDependencies = validateDependencies(dependencies);
  const resolvedDatabasePath = await validateDatabasePath(databasePath);

  return {
    server,
    databasePath: resolvedDatabasePath,
    host: host.trim(),
    port,
    flushRuntimeState,
    shutdownTimeoutMs,
    dependencies: resolvedDependencies
  };
}

function validateDependencies(dependencies) {
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
  }
  if (Reflect.ownKeys(dependencies).some((key) => typeof key !== "string" || !DEPENDENCY_KEYS.has(key))) {
    throw lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
  }
  for (const key of Object.keys(dependencies)) {
    if (typeof dependencies[key] !== "function") {
      throw lifecycleError("SERVER_LIFECYCLE_OPTIONS_INVALID");
    }
  }
  return { ...defaultDependencies, ...dependencies };
}

async function validateDatabasePath(databasePath) {
  if (typeof databasePath !== "string") throw lifecycleError("SERVER_SQLITE_PATH_INVALID");
  const trimmedPath = databasePath.trim();
  if (!trimmedPath || trimmedPath.includes("\0") || !path.isAbsolute(trimmedPath)) {
    throw lifecycleError("SERVER_SQLITE_PATH_INVALID");
  }

  try {
    const target = await stat(trimmedPath);
    if (target.isDirectory()) throw lifecycleError("SERVER_SQLITE_PATH_INVALID");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error?.code === "SERVER_SQLITE_PATH_INVALID") throw error;
      throw lifecycleError("SERVER_SQLITE_PATH_INVALID");
    }
  }
  return trimmedPath;
}

function claimServer(server) {
  if (server.listening || claimedServers.has(server)) {
    throw lifecycleError("SERVER_LIFECYCLE_ALREADY_STARTED");
  }
  claimedServers.add(server);
}

function validateMigrationResult(result) {
  if (
    !result
    || result.currentVersion !== TARGET_SCHEMA_VERSION
    || !Array.isArray(result.applied)
    || !Number.isSafeInteger(result.applied.length)
    || result.applied.length < 0
  ) {
    throw new Error("migration result invalid");
  }
}

function listenForReadiness(server, port, host) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("listen failed"));
    };
    const onError = () => fail();
    const onListening = () => {
      const rawAddress = server.address();
      if (!isTcpAddress(rawAddress)) return fail();
      settled = true;
      cleanup();
      resolve({
        address: rawAddress.address,
        family: rawAddress.family,
        port: rawAddress.port
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch {
      fail();
    }
  });
}

function isTcpAddress(address) {
  return Boolean(
    address
    && typeof address === "object"
    && typeof address.address === "string"
    && typeof address.family === "string"
    && Number.isInteger(address.port)
    && address.port >= 0
    && address.port <= 65535
  );
}

async function attemptServerRollback(server) {
  if (!server.listening) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      server.close(finish);
      server.closeAllConnections?.();
    } catch {
      finish();
    }
  });
}

async function attemptDatabaseClose(closeDatabase, database) {
  try {
    await closeDatabase(database);
  } catch {
    // Startup errors keep their deterministic stage classification after cleanup is attempted.
  }
}

async function performShutdown({
  server,
  database,
  flushRuntimeState,
  shutdownTimeoutMs,
  dependencies
}) {
  const failures = [];
  const drain = await drainHttpServer(server, shutdownTimeoutMs);
  if (drain.timedOut) failures.push("timeout");
  if (drain.httpFailed) failures.push("http");

  try {
    await flushRuntimeState();
  } catch {
    failures.push("flush");
  }

  try {
    await dependencies.closeDatabase(database);
  } catch {
    failures.push("sqlite");
  }

  if (failures.length === 0) return;
  if (failures.length === 1 && failures[0] === "timeout") {
    throw lifecycleError("SERVER_SHUTDOWN_TIMEOUT");
  }
  if (failures.length === 1 && failures[0] === "sqlite") {
    throw lifecycleError("SERVER_SQLITE_CLOSE_FAILED");
  }
  throw lifecycleError("SERVER_SHUTDOWN_FAILED");
}

function drainHttpServer(server, shutdownTimeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let httpFailed = false;
    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ timedOut, httpFailed });
    };
    const startTimer = () => {
      if (settled || timer) return;
      timer = setTimeout(() => {
        try {
          if (typeof server.closeAllConnections !== "function") throw new Error("unsupported");
          server.closeAllConnections();
        } catch {
          httpFailed = true;
        }
        finish(true);
      }, shutdownTimeoutMs);
      timer.unref?.();
    };

    try {
      server.close((error) => {
        if (error) httpFailed = true;
        finish(false);
      });
    } catch {
      httpFailed = true;
    }
    startTimer();
  });
}

function isValidShutdownReason(reason) {
  return typeof reason === "string"
    && reason.trim().length > 0
    && reason.length <= MAX_SHUTDOWN_REASON_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(reason);
}

function lifecycleError(code) {
  const error = new Error(ERROR_MESSAGES[code]);
  Object.defineProperties(error, {
    name: { value: "ServerLifecycleError", enumerable: false, configurable: true },
    code: { value: code, enumerable: false, configurable: false },
    stack: {
      value: `ServerLifecycleError: ${ERROR_MESSAGES[code]}`,
      enumerable: false,
      configurable: true
    }
  });
  return error;
}
