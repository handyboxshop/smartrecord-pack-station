import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeSqliteDatabase, openSqliteDatabase } from "../src/storage/sqliteDatabase.mjs";
import { createUserLegacyBackfillPlan, disposeUserLegacyBackfillPlan } from "../src/storage/userLegacyBackfillPlan.mjs";
import { backfillLegacyUsernames } from "../src/storage/userLegacyBackfiller.mjs";
import { verifyUserLegacyBackfill } from "../src/storage/userLegacyBackfillVerifier.mjs";
import { parseUserImportJsonBytes, sourceManifestSha256 } from "./check-user-import-readiness.mjs";

const LIMITS = Object.freeze({ users: 16 * 1024 * 1024, config: 4 * 1024 * 1024, usernameMap: 4 * 1024 * 1024 });
const APPROVED_CODES = new Set([
  "USERS_BACKFILL_USAGE_INVALID", "USERS_BACKFILL_SOURCE_READ_FAILED",
  "USERS_BACKFILL_SOURCE_JSON_INVALID", "USERS_BACKFILL_CONFIG_INVALID",
  "USERS_BACKFILL_USERNAME_MAP_INVALID", "USERS_BACKFILL_SOURCE_MANIFEST_MISMATCH",
  "USERS_BACKFILL_SCHEMA_REQUIRED", "USERS_BACKFILL_DATABASE_POLICY_FAILED",
  "USERS_BACKFILL_PLAN_INVALID", "USERS_BACKFILL_DATABASE_CHANGED",
  "USERS_BACKFILL_TRANSACTION_FAILED", "USERS_BACKFILL_ROLLBACK_FAILED",
  "USERS_BACKFILL_COMMIT_OUTCOME_UNKNOWN", "USERS_BACKFILL_COMMITTED_CLOSE_FAILED",
  "USERS_BACKFILL_POST_COMMIT_VERIFICATION_MISMATCH", "USERS_BACKFILL_STORED_DATA_INVALID",
  "USERS_BACKFILL_INTERRUPTED", "USERS_BACKFILL_INTERNAL_FAILED"
]);
const SAFE_MESSAGE = "Legacy Users backfill CLI operation failed safely.";
const DEFAULT_DEPENDENCIES = Object.freeze({
  backfillLegacyUsernames, closeSqliteDatabase, createUserLegacyBackfillPlan,
  lstat, open, openSqliteDatabase, verifyUserLegacyBackfill
});

class UserLegacyBackfillCliError extends Error {
  constructor(code, exitCode, { committed = false, outcomeUnknown = false } = {}) {
    const safeCode = APPROVED_CODES.has(code) ? code : "USERS_BACKFILL_INTERNAL_FAILED";
    super(SAFE_MESSAGE);
    this.name = "UserLegacyBackfillCliError";
    this.code = safeCode;
    Object.defineProperties(this, {
      stack: { value: `${this.name}: ${SAFE_MESSAGE}`, writable: false },
      exitCode: { value: exitCode, enumerable: false },
      committed: { value: committed, enumerable: false },
      outcomeUnknown: { value: outcomeUnknown, enumerable: false }
    });
  }
}

/**
 * Run the offline legacy-username backfill CLI with caller-independent source descriptors.
 * @param {string[]} argv Exact absolute-path and manifest arguments.
 * @param {object} dependencies Optional deterministic-test dependency overrides.
 * @returns {Promise<number>} Process exit code; the function emits exactly one sanitized JSON line.
 * The CLI owns and closes its database handles, wipes source buffers, and never retries a commit.
 */
