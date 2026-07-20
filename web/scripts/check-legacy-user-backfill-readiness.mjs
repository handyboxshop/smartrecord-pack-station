import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeSqliteDatabase, openReadOnlySqliteDatabase } from "../src/storage/sqliteDatabase.mjs";
import {
  createUserLegacyBackfillPlan,
  disposeUserLegacyBackfillPlan
} from "../src/storage/userLegacyBackfillPlan.mjs";
import { verifyUserLegacyBackfill } from "../src/storage/userLegacyBackfillVerifier.mjs";
import { parseUserImportJsonBytes, sourceManifestSha256 } from "./check-user-import-readiness.mjs";

const LIMITS = Object.freeze({
  users: 16 * 1024 * 1024,
  config: 4 * 1024 * 1024,
  usernameMap: 4 * 1024 * 1024
});
const SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm", "-journal"]);
const APPROVED_CODES = new Set([
  "USERS_BACKFILL_READINESS_USAGE_INVALID",
  "USERS_BACKFILL_READINESS_SOURCE_READ_FAILED",
  "USERS_BACKFILL_READINESS_SOURCE_JSON_INVALID",
  "USERS_BACKFILL_READINESS_CONFIG_INVALID",
  "USERS_BACKFILL_READINESS_USERNAME_MAP_INVALID",
  "USERS_BACKFILL_READINESS_SOURCE_MANIFEST_MISMATCH",
  "USERS_BACKFILL_READINESS_DATABASE_POLICY_FAILED",
  "USERS_BACKFILL_READINESS_DATABASE_OPEN_FAILED",
  "USERS_BACKFILL_READINESS_SCHEMA_REQUIRED",
  "USERS_BACKFILL_READINESS_PLAN_INVALID",
  "USERS_BACKFILL_READINESS_STORED_DATA_INVALID",
  "USERS_BACKFILL_READINESS_VERIFICATION_MISMATCH",
  "USERS_BACKFILL_READINESS_DATABASE_CHANGED",
  "USERS_BACKFILL_READINESS_INTERRUPTED",
  "USERS_BACKFILL_READINESS_INTERNAL_FAILED"
]);
const DEFAULT_DEPENDENCIES = Object.freeze({
  closeSqliteDatabase,
  createUserLegacyBackfillPlan,
  disposeUserLegacyBackfillPlan,
  lstat,
  open,
  openReadOnlySqliteDatabase,
  verifyUserLegacyBackfill
});

class UserLegacyBackfillReadinessCliError extends Error {
  constructor(code, exitCode) {
    const safeCode = APPROVED_CODES.has(code) ? code : "USERS_BACKFILL_READINESS_INTERNAL_FAILED";
    super("Legacy Users backfill readiness check failed safely.");
    this.name = "UserLegacyBackfillReadinessCliError";
    this.code = safeCode;
    Object.defineProperties(this, {
      stack: { value: `${this.name}: Legacy Users backfill readiness check failed safely.`, writable: false },
      exitCode: { value: exitCode, enumerable: false }
    });
  }
}

/**
 * Check legacy username readiness without changing sources or the SQLite database.
 * @param {string[]} argv Exact absolute-path and expected-manifest arguments.
 * @param {object} dependencies Optional deterministic-test dependency overrides.
 * @returns {Promise<number>} Exit code after one sanitized JSON line is emitted.
 */
