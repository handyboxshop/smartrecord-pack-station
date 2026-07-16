import { constants as fsConstants } from "node:fs";
import {
  access,
  link,
  lstat,
  open,
  readFile,
  realpath,
  stat,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  runSqliteForeignKeyCheck,
  runSqliteQuickCheck
} from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import { validatePackRecordImport } from "../src/storage/packRecordImportValidator.mjs";
import { importPackRecords } from "../src/storage/packRecordImporter.mjs";
import { verifyPackRecordImport } from "../src/storage/packRecordImportVerifier.mjs";

const USAGE = "Usage: npm run db:import-pack-records -- <source-json-path> <destination-sqlite-path>";
const ARGUMENT_ERROR_CODES = new Set([
  "SOURCE_ARGUMENT_REQUIRED",
  "DESTINATION_ARGUMENT_REQUIRED",
  "UNKNOWN_ARGUMENT"
]);
const PROMOTION_STATE = Object.freeze({
  NOT_STARTED: "not_started",
  STAGING_RESERVED: "staging_reserved",
  DATABASE_OPEN: "database_open",
  DATABASE_CLOSED_VERIFIED: "database_closed_verified",
  COMMITTED: "committed",
  COMMITTED_WITH_CLEANUP_WARNING: "committed_with_cleanup_warning"
});
const STAGING_CLEANUP_WARNING = "STAGING_ALIAS_CLEANUP_FAILED";
const COMMITTED_DESTINATION_IDENTITY_CHECK_WARNING =
  "COMMITTED_DESTINATION_IDENTITY_CHECK_FAILED";

const DEFAULT_DEPENDENCIES = {
  access,
  closeSqliteDatabase,
  checkpointSqliteDatabase,
  importPackRecords,
  link,
  lstat,
  open,
  openSqliteDatabase,
  randomUUID,
  readFile,
  realpath,
  runSqliteForeignKeyCheck,
  runSqliteMigrations,
  runSqliteQuickCheck,
  stat,
  unlink,
  validatePackRecordImport,
  verifyPackRecordImport
};

class PackRecordImportCliError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "PackRecordImportCliError";
    this.code = code;
    this.stagingId = options.stagingId ?? null;
  }
}

export async function runPackRecordImportCli({
  argv = process.argv.slice(2),
  output = console.log,
  errorOutput = console.error,
  dependencies = {}
} = {}) {
  try {
    const { sourcePath, destinationPath } = parseArguments(argv);
    const result = await importPackRecordSnapshot({
      sourcePath,
      destinationPath,
      dependencies
    });

    output("status=success");
    output(`imported_records=${result.importResult.insertedPackRecordRows}`);
    output(`imported_videos=${result.importResult.insertedVideoRows}`);
    output(`verified_records=${result.verificationResult.verifiedRecordCount}`);
    output("quick_check=ok");
    output("foreign_key_check=ok");
    if (result.cleanupWarningCode) {
      output(`cleanup_warning=${result.cleanupWarningCode}`);
      output(`staging_id=${result.stagingId}`);
    }
    return 0;
  } catch (cause) {
    const failure = normalizeFailure(cause);
    errorOutput(
      `[db:import-pack-records] status=failed code=${failure.code} reason=${failure.message}`
    );
    if (failure.stagingId) {
      errorOutput(`staging_id=${failure.stagingId}`);
    }
    if (ARGUMENT_ERROR_CODES.has(failure.code)) errorOutput(USAGE);
    return 1;
  }
}

