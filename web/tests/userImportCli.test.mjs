import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { link, lstat, mkdtemp, open, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { closeSqliteDatabase, openSqliteDatabase } from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import { runUserImportReadinessCli, parseUserImportJsonBytes, sourceManifestSha256 as readinessManifest } from "../scripts/check-user-import-readiness.mjs";
import { runUserImportCli, sourceManifestSha256 } from "../scripts/import-users.mjs";

function config() {
  return { auth: {
    modules: [{ id: "pack", label: "Pack", section: "Ops", viewPermission: "pack:use", editPermission: "pack:use" }],
    roles: [{ id: "packer", label: "Packer", modulePermissions: [{ moduleId: "pack", canView: true, canEdit: true }] }]
  } };
}
function users(overrides = {}) {
  return [{ id: "USR-ONE", username: "one.user", email: "one@example.test", name: "One User", roleId: "packer", active: true, passwordSalt: "synthetic-salt", passwordHash: "a".repeat(64), ...overrides }];
}

async function fixture(t, { usersBytes, configBytes, mapBytes, schemaVersion = 5 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "user-import-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    users: path.join(directory, "users.json"), config: path.join(directory, "config.json"),
    map: path.join(directory, "map.json"), database: path.join(directory, "users.sqlite")
  };
  const bytes = [
    usersBytes ?? Buffer.from(JSON.stringify(users())),
    configBytes ?? Buffer.from(JSON.stringify(config())),
    mapBytes ?? Buffer.from("{}")
  ];
  await Promise.all([writeFile(paths.users, bytes[0]), writeFile(paths.config, bytes[1]), writeFile(paths.map, bytes[2])]);
  const database = await openSqliteDatabase(paths.database);
  await runSqliteMigrations(database, { maximumVersion: Math.min(schemaVersion, 5) });
  if (schemaVersion > 5) database.exec(`PRAGMA user_version=${schemaVersion}`);
  closeSqliteDatabase(database);
  return { directory, paths, bytes, manifest: sourceManifestSha256(bytes) };
}

function args(data, overrides = {}) {
  return [
    "--users", overrides.users ?? data.paths.users,
    "--config", overrides.config ?? data.paths.config,
    "--username-map", overrides.map ?? data.paths.map,
    "--database", overrides.database ?? data.paths.database,
    "--expected-manifest-sha256", overrides.manifest ?? data.manifest
  ];
}
async function run(argv, options = {}) {
  const stdout = [];
  const stderr = [];
  const code = await runUserImportCli({ argv, output: (line) => stdout.push(line), errorOutput: (line) => stderr.push(line), ...options });
  return { code, stdout, stderr, payload: JSON.parse((stdout[0] ?? stderr[0]) || "null") };
}

test("readiness and import use the exact same domain-separated manifest", async (t) => {
  const data = await fixture(t);
  assert.equal(sourceManifestSha256(data.bytes), readinessManifest(data.bytes));
  const stdout = [];
  const code = await runUserImportReadinessCli({
    argv: ["--users", data.paths.users, "--config", data.paths.config, "--username-map", data.paths.map],
    output: (line) => stdout.push(line), errorOutput() {}
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout[0]).sourceManifestSha256, data.manifest);
});

test("shared JSON parser rejects decoded duplicate keys at every nesting shape and escape equivalence", () => {
  const invalid = [
    "{\"a\":1,\"a\":2}",
    "{\"outer\":{\"a\":1,\"\\u0061\":2}}",
    "[{\"a\":1,\"a\":2}]",
    "{\"array\":[{\"deep\":{\"x\":1,\"\\u0078\":2}}]}",
    "{\"value\":\"comma,:, brace } and \\\"quote\\\"\",\"value\":2}"
  ];
  for (const text of invalid) assert.throws(() => parseUserImportJsonBytes(Buffer.from(text)), SyntaxError);
  assert.deepEqual(parseUserImportJsonBytes(Buffer.from("[{\"text\":\"[,]{}:\\\"\",\"nested\":{\"ok\":true}}]")), [{ text: "[,]{}:\"", nested: { ok: true } }]);
  assert.throws(() => parseUserImportJsonBytes(Buffer.from("[[[]]]"), { maximumDepth: 2 }), SyntaxError);
});

test("both CLIs categorize duplicate Users, config, and map JSON consistently", async (t) => {
  const cases = [
    { key: "usersBytes", bytes: Buffer.from("[{\"id\":1,\"\\u0069d\":2}]"), readiness: "USERS_READINESS_SOURCE_JSON_INVALID", imported: "USERS_IMPORT_SOURCE_JSON_INVALID" },
    { key: "configBytes", bytes: Buffer.from("{\"auth\":{\"roles\":[],\"r\\u006fles\":[],\"modules\":[]}}"), readiness: "USERS_READINESS_CONFIG_INVALID", imported: "USERS_IMPORT_CONFIG_INVALID" },
    { key: "mapBytes", bytes: Buffer.from("{\"USR-ONE\":\"a\",\"USR-\\u004fNE\":\"b\"}"), readiness: "USERS_READINESS_USERNAME_MAP_INVALID", imported: "USERS_IMPORT_USERNAME_MAP_INVALID" }
  ];
  for (const entry of cases) {
    const data = await fixture(t, { [entry.key]: entry.bytes });
    const readinessErrors = [];
    const readinessCode = await runUserImportReadinessCli({
      argv: ["--users", data.paths.users, "--config", data.paths.config, "--username-map", data.paths.map],
      output() {}, errorOutput: (line) => readinessErrors.push(line)
    });
    assert.equal(readinessCode, 1);
    assert.equal(JSON.parse(readinessErrors[0]).code, entry.readiness);
    const imported = await run(args(data));
    assert.equal(imported.code, 3);
    assert.equal(imported.payload.code, entry.imported);
    assert.equal(imported.stderr.length, 1);
  }
});

test("real CLI commits, closes, reopens, verifies, and emits one safe line", async (t) => {
  const data = await fixture(t);
  const result = await run(args(data));
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 1);
  assert.equal(result.stderr.length, 0);
  assert.deepEqual({ ...result.payload, importedAt: "timestamp" }, {
    ok: true, status: "committed", committed: true, importedUserCount: 1,
    importedPermissionCount: 1, importedAt: "timestamp", action: "do_not_retry_normal_import"
  });
  assert.doesNotMatch(result.stdout[0], /users\.json|users\.sqlite|synthetic-salt|USR-ONE|SELECT|INSERT/);
  const database = await openSqliteDatabase(data.paths.database);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM main.users").get().count, 1);
  closeSqliteDatabase(database);
});

