import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeUserImportReadiness } from "../src/storage/userImportReadiness.mjs";

const HELP_TEXT = [
  "Usage: npm run db:check-users-readiness -- --users /absolute/path/users.json --config /absolute/path/app-config.json --username-map /absolute/path/usernames.json",
  "",
  "Offline validation only. No users are imported and no database is opened."
].join("\n");

const FILE_LIMITS = Object.freeze({
  users: 16 * 1024 * 1024,
  config: 4 * 1024 * 1024,
  usernameMap: 4 * 1024 * 1024
});

const DEFAULT_DEPENDENCIES = Object.freeze({
  analyzeUserImportReadiness,
  lstat,
  readFile
});

class UserImportReadinessCliError extends Error {
  constructor(code) {
    super("User import readiness CLI operation failed.");
    this.name = "UserImportReadinessCliError";
    this.code = code;
  }
}

export async function runUserImportReadinessCli({
  argv = process.argv.slice(2),
  output = process.stdout,
  errorOutput = process.stderr,
  dependencies = {}
} = {}) {
  const retainedBuffers = [];
  try {
    const args = parseArguments(argv);
    if (args.help) {
      emitLine(output, HELP_TEXT);
      return 0;
    }
    const deps = normalizeDependencies(dependencies);
    const usersInput = await readJsonInput(args.users, FILE_LIMITS.users, "users", deps, retainedBuffers);
    const configInput = await readJsonInput(args.config, FILE_LIMITS.config, "config", deps, retainedBuffers);
    const users = usersInput.value;
    const config = configInput.value;
    const extractedConfig = extractConfig(config);
    const usernameInput = await readJsonInput(args.usernameMap, FILE_LIMITS.usernameMap, "usernameMap", deps, retainedBuffers);
    const usernameAssignments = usernameInput.value;
    requireUsernameMap(usernameAssignments);
    const report = deps.analyzeUserImportReadiness(users, {
      roles: extractedConfig.roles,
      modules: extractedConfig.modules,
      passwordPolicy: extractedConfig.passwordPolicy,
      usernameAssignments
    });

    if (report.issues.some((issue) => (
      issue.code === "CONFIG_ROLES_INVALID"
      || issue.code === "CONFIG_MODULES_INVALID"
      || issue.code === "CONFIG_PASSWORD_POLICY_INVALID"
    ))) {
      throw cliError("USERS_READINESS_CONFIG_INVALID");
    }
    if (report.issues.some((issue) => issue.code === "USERNAME_ASSIGNMENTS_INVALID")) {
      throw cliError("USERS_READINESS_USERNAME_MAP_INVALID");
    }
    if (!report.ok) {
      emitJson(errorOutput, { code: "USERS_READINESS_BLOCKED", report });
      return 1;
    }
    emitJson(output, { code: "USERS_READINESS_READY", report, sourceManifestSha256: sourceManifestSha256([usersInput.bytes, configInput.bytes, usernameInput.bytes]) });
    return 0;
  } catch (cause) {
    const code = cause instanceof UserImportReadinessCliError
      ? cause.code
      : "USERS_READINESS_INTERNAL_FAILED";
    try {
      emitJson(errorOutput, { code });
    } catch {
      // An unusable output sink has no safe reporting channel.
    }
    return 1;
  } finally { for (const bytes of retainedBuffers) if (Buffer.isBuffer(bytes)) bytes.fill(0); }
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw cliError("USERS_READINESS_USAGE_INVALID");
  }
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  if (argv.includes("--help")) throw cliError("USERS_READINESS_USAGE_INVALID");

  const accepted = new Map([
    ["--users", "users"],
    ["--config", "config"],
    ["--username-map", "usernameMap"]
  ]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const property = accepted.get(flag);
    if (!property || Object.hasOwn(result, property) || typeof value !== "string"
        || value.startsWith("--") || flag.includes("=") || value.includes("\0")
        || !value.trim() || !path.isAbsolute(value)) {
      throw cliError("USERS_READINESS_USAGE_INVALID");
    }
    result[property] = value;
  }
  if (!result.users || !result.config || !result.usernameMap) throw cliError("USERS_READINESS_USAGE_INVALID");
  return result;
}

function normalizeDependencies(dependencies) {
  if (!isPlainObject(dependencies)) throw cliError("USERS_READINESS_INTERNAL_FAILED");
  const allowed = new Set(Object.keys(DEFAULT_DEPENDENCIES));
  if (Reflect.ownKeys(dependencies).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw cliError("USERS_READINESS_INTERNAL_FAILED");
  }
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  if (Object.values(deps).some((dependency) => typeof dependency !== "function")) {
    throw cliError("USERS_READINESS_INTERNAL_FAILED");
  }
  return deps;
}

