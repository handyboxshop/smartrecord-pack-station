import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeSqliteDatabase, openSqliteDatabase } from "../src/storage/sqliteDatabase.mjs";
import { createUserImportPlan, disposeUserImportPlan } from "../src/storage/userImportPlan.mjs";
import { importUsers } from "../src/storage/userImporter.mjs";
import { verifyUserImport } from "../src/storage/userImportVerifier.mjs";
import { analyzeUserImportReadiness } from "../src/storage/userImportReadiness.mjs";
import {
  parseUserImportJsonBytes,
  sourceManifestSha256 as computeSourceManifestSha256
} from "./check-user-import-readiness.mjs";

export { computeSourceManifestSha256 as sourceManifestSha256 };

const LIMITS = Object.freeze({
  users: 16 * 1024 * 1024,
  config: 4 * 1024 * 1024,
  usernameMap: 4 * 1024 * 1024
});
const SAFE_MESSAGE = "Users import CLI operation failed safely.";
const APPROVED_CODES = new Set([
  "USERS_IMPORT_USAGE_INVALID", "USERS_IMPORT_SOURCE_READ_FAILED",
  "USERS_IMPORT_SOURCE_JSON_INVALID", "USERS_IMPORT_CONFIG_INVALID",
  "USERS_IMPORT_USERNAME_MAP_INVALID", "USERS_IMPORT_SOURCE_MANIFEST_MISMATCH",
  "USERS_IMPORT_READINESS_BLOCKED", "USERS_IMPORT_SCHEMA_REQUIRED",
  "USERS_IMPORT_DESTINATION_NOT_EMPTY", "USERS_IMPORT_IDENTITY_CONFLICT",
  "USERS_IMPORT_PERMISSION_FAILED", "USERS_IMPORT_CREDENTIAL_FAILED",
  "USERS_IMPORT_TRANSACTION_FAILED", "USERS_IMPORT_ROLLBACK_FAILED",
  "USERS_IMPORT_IN_TRANSACTION_VERIFICATION_FAILED", "USERS_IMPORT_COMMIT_OUTCOME_UNKNOWN",
  "USERS_IMPORT_COMMITTED_CLOSE_FAILED", "USERS_IMPORT_POST_COMMIT_VERIFICATION_MISMATCH",
  "USERS_IMPORT_STORED_DATA_INVALID", "USERS_IMPORT_INTERNAL_FAILED",
  "USERS_IMPORT_INTERRUPTED"
]);

const DEFAULT_DEPENDENCIES = Object.freeze({
  analyzeUserImportReadiness,
  closeSqliteDatabase,
  createUserImportPlan,
  importUsers,
  lstat,
  open,
  openSqliteDatabase,
  verifyUserImport
});

class UserImportCliError extends Error {
  constructor(code, exitCode, { committed = false, outcomeUnknown = false } = {}) {
    const safeCode = APPROVED_CODES.has(code) ? code : "USERS_IMPORT_INTERNAL_FAILED";
    super(SAFE_MESSAGE);
    this.name = "UserImportCliError";
    this.code = safeCode;
    Object.defineProperties(this, {
      stack: { value: `${this.name}: ${SAFE_MESSAGE}`, writable: false },
      exitCode: { value: exitCode, enumerable: false },
      committed: { value: committed, enumerable: false },
      outcomeUnknown: { value: outcomeUnknown, enumerable: false }
    });
  }
}

