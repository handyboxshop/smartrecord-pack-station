import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  runSqliteForeignKeyCheck,
  runSqliteQuickCheck
} from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import {
  InitialAdminBootstrapError,
  bootstrapInitialAdmin
} from "../src/domain/initialAdminBootstrap.mjs";
import {
  UserIdentityError,
  normalizeSqliteEmail,
  normalizeUsername
} from "../src/domain/userIdentity.mjs";

const VALUE_FLAGS = new Map([
  ["--database", "databasePath"],
  ["--username", "username"],
  ["--email", "email"],
  ["--display-name", "displayName"]
]);
const BOOLEAN_FLAGS = new Set(["--password-stdin", "--help"]);
const DEPENDENCY_KEYS = new Set([
  "openDatabase", "runMigrations", "runQuickCheck", "runForeignKeyCheck",
  "closeDatabase", "bootstrapInitialAdmin", "readPassword", "lstat", "realpath"
]);
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAX_PASSWORD_INPUT_BYTES = 1026;

const DEFAULT_DEPENDENCIES = Object.freeze({
  openDatabase: (databasePath) => openSqliteDatabase(databasePath, { createParentDirectory: false }),
  runMigrations: (database) => runSqliteMigrations(database, { maximumVersion: 5 }),
  runQuickCheck: runSqliteQuickCheck,
  runForeignKeyCheck: runSqliteForeignKeyCheck,
  closeDatabase: closeSqliteDatabase,
  bootstrapInitialAdmin,
  readPassword: readPasswordInput,
  lstat,
  realpath
});

const EXIT_CODES = Object.freeze({
  BOOTSTRAP_USAGE_INVALID: 2,
  BOOTSTRAP_DATABASE_PATH_INVALID: 2,
  BOOTSTRAP_USERNAME_INVALID: 2,
  BOOTSTRAP_EMAIL_INVALID: 2,
  BOOTSTRAP_DISPLAY_NAME_INVALID: 2,
  BOOTSTRAP_PASSWORD_INVALID: 2,
  BOOTSTRAP_PASSWORD_INPUT_FAILED: 2,
  BOOTSTRAP_DATABASE_OPEN_FAILED: 3,
  BOOTSTRAP_SCHEMA_FAILED: 4,
  BOOTSTRAP_INTEGRITY_FAILED: 4,
  BOOTSTRAP_NOT_ALLOWED: 5,
  BOOTSTRAP_IDENTITY_CONFLICT: 5,
  BOOTSTRAP_HASH_FAILED: 6,
  BOOTSTRAP_PERSIST_FAILED: 6,
  BOOTSTRAP_AUDIT_FAILED: 6,
  BOOTSTRAP_ACTIVITY_FAILED: 6,
  BOOTSTRAP_DATABASE_CLOSE_FAILED: 7
});

class BootstrapCliError extends Error {
  constructor(code, signal = null) {
    super("Initial administrator bootstrap failed.");
    this.name = "BootstrapCliError";
    this.code = code;
    this.signal = signal;
  }
}

export async function runInitialAdminBootstrapCli({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  dependencies = {}
} = {}) {
  let deps;
  let parsed;
  let pathState;
  let password;
  try {
    deps = resolveDependencies(dependencies);
    parsed = parseArguments(argv);
    if (parsed.help) {
      write(stdout, "Usage: npm run db:bootstrap-initial-admin -- --database <absolute-path> --username <value> --email <value> --display-name <value> [--password-stdin]\n");
      return 0;
    }
    validateIdentityArguments(parsed);
    pathState = await validateDatabasePath(parsed.databasePath, deps);
    password = await deps.readPassword({ stdin, stderr, passwordStdin: parsed.passwordStdin });
    validatePassword(password);
  } catch (cause) {
    const failure = normalizeCliFailure(cause, "BOOTSTRAP_USAGE_INVALID");
    emitFailure(stderr, failure.code, false);
    return exitCodeFor(failure);
  }

  let database;
  let committed = false;
  let failure = null;
  const signals = observeSignals();
  try {
    signals.throwIfObserved();
    try {
      database = await deps.openDatabase(pathState.databasePath, { createParentDirectory: false });
    } catch {
      throw cliError("BOOTSTRAP_DATABASE_OPEN_FAILED");
    }
    signals.throwIfObserved();
    await revalidateDatabasePath(pathState, deps);
    signals.throwIfObserved();

    let migrationResult;
    try {
      migrationResult = await deps.runMigrations(database, { maximumVersion: 5 });
      if (migrationResult?.currentVersion !== 5) throw new Error("schema mismatch");
    } catch {
      throw cliError("BOOTSTRAP_SCHEMA_FAILED");
    }
    signals.throwIfObserved();
    try {
      if ((await deps.runQuickCheck(database))?.ok !== true) throw new Error("quick check");
      signals.throwIfObserved();
      if ((await deps.runForeignKeyCheck(database))?.ok !== true) throw new Error("foreign key check");
    } catch {
      throw cliError("BOOTSTRAP_INTEGRITY_FAILED");
    }
    signals.throwIfObserved();

    try {
      await deps.bootstrapInitialAdmin(database, {
        username: parsed.username,
        email: parsed.email,
        displayName: parsed.displayName,
        password
      });
      committed = true;
      signals.throwIfObserved();
    } catch (cause) {
      signals.throwIfObserved();
      throw normalizeBootstrapFailure(cause);
    }
  } catch (cause) {
    failure = signals.failure() ?? normalizeCliFailure(cause, "BOOTSTRAP_PERSIST_FAILED");
  } finally {
    password = undefined;
    if (database) {
      try {
        await deps.closeDatabase(database);
      } catch {
        failure = cliError("BOOTSTRAP_DATABASE_CLOSE_FAILED");
      }
    }
    failure = signals.failure() ?? failure;
    signals.cleanup();
  }

  if (failure) {
    emitFailure(stderr, failure.code, committed);
    if (failure.code === "BOOTSTRAP_DATABASE_CLOSE_FAILED" && committed) {
      write(stderr, "action=do_not_retry_normal_bootstrap\n");
    }
    return exitCodeFor(failure);
  }
  write(stdout, "status=success\ncode=INITIAL_ADMIN_CREATED\ncommitted=true\n");
  return 0;
}

