import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { closeSqliteDatabase, openSqliteDatabase } from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import { sourceManifestSha256 } from "../scripts/check-user-import-readiness.mjs";
import { runUserLegacyBackfillCli } from "../scripts/backfill-legacy-usernames.mjs";

const user = { id: "USR-ONE", email: "one@example.test", name: "One User", roleId: "packer", active: true, passwordSalt: "synthetic-salt", passwordHash: "a".repeat(64) };
const config = { auth: { modules: [{ id: "pack", label: "Pack", section: "Ops", viewPermission: "pack:use", editPermission: "pack:use" }], roles: [{ id: "packer", label: "Packer", modulePermissions: [{ moduleId: "pack", canView: true, canEdit: true }] }] } };

async function fixture(t, { version = 5 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "legacy-backfill-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { users: path.join(directory, "users.json"), config: path.join(directory, "config.json"), map: path.join(directory, "usernames.json"), database: path.join(directory, "users.sqlite") };
  const bytes = [Buffer.from(JSON.stringify([user])), Buffer.from(JSON.stringify(config)), Buffer.from(JSON.stringify({ "USR-ONE": "one.user" }))];
  await Promise.all([writeFile(paths.users, bytes[0], { mode: 0o600 }), writeFile(paths.config, bytes[1], { mode: 0o600 }), writeFile(paths.map, bytes[2], { mode: 0o600 })]);
  const db = await openSqliteDatabase(paths.database);
  await runSqliteMigrations(db, { maximumVersion: 4 });
  db.prepare(`INSERT INTO main.users(user_sequence,id,email,name,role_id,role_name,employee_name,employee_id,active,password_salt,password_hash,created_at,updated_at,deleted_at)
    VALUES(1,?,?,?,?,NULL,NULL,NULL,1,?,?,?, ?,NULL)`).run(user.id, user.email, user.name, user.roleId, user.passwordSalt, user.passwordHash, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO main.user_module_permissions VALUES(?,0,'pack',1,1)").run(user.id);
  if (version === 5) await runSqliteMigrations(db);
  closeSqliteDatabase(db);
  return { paths, manifest: sourceManifestSha256(bytes) };
}
function args(data, manifest = data.manifest) { return ["--users", data.paths.users, "--config", data.paths.config, "--username-map", data.paths.map, "--database", data.paths.database, "--expected-manifest-sha256", manifest]; }
async function run(argv, dependencies = {}) {
  const stdout = []; const stderr = [];
  const code = await runUserLegacyBackfillCli(argv, { ...dependencies, output: (line) => stdout.push(JSON.parse(line)), errorOutput: (line) => stderr.push(JSON.parse(line)) });
  return { code, stdout, stderr, payload: stdout[0] ?? stderr[0] };
}

test("CLI backfills, reopens, verifies, and emits exactly one aggregate JSON line", async (t) => {
  const data = await fixture(t); const result = await run(args(data));
  assert.equal(result.code, 0); assert.equal(result.stdout.length, 1); assert.equal(result.stderr.length, 0);
  assert.deepEqual(Object.keys(result.payload), ["ok", "status", "committed", "userCount", "requiredBackfillCount", "backfilledCount", "verifiedUserCount", "action"]);
  assert.deepEqual(result.payload, { ok: true, status: "backfilled", committed: true, userCount: 1, requiredBackfillCount: 1, backfilledCount: 1, verifiedUserCount: 1, action: "do_not_retry_normal_backfill" });
  const db = await openSqliteDatabase(data.paths.database); assert.equal(db.prepare("SELECT username FROM main.users").get().username, "one.user"); closeSqliteDatabase(db);
});

test("already-complete is exit 0 and performs no backfill write", async (t) => {
  const data = await fixture(t); const db = await openSqliteDatabase(data.paths.database);
  db.prepare("UPDATE main.users SET username='one.user'").run(); closeSqliteDatabase(db);
  const result = await run(args(data));
  assert.equal(result.code, 0); assert.equal(result.payload.status, "already-complete"); assert.equal(result.payload.committed, false); assert.equal(result.payload.backfilledCount, 0);
});

test("exact argument allowlist rejects missing, duplicate, combined, relative, and unknown forms", async () => {
  for (const argv of [[], ["--users=x"], ["--users", "relative", "--config", "/x", "--username-map", "/y", "--database", "/z", "--expected-manifest-sha256", "a".repeat(64)], ["--unknown", "/x", "--config", "/x", "--username-map", "/y", "--database", "/z", "--expected-manifest-sha256", "a".repeat(64)]]) {
    const result = await run(argv); assert.equal(result.code, 2); assert.deepEqual(Object.keys(result.payload), ["ok", "code", "committed", "action"]); assert.equal(result.payload.code, "USERS_BACKFILL_USAGE_INVALID");
  }
});

test("stale manifest, duplicate JSON keys, and schema v4 map to exact failure classes", async (t) => {
  const stale = await fixture(t); const staleResult = await run(args(stale, "0".repeat(64)));
  assert.equal(staleResult.code, 3); assert.equal(staleResult.payload.code, "USERS_BACKFILL_SOURCE_MANIFEST_MISMATCH");
  const duplicate = await fixture(t); await writeFile(duplicate.paths.map, '{"USR-ONE":"one.user","USR-ONE":"two.user"}');
  const duplicateResult = await run(args(duplicate)); assert.equal(duplicateResult.code, 3); assert.equal(duplicateResult.payload.code, "USERS_BACKFILL_USERNAME_MAP_INVALID");
  const v4 = await fixture(t, { version: 4 }); const v4Result = await run(args(v4));
  assert.equal(v4Result.code, 4); assert.equal(v4Result.payload.code, "USERS_BACKFILL_SCHEMA_REQUIRED");
});

test("unsafe database mode and changed source identity fail before mutation", async (t) => {
  const unsafe = await fixture(t); await chmod(unsafe.paths.database, 0o666);
  const unsafeResult = await run(args(unsafe)); assert.equal(unsafeResult.code, 4); assert.equal(unsafeResult.payload.code, "USERS_BACKFILL_DATABASE_POLICY_FAILED");

  const unsafeSource = await fixture(t); await chmod(unsafeSource.paths.users, 0o666);
  const unsafeSourceResult = await run(args(unsafeSource));
  assert.equal(unsafeSourceResult.code, 3); assert.equal(unsafeSourceResult.payload.code, "USERS_BACKFILL_SOURCE_READ_FAILED");

  const changed = await fixture(t); let checks = 0;
  const changedResult = await run(args(changed), { async lstat(filePath) { const value = await lstat(filePath); if (filePath === changed.paths.users && ++checks === 2) return { ...value, ino: value.ino + 1 }; return value; } });
  assert.equal(changedResult.code, 3); assert.equal(changedResult.payload.code, "USERS_BACKFILL_SOURCE_READ_FAILED");
});

test("retained Buffers are wiped and handles close on every failure", async (t) => {
  const data = await fixture(t); const retained = []; let closed = 0;
  const result = await run(args(data, "0".repeat(64)), { async open(filePath, flags) { const handle = await open(filePath, flags); return { stat: (...values) => handle.stat(...values), async readFile(...values) { const bytes = await handle.readFile(...values); retained.push(bytes); return bytes; }, async close() { closed += 1; return handle.close(); } }; } });
  assert.equal(result.code, 3); assert.equal(closed, 3); assert.ok(retained.every((bytes) => bytes.every((byte) => byte === 0)));
});

test("transaction, rollback, ambiguous commit, and post-check failures use exact exit codes", async (t) => {
  const transaction = await fixture(t); const txResult = await run(args(transaction), { backfillLegacyUsernames() { const error = new Error("raw"); error.code = "USERS_BACKFILL_TRANSACTION_FAILED"; throw error; } });
  assert.equal(txResult.code, 6); assert.equal(txResult.payload.code, "USERS_BACKFILL_TRANSACTION_FAILED");
  assert.deepEqual(txResult.payload, { ok: false, code: "USERS_BACKFILL_TRANSACTION_FAILED", committed: false, action: "correct_input_and_retry" });
  assert.equal(txResult.stdout.length, 0); assert.equal(txResult.stderr.length, 1);
  const rollback = await fixture(t); const rollbackResult = await run(args(rollback), { backfillLegacyUsernames() { const error = new Error("raw"); error.code = "USERS_BACKFILL_ROLLBACK_FAILED"; throw error; } });
  assert.equal(rollbackResult.code, 7); assert.equal(rollbackResult.payload.code, "USERS_BACKFILL_ROLLBACK_FAILED");
  assert.deepEqual(rollbackResult.payload, { ok: false, code: "USERS_BACKFILL_ROLLBACK_FAILED", committed: false, action: "verify_before_retry" });
  assert.equal(rollbackResult.stdout.length, 0); assert.equal(rollbackResult.stderr.length, 1);
  const ambiguous = await fixture(t); const ambiguousResult = await run(args(ambiguous), { backfillLegacyUsernames() { const error = new Error("raw"); error.code = "USERS_BACKFILL_COMMIT_OUTCOME_UNKNOWN"; throw error; } });
  assert.equal(ambiguousResult.code, 7); assert.equal(ambiguousResult.payload.action, "verify_before_retry");
  assert.equal(ambiguousResult.payload.committed, null);
  assert.deepEqual(ambiguousResult.payload, { ok: false, code: "USERS_BACKFILL_COMMIT_OUTCOME_UNKNOWN", committed: null, action: "verify_before_retry" });
  assert.equal(ambiguousResult.stdout.length, 0); assert.equal(ambiguousResult.stderr.length, 1);
  const verify = await fixture(t); const verifyResult = await run(args(verify), { verifyUserLegacyBackfill() { return { status: "mismatch" }; } });
  assert.equal(verifyResult.code, 7); assert.equal(verifyResult.payload.code, "USERS_BACKFILL_POST_COMMIT_VERIFICATION_MISMATCH"); assert.equal(verifyResult.payload.committed, true);
  assert.equal(verifyResult.payload.action, "do_not_retry_normal_backfill");
  assert.equal(verifyResult.stdout.length, 0); assert.equal(verifyResult.stderr.length, 1);
});

test("SIGINT and SIGTERM share cleanup and exact exit handling", async (t) => {
  for (const [signal, expected] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const data = await fixture(t); const source = new EventEmitter();
    const pending = run(args(data), { signalSource: source }); source.emit(signal);
    const result = await pending; assert.equal(result.code, expected); assert.equal(result.payload.code, "USERS_BACKFILL_INTERRUPTED"); assert.equal(result.stdout.length + result.stderr.length, 1);
  }
});