/** Execute the existing-database import without ever creating or migrating it. */
export async function runUserImportCli({
  argv = process.argv.slice(2),
  output = process.stdout,
  errorOutput = process.stderr,
  dependencies = {},
  signalSource = process
} = {}) {
  let deps = DEFAULT_DEPENDENCIES;
  const resources = { sources: [], importDatabase: null, verificationDatabase: null, plan: null };
  let committed = false;
  let outcomeUnknown = false;
  let emitted = false;
  let interruptedSignal = null;
  let shutdownPromise = null;
  const cleanup = () => {
    shutdownPromise ??= cleanupResources(resources, deps);
    return shutdownPromise;
  };
  const onSigint = () => { interruptedSignal ??= "SIGINT"; };
  const onSigterm = () => { interruptedSignal ??= "SIGTERM"; };
  const handlersInstalled = installSignalHandlers(signalSource, onSigint, onSigterm);
  const checkInterrupted = () => {
    if (interruptedSignal) {
      throw cliError("USERS_IMPORT_INTERRUPTED", interruptedSignal === "SIGINT" ? 130 : 143, { committed, outcomeUnknown });
    }
  };

  try {
    deps = normalizeDependencies(dependencies);
    const args = parseArguments(argv);
    checkInterrupted();
    for (const [filePath, maximumBytes] of [
      [args.users, LIMITS.users],
      [args.config, LIMITS.config],
      [args.usernameMap, LIMITS.usernameMap]
    ]) {
      resources.sources.push(await openSource(filePath, maximumBytes, deps));
    }
    checkInterrupted();
    const users = parseSource(resources.sources[0].bytes, "USERS_IMPORT_SOURCE_JSON_INVALID");
    const config = parseSource(resources.sources[1].bytes, "USERS_IMPORT_CONFIG_INVALID");
    const usernameMap = parseSource(resources.sources[2].bytes, "USERS_IMPORT_USERNAME_MAP_INVALID");
    const auth = requireConfig(config);
    requireUsernameMap(usernameMap);
    const manifest = computeSourceManifestSha256(resources.sources.map((source) => source.bytes));
    if (manifest !== args.expectedManifestSha256) throw cliError("USERS_IMPORT_SOURCE_MANIFEST_MISMATCH", 3);
    const report = deps.analyzeUserImportReadiness(users, {
      roles: auth.roles,
      modules: auth.modules,
      passwordPolicy: auth.passwordPolicy,
      usernameAssignments: usernameMap
    });
    if (!report.ok) throw cliError("USERS_IMPORT_READINESS_BLOCKED", 3);
    try {
      resources.plan = deps.createUserImportPlan(users, {
        roles: auth.roles,
        modules: auth.modules,
        passwordPolicy: auth.passwordPolicy,
        usernameAssignments: usernameMap,
        sourceManifestSha256: manifest
      });
    } catch (error) {
      throw translatePlanningError(error);
    }
    const databaseIdentity = await captureDatabaseIdentity(args.database, deps);
    checkInterrupted();
    try {
      // The shared SQLite wrapper opens by path. Holding and rechecking identity on
      // both sides of open is the fail-closed boundary for the unavoidable syscall gap.
      resources.importDatabase = await deps.openSqliteDatabase(args.database);
    } catch {
      throw cliError("USERS_IMPORT_SCHEMA_REQUIRED", 4);
    }
    await revalidateDatabaseIdentity(databaseIdentity, deps, { stableMetadata: false });
    await refreshDatabaseMetadata(databaseIdentity, deps);
    await Promise.all(resources.sources.map((source) => revalidateSource(source, deps)));
    await revalidateDatabaseIdentity(databaseIdentity, deps, { stableMetadata: true });
    checkInterrupted();
    let result;
    try {
      result = deps.importUsers(resources.importDatabase, resources.plan);
      committed = result?.committed === true;
    } catch (error) {
      const translated = translateImportError(error);
      outcomeUnknown = translated.outcomeUnknown;
      throw translated;
    }
    try {
      deps.closeSqliteDatabase(resources.importDatabase);
      resources.importDatabase = null;
    } catch {
      throw cliError("USERS_IMPORT_COMMITTED_CLOSE_FAILED", 7, { committed: true });
    }
    checkInterrupted();
    await revalidateDatabaseIdentity(databaseIdentity, deps, { stableMetadata: false });
    await refreshDatabaseMetadata(databaseIdentity, deps);
    try {
      resources.verificationDatabase = await deps.openSqliteDatabase(args.database);
    } catch {
      throw cliError("USERS_IMPORT_POST_COMMIT_VERIFICATION_MISMATCH", 7, { committed: true });
    }
    await revalidateDatabaseIdentity(databaseIdentity, deps, { stableMetadata: false });
    let verification;
    try {
      verification = deps.verifyUserImport(resources.verificationDatabase, resources.plan, { importedAt: result.importedAt });
    } catch (error) {
      const code = error?.code === "USERS_IMPORT_STORED_DATA_INVALID"
        ? "USERS_IMPORT_STORED_DATA_INVALID"
        : "USERS_IMPORT_POST_COMMIT_VERIFICATION_MISMATCH";
      throw cliError(code, 7, { committed: true });
    }
    if (!verification?.ok) {
      const code = verification?.status === "stored-data-invalid"
        ? "USERS_IMPORT_STORED_DATA_INVALID"
        : "USERS_IMPORT_POST_COMMIT_VERIFICATION_MISMATCH";
      throw cliError(code, 7, { committed: true });
    }
    try {
      deps.closeSqliteDatabase(resources.verificationDatabase);
      resources.verificationDatabase = null;
    } catch {
      throw cliError("USERS_IMPORT_COMMITTED_CLOSE_FAILED", 7, { committed: true });
    }
    checkInterrupted();
    emitOnce(output, {
      ok: true,
      status: "committed",
      committed: true,
      importedUserCount: result.importedUserCount,
      importedPermissionCount: result.importedPermissionCount,
      importedAt: result.importedAt,
      action: "do_not_retry_normal_import"
    }, () => { emitted = true; });
    return 0;
  } catch (error) {
    const failure = normalizeFailure(error, { committed, outcomeUnknown });
    committed ||= failure.committed;
    outcomeUnknown ||= failure.outcomeUnknown;
    if (!emitted) {
      emitOnce(errorOutput, {
        ok: false,
        code: failure.code,
        committed,
        action: committed ? "do_not_retry_normal_import"
          : outcomeUnknown ? "verify_before_retry" : "correct_input_and_retry"
      }, () => { emitted = true; });
    }
    return failure.exitCode;
  } finally {
    removeSignalHandlers(signalSource, handlersInstalled, onSigint, onSigterm);
    await cleanup();
  }
}

