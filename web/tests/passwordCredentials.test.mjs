import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  PASSWORD_KEY_BYTES,
  PASSWORD_SALT_BYTES,
  PBKDF2_DIGEST,
  PBKDF2_ITERATIONS,
  PasswordCredentialError,
  createPasswordCredentials,
  verifyPasswordCredentials
} from "../src/domain/passwordCredentials.mjs";

test("exports the approved PBKDF2 contract and matches a Unicode known vector", () => {
  assert.equal(PBKDF2_DIGEST, "sha256");
  assert.equal(PBKDF2_ITERATIONS, 120000);
  assert.equal(PASSWORD_SALT_BYTES, 12);
  assert.equal(PASSWORD_KEY_BYTES, 32);
  const password = "pässword🔐";
  const credentials = createPasswordCredentials(password, {
    randomBytes: () => Buffer.from("000102030405060708090a0b", "hex")
  });
  assert.deepEqual(credentials, {
    passwordSalt: "000102030405060708090a0b",
    passwordHash: "623f540307d9829fdfd97b5ed1315a40b29309d52e4711995bd1b39bd0084f33"
  });
  assert.equal(verifyPasswordCredentials(password, credentials), true);
  assert.equal(verifyPasswordCredentials(`${password}x`, credentials), false);
});

test("custom iterations remain compatible and callers are not mutated", () => {
  const options = Object.freeze({ iterations: 2, randomBytes: () => Buffer.alloc(12, 7) });
  const credentials = createPasswordCredentials(" exact whitespace ", options);
  assert.equal(verifyPasswordCredentials(" exact whitespace ", credentials, { iterations: 2 }), true);
  assert.equal(verifyPasswordCredentials("exact whitespace", credentials, { iterations: 2 }), false);
  assert.equal(options.iterations, 2);
});

test("verification preserves bounded printable legacy JSON salts", () => {
  const credentials = {
    passwordSalt: "test-salt-admin",
    passwordHash: "bde25500d21f5b4e8193c81adc619bd6f6afb06085b967613de452705d5cf9cd"
  };
  assert.equal(verifyPasswordCredentials("RuntimeAdminPassword!", credentials), true);
});

test("malformed credential metadata and verifier options return false", () => {
  for (const credentials of [null, {}, { passwordSalt: "x", passwordHash: "y" }, { passwordSalt: "00".repeat(12), passwordHash: "g".repeat(64) }]) {
    assert.equal(verifyPasswordCredentials("password", credentials), false);
  }
  assert.equal(verifyPasswordCredentials("password", {
    passwordSalt: "00".repeat(12),
    passwordHash: "0".repeat(64)
  }, { iterations: 0 }), false);
  assert.equal(verifyPasswordCredentials("password", {
    passwordSalt: "00".repeat(12),
    passwordHash: "0".repeat(64)
  }, { randomBytes: () => Buffer.alloc(12) }), false);
});

test("creation failures are stable and sensitive values never enter public error surfaces", () => {
  const secret = "SENSITIVE_PASSWORD_MARKER";
  for (const action of [
    () => createPasswordCredentials(null),
    () => createPasswordCredentials(secret, { iterations: 0 }),
    () => createPasswordCredentials(secret, { randomBytes: () => { throw new Error(secret); } })
  ]) {
    assert.throws(action, (error) => {
      assert.equal(error instanceof PasswordCredentialError, true);
      const surface = `${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${inspect(error)}`;
      assert.equal(surface.includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
