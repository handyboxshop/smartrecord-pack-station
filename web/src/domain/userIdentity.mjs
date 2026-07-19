const ASCII_VISIBLE_PATTERN = /^[\x20-\x7e]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,62}[A-Za-z0-9])?$/;
const EMAIL_LOCAL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const EMAIL_DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 64;
export const SQLITE_EMAIL_MAX_LENGTH = 320;
export const LOGIN_IDENTITY_MAX_LENGTH = 320;

const ERROR_MESSAGES = Object.freeze({
  USER_USERNAME_REQUIRED: "A username is required.",
  USER_USERNAME_INVALID: "The username is invalid.",
  USER_EMAIL_REQUIRED: "An email address is required.",
  USER_EMAIL_INVALID: "The email address is invalid.",
  USER_LOGIN_IDENTITY_INVALID: "The login identity is invalid."
});

export class UserIdentityError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code]);
    this.name = "UserIdentityError";
    this.code = code;
  }
}

export function normalizeLegacyEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeUsername(value) {
  if (typeof value !== "string") throw identityError("USER_USERNAME_REQUIRED");
  const username = value.trim();
  if (!username) throw identityError("USER_USERNAME_REQUIRED");
  if (
    username.length < USERNAME_MIN_LENGTH
    || username.length > USERNAME_MAX_LENGTH
    || !USERNAME_PATTERN.test(username)
  ) {
    throw identityError("USER_USERNAME_INVALID");
  }
  return Object.freeze({ username, usernameNormalized: username.toLowerCase() });
}

export function normalizeSqliteEmail(value) {
  if (typeof value !== "string") throw identityError("USER_EMAIL_REQUIRED");
  const email = value.trim();
  if (!email) throw identityError("USER_EMAIL_REQUIRED");
  if (
    email.length < 3
    || email.length > SQLITE_EMAIL_MAX_LENGTH
    || !ASCII_VISIBLE_PATTERN.test(email)
  ) {
    throw identityError("USER_EMAIL_INVALID");
  }

  const parts = email.split("@");
  if (parts.length !== 2) throw identityError("USER_EMAIL_INVALID");
  const [local, domain] = parts;
  const labels = domain.split(".");
  if (
    !local
    || local.length > 64
    || !EMAIL_LOCAL_PATTERN.test(local)
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !domain
    || domain.length > 255
    || labels.some((label) => !EMAIL_DOMAIN_LABEL_PATTERN.test(label))
  ) {
    throw identityError("USER_EMAIL_INVALID");
  }

  return Object.freeze({ email, emailNormalized: email.toLowerCase() });
}

export function normalizeLoginIdentity(value) {
  if (typeof value !== "string") throw identityError("USER_LOGIN_IDENTITY_INVALID");
  const identity = value.trim();
  if (
    !identity
    || identity.length > LOGIN_IDENTITY_MAX_LENGTH
    || !ASCII_VISIBLE_PATTERN.test(identity)
  ) {
    throw identityError("USER_LOGIN_IDENTITY_INVALID");
  }
  return identity.toLowerCase();
}

function identityError(code) {
  return new UserIdentityError(code);
}