export async function runUserLegacyBackfillCli(argv = process.argv.slice(2), dependencies = {}) {
  let deps = DEFAULT_DEPENDENCIES;
  const resources = { sources: [], database: null, verificationDatabase: null, plan: null };
  let committed = false;
  let outcomeUnknown = false;
  let emitted = false;
  let interrupted = null;
  let cleanupPromise;
  const output = dependencies.output ?? process.stdout;
  const errorOutput = dependencies.errorOutput ?? process.stderr;
  const signalSource = dependencies.signalSource ?? process;
  const cleanup = () => { cleanupPromise ??= cleanupResources(resources, deps); return cleanupPromise; };
  const onSigint = () => { interrupted ??= "SIGINT"; };
  const onSigterm = () => { interrupted ??= "SIGTERM"; };
  const installed = installSignals(signalSource, onSigint, onSigterm);
  const checkInterrupted = () => {
    if (interrupted) throw cliError("USERS_BACKFILL_INTERRUPTED", interrupted === "SIGINT" ? 130 : 143, { committed, outcomeUnknown });
  };
  try {
    deps = normalizeDependencies(dependencies);
    const args = parseArguments(argv);
    checkInterrupted();
    for (const [filePath, maximumBytes] of [[args.users, LIMITS.users], [args.config, LIMITS.config], [args.usernameMap, LIMITS.usernameMap]]) {
      resources.sources.push(await openSource(filePath, maximumBytes, deps));
    }
    checkInterrupted();
    const users = parseSource(resources.sources[0].bytes, "USERS_BACKFILL_SOURCE_JSON_INVALID");
    const config = parseSource(resources.sources[1].bytes, "USERS_BACKFILL_CONFIG_INVALID");
    const usernameMap = parseSource(resources.sources[2].bytes, "USERS_BACKFILL_USERNAME_MAP_INVALID");
    const auth = requireConfig(config);
    requireUsernameMap(usernameMap);
    const manifest = sourceManifestSha256(resources.sources.map((source) => source.bytes));
    if (manifest !== args.expectedManifestSha256) throw cliError("USERS_BACKFILL_SOURCE_MANIFEST_MISMATCH", 3);
    const identity = await captureDatabaseIdentity(args.database, deps);
    try { resources.database = await deps.openSqliteDatabase(args.database); }
    catch { throw cliError("USERS_BACKFILL_SCHEMA_REQUIRED", 4); }
    await revalidateDatabaseIdentity(identity, deps, false);
    await refreshDatabaseMetadata(identity, deps);
    await Promise.all(resources.sources.map((source) => revalidateSource(source, deps)));
    await revalidateDatabaseIdentity(identity, deps, true);
    checkInterrupted();
    try {
      resources.plan = deps.createUserLegacyBackfillPlan(users, {
        roles: auth.roles, modules: auth.modules, passwordPolicy: auth.passwordPolicy,
        usernameAssignments: usernameMap, sourceManifestSha256: manifest
      }, resources.database);
    } catch (error) { throw translatePlanError(error); }
    await Promise.all(resources.sources.map((source) => revalidateSource(source, deps)));
    await revalidateDatabaseIdentity(identity, deps, true);
    checkInterrupted();
    let result;
    try {
      result = deps.backfillLegacyUsernames(resources.database, resources.plan);
      committed = result?.committed === true;
    } catch (error) {
      const translated = translateBackfillError(error);
      outcomeUnknown = translated.outcomeUnknown;
      throw translated;
    }
    try { deps.closeSqliteDatabase(resources.database); resources.database = null; }
    catch { throw cliError("USERS_BACKFILL_COMMITTED_CLOSE_FAILED", 7, { committed }); }
    try {
      await revalidateDatabaseIdentity(identity, deps, false);
      await refreshDatabaseMetadata(identity, deps);
    } catch (error) {
      if (committed) throw cliError("USERS_BACKFILL_POST_COMMIT_VERIFICATION_MISMATCH", 7, { committed: true });
      throw error;
    }
    checkInterrupted();
    try { resources.verificationDatabase = await deps.openSqliteDatabase(args.database); }
    catch { throw cliError("USERS_BACKFILL_POST_COMMIT_VERIFICATION_MISMATCH", 7, { committed }); }
    try { await revalidateDatabaseIdentity(identity, deps, false); }
    catch (error) {
      if (committed) throw cliError("USERS_BACKFILL_POST_COMMIT_VERIFICATION_MISMATCH", 7, { committed: true });
      throw error;
    }
    let verification;
    try { verification = deps.verifyUserLegacyBackfill(resources.verificationDatabase, resources.plan); }
    catch (error) {
      throw cliError(error?.code === "USERS_BACKFILL_STORED_DATA_INVALID"
        ? "USERS_BACKFILL_STORED_DATA_INVALID" : "USERS_BACKFILL_POST_COMMIT_VERIFICATION_MISMATCH", 7, { committed });
    }
    if (!["verified", "already-complete"].includes(verification?.status)) {
      throw cliError(verification?.status === "stored-data-invalid" ? "USERS_BACKFILL_STORED_DATA_INVALID"
        : "USERS_BACKFILL_POST_COMMIT_VERIFICATION_MISMATCH", 7, { committed });
    }
    try { deps.closeSqliteDatabase(resources.verificationDatabase); resources.verificationDatabase = null; }
    catch { throw cliError("USERS_BACKFILL_COMMITTED_CLOSE_FAILED", 7, { committed }); }
    checkInterrupted();
    emitOnce(output, {
      ok: true, status: result.status, committed,
      userCount: result.userCount, requiredBackfillCount: result.requiredBackfillCount,
      backfilledCount: result.backfilledCount, verifiedUserCount: verification.verifiedUserCount,
      action: committed ? "do_not_retry_normal_backfill" : "no_backfill_required"
    }, () => { emitted = true; });
    return 0;
  } catch (error) {
    const failure = normalizeFailure(error, { committed, outcomeUnknown });
    committed ||= failure.committed;
    outcomeUnknown ||= failure.outcomeUnknown;
    const verifyBeforeRetry = outcomeUnknown || failure.code === "USERS_BACKFILL_ROLLBACK_FAILED";
    if (!emitted) emitOnce(errorOutput, {
      ok: false, code: failure.code, committed: outcomeUnknown && !committed ? null : committed,
      action: committed ? "do_not_retry_normal_backfill" : verifyBeforeRetry ? "verify_before_retry" : "correct_input_and_retry"
    }, () => { emitted = true; });
    return failure.exitCode;
  } finally {
    removeSignals(signalSource, installed, onSigint, onSigterm);
    await cleanup();
  }
}