export async function importPackRecordSnapshot({
  sourcePath,
  destinationPath,
  dependencies = {}
}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const paths = await validatePaths(sourcePath, destinationPath, deps);
  const sourceBytes = await readSource(paths.sourcePath, deps);
  const input = parseSourceJson(sourceBytes);
  validateSourceStructure(input, deps);

  const operation = {
    state: PROMOTION_STATE.NOT_STARTED,
    stagingId: createStagingId(deps.randomUUID),
    stagingPath: null,
    stagingIdentity: null
  };
  operation.stagingPath = createStagingPath(paths.canonicalParentPath, operation.stagingId);
  operation.stagingIdentity = await reserveStagingDatabase(operation, deps);
  operation.state = PROMOTION_STATE.STAGING_RESERVED;

  let database;
  let failure = null;
  let importResult;
  let verificationResult;
  let integrityResult;

  try {
    await assertParentAndDestinationMapping(paths, deps);
    await assertStagingIdentity(operation, deps);
    // Path-only SQLite/link APIs cannot eliminate an exact syscall race in a hostile
    // directory; the canonical destination parent must remain operator-controlled.
    database = await runPhase(
      () => deps.openSqliteDatabase(operation.stagingPath),
      "SQLITE_OPEN_FAILED",
      "The staging database could not be opened."
    );
    operation.state = PROMOTION_STATE.DATABASE_OPEN;
    await runPhase(
      () => deps.runSqliteMigrations(database),
      "SQLITE_MIGRATION_FAILED",
      "SQLite migrations failed."
    );
    importResult = await runPhase(
      () => deps.importPackRecords(database, input),
      "PACK_RECORD_IMPORT_FAILED",
      "Pack Record import failed.",
      "PACK_RECORD_IMPORT_"
    );
    verificationResult = await runPhase(
      () => deps.verifyPackRecordImport(database, input, importResult),
      "PACK_RECORD_IMPORT_VERIFICATION_FAILED",
      "Pack Record verification failed.",
      "PACK_RECORD_IMPORT_VERIFICATION_"
    );
    if (verificationResult?.ok !== true) {
      throw cliError(
        "PACK_RECORD_IMPORT_VERIFICATION_MISMATCH",
        "Pack Record verification reported a mismatch."
      );
    }

    integrityResult = runIntegrityChecks(database, deps);
    await runPhase(
      () => deps.checkpointSqliteDatabase(database),
      "SQLITE_CHECKPOINT_FAILED",
      "The SQLite WAL checkpoint could not be completed.",
      "SQLITE_CHECKPOINT_"
    );
  } catch (cause) {
    failure = normalizeFailure(cause);
  } finally {
    if (database) {
      try {
        deps.closeSqliteDatabase(database);
      } catch (cause) {
        failure = cliError(
          "SQLITE_CLOSE_FAILED",
          "The staging database could not be closed safely.",
          cause
        );
      }
    }
  }

  if (failure) throw withStagingId(failure, operation);

  try {
    await assertParentAndDestinationMapping(paths, deps);
    await assertStagingIdentity(operation, deps);
    await requireNoSidecars(operation, deps);
    await assertParentAndDestinationMapping(paths, deps);
    await assertStagingIdentity(operation, deps);
  } catch (cause) {
    throw withStagingId(cause, operation);
  }
  operation.state = PROMOTION_STATE.DATABASE_CLOSED_VERIFIED;

  const promotionResult = await promoteStagingDatabase(operation, paths, deps);

  return {
    importResult,
    verificationResult,
    integrityResult,
    cleanupWarningCode: promotionResult.cleanupWarningCode,
    stagingId: promotionResult.cleanupWarningCode ? operation.stagingId : null,
    promotionState: operation.state
  };
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !String(argv[0] ?? "").trim()) {
    throw cliError("SOURCE_ARGUMENT_REQUIRED", "A source JSON path is required.");
  }
  if (String(argv[0]).startsWith("-")) {
    throw cliError("UNKNOWN_ARGUMENT", "Unknown arguments are not supported.");
  }
  if (argv.length === 1 || !String(argv[1] ?? "").trim()) {
    throw cliError("DESTINATION_ARGUMENT_REQUIRED", "A destination SQLite path is required.");
  }
  if (String(argv[1]).startsWith("-") || argv.length > 2) {
    throw cliError("UNKNOWN_ARGUMENT", "Unknown arguments are not supported.");
  }
  return {
    sourcePath: String(argv[0]),
    destinationPath: String(argv[1])
  };
}

