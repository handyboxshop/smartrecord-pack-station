import crypto from "node:crypto";

export const PBKDF2_DIGEST = "sha256";
export const PBKDF2_ITERATIONS = 120000;
export const PASSWORD_SALT_BYTES = 12;
export const PASSWORD_KEY_BYTES = 32;

const MAX_ITERATIONS = 10_000_000;
const SALT_PATTERN = /^[\x20-\x7e]{1,512}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class PasswordCredentialError extends Error {
  constructor(code) {
    super(code === "PASSWORD_CREDENTIAL_HASH_FAILED"
      ? "Password credentials could not be created."
      : "Password credential input is invalid.");
    this.name = "PasswordCredentialError";
    this.code = code;
  }
}

export function createPasswordCredentials(password, options = {}) {
  if (typeof password !== "string") throw credentialError("PASSWORD_CREDENTIAL_INPUT_INVALID");
  const { iterations, randomBytes } = normalizeOptions(options, { throwing: true });
  try {
    const saltBytes = randomBytes(PASSWORD_SALT_BYTES);
    if (!Buffer.isBuffer(saltBytes) || saltBytes.length !== PASSWORD_SALT_BYTES) {
      throw new Error("invalid random bytes");
    }
    const passwordSalt = saltBytes.toString("hex");
    const passwordHash = crypto.pbkdf2Sync(
      password,
      passwordSalt,
      iterations,
      PASSWORD_KEY_BYTES,
      PBKDF2_DIGEST
    ).toString("hex");
    return { passwordSalt, passwordHash };
  } catch {
    throw credentialError("PASSWORD_CREDENTIAL_HASH_FAILED");
  }
}

export function verifyPasswordCredentials(password, credentials, options = {}) {
  if (typeof password !== "string" || !isPlainRecord(credentials)) return false;
  const normalizedOptions = normalizeOptions(options, { throwing: false });
  if (!normalizedOptions) return false;
  if (
    typeof credentials.passwordSalt !== "string"
    || typeof credentials.passwordHash !== "string"
    || !SALT_PATTERN.test(credentials.passwordSalt)
    || !HASH_PATTERN.test(credentials.passwordHash)
  ) return false;

  try {
    const actual = crypto.pbkdf2Sync(
      password,
      credentials.passwordSalt,
      normalizedOptions.iterations,
      PASSWORD_KEY_BYTES,
      PBKDF2_DIGEST
    );
    const expected = Buffer.from(credentials.passwordHash, "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function normalizeOptions(options, { throwing }) {
  const allowedKeys = throwing ? ["iterations", "randomBytes"] : ["iterations"];
  if (!isPlainRecord(options) || Reflect.ownKeys(options).some((key) => !allowedKeys.includes(key))) {
    if (throwing) throw credentialError("PASSWORD_CREDENTIAL_INPUT_INVALID");
    return null;
  }
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  const randomBytes = options.randomBytes ?? crypto.randomBytes;
  if (
    !Number.isSafeInteger(iterations)
    || iterations < 1
    || iterations > MAX_ITERATIONS
    || typeof randomBytes !== "function"
  ) {
    if (throwing) throw credentialError("PASSWORD_CREDENTIAL_INPUT_INVALID");
    return null;
  }
  return { iterations, randomBytes };
}

function isPlainRecord(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function credentialError(code) {
  return new PasswordCredentialError(code);
}