function parseArguments(argv) {
  const accepted = new Map([["--users", "users"], ["--config", "config"], ["--username-map", "usernameMap"], ["--database", "database"], ["--expected-manifest-sha256", "expectedManifestSha256"]]);
  if (!Array.isArray(argv) || argv.length !== 10 || argv.some((value) => typeof value !== "string")) throw cliError("USERS_BACKFILL_USAGE_INVALID", 2);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1]; const property = accepted.get(flag);
    if (!property || Object.hasOwn(result, property) || flag.includes("=") || value.startsWith("--") || value.includes("\0") || !value.trim()) throw cliError("USERS_BACKFILL_USAGE_INVALID", 2);
    if (property !== "expectedManifestSha256" && !path.isAbsolute(value)) throw cliError("USERS_BACKFILL_USAGE_INVALID", 2);
    result[property] = value;
  }
  if (!/^[0-9a-f]{64}$/.test(result.expectedManifestSha256 ?? "")) throw cliError("USERS_BACKFILL_USAGE_INVALID", 2);
  return result;
}

function normalizeDependencies(overrides) {
  if (!plainObject(overrides)) throw cliError("USERS_BACKFILL_INTERNAL_FAILED", 6);
  const operational = Object.fromEntries(Object.entries(overrides).filter(([key]) => !["output", "errorOutput", "signalSource"].includes(key)));
  if (Reflect.ownKeys(operational).some((key) => typeof key !== "string" || !Object.hasOwn(DEFAULT_DEPENDENCIES, key))) throw cliError("USERS_BACKFILL_INTERNAL_FAILED", 6);
  const result = { ...DEFAULT_DEPENDENCIES, ...operational };
  if (Object.values(result).some((value) => typeof value !== "function")) throw cliError("USERS_BACKFILL_INTERNAL_FAILED", 6);
  return result;
}