async function validatePaths(sourcePath, destinationPath, deps) {
  const resolvedSource = path.resolve(sourcePath);
  const requestedDestinationPath = path.resolve(destinationPath);
  if (resolvedSource === requestedDestinationPath) {
    throw cliError(
      "SOURCE_DESTINATION_SAME",
      "Source and destination paths must be different."
    );
  }

  let sourceStats;
  try {
    sourceStats = await deps.stat(resolvedSource);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      throw cliError("SOURCE_NOT_FOUND", "The source JSON file does not exist.", cause);
    }
    throw cliError("SOURCE_STAT_FAILED", "The source JSON file could not be inspected.", cause);
  }
  if (!sourceStats.isFile()) {
    throw cliError("SOURCE_NOT_FILE", "The source JSON path is not a regular file.");
  }
  try {
    await deps.access(resolvedSource, fsConstants.R_OK);
  } catch (cause) {
    throw cliError("SOURCE_NOT_READABLE", "The source JSON file is not readable.", cause);
  }

  const requestedParentPath = path.dirname(requestedDestinationPath);
  let canonicalParentPath;
  try {
    canonicalParentPath = path.resolve(await deps.realpath(requestedParentPath));
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      throw cliError(
        "DESTINATION_PARENT_NOT_FOUND",
        "The destination parent directory does not exist.",
        cause
      );
    }
    if (cause?.code === "ENOTDIR") {
      throw cliError(
        "DESTINATION_PARENT_NOT_DIRECTORY",
        "The destination parent is not a directory.",
        cause
      );
    }
    throw cliError(
      "DESTINATION_PARENT_REALPATH_FAILED",
      "The destination parent could not be canonicalized.",
      cause
    );
  }

  let parentStats;
  try {
    parentStats = await deps.lstat(canonicalParentPath);
  } catch (cause) {
    throw cliError(
      "DESTINATION_PARENT_STAT_FAILED",
      "The destination parent could not be inspected.",
      cause
    );
  }
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw cliError(
      "DESTINATION_PARENT_NOT_DIRECTORY",
      "The destination parent is not a directory."
    );
  }

  const canonicalDestinationPath = path.join(
    canonicalParentPath,
    path.basename(requestedDestinationPath)
  );
  if (resolvedSource === canonicalDestinationPath) {
    throw cliError(
      "SOURCE_DESTINATION_SAME",
      "Source and destination paths must be different."
    );
  }

  const paths = {
    sourcePath: resolvedSource,
    requestedParentPath,
    canonicalParentPath,
    canonicalDestinationPath,
    parentIdentity: captureIdentity(parentStats)
  };
  await assertParentAndDestinationMapping(paths, deps);
  return paths;
}

async function assertParentAndDestinationMapping(paths, deps) {
  let currentCanonicalParent;
  try {
    currentCanonicalParent = path.resolve(await deps.realpath(paths.requestedParentPath));
  } catch (cause) {
    throw cliError(
      "DESTINATION_PARENT_CHANGED",
      "The destination parent changed during import.",
      cause
    );
  }
  if (currentCanonicalParent !== paths.canonicalParentPath) {
    throw cliError(
      "DESTINATION_PARENT_CHANGED",
      "The destination parent changed during import."
    );
  }

  let parentStats;
  try {
    parentStats = await deps.lstat(paths.canonicalParentPath);
  } catch (cause) {
    throw cliError(
      "DESTINATION_PARENT_CHANGED",
      "The destination parent changed during import.",
      cause
    );
  }
  if (parentStats.isSymbolicLink()
    || !parentStats.isDirectory()
    || !identitiesEqual(captureIdentity(parentStats), paths.parentIdentity)) {
    throw cliError(
      "DESTINATION_PARENT_IDENTITY_MISMATCH",
      "The destination parent identity changed during import."
    );
  }

  await assertDestinationAbsent(paths.canonicalDestinationPath, deps);
}

async function assertDestinationAbsent(destinationPath, deps) {
  try {
    await deps.lstat(destinationPath);
    throw cliError("DESTINATION_EXISTS", "The destination already exists.");
  } catch (cause) {
    if (cause instanceof PackRecordImportCliError) throw cause;
    if (cause?.code !== "ENOENT") {
      throw cliError(
        "DESTINATION_STAT_FAILED",
        "The destination path could not be inspected.",
        cause
      );
    }
  }
}

async function readSource(sourcePath, deps) {
  try {
    return await deps.readFile(sourcePath);
  } catch (cause) {
    throw cliError("SOURCE_READ_FAILED", "The source JSON file could not be read.", cause);
  }
}

function parseSourceJson(sourceBytes) {
  try {
    return JSON.parse(sourceBytes.toString("utf8"));
  } catch (cause) {
    throw cliError("SOURCE_JSON_INVALID", "The source file is not valid JSON.", cause);
  }
}