test("usage and manifest failures have exact exit codes and retry classification", async (t) => {
  const data = await fixture(t);
  const usage = await run([]);
  assert.equal(usage.code, 2);
  assert.equal(usage.payload.code, "USERS_IMPORT_USAGE_INVALID");
  const manifest = await run(args(data, { manifest: "0".repeat(64) }));
  assert.equal(manifest.code, 3);
  assert.equal(manifest.payload.code, "USERS_IMPORT_SOURCE_MANIFEST_MISMATCH");
  assert.equal(manifest.payload.action, "correct_input_and_retry");
  for (const invalid of [
    ["--unknown", "/tmp/value"],
    ["--users=/tmp/users.json"],
    ["--users", "/tmp/a", "--users", "/tmp/b"]
  ]) assert.equal((await run(invalid)).code, 2);
});

test("fatal UTF-8, symlinks, and hard links are rejected before database opening", async (t) => {
  const invalidUtf8 = await fixture(t, { usersBytes: Buffer.from([0xc3, 0x28]) });
  assert.equal((await run(args(invalidUtf8))).code, 3);
  const data = await fixture(t);
  const symbolic = path.join(data.directory, "symbolic-users.json");
  await symlink(data.paths.users, symbolic);
  const symbolicResult = await run(args(data, { users: symbolic }));
  assert.equal(symbolicResult.code, 3);
  const hard = path.join(data.directory, "hard-users.json");
  await link(data.paths.users, hard);
  const hardResult = await run(args(data));
  assert.equal(hardResult.code, 3);
});

test("database symlinks, hard links, unsafe parents, and wrong schemas map to exit 4", async (t) => {
  const symlinkData = await fixture(t);
  const symbolic = path.join(symlinkData.directory, "symbolic.sqlite");
  await symlink(symlinkData.paths.database, symbolic);
  assert.equal((await run(args(symlinkData, { database: symbolic }))).code, 4);

  const hardData = await fixture(t);
  const hard = path.join(hardData.directory, "hard.sqlite");
  await link(hardData.paths.database, hard);
  assert.equal((await run(args(hardData))).code, 4);

  const unsafeData = await fixture(t);
  await chmod(unsafeData.directory, 0o777);
  assert.equal((await run(args(unsafeData))).code, 4);
  await chmod(unsafeData.directory, 0o700);

  for (const version of [4, 6]) {
    const wrong = await fixture(t, { schemaVersion: version });
    const result = await run(args(wrong));
    assert.equal(result.code, 4);
    assert.equal(result.payload.code, "USERS_IMPORT_SCHEMA_REQUIRED");
  }
});