function resolveDependencies(dependencies) {
  if (!isPlainRecord(dependencies)) throw cliError("BOOTSTRAP_USAGE_INVALID");
  if (Reflect.ownKeys(dependencies).some((key) => typeof key !== "string" || !DEPENDENCY_KEYS.has(key))) {
    throw cliError("BOOTSTRAP_USAGE_INVALID");
  }
  for (const value of Object.values(dependencies)) {
    if (typeof value !== "function") throw cliError("BOOTSTRAP_USAGE_INVALID");
  }
  return { ...DEFAULT_DEPENDENCIES, ...dependencies };
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) throw cliError("BOOTSTRAP_USAGE_INVALID");
  const values = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (typeof flag !== "string" || !flag.startsWith("--") || seen.has(flag)) {
      throw cliError("BOOTSTRAP_USAGE_INVALID");
    }
    seen.add(flag);
    if (VALUE_FLAGS.has(flag)) {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) {
        throw cliError("BOOTSTRAP_USAGE_INVALID");
      }
      values[VALUE_FLAGS.get(flag)] = value;
      index += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      values[flag === "--help" ? "help" : "passwordStdin"] = true;
      continue;
    }
    throw cliError("BOOTSTRAP_USAGE_INVALID");
  }
  if (values.help) {
    if (seen.size !== 1) throw cliError("BOOTSTRAP_USAGE_INVALID");
    return { help: true };
  }
  if (!values.databasePath || !values.username || !values.email || !values.displayName) {
    throw cliError("BOOTSTRAP_USAGE_INVALID");
  }
  return { ...values, help: false, passwordStdin: values.passwordStdin === true };
}

function validateIdentityArguments(parsed) {
  try {
    normalizeUsername(parsed.username);
  } catch (cause) {
    if (cause instanceof UserIdentityError) throw cliError("BOOTSTRAP_USERNAME_INVALID");
    throw cliError("BOOTSTRAP_USERNAME_INVALID");
  }
  try {
    normalizeSqliteEmail(parsed.email);
  } catch (cause) {
    if (cause instanceof UserIdentityError) throw cliError("BOOTSTRAP_EMAIL_INVALID");
    throw cliError("BOOTSTRAP_EMAIL_INVALID");
  }
  const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
  if (!displayName || displayName.length > 200 || CONTROL_PATTERN.test(displayName)) {
    throw cliError("BOOTSTRAP_DISPLAY_NAME_INVALID");
  }
}

async function validateDatabasePath(value, deps) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !path.isAbsolute(value.trim())) {
    throw cliError("BOOTSTRAP_DATABASE_PATH_INVALID");
  }
  const databasePath = path.normalize(value.trim());
  const parentPath = path.dirname(databasePath);
  let parent;
  let canonicalParent;
  try {
    parent = await deps.lstat(parentPath);
    canonicalParent = await deps.realpath(parentPath);
  } catch {
    throw cliError("BOOTSTRAP_DATABASE_PATH_INVALID");
  }
  if (!parent.isDirectory()) throw cliError("BOOTSTRAP_DATABASE_PATH_INVALID");

  let target = null;
  try {
    target = await deps.lstat(databasePath);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cliError("BOOTSTRAP_DATABASE_PATH_INVALID");
  }
  if (target && (target.isSymbolicLink() || !target.isFile())) {
    throw cliError("BOOTSTRAP_DATABASE_PATH_INVALID");
  }
  return {
    databasePath,
    canonicalParent,
    targetIdentity: target ? `${target.dev}:${target.ino}` : null
  };
}