async function readJsonInput(filePath, maximumBytes, kind, deps, retainedBuffers) {
  let before;
  let bytes;
  let after;
  try {
    before = await deps.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size)
        || before.size < 0 || before.size > maximumBytes) {
      throw new Error("invalid file");
    }
    bytes = await deps.readFile(filePath);
    if (Buffer.isBuffer(bytes)) retainedBuffers.push(bytes);
    after = await deps.lstat(filePath);
    if (!Buffer.isBuffer(bytes) || bytes.length > maximumBytes
        || !after.isFile() || after.isSymbolicLink()
        || after.size !== before.size || after.size !== bytes.length
        || after.dev !== before.dev || after.ino !== before.ino
        || after.mtimeMs !== before.mtimeMs) {
      throw new Error("file changed");
    }
  } catch {
    throw cliError("USERS_READINESS_SOURCE_READ_FAILED");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw cliError("USERS_READINESS_SOURCE_READ_FAILED");
  }
  try {
    return { value: parseUserImportJsonBytes(bytes), bytes };
  } catch {
    if (kind === "config") throw cliError("USERS_READINESS_CONFIG_INVALID");
    if (kind === "usernameMap") throw cliError("USERS_READINESS_USERNAME_MAP_INVALID");
    throw cliError("USERS_READINESS_SOURCE_JSON_INVALID");
  }
}

function extractConfig(config) {
  if (!isPlainObject(config) || !isPlainObject(config.auth)
      || !Array.isArray(config.auth.roles) || !Array.isArray(config.auth.modules)) {
    throw cliError("USERS_READINESS_CONFIG_INVALID");
  }
  return {
    roles: config.auth.roles,
    modules: config.auth.modules,
    passwordPolicy: config.auth.passwordPolicy
  };
}

function requireUsernameMap(value) {
  if (!isPlainObject(value) || Reflect.ownKeys(value).some((key) => (
    typeof key !== "string" || typeof value[key] !== "string"
  ))) {
    throw cliError("USERS_READINESS_USERNAME_MAP_INVALID");
  }
}

export function sourceManifestSha256([users, config, usernameMap]) {
  const hashes = [users, config, usernameMap].map((bytes) => createHash("sha256").update(bytes).digest("hex"));
  return createHash("sha256").update(`smartrecord-users-import-manifest-v1\nusers:${hashes[0]}\nconfig:${hashes[1]}\nusername-map:${hashes[2]}\n`, "utf8").digest("hex");
}

/** Parse exact UTF-8 JSON while rejecting duplicate decoded object keys. */
export function parseUserImportJsonBytes(bytes, { maximumDepth = 128, maximumNodes = 1_000_000 } = {}) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(maximumDepth) || maximumDepth < 1
      || !Number.isSafeInteger(maximumNodes) || maximumNodes < 1) throw new SyntaxError("Invalid JSON input.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let index = 0;
  let nodes = 0;
  const whitespace = () => { while (index < text.length && " \t\r\n".includes(text[index])) index += 1; };
  const stringToken = () => {
    if (text[index] !== "\"") throw new SyntaxError("Invalid JSON input.");
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index];
      if (!escaped && character === "\"") {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
      index += 1;
    }
    throw new SyntaxError("Invalid JSON input.");
  };
  const value = (depth) => {
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth) throw new SyntaxError("JSON input is too complex.");
    whitespace();
    if (text[index] === "{") return object(depth + 1);
    if (text[index] === "[") return array(depth + 1);
    if (text[index] === "\"") { stringToken(); return; }
    const start = index;
    while (index < text.length && !" \t\r\n,]}".includes(text[index])) index += 1;
    if (index === start) throw new SyntaxError("Invalid JSON input.");
  };
  const object = (depth) => {
    if (depth > maximumDepth) throw new SyntaxError("JSON input is too complex.");
    index += 1;
    whitespace();
    const keys = new Set();
    if (text[index] === "}") { index += 1; return; }
    while (index < text.length) {
      whitespace();
      const key = stringToken();
      if (keys.has(key)) throw new SyntaxError("Duplicate JSON key.");
      keys.add(key);
      whitespace();
      if (text[index] !== ":") throw new SyntaxError("Invalid JSON input.");
      index += 1;
      value(depth);
      whitespace();
      if (text[index] === "}") { index += 1; return; }
      if (text[index] !== ",") throw new SyntaxError("Invalid JSON input.");
      index += 1;
    }
    throw new SyntaxError("Invalid JSON input.");
  };
  const array = (depth) => {
    if (depth > maximumDepth) throw new SyntaxError("JSON input is too complex.");
    index += 1;
    whitespace();
    if (text[index] === "]") { index += 1; return; }
    while (index < text.length) {
      value(depth);
      whitespace();
      if (text[index] === "]") { index += 1; return; }
      if (text[index] !== ",") throw new SyntaxError("Invalid JSON input.");
      index += 1;
    }
    throw new SyntaxError("Invalid JSON input.");
  };
  whitespace();
  value(0);
  whitespace();
  if (index !== text.length) throw new SyntaxError("Invalid JSON input.");
  return JSON.parse(text);
}

function emitJson(target, value) {
  emitLine(target, JSON.stringify(value));
}

function emitLine(target, value) {
  const line = `${value}\n`;
  if (typeof target === "function") {
    target(value);
    return;
  }
  if (target && typeof target.write === "function") {
    target.write(line);
    return;
  }
  throw cliError("USERS_READINESS_INTERNAL_FAILED");
}

function isPlainObject(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cliError(code) {
  return new UserImportReadinessCliError(code);
}

const isProductionEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isProductionEntrypoint) {
  process.exitCode = await runUserImportReadinessCli();
}