function validateSourceStructure(input, deps) {
  let validationResult;
  try {
    validationResult = deps.validatePackRecordImport(input);
  } catch (cause) {
    throw cliError(
      "SOURCE_STRUCTURE_VALIDATION_FAILED",
      "The source snapshot could not be validated.",
      cause
    );
  }
  if (validationResult?.ok !== true) {
    throw cliError(
      "SOURCE_STRUCTURE_INVALID",
      "The source snapshot is not a valid Pack Record array."
    );
  }
}

function createStagingId(uuid) {
  const stagingId = String(uuid()).replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
  if (!stagingId) {
    throw cliError("STAGING_NAME_FAILED", "A safe staging database name could not be created.");
  }
  return stagingId;
}

function createStagingPath(canonicalParentPath, stagingId) {
  return path.join(
    canonicalParentPath,
    `.smartrecord-pack-records.staging-${stagingId}.sqlite`
  );
}

async function reserveStagingDatabase(operation, deps) {
  let handle;
  try {
    handle = await deps.open(operation.stagingPath, "wx", 0o600);
    operation.state = PROMOTION_STATE.STAGING_RESERVED;
    const stats = await handle.stat();
    if (!stats.isFile() || Number(stats.nlink) !== 1) {
      throw cliError(
        "STAGING_IDENTITY_INVALID",
        "The reserved staging artifact is not a private regular file."
      );
    }
    await handle.close();
    return captureIdentity(stats);
  } catch (cause) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The direct CLI process will release an uncloseable descriptor on exit.
      }
    }
    if (operation.state === PROMOTION_STATE.NOT_STARTED && cause?.code === "EEXIST") {
      throw cliError(
        "STAGING_COLLISION",
        "The generated staging identifier is already in use.",
        cause
      );
    }
    throw withStagingId(
      cause instanceof PackRecordImportCliError
        ? cause
        : cliError("STAGING_CREATE_FAILED", "The staging database could not be created.", cause),
      operation
    );
  }
}

async function assertStagingIdentity(operation, deps) {
  let stats;
  try {
    stats = await deps.lstat(operation.stagingPath);
  } catch (cause) {
    throw withStagingId(
      cliError("STAGING_IDENTITY_CHECK_FAILED", "The staging identity could not be checked.", cause),
      operation
    );
  }
  if (stats.isSymbolicLink()
    || !stats.isFile()
    || Number(stats.nlink) !== 1
    || !identitiesEqual(captureIdentity(stats), operation.stagingIdentity)) {
    throw withStagingId(
      cliError("STAGING_IDENTITY_MISMATCH", "The staging identity changed during import."),
      operation
    );
  }
}

function runIntegrityChecks(database, deps) {
  let quickCheck;
  let foreignKeyCheck;
  try {
    quickCheck = deps.runSqliteQuickCheck(database);
    foreignKeyCheck = deps.runSqliteForeignKeyCheck(database);
  } catch (cause) {
    throw cliError(
      "SQLITE_INTEGRITY_CHECK_FAILED",
      "SQLite integrity checks could not be completed.",
      cause
    );
  }
  if (quickCheck?.ok !== true || foreignKeyCheck?.ok !== true) {
    throw cliError(
      "SQLITE_INTEGRITY_INVALID",
      "SQLite integrity checks reported a failure."
    );
  }
  return { quickCheck, foreignKeyCheck };
}

function checkpointSqliteDatabase(database) {
  let checkpoint;
  try {
    checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch (cause) {
    throw cliError(
      "SQLITE_CHECKPOINT_FAILED",
      "The SQLite WAL checkpoint could not be completed.",
      cause
    );
  }
  if (Number(checkpoint?.busy) !== 0 || Number(checkpoint?.log) !== 0) {
    throw cliError(
      "SQLITE_CHECKPOINT_INCOMPLETE",
      "The SQLite WAL checkpoint did not complete safely."
    );
  }
}

async function requireNoSidecars(operation, deps) {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await deps.lstat(`${operation.stagingPath}${suffix}`);
      throw withStagingId(
        cliError(
          "SQLITE_SIDECAR_REMAINS",
          "A SQLite sidecar remained after database close."
        ),
        operation
      );
    } catch (cause) {
      if (cause instanceof PackRecordImportCliError) throw cause;
      if (cause?.code !== "ENOENT") {
        throw withStagingId(
          cliError(
            "SQLITE_SIDECAR_CHECK_FAILED",
            "SQLite sidecars could not be checked safely.",
            cause
          ),
          operation
        );
      }
    }
  }
}