async function openSource(filePath, maximumBytes, deps) {
  let handle;
  try {
    const pathStat = await deps.lstat(filePath);
    requireSourcePolicy(pathStat, maximumBytes);
    handle = await deps.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const descriptorStat = await handle.stat();
    requireSourcePolicy(descriptorStat, maximumBytes);
    if (!sameIdentity(pathStat, descriptorStat) || !sameStableMetadata(pathStat, descriptorStat)) throw new Error();
    const bytes = await handle.readFile();
    if (!Buffer.isBuffer(bytes) || bytes.length !== descriptorStat.size) throw new Error();
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { filePath, handle, bytes, pathStat, descriptorStat };
  } catch {
    if (handle) { try { await handle.close(); } catch {} }
    throw cliError("USERS_BACKFILL_SOURCE_READ_FAILED", 3);
  }
}

async function revalidateSource(source, deps) {
  try {
    const descriptorStat = await source.handle.stat(); const pathStat = await deps.lstat(source.filePath);
    requireSourcePolicy(descriptorStat, source.descriptorStat.size); requireSourcePolicy(pathStat, source.pathStat.size);
    if (!sameIdentity(source.descriptorStat, descriptorStat) || !sameStableMetadata(source.descriptorStat, descriptorStat)
        || !sameIdentity(source.pathStat, pathStat) || !sameStableMetadata(source.pathStat, pathStat)
        || !sameIdentity(pathStat, descriptorStat)) throw new Error();
  } catch { throw cliError("USERS_BACKFILL_SOURCE_READ_FAILED", 3); }
}

async function captureDatabaseIdentity(databasePath, deps) {
  try {
    const parentPath = path.dirname(databasePath);
    const [target, parent] = await Promise.all([deps.lstat(databasePath), deps.lstat(parentPath)]);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : parent.uid;
    requireDatabasePolicy(target, parent, currentUid);
    return { databasePath, parentPath, target, parent, currentUid };
  } catch { throw cliError("USERS_BACKFILL_DATABASE_POLICY_FAILED", 4); }
}
async function revalidateDatabaseIdentity(identity, deps, stable) {
  try {
    const [target, parent] = await Promise.all([deps.lstat(identity.databasePath), deps.lstat(identity.parentPath)]);
    requireDatabasePolicy(target, parent, identity.currentUid);
    if (!sameIdentity(target, identity.target) || !sameIdentity(parent, identity.parent)
        || (stable && (!sameStableMetadata(target, identity.target) || !sameStableMetadata(parent, identity.parent)))) throw new Error();
  } catch { throw cliError("USERS_BACKFILL_DATABASE_POLICY_FAILED", 4); }
}
async function refreshDatabaseMetadata(identity, deps) {
  await revalidateDatabaseIdentity(identity, deps, false);
  const [target, parent] = await Promise.all([deps.lstat(identity.databasePath), deps.lstat(identity.parentPath)]);
  identity.target = target; identity.parent = parent;
}