test("database owner and mode policy is reapplied before every import boundary", async (t) => {
  for (const mode of [0o660, 0o666]) {
    const data = await fixture(t);
    await chmod(data.paths.database, mode);
    try { await assertPolicyRejected(data); }
    finally { await chmod(data.paths.database, 0o600); }
  }

  for (const scenario of [
    { target: "parent", property: "mode", transform: (value) => value | 0o020 },
    { target: "database", property: "mode", transform: (value) => value | 0o002 },
    { target: "database", property: "uid", transform: (value) => value + 1 },
    { target: "parent", property: "uid", transform: (value) => value + 1 }
  ]) {
    const data = await fixture(t);
    const selectedPath = scenario.target === "database" ? data.paths.database : data.directory;
    let selectedStats = 0;
    await assertPolicyRejected(data, {
      async lstat(filePath) {
        const value = await lstat(filePath);
        if (filePath === selectedPath && ++selectedStats === 2) {
          return changedMetadata(value, scenario.property, scenario.transform(value[scenario.property]));
        }
        return value;
      }
    });
  }
});

test("planning, transaction, and outcome-unknown dependency failures map to exits 5, 6, and 7", async (t) => {
  const data = await fixture(t);
  const planning = await run(args(data), { dependencies: {
    createUserImportPlan() { const error = new Error("raw"); error.code = "USERS_IMPORT_CREDENTIAL_FAILED"; throw error; }
  } });
  assert.equal(planning.code, 5);
  assert.equal(planning.payload.code, "USERS_IMPORT_CREDENTIAL_FAILED");

  const transaction = await run(args(data), { dependencies: {
    importUsers() { const error = new Error("raw SQLite"); error.code = "USERS_IMPORT_TRANSACTION_FAILED"; throw error; }
  } });
  assert.equal(transaction.code, 6);
  assert.equal(transaction.payload.action, "correct_input_and_retry");

  const uncertain = await run(args(data), { dependencies: {
    importUsers() { const error = new Error("raw commit"); error.code = "USERS_IMPORT_COMMIT_OUTCOME_UNKNOWN"; Object.defineProperty(error, "transactionState", { value: "outcome-unknown" }); throw error; }
  } });
  assert.equal(uncertain.code, 7);
  assert.equal(uncertain.payload.action, "verify_before_retry");
  assert.equal(uncertain.payload.committed, false);
});

test("committed close, reopen, post-verification, and verification-close failures use exit 7", async (t) => {
  const closeData = await fixture(t);
  let closes = 0;
  const closeFailure = await run(args(closeData), { dependencies: {
    closeSqliteDatabase(database) { closes += 1; if (closes === 1) throw new Error("raw close"); return closeSqliteDatabase(database); }
  } });
  assert.equal(closeFailure.code, 7);
  assert.equal(closeFailure.payload.code, "USERS_IMPORT_COMMITTED_CLOSE_FAILED");
  assert.equal(closeFailure.payload.action, "do_not_retry_normal_import");

  const reopenData = await fixture(t);
  let opens = 0;
  const reopenFailure = await run(args(reopenData), { dependencies: {
    async openSqliteDatabase(databasePath) { opens += 1; if (opens === 2) throw new Error("raw reopen"); return openSqliteDatabase(databasePath); }
  } });
  assert.equal(reopenFailure.code, 7);
  assert.equal(reopenFailure.payload.code, "USERS_IMPORT_POST_COMMIT_VERIFICATION_MISMATCH");

  const verifyData = await fixture(t);
  const verificationFailure = await run(args(verifyData), { dependencies: {
    verifyUserImport() { return { ok: false, status: "mismatch" }; }
  } });
  assert.equal(verificationFailure.code, 7);
  assert.equal(verificationFailure.payload.code, "USERS_IMPORT_POST_COMMIT_VERIFICATION_MISMATCH");

  const verificationCloseData = await fixture(t);
  let verificationCloseCalls = 0;
  const verificationCloseFailure = await run(args(verificationCloseData), { dependencies: {
    closeSqliteDatabase(database) {
      verificationCloseCalls += 1;
      if (verificationCloseCalls === 2) throw new Error("raw verification close");
      return closeSqliteDatabase(database);
    }
  } });
  assert.equal(verificationCloseFailure.code, 7);
  assert.equal(verificationCloseFailure.payload.code, "USERS_IMPORT_COMMITTED_CLOSE_FAILED");
});

