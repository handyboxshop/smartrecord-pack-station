import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeUserImportReadiness } from "../src/storage/userImportReadiness.mjs";

const HELP_TEXT = [
  "Usage: npm run db:check-users-readiness -- --users /absolute/path/users.json --config /absolute/path/app-config.json [--username-map /absolute/path/usernames.json]",
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
  try {
    const args = parseArguments(argv);
    if (args.help) {
      emitLine(output, HELP_TEXT);
      return 0;
    }
    const deps = normalizeDependencies(dependencies);
    const users = await readJsonInput(args.users, FILE_LIMITS.users, "users", deps);
    const config = await readJsonInput(args.config, FILE_LIMITS.config, "config", deps);
    const usernameAssignments = args.usernameMap
      ? await readJsonInput(args.usernameMap, FILE_LIMITS.usernameMap, "usernameMap", deps)
      : {};

    const extractedConfig = extractConfig(config);
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
    emitJson(output, { code: "USERS_READINESS_READY", report });
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
  }
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
  if (!result.users || !result.config) throw cliError("USERS_READINESS_USAGE_INVALID");
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

async function readJsonInput(filePath, maximumBytes, kind, deps) {
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
  if (kind === "usernameMap" && hasDuplicateTopLevelKeys(text)) {
    throw cliError("USERS_READINESS_USERNAME_MAP_INVALID");
  }
  try {
    return JSON.parse(text);
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

function hasDuplicateTopLevelKeys(text) {
  try {
    let index = skipWhitespace(text, 0);
    if (text[index] !== "{") return false;
    index = skipWhitespace(text, index + 1);
    const keys = new Set();
    if (text[index] === "}") return false;
    while (index < text.length) {
      const parsedKey = readJsonString(text, index);
      if (!parsedKey) return false;
      if (keys.has(parsedKey.value)) return true;
      keys.add(parsedKey.value);
      index = skipWhitespace(text, parsedKey.end);
      if (text[index] !== ":") return false;
      const valueEnd = skipJsonValue(text, skipWhitespace(text, index + 1));
      if (valueEnd < 0) return false;
      index = skipWhitespace(text, valueEnd);
      if (text[index] === "}") return false;
      if (text[index] !== ",") return false;
      index = skipWhitespace(text, index + 1);
    }
    return false;
  } catch {
    return false;
  }
}

function skipJsonValue(text, start) {
  let inString = false;
  let escaped = false;
  let objectDepth = 0;
  let arrayDepth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{") objectDepth += 1;
    else if (character === "[") arrayDepth += 1;
    else if (character === "}") {
      if (objectDepth === 0 && arrayDepth === 0) return index;
      objectDepth -= 1;
    } else if (character === "]") arrayDepth -= 1;
    else if (character === "," && objectDepth === 0 && arrayDepth === 0) return index;
  }
  return -1;
}

function readJsonString(text, start) {
  if (text[start] !== "\"") return null;
  let value = "";
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\"") return { value, end: index + 1 };
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = text[index + 1];
    const simple = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    if (Object.hasOwn(simple, escaped)) {
      value += simple[escaped];
      index += 1;
      continue;
    }
    if (escaped !== "u") return null;
    const hex = text.slice(index + 2, index + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
    value += String.fromCharCode(Number.parseInt(hex, 16));
    index += 5;
  }
  return null;
}

function skipWhitespace(text, index) {
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
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