function parseSource(bytes, code) { try { return parseUserImportJsonBytes(bytes); } catch { throw cliError(code, 3); } }
function requireConfig(config) {
  if (!plainObject(config) || !plainObject(config.auth) || !Array.isArray(config.auth.roles) || !Array.isArray(config.auth.modules)) throw cliError("USERS_BACKFILL_CONFIG_INVALID", 3);
  return config.auth;
}
function requireUsernameMap(value) {
  if (!plainObject(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string" || typeof value[key] !== "string")) throw cliError("USERS_BACKFILL_USERNAME_MAP_INVALID", 3);
}
function translatePlanError(error) {
  if (error?.code === "USERS_BACKFILL_SCHEMA_REQUIRED") return cliError(error.code, 4);
  if (error?.code === "USERS_BACKFILL_STORED_DATA_INVALID") return cliError(error.code, 5);
  return cliError(error?.code === "USERS_BACKFILL_PLAN_INVALID" ? error.code : "USERS_BACKFILL_INTERNAL_FAILED", 5);
}
function translateBackfillError(error) {
  const code = APPROVED_CODES.has(error?.code) ? error.code : "USERS_BACKFILL_TRANSACTION_FAILED";
  const state = error?.transactionState;
  const uncertain = code === "USERS_BACKFILL_COMMIT_OUTCOME_UNKNOWN" || state === "outcome-unknown";
  const exitCode = uncertain || code === "USERS_BACKFILL_ROLLBACK_FAILED" ? 7
    : ["USERS_BACKFILL_SCHEMA_REQUIRED", "USERS_BACKFILL_DATABASE_POLICY_FAILED", "USERS_BACKFILL_DATABASE_CHANGED"].includes(code) ? 4
      : code === "USERS_BACKFILL_STORED_DATA_INVALID" || code === "USERS_BACKFILL_PLAN_INVALID" ? 5 : 6;
  return cliError(code, exitCode, { outcomeUnknown: uncertain });
}
function normalizeFailure(error, state) { return error instanceof UserLegacyBackfillCliError ? error : cliError("USERS_BACKFILL_INTERNAL_FAILED", state.committed || state.outcomeUnknown ? 7 : 6, state); }
async function cleanupResources(resources, deps) {
  for (const key of ["verificationDatabase", "database"]) {
    const database = resources[key]; resources[key] = null;
    if (database) { try { deps.closeSqliteDatabase(database); } catch {} }
  }
  if (resources.plan) { try { disposeUserLegacyBackfillPlan(resources.plan); } catch {} resources.plan = null; }
  for (const source of resources.sources) {
    if (Buffer.isBuffer(source.bytes)) source.bytes.fill(0);
    try { await source.handle.close(); } catch {}
  }
  resources.sources = [];
}
function requireRegularSingleLink(stat, maximumBytes) { if (!stat?.isFile?.() || stat.isSymbolicLink?.() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximumBytes) throw new Error(); }
function requireSourcePolicy(stat, maximumBytes) { requireRegularSingleLink(stat, maximumBytes); const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid; if (stat.uid !== uid || (stat.mode & 0o022) !== 0) throw new Error(); }
function requireDatabasePolicy(target, parent, uid) { requireRegularSingleLink(target, Number.MAX_SAFE_INTEGER); if (!parent?.isDirectory?.() || parent.isSymbolicLink?.() || target.uid !== uid || parent.uid !== uid || (target.mode & 0o022) !== 0 || (parent.mode & 0o022) !== 0) throw new Error(); }
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameStableMetadata(left, right) { return left.size === right.size && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function installSignals(source, sigint, sigterm) { if (!source || typeof source.on !== "function" || typeof source.off !== "function") return false; source.on("SIGINT", sigint); source.on("SIGTERM", sigterm); return true; }
function removeSignals(source, installed, sigint, sigterm) { if (installed) { source.off("SIGINT", sigint); source.off("SIGTERM", sigterm); } }
function emitOnce(target, value, mark) { const json = JSON.stringify(value); if (typeof target === "function") target(json); else if (target && typeof target.write === "function") target.write(`${json}\n`); else throw cliError("USERS_BACKFILL_INTERNAL_FAILED", 6); mark(); }
function plainObject(value) { if (!value || Array.isArray(value) || typeof value !== "object") return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function cliError(code, exitCode, options) { return new UserLegacyBackfillCliError(code, exitCode, options); }

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) process.exitCode = await runUserLegacyBackfillCli();