export async function runUserLegacyBackfillReadinessCli(argv = process.argv.slice(2), dependencies = {}) {
  let deps = DEFAULT_DEPENDENCIES;
  const resources = { sources: [], database: null, databaseIdentity: null, plan: null };
  const output = dependencies?.output ?? process.stdout;
  const errorOutput = dependencies?.errorOutput ?? process.stderr;
  const signalSource = dependencies?.signalSource ?? process;
  let interrupted = null;
  let success = null;
  let failure = null;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= cleanupResources(resources, deps);
    return cleanupPromise;
  };
  const onSigint = () => { interrupted ??= "SIGINT"; };
  const onSigterm = () => { interrupted ??= "SIGTERM"; };
  const installed = installSignals(signalSource, onSigint, onSigterm);
  const checkInterrupted = () => {
    if (interrupted) throw cliError(
      "USERS_BACKFILL_READINESS_INTERRUPTED",
      interrupted === "SIGINT" ? 130 : 143
    );
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
    const users = parseSource(resources.sources[0].bytes, "USERS_BACKFILL_READINESS_SOURCE_JSON_INVALID");
    const config = parseSource(resources.sources[1].bytes, "USERS_BACKFILL_READINESS_CONFIG_INVALID");
    const usernameMap = parseSource(
      resources.sources[2].bytes,
      "USERS_BACKFILL_READINESS_USERNAME_MAP_INVALID"
    );
    const auth = requireConfig(config);
    requireUsernameMap(usernameMap);
    const manifest = sourceManifestSha256(resources.sources.map((source) => source.bytes));
    if (manifest !== args.expectedManifestSha256) {
      throw cliError("USERS_BACKFILL_READINESS_SOURCE_MANIFEST_MISMATCH", 3);
    }

    resources.databaseIdentity = await captureDatabaseIdentity(args.database, deps);
    try {
      resources.database = await deps.openReadOnlySqliteDatabase(args.database);
    } catch {
      throw cliError("USERS_BACKFILL_READINESS_DATABASE_OPEN_FAILED", 4);
    }
    await revalidatePlanningBoundary(resources, deps);
    checkInterrupted();
    try {
      resources.plan = deps.createUserLegacyBackfillPlan(users, {
        roles: auth.roles,
        modules: auth.modules,
        passwordPolicy: auth.passwordPolicy,
        usernameAssignments: usernameMap,
        sourceManifestSha256: manifest
      }, resources.database);
    } catch (error) {
      throw translatePlanError(error);
    }
    requirePlan(resources.plan, manifest);

    await revalidatePlanningBoundary(resources, deps);
    checkInterrupted();
    let verification;
    try {
      verification = deps.verifyUserLegacyBackfill(resources.database, resources.plan);
    } catch (error) {
      throw translateVerificationError(error);
    }
    requireExpectedVerification(resources.plan, verification);
    await revalidatePlanningBoundary(resources, deps);
    checkInterrupted();
    success = successPayload(resources.plan, verification);
  } catch (error) {
    failure = normalizeFailure(error);
  } finally {
    removeSignals(signalSource, installed, onSigint, onSigterm);
    try {
      await cleanup();
    } catch (error) {
      failure = normalizeFailure(error);
      success = null;
    }
  }

  if (!failure && interrupted) {
    failure = cliError(
      "USERS_BACKFILL_READINESS_INTERRUPTED",
      interrupted === "SIGINT" ? 130 : 143
    );
    success = null;
  }
  if (failure) {
    emitJson(errorOutput, {
      ok: false,
      code: failure.code,
      action: failureAction(failure.code)
    });
    return failure.exitCode;
  }
  emitJson(output, success);
  return 0;
}

function parseArguments(argv) {
  const accepted = new Map([
    ["--users", "users"],
    ["--config", "config"],
    ["--username-map", "usernameMap"],
    ["--database", "database"],
    ["--expected-manifest-sha256", "expectedManifestSha256"]
  ]);
  if (!Array.isArray(argv) || argv.length !== 10 || argv.some((value) => typeof value !== "string")) {
    throw cliError("USERS_BACKFILL_READINESS_USAGE_INVALID", 2);
  }
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const property = accepted.get(flag);
    if (!property || Object.hasOwn(result, property) || flag.includes("=") || value.startsWith("--")
        || value.includes("\0") || !value.trim()) {
      throw cliError("USERS_BACKFILL_READINESS_USAGE_INVALID", 2);
    }
    if (property !== "expectedManifestSha256" && !path.isAbsolute(value)) {
      throw cliError("USERS_BACKFILL_READINESS_USAGE_INVALID", 2);
    }
    result[property] = value;
  }
  if (!/^[0-9a-f]{64}$/.test(result.expectedManifestSha256 ?? "")) {
    throw cliError("USERS_BACKFILL_READINESS_USAGE_INVALID", 2);
  }
  return result;
}

