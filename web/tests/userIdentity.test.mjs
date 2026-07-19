import assert from "node:assert/strict";
import test from "node:test";
import {
  LOGIN_IDENTITY_MAX_LENGTH,
  SQLITE_EMAIL_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  UserIdentityError,
  normalizeLegacyEmail,
  normalizeLoginIdentity,
  normalizeSqliteEmail,
  normalizeUsername
} from "../src/domain/userIdentity.mjs";

test("exports the approved identity boundaries and preserves legacy JSON normalization", () => {
  assert.equal(USERNAME_MIN_LENGTH, 3);
  assert.equal(USERNAME_MAX_LENGTH, 64);
  assert.equal(SQLITE_EMAIL_MAX_LENGTH, 320);
  assert.equal(LOGIN_IDENTITY_MAX_LENGTH, 320);
  for (const value of [null, undefined, 42, false, "  Mixed@Example.Local  "]) {
    assert.equal(normalizeLegacyEmail(value), String(value ?? "").trim().toLowerCase());
  }
});

test("username normalization preserves trimmed spelling and applies ASCII lowercase", () => {
  const input = "  Initial.Owner-_1  ";
  const result = normalizeUsername(input);
  assert.deepEqual(result, {
    username: "Initial.Owner-_1",
    usernameNormalized: "initial.owner-_1"
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(input, "  Initial.Owner-_1  ");
});

test("username rejects missing, boundary, separator, control, Unicode, and endpoint violations privately", () => {
  const invalid = [null, "", "ab", "a".repeat(65), ".abc", "abc-", "a b", "a@b", "a/b", "a\\b", "a:b", "ผู้ใช้", "ab\0c", "ab\nc"];
  for (const value of invalid) {
    assert.throws(
      () => normalizeUsername(value),
      (error) => {
        assert.equal(error instanceof UserIdentityError, true);
        assert.equal(["USER_USERNAME_REQUIRED", "USER_USERNAME_INVALID"].includes(error.code), true);
        const serialized = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
        if (typeof value === "string" && value.length > 2) assert.equal(serialized.includes(value), false);
        return true;
      }
    );
  }
  assert.equal(normalizeUsername("abc").username, "abc");
  assert.equal(normalizeUsername("A".repeat(64)).usernameNormalized, "a".repeat(64));
});

test("strict SQLite email accepts canonical ASCII and rejects malformed domains and local parts", () => {
  assert.deepEqual(normalizeSqliteEmail(" Owner.Tag+1@Example.Local "), {
    email: "Owner.Tag+1@Example.Local",
    emailNormalized: "owner.tag+1@example.local"
  });
  for (const value of [null, "", "a@", "@b", "a@@b", ".a@b", "a.@b", "a..b@c", "a@-b", "a@b-", "a@b..c", "a b@c", "ผู้ใช้@example.test", "a\0b@example.test"]) {
    assert.throws(
      () => normalizeSqliteEmail(value),
      (error) => error instanceof UserIdentityError
        && ["USER_EMAIL_REQUIRED", "USER_EMAIL_INVALID"].includes(error.code)
    );
  }
});

test("login identity is bounded ASCII lowercase and errors expose no supplied identity", () => {
  assert.equal(normalizeLoginIdentity("  Initial.Owner  "), "initial.owner");
  assert.equal(normalizeLoginIdentity(" Owner@Example.Test "), "owner@example.test");
  for (const value of [null, "", "ผู้ใช้", "a\0b", "a\nb", "a".repeat(321)]) {
    assert.throws(
      () => normalizeLoginIdentity(value),
      (error) => error instanceof UserIdentityError && error.code === "USER_LOGIN_IDENTITY_INVALID"
    );
  }
});