function parseArguments(argv) {
  const accepted = new Map([
    ["--users", "users"], ["--config", "config"], ["--username-map", "usernameMap"],
    ["--database", "database"], ["--expected-manifest-sha256", "expectedManifestSha256"]
  ]);
  if (!Array.isArray(argv) || argv.length !== 10 || argv.some((value) => typeof value !== "string")) {
    throw cliError("USERS_IMPORT_USAGE_INVALID", 2);
  }
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const property = accepted.get(flag);
    if (!property || Object.hasOwn(result, property) || flag.includes("=") || value.startsWith("--")
        || value.includes("\0") || !value.trim()) throw cliError("USERS_IMPORT_USAGE_INVALID", 2);
    if (property !== "expectedManifestSha256" && !path.isAbsolute(value)) {
      throw cliError("USERS_IMPORT_USAGE_INVALID", 2);
    }
    result[property] = value;
  }
  if (!/^[0-9a-f]{64}$/.test(result.expectedManifestSha256 ?? "")) {
    throw cliError("USERS_IMPORT_USAGE_INVALID", 2);
  }
  return result;
}

function normalizeDependencies(overrides) {
  if (!isPlainObject(overrides)) throw cliError("USERS_IMPORT_INTERNAL_FAILED", 6);
  const allowed = new Set(Object.keys(DEFAULT_DEPENDENCIES));
  if (Reflect.ownKeys(overrides).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw cliError("USERS_IMPORT_INTERNAL_FAILED", 6);
  }
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
  if (Object.values(deps).some((value) => typeof value !== "function")) {
    throw cliError("USERS_IMPORT_INTERNAL_FAILED", 6);
  }
  return deps;
}

async function openSource(filePath, maximumBytes, deps) {
  let handle;
  try {
    const pathStat = await deps.lstat(filePath, { bigint: false });
    requireRegularSingleLink(pathStat, maximumBytes);
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await deps.open(filePath, flags);
    const descriptorStat = await handle.stat();
    requireRegularSingleLink(descriptorStat, maximumBytes);
    if (!sameIdentity(pathStat, descriptorStat) || !sameStableMetadata(pathStat, descriptorStat)) throw new Error();
    const bytes = await handle.readFile();
    if (!Buffer.isBuffer(bytes) || bytes.length !== descriptorStat.size) throw new Error();
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { filePath, handle, bytes, pathStat, descriptorStat };
  } catch {
    if (handle) { try { await handle.close(); } catch {} }
    throw cliError("USERS_IMPORT_SOURCE_READ_FAILED", 3);
  }
}