function normalizeDependencies(overrides) {
  if (!plainObject(overrides)) throw cliError("USERS_BACKFILL_READINESS_INTERNAL_FAILED", 5);
  const operational = Object.fromEntries(Object.entries(overrides).filter(
    ([key]) => !["output", "errorOutput", "signalSource"].includes(key)
  ));
  if (Reflect.ownKeys(operational).some(
    (key) => typeof key !== "string" || !Object.hasOwn(DEFAULT_DEPENDENCIES, key)
  )) throw cliError("USERS_BACKFILL_READINESS_INTERNAL_FAILED", 5);
  const result = { ...DEFAULT_DEPENDENCIES, ...operational };
  if (Object.values(result).some((value) => typeof value !== "function")) {
    throw cliError("USERS_BACKFILL_READINESS_INTERNAL_FAILED", 5);
  }
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
    if (handle) { try { await handle.close(); } catch { /* Primary failure is retained. */ } }
    throw cliError("USERS_BACKFILL_READINESS_SOURCE_READ_FAILED", 3);
  }
}

async function revalidateSource(source, deps) {
  try {
    const [descriptorStat, pathStat] = await Promise.all([source.handle.stat(), deps.lstat(source.filePath)]);
    requireSourcePolicy(descriptorStat, source.descriptorStat.size);
    requireSourcePolicy(pathStat, source.pathStat.size);
    if (!sameIdentity(source.descriptorStat, descriptorStat)
        || !sameStableMetadata(source.descriptorStat, descriptorStat)
        || !sameIdentity(source.pathStat, pathStat)
        || !sameStableMetadata(source.pathStat, pathStat)
        || !sameIdentity(pathStat, descriptorStat)) throw new Error();
  } catch {
    throw cliError("USERS_BACKFILL_READINESS_SOURCE_READ_FAILED", 3);
  }
}

async function captureDatabaseIdentity(databasePath, deps) {
  let handle;
  try {
    const parentPath = path.dirname(databasePath);
    const [target, parent] = await Promise.all([deps.lstat(databasePath), deps.lstat(parentPath)]);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : parent.uid;
    requireDatabasePolicy(target, parent, currentUid);
    await requireNoSidecars(databasePath, deps);
    handle = await deps.open(databasePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const descriptor = await handle.stat();
    requireRegularSingleLink(descriptor, Number.MAX_SAFE_INTEGER);
    if (!sameIdentity(target, descriptor) || !sameStableMetadata(target, descriptor)) throw new Error();
    const fingerprint = await fingerprintHandle(handle, descriptor.size);
    return { databasePath, parentPath, target, parent, descriptor, currentUid, fingerprint, handle };
  } catch {
    if (handle) { try { await handle.close(); } catch { /* Primary failure is retained. */ } }
    throw cliError("USERS_BACKFILL_READINESS_DATABASE_POLICY_FAILED", 4);
  }
}

async function revalidatePlanningBoundary(resources, deps) {
  await Promise.all(resources.sources.map((source) => revalidateSource(source, deps)));
  await revalidateDatabase(resources.databaseIdentity, deps, true);
}

async function revalidateDatabase(identity, deps, includeFingerprint) {
  let target;
  let parent;
  let descriptor;
  try {
    [target, parent, descriptor] = await Promise.all([
      deps.lstat(identity.databasePath),
      deps.lstat(identity.parentPath),
      identity.handle.stat()
    ]);
    requireDatabasePolicy(target, parent, identity.currentUid);
    requireRegularSingleLink(descriptor, Number.MAX_SAFE_INTEGER);
  } catch {
    throw cliError("USERS_BACKFILL_READINESS_DATABASE_POLICY_FAILED", 4);
  }
  try {
    await requireNoSidecars(identity.databasePath, deps);
    if (!sameIdentity(target, identity.target) || !sameIdentity(parent, identity.parent)
        || !sameIdentity(descriptor, identity.descriptor)
        || !sameIdentity(target, descriptor)
        || !sameStableMetadata(target, identity.target)
        || !sameStableMetadata(parent, identity.parent)
        || !sameStableMetadata(descriptor, identity.descriptor)) throw new Error();
    if (includeFingerprint && await fingerprintHandle(identity.handle, descriptor.size) !== identity.fingerprint) {
      throw new Error();
    }
  } catch {
    throw cliError("USERS_BACKFILL_READINESS_DATABASE_CHANGED", 4);
  }
}

async function fingerprintHandle(handle, size) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let position = 0;
    while (position < size) {
      const requested = Math.min(buffer.length, size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead <= 0) throw new Error();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    buffer.fill(0);
  }
}