test("source descriptors close and retained byte buffers are overwritten on failure", async (t) => {
  const data = await fixture(t);
  const retained = [];
  let closed = 0;
  const result = await run(args(data, { manifest: "0".repeat(64) }), { dependencies: {
    async open(filePath, flags) {
      const handle = await open(filePath, flags);
      return {
        stat: (...values) => handle.stat(...values),
        async readFile(...values) { const bytes = await handle.readFile(...values); retained.push(bytes); return bytes; },
        async close() { closed += 1; return handle.close(); }
      };
    }
  } });
  assert.equal(result.code, 3);
  assert.equal(closed, 3);
  assert.ok(retained.every((bytes) => bytes.every((byte) => byte === 0)));
});

test("source and database path identity replacement is rejected at revalidation", async (t) => {
  const sourceData = await fixture(t);
  let usersStats = 0;
  const sourceResult = await run(args(sourceData), { dependencies: {
    async lstat(filePath) {
      const value = await lstat(filePath);
      if (filePath === sourceData.paths.users && ++usersStats === 2) {
        return changedIdentity(value);
      }
      return value;
    }
  } });
  assert.equal(sourceResult.code, 3);
  assert.equal(sourceResult.payload.code, "USERS_IMPORT_SOURCE_READ_FAILED");

  const databaseData = await fixture(t);
  let databaseStats = 0;
  const databaseResult = await run(args(databaseData), { dependencies: {
    async lstat(filePath) {
      const value = await lstat(filePath);
      if (filePath === databaseData.paths.database && ++databaseStats === 2) {
        return changedIdentity(value);
      }
      return value;
    }
  } });
  assert.equal(databaseResult.code, 4);
  assert.equal(databaseResult.payload.code, "USERS_IMPORT_SCHEMA_REQUIRED");
});

test("SIGINT and SIGTERM use one cleanup path, exact exit codes, and one output line", async (t) => {
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const data = await fixture(t);
    const signals = new EventEmitter();
    const promise = run(args(data), { signalSource: signals });
    signals.emit(signal);
    const result = await promise;
    assert.equal(result.code, exitCode);
    assert.equal(result.stderr.length, 1);
    assert.equal(result.stdout.length, 0);
    assert.equal(result.payload.code, "USERS_IMPORT_INTERRUPTED");
    assert.equal(result.payload.action, "correct_input_and_retry");
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  }
});

test("unknown dependency and raw error codes never pass through public output", async (t) => {
  const data = await fixture(t);
  const marker = "SECRET-RAW-CODE-MARKER";
  const result = await run(args(data), { dependencies: {
    importUsers() { const error = new Error(marker); error.code = marker; throw error; }
  } });
  assert.equal(result.payload.code, "USERS_IMPORT_TRANSACTION_FAILED");
  assert.doesNotMatch(result.stderr[0], /SECRET|RAW-CODE|MARKER|sqlite|SELECT|USR-ONE/i);
  assert.equal(result.stderr.length, 1);
});

function changedIdentity(stat) {
  return new Proxy(stat, {
    get(target, property, receiver) {
      if (property === "ino") return Number(target.ino) + 1;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function changedMetadata(stat, property, replacement) {
  return new Proxy(stat, {
    get(target, key, receiver) {
      if (key === property) return replacement;
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function assertPolicyRejected(data, dependencies = {}) {
  let importCalls = 0;
  const result = await run(args(data), { dependencies: {
    ...dependencies,
    importUsers() { importCalls += 1; throw new Error("must not import"); }
  } });
  assert.equal(result.code, 4);
  assert.equal(result.payload.code, "USERS_IMPORT_SCHEMA_REQUIRED");
  assert.equal(result.stderr.length, 1);
  assert.equal(importCalls, 0);
  const database = await openSqliteDatabase(data.paths.database);
  try {
    for (const table of ["users", "user_module_permissions", "user_audit_logs", "user_audit_log_fields", "user_activity_logs"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) count FROM main.${table}`).get().count, 0);
    }
    assert.equal(database.prepare("SELECT COUNT(*) count FROM main.sqlite_sequence WHERE name LIKE 'user%'").get().count, 0);
  } finally { closeSqliteDatabase(database); }
}