async function revalidateDatabasePath(pathState, deps) {
  try {
    const canonicalParent = await deps.realpath(path.dirname(pathState.databasePath));
    const target = await deps.lstat(pathState.databasePath);
    if (canonicalParent !== pathState.canonicalParent || target.isSymbolicLink() || !target.isFile()) {
      throw new Error("mapping changed");
    }
    if (pathState.targetIdentity && `${target.dev}:${target.ino}` !== pathState.targetIdentity) {
      throw new Error("identity changed");
    }
  } catch {
    throw cliError("BOOTSTRAP_DATABASE_PATH_INVALID");
  }
}

async function readPasswordInput({ stdin, stderr, passwordStdin }) {
  if (!stdin || typeof stdin.on !== "function") throw cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED");
  if (passwordStdin) {
    if (stdin.isTTY) throw cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED");
    return readSinglePasswordLine(stdin);
  }
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED");
  }
  const first = await readHiddenLine(stdin, stderr, "Password: ");
  const second = await readHiddenLine(stdin, stderr, "Confirm password: ");
  if (first !== second) throw cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED");
  return first;
}

async function readSinglePasswordLine(stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_PASSWORD_INPUT_BYTES) throw cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED");
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  const newline = bytes.indexOf(0x0a);
  if (newline < 0 || newline !== bytes.length - 1 || bytes.indexOf(0x0a, newline + 1) >= 0) {
    throw cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED");
  }
  const passwordBytes = newline > 0 && bytes[newline - 1] === 0x0d
    ? bytes.subarray(0, newline - 1)
    : bytes.subarray(0, newline);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(passwordBytes);
  } catch {
    throw cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED");
  }
}

function readHiddenLine(stdin, stderr, prompt) {
  return new Promise((resolve, reject) => {
    const bytes = [];
    const wasRaw = stdin.isRaw === true;
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      try { stdin.setRawMode(wasRaw); } catch { /* The fixed failure below remains authoritative. */ }
    };
    const fail = (error) => { cleanup(); reject(error); };
    const finish = () => {
      cleanup();
      write(stderr, "\n");
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
      } catch {
        reject(cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED"));
      }
    };
    const onError = () => fail(cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED"));
    const onSigint = () => fail(cliError("BOOTSTRAP_INTERRUPTED", "SIGINT"));
    const onSigterm = () => fail(cliError("BOOTSTRAP_INTERRUPTED", "SIGTERM"));
    const onData = (chunk) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 0x03) return onSigint();
        if (byte === 0x0d || byte === 0x0a) return finish();
        if (byte === 0x7f || byte === 0x08) {
          bytes.pop();
        } else if (bytes.length < MAX_PASSWORD_INPUT_BYTES) {
          bytes.push(byte);
        } else {
          return fail(cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED"));
        }
      }
    };
    write(stderr, prompt);
    try { stdin.setRawMode(true); } catch { return fail(cliError("BOOTSTRAP_PASSWORD_INPUT_FAILED")); }
    stdin.on("data", onData);
    stdin.once("error", onError);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    stdin.resume?.();
  });
}

function observeSignals() {
  let signal = null;
  const onSigint = () => { signal ??= "SIGINT"; };
  const onSigterm = () => { signal ??= "SIGTERM"; };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    cleanup() {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    },
    failure() {
      return signal ? cliError("BOOTSTRAP_INTERRUPTED", signal) : null;
    },
    throwIfObserved() {
      if (signal) throw cliError("BOOTSTRAP_INTERRUPTED", signal);
    }
  };
}

function validatePassword(value) {
  if (
    typeof value !== "string"
    || value.length < 8
    || Buffer.byteLength(value, "utf8") > 1024
    || CONTROL_PATTERN.test(value)
    || value !== value.trim()
  ) throw cliError("BOOTSTRAP_PASSWORD_INVALID");
}

function normalizeBootstrapFailure(cause) {
  if (!(cause instanceof InitialAdminBootstrapError)) return cliError("BOOTSTRAP_PERSIST_FAILED");
  return cliError(cause.code);
}

function normalizeCliFailure(cause, fallbackCode) {
  return cause instanceof BootstrapCliError ? cause : cliError(fallbackCode);
}

function exitCodeFor(error) {
  if (error.code === "BOOTSTRAP_INTERRUPTED") return error.signal === "SIGTERM" ? 143 : 130;
  return EXIT_CODES[error.code] ?? 6;
}

function emitFailure(stderr, code, committed) {
  write(stderr, `status=failed\ncode=${code}\ncommitted=${committed ? "true" : "false"}\n`);
}

function write(stream, value) {
  if (!stream || typeof stream.write !== "function") return;
  stream.write(value);
}

function isPlainRecord(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cliError(code, signal = null) {
  return new BootstrapCliError(code, signal);
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  process.exitCode = await runInitialAdminBootstrapCli();
}