async function requireNoSidecars(databasePath, deps) {
  for (const suffix of SIDECAR_SUFFIXES) {
    try {
      await deps.lstat(`${databasePath}${suffix}`);
      throw new Error();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function parseSource(bytes, code) {
  try { return parseUserImportJsonBytes(bytes); }
  catch { throw cliError(code, 3); }
}

function requireConfig(config) {
  if (!plainObject(config) || !plainObject(config.auth)
      || !Array.isArray(config.auth.roles) || !Array.isArray(config.auth.modules)) {
    throw cliError("USERS_BACKFILL_READINESS_CONFIG_INVALID", 3);
  }
  return config.auth;
}

function requireUsernameMap(value) {
  if (!plainObject(value) || Reflect.ownKeys(value).some(
    (key) => typeof key !== "string" || typeof value[key] !== "string"
  )) throw cliError("USERS_BACKFILL_READINESS_USERNAME_MAP_INVALID", 3);
}

function requirePlan(plan, manifest) {
  const keys = [
    "status", "sourceManifestSha256", "userCount", "permissionCount",
    "requiredBackfillCount", "alreadyAssignedCount"
  ];
  if (!exactDataKeys(plan, keys) || !["ready", "already-complete"].includes(plan.status)
      || plan.sourceManifestSha256 !== manifest
      || !safeCount(plan.userCount) || !safeCount(plan.permissionCount)
      || !safeCount(plan.requiredBackfillCount) || !safeCount(plan.alreadyAssignedCount)
      || plan.requiredBackfillCount + plan.alreadyAssignedCount !== plan.userCount
      || (plan.status === "ready" && plan.requiredBackfillCount === 0)
      || (plan.status === "already-complete" && plan.requiredBackfillCount !== 0)) {
    throw cliError("USERS_BACKFILL_READINESS_PLAN_INVALID", 5);
  }
}

function requireExpectedVerification(plan, report) {
  if (!exactDataKeys(report, [
    "status", "expectedUserCount", "actualUserCount", "verifiedUserCount",
    "mismatchedUserCount", "issueCodeCounts"
  ])
      || !safeCount(report.expectedUserCount) || !safeCount(report.actualUserCount)
      || !safeCount(report.verifiedUserCount) || !safeCount(report.mismatchedUserCount)
      || report.expectedUserCount !== plan.userCount || report.actualUserCount !== plan.userCount
      || report.verifiedUserCount + report.mismatchedUserCount !== plan.userCount) {
    throw cliError("USERS_BACKFILL_READINESS_VERIFICATION_MISMATCH", 5);
  }
  const counts = report.issueCodeCounts;
  if (plan.status === "ready") {
    if (report.status !== "mismatch" || report.verifiedUserCount !== plan.alreadyAssignedCount
        || report.mismatchedUserCount !== plan.requiredBackfillCount
        || !exactIssueCounts(counts, { USERNAME_MISMATCH: plan.requiredBackfillCount })) {
      throw cliError("USERS_BACKFILL_READINESS_VERIFICATION_MISMATCH", 5);
    }
    return;
  }
  if (report.status !== "already-complete" || report.verifiedUserCount !== plan.userCount
      || report.mismatchedUserCount !== 0 || !exactIssueCounts(counts, {})) {
    throw cliError("USERS_BACKFILL_READINESS_VERIFICATION_MISMATCH", 5);
  }
}

function exactIssueCounts(actual, expected) {
  const expectedKeys = Object.keys(expected);
  if (!Array.isArray(actual) || actual.length !== expectedKeys.length) return false;
  const seen = new Set();
  for (const entry of actual) {
    if (!exactDataKeys(entry, ["code", "count"])
        || typeof entry.code !== "string" || !Object.hasOwn(expected, entry.code)
        || entry.count !== expected[entry.code] || seen.has(entry.code)) return false;
    seen.add(entry.code);
  }
  return seen.size === expectedKeys.length;
}

function successPayload(plan, verification) {
  return {
    ok: true,
    status: plan.status,
    sourceManifestSha256: plan.sourceManifestSha256,
    userCount: plan.userCount,
    permissionCount: plan.permissionCount,
    requiredBackfillCount: plan.requiredBackfillCount,
    alreadyAssignedCount: plan.alreadyAssignedCount,
    verificationStatus: verification.status,
    verifiedUserCount: verification.verifiedUserCount,
    mismatchedUserCount: verification.mismatchedUserCount,
    action: plan.status === "ready" ? "request_offline_rehearsal_approval" : "no_backfill_required"
  };
}

function translatePlanError(error) {
  if (error?.code === "USERS_BACKFILL_SCHEMA_REQUIRED") {
    return cliError("USERS_BACKFILL_READINESS_SCHEMA_REQUIRED", 4);
  }
  if (error?.code === "USERS_BACKFILL_STORED_DATA_INVALID") {
    return cliError("USERS_BACKFILL_READINESS_STORED_DATA_INVALID", 5);
  }
  if (error?.code === "USERS_BACKFILL_PLAN_INVALID") {
    return cliError("USERS_BACKFILL_READINESS_PLAN_INVALID", 5);
  }
  return cliError("USERS_BACKFILL_READINESS_INTERNAL_FAILED", 5);
}

function translateVerificationError(error) {
  if (error?.code === "USERS_BACKFILL_SCHEMA_REQUIRED") {
    return cliError("USERS_BACKFILL_READINESS_SCHEMA_REQUIRED", 4);
  }
  if (error?.code === "USERS_BACKFILL_STORED_DATA_INVALID") {
    return cliError("USERS_BACKFILL_READINESS_STORED_DATA_INVALID", 5);
  }
  if (error?.code === "USERS_BACKFILL_DATABASE_CHANGED") {
    return cliError("USERS_BACKFILL_READINESS_DATABASE_CHANGED", 4);
  }
  return cliError("USERS_BACKFILL_READINESS_VERIFICATION_MISMATCH", 5);
}

async function cleanupResources(resources, deps) {
  let cleanupFailed = false;
  let databaseChanged = false;
  if (resources.database) {
    try { deps.closeSqliteDatabase(resources.database); }
    catch { cleanupFailed = true; }
    resources.database = null;
  }
  if (resources.plan) {
    try { deps.disposeUserLegacyBackfillPlan(resources.plan); }
    catch { cleanupFailed = true; }
    resources.plan = null;
  }
  if (resources.databaseIdentity) {
    try { await revalidateDatabase(resources.databaseIdentity, deps, true); }
    catch { databaseChanged = true; }
    try { await resources.databaseIdentity.handle.close(); }
    catch { cleanupFailed = true; }
    resources.databaseIdentity = null;
  }
  for (const source of resources.sources) {
    if (Buffer.isBuffer(source.bytes)) source.bytes.fill(0);
    try { await source.handle.close(); }
    catch { cleanupFailed = true; }
  }
  resources.sources = [];
  if (databaseChanged) throw cliError("USERS_BACKFILL_READINESS_DATABASE_CHANGED", 4);
  if (cleanupFailed) throw cliError("USERS_BACKFILL_READINESS_INTERNAL_FAILED", 5);
}

function failureAction(code) {
  if ([
    "USERS_BACKFILL_READINESS_USAGE_INVALID",
    "USERS_BACKFILL_READINESS_SOURCE_READ_FAILED",
    "USERS_BACKFILL_READINESS_SOURCE_JSON_INVALID",
    "USERS_BACKFILL_READINESS_CONFIG_INVALID",
    "USERS_BACKFILL_READINESS_USERNAME_MAP_INVALID",
    "USERS_BACKFILL_READINESS_SOURCE_MANIFEST_MISMATCH",
    "USERS_BACKFILL_READINESS_DATABASE_POLICY_FAILED"
  ].includes(code)) return "correct_input_and_retry";
  if ([
    "USERS_BACKFILL_READINESS_DATABASE_OPEN_FAILED",
    "USERS_BACKFILL_READINESS_SCHEMA_REQUIRED"
  ].includes(code)) return "replace_offline_copy";
  return "do_not_proceed";
}

function requireRegularSingleLink(stat, maximumBytes) {
  if (!stat?.isFile?.() || stat.isSymbolicLink?.() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size)
      || stat.size < 0 || stat.size > maximumBytes) throw new Error();
}
function requireSourcePolicy(stat, maximumBytes) {
  requireRegularSingleLink(stat, maximumBytes);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.uid !== uid || (stat.mode & 0o022) !== 0) throw new Error();
}
function requireDatabasePolicy(target, parent, uid) {
  requireRegularSingleLink(target, Number.MAX_SAFE_INTEGER);
  if (!parent?.isDirectory?.() || parent.isSymbolicLink?.() || target.uid !== uid || parent.uid !== uid
      || (target.mode & 0o022) !== 0 || (parent.mode & 0o022) !== 0) throw new Error();
}
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameStableMetadata(left, right) {
  return left.size === right.size && left.mode === right.mode && left.uid === right.uid
    && left.gid === right.gid && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}
function safeCount(value) { return Number.isSafeInteger(value) && value >= 0; }
function plainObject(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactDataKeys(value, expectedKeys) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === expectedKeys.length && keys.every((key) => (
    typeof key === "string" && expectedKeys.includes(key)
    && "value" in descriptors[key] && descriptors[key].enumerable
  ));
}
function installSignals(source, sigint, sigterm) {
  if (!source || typeof source.on !== "function" || typeof source.off !== "function") return false;
  source.on("SIGINT", sigint);
  source.on("SIGTERM", sigterm);
  return true;
}
function removeSignals(source, installed, sigint, sigterm) {
  if (installed) {
    source.off("SIGINT", sigint);
    source.off("SIGTERM", sigterm);
  }
}
function emitJson(target, value) {
  const json = JSON.stringify(value);
  if (typeof target === "function") target(json);
  else if (target && typeof target.write === "function") target.write(`${json}\n`);
  else throw cliError("USERS_BACKFILL_READINESS_INTERNAL_FAILED", 5);
}
function normalizeFailure(error) {
  return error instanceof UserLegacyBackfillReadinessCliError
    ? error : cliError("USERS_BACKFILL_READINESS_INTERNAL_FAILED", 5);
}
function cliError(code, exitCode) { return new UserLegacyBackfillReadinessCliError(code, exitCode); }

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) process.exitCode = await runUserLegacyBackfillReadinessCli();
