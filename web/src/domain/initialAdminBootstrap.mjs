import crypto from "node:crypto";
import { createPasswordCredentials as createCredentials } from "./passwordCredentials.mjs";
import {
  UserIdentityError,
  normalizeSqliteEmail,
  normalizeUsername
} from "./userIdentity.mjs";
import {
  UserRepositoryError,
  createUserRepository
} from "../storage/userRepository.mjs";

const INPUT_KEYS = new Set(["username", "email", "displayName", "password"]);
const OPTION_KEYS = new Set(["now", "randomUUID", "createPasswordCredentials"]);
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const USER_ID_PATTERN = /^USR-[A-F0-9]{32}$/;

const ERROR_MESSAGES = Object.freeze({
  BOOTSTRAP_USERNAME_INVALID: "The initial administrator username is invalid.",
  BOOTSTRAP_EMAIL_INVALID: "The initial administrator email is invalid.",
  BOOTSTRAP_DISPLAY_NAME_INVALID: "The initial administrator display name is invalid.",
  BOOTSTRAP_PASSWORD_INVALID: "The initial administrator password is invalid.",
  BOOTSTRAP_HASH_FAILED: "Initial administrator credentials could not be created.",
  BOOTSTRAP_NOT_ALLOWED: "Initial administrator bootstrap is not allowed.",
  BOOTSTRAP_IDENTITY_CONFLICT: "The initial administrator identity conflicts with reserved data.",
  BOOTSTRAP_PERSIST_FAILED: "The initial administrator could not be stored.",
  BOOTSTRAP_AUDIT_FAILED: "The initial administrator audit event could not be stored.",
  BOOTSTRAP_ACTIVITY_FAILED: "The initial administrator activity event could not be stored."
});

export class InitialAdminBootstrapError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code]);
    this.name = "InitialAdminBootstrapError";
    this.code = code;
  }
}

export function bootstrapInitialAdmin(database, input, options = {}) {
  assertPlainRecord(input, "BOOTSTRAP_PERSIST_FAILED");
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !INPUT_KEYS.has(key))) {
    throw bootstrapError("BOOTSTRAP_PERSIST_FAILED");
  }
  assertPlainRecord(options, "BOOTSTRAP_PERSIST_FAILED");
  if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !OPTION_KEYS.has(key))) {
    throw bootstrapError("BOOTSTRAP_PERSIST_FAILED");
  }

  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? crypto.randomUUID;
  const credentialFactory = options.createPasswordCredentials ?? createCredentials;
  if (typeof now !== "function" || typeof randomUUID !== "function" || typeof credentialFactory !== "function") {
    throw bootstrapError("BOOTSTRAP_PERSIST_FAILED");
  }

  let username;
  let email;
  try {
    username = normalizeUsername(input.username);
  } catch (cause) {
    if (cause instanceof UserIdentityError) throw bootstrapError("BOOTSTRAP_USERNAME_INVALID");
    throw bootstrapError("BOOTSTRAP_USERNAME_INVALID");
  }
  try {
    email = normalizeSqliteEmail(input.email);
  } catch (cause) {
    if (cause instanceof UserIdentityError) throw bootstrapError("BOOTSTRAP_EMAIL_INVALID");
    throw bootstrapError("BOOTSTRAP_EMAIL_INVALID");
  }
  const displayName = normalizeDisplayName(input.displayName);
  const password = normalizeBootstrapPassword(input.password);

  let credentials;
  try {
    credentials = credentialFactory(password);
  } catch {
    throw bootstrapError("BOOTSTRAP_HASH_FAILED");
  }
  if (
    !credentials
    || typeof credentials.passwordSalt !== "string"
    || typeof credentials.passwordHash !== "string"
  ) throw bootstrapError("BOOTSTRAP_HASH_FAILED");

  let id;
  try {
    id = `USR-${String(randomUUID()).replaceAll("-", "").toUpperCase()}`;
  } catch {
    throw bootstrapError("BOOTSTRAP_PERSIST_FAILED");
  }
  if (!USER_ID_PATTERN.test(id)) throw bootstrapError("BOOTSTRAP_PERSIST_FAILED");

  let repository;
  try {
    repository = createUserRepository(database, { now });
    return repository.createInitialUser({
      id,
      username: username.username,
      email: email.email,
      name: displayName,
      passwordSalt: credentials.passwordSalt,
      passwordHash: credentials.passwordHash
    });
  } catch (cause) {
    throw mapRepositoryFailure(cause);
  }
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") throw bootstrapError("BOOTSTRAP_DISPLAY_NAME_INVALID");
  const displayName = value.trim();
  if (!displayName || displayName.length > 200 || CONTROL_PATTERN.test(displayName)) {
    throw bootstrapError("BOOTSTRAP_DISPLAY_NAME_INVALID");
  }
  return displayName;
}

function normalizeBootstrapPassword(value) {
  if (
    typeof value !== "string"
    || value.length < 8
    || Buffer.byteLength(value, "utf8") > 1024
    || CONTROL_PATTERN.test(value)
    || value !== value.trim()
  ) throw bootstrapError("BOOTSTRAP_PASSWORD_INVALID");
  return value;
}

function mapRepositoryFailure(cause) {
  if (!(cause instanceof UserRepositoryError)) return bootstrapError("BOOTSTRAP_PERSIST_FAILED");
  if (cause.code === "USER_BOOTSTRAP_NOT_ALLOWED") return bootstrapError("BOOTSTRAP_NOT_ALLOWED");
  if (["USER_USERNAME_EXISTS", "USER_EMAIL_EXISTS", "USER_IDENTITY_CONFLICT", "USER_ID_EXISTS"].includes(cause.code)) {
    return bootstrapError("BOOTSTRAP_IDENTITY_CONFLICT");
  }
  if (cause.code.startsWith("USER_AUDIT_")) return bootstrapError("BOOTSTRAP_AUDIT_FAILED");
  if (cause.code.startsWith("USER_ACTIVITY_")) return bootstrapError("BOOTSTRAP_ACTIVITY_FAILED");
  return bootstrapError("BOOTSTRAP_PERSIST_FAILED");
}

function assertPlainRecord(value, code) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw bootstrapError(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw bootstrapError(code);
}

function bootstrapError(code) {
  return new InitialAdminBootstrapError(code);
}