async function promoteStagingDatabase(operation, paths, deps) {
  try {
    await assertParentAndDestinationMapping(paths, deps);
    await assertStagingIdentity(operation, deps);
  } catch (cause) {
    throw withStagingId(cause, operation);
  }

  try {
    await deps.link(operation.stagingPath, paths.canonicalDestinationPath);
  } catch (cause) {
    let error;
    if (cause?.code === "EEXIST") {
      error = cliError("DESTINATION_EXISTS", "The destination already exists.", cause);
    } else if (["ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(cause?.code)) {
      error = cliError(
        "HARD_LINK_UNSUPPORTED",
        "The destination filesystem does not support safe hard-link promotion.",
        cause
      );
    } else {
      error = cliError(
        "DESTINATION_PROMOTION_FAILED",
        "The completed database could not be promoted safely.",
        cause
      );
    }
    throw withStagingId(error, operation);
  }
  operation.state = PROMOTION_STATE.COMMITTED;

  try {
    await assertCommittedDestinationIdentity(operation, paths, deps);
  } catch {
    operation.state = PROMOTION_STATE.COMMITTED_WITH_CLEANUP_WARNING;
    return { cleanupWarningCode: COMMITTED_DESTINATION_IDENTITY_CHECK_WARNING };
  }

  try {
    await deps.unlink(operation.stagingPath);
  } catch {
    operation.state = PROMOTION_STATE.COMMITTED_WITH_CLEANUP_WARNING;
    return {
      cleanupWarningCode: STAGING_CLEANUP_WARNING
    };
  }
  return { cleanupWarningCode: null };
}

async function assertCommittedDestinationIdentity(operation, paths, deps) {
  let stats;
  try {
    stats = await deps.lstat(paths.canonicalDestinationPath);
  } catch (cause) {
    throw withStagingId(
      cliError(
        "DESTINATION_IDENTITY_CHECK_FAILED_AFTER_COMMIT",
        "The committed destination identity could not be confirmed.",
        cause
      ),
      operation
    );
  }
  if (stats.isSymbolicLink()
    || !stats.isFile()
    || Number(stats.nlink) < 2
    || !identitiesEqual(captureIdentity(stats), operation.stagingIdentity)) {
    throw withStagingId(
      cliError(
        "DESTINATION_IDENTITY_MISMATCH_AFTER_COMMIT",
        "The committed destination identity could not be confirmed."
      ),
      operation
    );
  }
}

async function runPhase(callback, fallbackCode, message, preservedCodePrefix) {
  try {
    return await callback();
  } catch (cause) {
    if (cause instanceof PackRecordImportCliError) throw cause;
    const code = preservedCodePrefix && safeCode(cause?.code)?.startsWith(preservedCodePrefix)
      ? safeCode(cause.code)
      : fallbackCode;
    throw cliError(code, message, cause);
  }
}

function withStagingId(error, operation) {
  const failure = normalizeFailure(error);
  if (operation.state !== PROMOTION_STATE.NOT_STARTED) {
    failure.stagingId = operation.stagingId;
  }
  return failure;
}

function captureIdentity(stats) {
  return {
    dev: stats?.dev === undefined ? null : String(stats.dev),
    ino: stats?.ino === undefined ? null : String(stats.ino)
  };
}

function identitiesEqual(left, right) {
  if (!left || !right) return false;
  const comparableFields = ["dev", "ino"].filter(
    (field) => left[field] !== null && right[field] !== null
  );
  return comparableFields.length > 0
    && comparableFields.every((field) => left[field] === right[field]);
}

function normalizeFailure(cause) {
  if (cause instanceof PackRecordImportCliError) return cause;
  return cliError("UNEXPECTED_FAILURE", "The import failed safely.", cause);
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]+$/.test(value) ? value : null;
}

function cliError(code, message, cause) {
  return new PackRecordImportCliError(
    code,
    message,
    cause ? { cause } : undefined
  );
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  process.exitCode = await runPackRecordImportCli();
}