async function revalidateSource(source, deps) {
  try {
    const descriptorStat = await source.handle.stat();
    const pathStat = await deps.lstat(source.filePath);
    requireRegularSingleLink(descriptorStat, source.descriptorStat.size);
    requireRegularSingleLink(pathStat, source.pathStat.size);
    if (!sameIdentity(source.descriptorStat, descriptorStat)
        || !sameStableMetadata(source.descriptorStat, descriptorStat)
        || !sameIdentity(source.pathStat, pathStat)
        || !sameStableMetadata(source.pathStat, pathStat)
        || !sameIdentity(pathStat, descriptorStat)) throw new Error();
  } catch {
    throw cliError("USERS_IMPORT_SOURCE_READ_FAILED", 3);
  }
}

async function captureDatabaseIdentity(databasePath, deps) {
  if (!path.isAbsolute(databasePath)) throw cliError("USERS_IMPORT_USAGE_INVALID", 2);
  try {
    const parentPath = path.dirname(databasePath);
    const [target, parent] = await Promise.all([deps.lstat(databasePath), deps.lstat(parentPath)]);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : parent.uid;
    requireDatabaseControlPolicy(target, parent, currentUid);
    return { databasePath, parentPath, target, parent, currentUid };
  } catch {
    throw cliError("USERS_IMPORT_SCHEMA_REQUIRED", 4);
  }
}

async function revalidateDatabaseIdentity(identity, deps, { stableMetadata }) {
  try {
    const [target, parent] = await Promise.all([
      deps.lstat(identity.databasePath), deps.lstat(identity.parentPath)
    ]);
    requireDatabaseControlPolicy(target, parent, identity.currentUid);
    if (!sameIdentity(target, identity.target) || !sameIdentity(parent, identity.parent)) throw new Error();
    if (stableMetadata && (!sameStableMetadata(target, identity.target)
        || !sameStableMetadata(parent, identity.parent))) throw new Error();
  } catch {
    throw cliError("USERS_IMPORT_SCHEMA_REQUIRED", 4);
  }
}

async function refreshDatabaseMetadata(identity, deps) {
  await revalidateDatabaseIdentity(identity, deps, { stableMetadata: false });
  const [target, parent] = await Promise.all([
    deps.lstat(identity.databasePath), deps.lstat(identity.parentPath)
  ]);
  try {
    requireDatabaseControlPolicy(target, parent, identity.currentUid);
    if (!sameIdentity(target, identity.target) || !sameIdentity(parent, identity.parent)) throw new Error();
    identity.target = target;
    identity.parent = parent;
  } catch { throw cliError("USERS_IMPORT_SCHEMA_REQUIRED", 4); }
}

function parseSource(bytes, code) {
  try { return parseUserImportJsonBytes(bytes); }
  catch { throw cliError(code, 3); }
}

function requireConfig(config) {
  if (!isPlainObject(config) || !isPlainObject(config.auth)
      || !Array.isArray(config.auth.roles) || !Array.isArray(config.auth.modules)) {
    throw cliError("USERS_IMPORT_CONFIG_INVALID", 3);
  }
  return config.auth;
}

function requireUsernameMap(value) {
  if (!isPlainObject(value) || Reflect.ownKeys(value).some((key) => (
    typeof key !== "string" || typeof value[key] !== "string"
  ))) throw cliError("USERS_IMPORT_USERNAME_MAP_INVALID", 3);
}

function translatePlanningError(error) {
  const code = ["USERS_IMPORT_USAGE_INVALID", "USERS_IMPORT_IDENTITY_CONFLICT",
    "USERS_IMPORT_PERMISSION_FAILED", "USERS_IMPORT_CREDENTIAL_FAILED",
    "USERS_IMPORT_READINESS_BLOCKED"].includes(error?.code)
    ? error.code : "USERS_IMPORT_INTERNAL_FAILED";
  return cliError(code, 5);
}

function translateImportError(error) {
  const importCodes = new Set([
    "USERS_IMPORT_SCHEMA_REQUIRED", "USERS_IMPORT_DESTINATION_NOT_EMPTY",
    "USERS_IMPORT_TRANSACTION_FAILED", "USERS_IMPORT_ROLLBACK_FAILED",
    "USERS_IMPORT_IN_TRANSACTION_VERIFICATION_FAILED", "USERS_IMPORT_COMMIT_OUTCOME_UNKNOWN",
    "USERS_IMPORT_STORED_DATA_INVALID", "USERS_IMPORT_INTERNAL_FAILED"
  ]);
  const code = importCodes.has(error?.code) ? error.code : "USERS_IMPORT_TRANSACTION_FAILED";
  const state = typeof error?.transactionState === "string" ? error.transactionState : "not-started";
  const outcomeUnknown = state === "outcome-unknown" || code === "USERS_IMPORT_COMMIT_OUTCOME_UNKNOWN";
  const schemaCodes = new Set(["USERS_IMPORT_SCHEMA_REQUIRED", "USERS_IMPORT_DESTINATION_NOT_EMPTY"]);
  const exitCode = outcomeUnknown ? 7 : schemaCodes.has(code) ? 4 : 6;
  return cliError(code, exitCode, { outcomeUnknown });
}

function normalizeFailure(error, state) {
  if (error instanceof UserImportCliError) return error;
  return cliError("USERS_IMPORT_INTERNAL_FAILED", state.committed || state.outcomeUnknown ? 7 : 6, state);
}

async function cleanupResources(resources, deps) {
  for (const key of ["verificationDatabase", "importDatabase"]) {
    const database = resources[key];
    resources[key] = null;
    if (database) { try { deps.closeSqliteDatabase(database); } catch {} }
  }
  if (resources.plan) { try { disposeUserImportPlan(resources.plan); } catch {} resources.plan = null; }
  for (const source of resources.sources) {
    if (Buffer.isBuffer(source.bytes)) source.bytes.fill(0);
    try { await source.handle.close(); } catch {}
  }
  resources.sources = [];
}

function installSignalHandlers(source, sigint, sigterm) {
  if (!source || typeof source.on !== "function" || typeof source.off !== "function") return false;
  source.on("SIGINT", sigint);
  source.on("SIGTERM", sigterm);
  return true;
}

function removeSignalHandlers(source, installed, sigint, sigterm) {
  if (!installed) return;
  source.off("SIGINT", sigint);
  source.off("SIGTERM", sigterm);
}

function emitOnce(target, value, mark) {
  const line = `${JSON.stringify(value)}\n`;
  if (typeof target === "function") target(JSON.stringify(value));
  else if (target && typeof target.write === "function") target.write(line);
  else throw cliError("USERS_IMPORT_INTERNAL_FAILED", 6);
  mark();
}

function requireRegularSingleLink(stat, maximumBytes) {
  if (!stat?.isFile?.() || stat.isSymbolicLink?.() || stat.nlink !== 1
      || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximumBytes) throw new Error();
}

function requireDatabaseControlPolicy(target, parent, currentUid) {
  requireRegularSingleLink(target, Number.MAX_SAFE_INTEGER);
  if (!parent?.isDirectory?.() || parent.isSymbolicLink?.() || target.uid !== currentUid
      || parent.uid !== currentUid || (target.mode & 0o022) !== 0 || (parent.mode & 0o022) !== 0) {
    throw new Error();
  }
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameStableMetadata(left, right) {
  return left.size === right.size && left.mode === right.mode && left.uid === right.uid
    && left.gid === right.gid && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function isPlainObject(value) { if (!value || Array.isArray(value) || typeof value !== "object") return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function cliError(code, exitCode, options) { return new UserImportCliError(code, exitCode, options); }

const isProductionEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isProductionEntrypoint) process.exitCode = await runUserImportCli();
