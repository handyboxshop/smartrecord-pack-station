import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod, link, lstat, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  closeSqliteDatabase,
  openReadOnlySqliteDatabase,
  openSqliteDatabase
} from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import { sourceManifestSha256 } from "../scripts/check-user-import-readiness.mjs";
import * as readinessApi from "../scripts/check-legacy-user-backfill-readiness.mjs";

const modules = [
  { id: "pack", label: "Pack", section: "Ops", viewPermission: "pack:use", editPermission: "pack:use" },
  { id: "returns", label: "Returns", section: "Ops", viewPermission: "returns:view", editPermission: "returns:edit" }
];
const packPermissions = [
  { moduleId: "pack", canView: true, canEdit: true },
  { moduleId: "returns", canView: false, canEdit: false }
];
const customPermissions = [
  { moduleId: "pack", canView: true, canEdit: false },
  { moduleId: "returns", canView: true, canEdit: true }
];
const config = { auth: { modules, roles: [
  { id: "packer", label: "Packer", modulePermissions: packPermissions },
  { id: "custom", label: "Custom", modulePermissions: packPermissions }
] } };

function syntheticUser(index = 1, overrides = {}) {
  return {
    id: `USR-${index}`,
    email: `user${index}@example.test`,
    name: `Synthetic User ${index}`,
    roleId: "packer",
    active: true,
    passwordSalt: `synthetic-salt-${index}`,
    passwordHash: String(index).repeat(64),
    ...overrides
  };
}

async function fixture(t, {
  sourceUsers = [syntheticUser()],
  storedUsers = sourceUsers,
  usernameMap = null,
  version = 5,
  usersBytes,
  configBytes,
  mapBytes
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "legacy-backfill-readiness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    users: path.join(directory, "users.json"),
    config: path.join(directory, "config.json"),
    map: path.join(directory, "usernames.json"),
    database: path.join(directory, "users.sqlite")
  };
  const assignments = usernameMap ?? Object.fromEntries(
    sourceUsers.map((user, index) => [user.id, `user.${index + 1}`])
  );
  const bytes = [
    usersBytes ?? Buffer.from(JSON.stringify(sourceUsers)),
    configBytes ?? Buffer.from(JSON.stringify(config)),
    mapBytes ?? Buffer.from(JSON.stringify(assignments))
  ];
  await Promise.all([
    writeFile(paths.users, bytes[0], { mode: 0o600 }),
    writeFile(paths.config, bytes[1], { mode: 0o600 }),
    writeFile(paths.map, bytes[2], { mode: 0o600 })
  ]);
  const database = await openSqliteDatabase(paths.database);
  await runSqliteMigrations(database, { maximumVersion: 4 });
  insertLegacyUsers(database, storedUsers);
  if (version === 5) await runSqliteMigrations(database);
  setSyntheticDeleteJournalMode(database);
  closeSqliteDatabase(database);
  assert.deepEqual((await readdir(directory)).sort(), ["config.json", "usernames.json", "users.json", "users.sqlite"]);
  return { directory, paths, bytes, manifest: sourceManifestSha256(bytes), sourceUsers, assignments };
}

function insertLegacyUsers(database, users) {
  const insertUser = database.prepare(`INSERT INTO main.users
    (user_sequence,id,email,name,role_id,role_name,employee_name,employee_id,active,
      password_salt,password_hash,created_at,updated_at,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);
  const insertPermission = database.prepare(`INSERT INTO main.user_module_permissions
    (user_id,permission_sequence,module_id,can_view,can_edit) VALUES (?,?,?,?,?)`);
  users.forEach((user, index) => {
    insertUser.run(index + 1, user.id, user.email.trim(), user.name, user.roleId,
      user.roleId === "custom" ? user.roleName.trim() : null,
      user.employeeName?.trim() ?? null, user.employeeId?.trim() ?? null,
      user.active ? 1 : 0, user.passwordSalt, user.passwordHash,
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const permissions = Object.hasOwn(user, "modulePermissions")
      ? user.modulePermissions : config.auth.roles.find((role) => role.id === user.roleId).modulePermissions;
    const byModule = new Map(permissions.map((permission) => [permission.moduleId, permission]));
    modules.forEach((module, permissionSequence) => {
      const permission = byModule.get(module.id);
      insertPermission.run(user.id, permissionSequence, module.id,
        permission.canView ? 1 : 0, permission.canEdit ? 1 : 0);
    });
  });
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

async function run(argv, dependencies = {}) {
  const stdout = [];
  const stderr = [];
  const code = await readinessApi.runUserLegacyBackfillReadinessCli(argv, {
    ...dependencies,
    output: (line) => stdout.push(line),
    errorOutput: (line) => stderr.push(line)
  });
  return {
    code,
    stdout,
    stderr,
    payload: JSON.parse(stdout[0] ?? stderr[0] ?? "null")
  };
}

test("exports exactly the readiness CLI API", () => {
  assert.deepEqual(Object.keys(readinessApi), ["runUserLegacyBackfillReadinessCli"]);
});

test("schema-v4 setup migrated separately to v5 reports ready without any mutation", async (t) => {
  const data = await fixture(t);
  const before = await evidence(data);
  const result = await run(args(data));
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.stdout.length, 1);
  assert.equal(result.stderr.length, 0);
  assert.deepEqual(result.payload, {
    ok: true,
    status: "ready",
    sourceManifestSha256: data.manifest,
    userCount: 1,
    permissionCount: 2,
    requiredBackfillCount: 1,
    alreadyAssignedCount: 0,
    verificationStatus: "mismatch",
    verifiedUserCount: 0,
    mismatchedUserCount: 1,
    action: "request_offline_rehearsal_approval"
  });
  await assertEvidenceUnchanged(data, before);
  const database = await openReadOnlySqliteDatabase(data.paths.database);
  assert.equal(database.prepare("SELECT username FROM main.users").get().username, null);
  closeSqliteDatabase(database);
});

test("mixed assigned and NULL users include active, inactive, custom roles, and permissions", async (t) => {
  const sourceUsers = [
    syntheticUser(1),
    syntheticUser(2, { active: false }),
    syntheticUser(3, {
      roleId: "custom",
      roleName: "Synthetic Returns",
      modulePermissions: customPermissions
    })
  ];
  const data = await fixture(t, { sourceUsers });
  await mutateDatabase(data, (database) => {
    database.prepare("UPDATE main.users SET username=? WHERE id=?").run("user.1", "USR-1");
  });
  const before = await evidence(data);
  const result = await run(args(data));
  assert.equal(result.code, 0);
  assert.deepEqual({
    status: result.payload.status,
    userCount: result.payload.userCount,
    permissionCount: result.payload.permissionCount,
    required: result.payload.requiredBackfillCount,
    assigned: result.payload.alreadyAssignedCount,
    verified: result.payload.verifiedUserCount,
    mismatched: result.payload.mismatchedUserCount
  }, { status: "ready", userCount: 3, permissionCount: 6, required: 2, assigned: 1, verified: 1, mismatched: 2 });
  await assertEvidenceUnchanged(data, before);
});

test("already-complete is successful and performs no write transaction", async (t) => {
  const data = await fixture(t);
  await mutateDatabase(data, (database) => {
    database.prepare("UPDATE main.users SET username=? WHERE id=?").run("user.1", "USR-1");
  });
  const before = await evidence(data);
  const result = await run(args(data));
  assert.equal(result.code, 0);
  assert.equal(result.payload.status, "already-complete");
  assert.equal(result.payload.verificationStatus, "already-complete");
  assert.equal(result.payload.requiredBackfillCount, 0);
  assert.equal(result.payload.action, "no_backfill_required");
  await assertEvidenceUnchanged(data, before);
});

test("manifest formula matches prior phases and stale manifests fail safely", async (t) => {
  const data = await fixture(t);
  assert.equal(data.manifest, sourceManifestSha256(data.bytes));
  const result = await run(args(data, { manifest: "0".repeat(64) }));
  assert.equal(result.code, 3);
  assert.deepEqual(result.payload, {
    ok: false,
    code: "USERS_BACKFILL_READINESS_SOURCE_MANIFEST_MISMATCH",
    action: "correct_input_and_retry"
  });
});

test("duplicate keys, invalid UTF-8, malformed config, and malformed map use exact source errors", async (t) => {
  const cases = [
    { key: "usersBytes", bytes: Buffer.from('[{"id":1,"\\u0069d":2}]'), code: "USERS_BACKFILL_READINESS_SOURCE_JSON_INVALID" },
    { key: "usersBytes", bytes: Buffer.from([0xc3, 0x28]), code: "USERS_BACKFILL_READINESS_SOURCE_READ_FAILED" },
    { key: "configBytes", bytes: Buffer.from('{"auth":{"roles":[],"r\\u006fles":[],"modules":[]}}'), code: "USERS_BACKFILL_READINESS_CONFIG_INVALID" },
    { key: "mapBytes", bytes: Buffer.from('{"USR-1":"user.1","USR-\\u0031":"other.1"}'), code: "USERS_BACKFILL_READINESS_USERNAME_MAP_INVALID" },
    { key: "mapBytes", bytes: Buffer.from("[]"), code: "USERS_BACKFILL_READINESS_USERNAME_MAP_INVALID" }
  ];
  for (const entry of cases) {
    const data = await fixture(t, { [entry.key]: entry.bytes });
    const result = await run(args(data));
    assert.equal(result.code, 3);
    assert.equal(result.payload.code, entry.code);
  }
});

test("argument parser rejects relative, missing, duplicate, combined, positional, and unknown forms", async () => {
  const validTail = [
    "--config", "/tmp/config.json", "--username-map", "/tmp/map.json",
    "--database", "/tmp/database.sqlite", "--expected-manifest-sha256", "a".repeat(64)
  ];
  for (const argv of [
    [],
    ["--users", "relative.json", ...validTail],
    ["--users=/tmp/users.json", ...validTail],
    ["--users", "/tmp/a", "--users", "/tmp/b", ...validTail.slice(2)],
    ["positional", "/tmp/users.json", ...validTail],
    ["--unknown", "/tmp/users.json", ...validTail]
  ]) {
    const result = await run(argv);
    assert.equal(result.code, 2);
    assert.equal(result.payload.code, "USERS_BACKFILL_READINESS_USAGE_INVALID");
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.length, 1);
  }
});

test("schema v4, altered migration checksum, and TEMP shadows fail closed", async (t) => {
  const v4 = await fixture(t, { version: 4 });
  const v4Result = await run(args(v4));
  assert.equal(v4Result.code, 4);
  assert.equal(v4Result.payload.code, "USERS_BACKFILL_READINESS_SCHEMA_REQUIRED");

  const checksum = await fixture(t);
  await mutateDatabase(checksum, (database) => {
    database.prepare("UPDATE main.schema_migrations SET checksum_sha256=? WHERE version=5").run("0".repeat(64));
  });
  const checksumResult = await run(args(checksum));
  assert.equal(checksumResult.code, 4);
  assert.equal(checksumResult.payload.code, "USERS_BACKFILL_READINESS_SCHEMA_REQUIRED");

  const alteredSchema = await fixture(t);
  await mutateDatabase(alteredSchema, (database) => {
    database.exec("DROP INDEX main.user_activity_logs_actor_index");
  });
  const schemaResult = await run(args(alteredSchema));
  assert.equal(schemaResult.code, 4);
  assert.equal(schemaResult.payload.code, "USERS_BACKFILL_READINESS_SCHEMA_REQUIRED");

  const shadow = await fixture(t);
  const shadowResult = await run(args(shadow), {
    async openReadOnlySqliteDatabase(databasePath) {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      database.exec("CREATE TEMP VIEW users AS SELECT 1");
      return database;
    }
  });
  assert.equal(shadowResult.code, 4);
  assert.equal(shadowResult.payload.code, "USERS_BACKFILL_READINESS_SCHEMA_REQUIRED");
});

test("missing users, mismatched assignments, collisions, tombstones, and contaminated rows fail", async (t) => {
  const missing = await fixture(t, {
    sourceUsers: [syntheticUser(1), syntheticUser(2)],
    storedUsers: [syntheticUser(1)]
  });
  assert.equal((await run(args(missing))).payload.code, "USERS_BACKFILL_READINESS_PLAN_INVALID");

  const extra = await fixture(t, {
    sourceUsers: [syntheticUser(1)],
    storedUsers: [syntheticUser(1), syntheticUser(2)]
  });
  assert.equal((await run(args(extra))).payload.code, "USERS_BACKFILL_READINESS_PLAN_INVALID");

  const mismatched = await fixture(t);
  await mutateDatabase(mismatched, (database) => {
    database.prepare("UPDATE main.users SET username=? WHERE id=?").run("wrong.user", "USR-1");
  });
  assert.equal((await run(args(mismatched))).payload.code, "USERS_BACKFILL_READINESS_PLAN_INVALID");

  const collision = await fixture(t, { usernameMap: { "USR-1": "user1@example.test" } });
  assert.equal((await run(args(collision))).payload.code, "USERS_BACKFILL_READINESS_PLAN_INVALID");

  const tombstone = await fixture(t);
  await mutateDatabase(tombstone, (database) => {
    database.prepare("UPDATE main.users SET active=0,deleted_at=? WHERE id=?")
      .run("2026-01-01T00:00:00.000Z", "USR-1");
  });
  assert.equal((await run(args(tombstone))).payload.code, "USERS_BACKFILL_READINESS_PLAN_INVALID");

  const contaminated = await fixture(t);
  await mutateDatabase(contaminated, (database) => {
    database.prepare("UPDATE main.sqlite_sequence SET seq=0 WHERE name='users'").run();
  });
  assert.equal((await run(args(contaminated))).payload.code, "USERS_BACKFILL_READINESS_STORED_DATA_INVALID");
});

test("source and database symlinks, hard links, unsafe modes, and unsafe parents are rejected", async (t) => {
  const sourceSymbolic = await fixture(t);
  const symbolicSource = path.join(sourceSymbolic.directory, "symbolic-users.json");
  await symlink(sourceSymbolic.paths.users, symbolicSource);
  assert.equal((await run(args(sourceSymbolic, { users: symbolicSource }))).code, 3);

  const sourceHard = await fixture(t);
  await link(sourceHard.paths.users, path.join(sourceHard.directory, "hard-users.json"));
  assert.equal((await run(args(sourceHard))).code, 3);

  const databaseSymbolic = await fixture(t);
  const symbolicDatabase = path.join(databaseSymbolic.directory, "symbolic.sqlite");
  await symlink(databaseSymbolic.paths.database, symbolicDatabase);
  assert.equal((await run(args(databaseSymbolic, { database: symbolicDatabase }))).code, 4);

  const databaseHard = await fixture(t);
  await link(databaseHard.paths.database, path.join(databaseHard.directory, "hard.sqlite"));
  assert.equal((await run(args(databaseHard))).code, 4);

  const unsafeSource = await fixture(t);
  await chmod(unsafeSource.paths.users, 0o666);
  assert.equal((await run(args(unsafeSource))).code, 3);

  const unsafeDatabase = await fixture(t);
  await chmod(unsafeDatabase.paths.database, 0o666);
  assert.equal((await run(args(unsafeDatabase))).code, 4);

  const unsafeParent = await fixture(t);
  await chmod(unsafeParent.directory, 0o777);
  try { assert.equal((await run(args(unsafeParent))).code, 4); }
  finally { await chmod(unsafeParent.directory, 0o700); }

  const wrongOwner = await fixture(t);
  const ownerResult = await run(args(wrongOwner), {
    async lstat(filePath) {
      const value = await lstat(filePath);
      return filePath === wrongOwner.paths.database
        ? changedStat(value, "uid", value.uid + 1) : value;
    }
  });
  assert.equal(ownerResult.code, 4);

  const sidecar = await fixture(t);
  await writeFile(`${sidecar.paths.database}-wal`, "synthetic-sidecar");
  const sidecarResult = await run(args(sidecar));
  assert.equal(sidecarResult.code, 4);
  assert.equal(sidecarResult.payload.code, "USERS_BACKFILL_READINESS_DATABASE_POLICY_FAILED");
});

test("database open failures and stable metadata changes use exact fail-closed codes", async (t) => {
  const corrupt = await fixture(t);
  await writeFile(corrupt.paths.database, "not a sqlite database");
  const corruptResult = await run(args(corrupt));
  assert.equal(corruptResult.code, 4);
  assert.equal(corruptResult.payload.code, "USERS_BACKFILL_READINESS_DATABASE_OPEN_FAILED");
  assert.equal(corruptResult.payload.action, "replace_offline_copy");

  const sourceMetadata = await fixture(t);
  let sourceStats = 0;
  const sourceResult = await run(args(sourceMetadata), {
    async lstat(filePath) {
      const value = await lstat(filePath);
      if (filePath === sourceMetadata.paths.users && ++sourceStats === 2) {
        return changedStat(value, "mtimeMs", value.mtimeMs + 1);
      }
      return value;
    }
  });
  assert.equal(sourceResult.code, 3);
  assert.equal(sourceResult.payload.code, "USERS_BACKFILL_READINESS_SOURCE_READ_FAILED");

  const databaseMetadata = await fixture(t);
  let databaseStats = 0;
  const databaseResult = await run(args(databaseMetadata), {
    async lstat(filePath) {
      const value = await lstat(filePath);
      if (filePath === databaseMetadata.paths.database && ++databaseStats === 2) {
        return changedStat(value, "ctimeMs", value.ctimeMs + 1);
      }
      return value;
    }
  });
  assert.equal(databaseResult.code, 4);
  assert.equal(databaseResult.payload.code, "USERS_BACKFILL_READINESS_DATABASE_CHANGED");
});

test("readiness rejects a WAL snapshot without changing files or creating a sidecar", async (t) => {
  const data = await fixture(t);
  const database = await openSqliteDatabase(data.paths.database);
  closeSqliteDatabase(database);
  const before = await evidence(data);

  const result = await run(args(data));
  assert.equal(result.code, 4);
  assert.equal(result.payload.code, "USERS_BACKFILL_READINESS_DATABASE_OPEN_FAILED");
  assert.equal(result.payload.action, "replace_offline_copy");
  await assertEvidenceUnchanged(data, before);
  assert.deepEqual(
    (await readdir(data.directory)).filter((name) => name.startsWith("users.sqlite")),
    ["users.sqlite"]
  );
});

test("source and database identity replacement and fingerprint changes are detected", async (t) => {
  const source = await fixture(t);
  let sourceStats = 0;
  const sourceResult = await run(args(source), {
    async lstat(filePath) {
      const value = await lstat(filePath);
      if (filePath === source.paths.users && ++sourceStats === 3) return changedStat(value, "ino", value.ino + 1);
      return value;
    }
  });
  assert.equal(sourceResult.code, 3);

  const database = await fixture(t);
  let databaseStats = 0;
  const databaseResult = await run(args(database), {
    async lstat(filePath) {
      const value = await lstat(filePath);
      if (filePath === database.paths.database && ++databaseStats === 3) {
        return changedStat(value, "ino", value.ino + 1);
      }
      return value;
    }
  });
  assert.equal(databaseResult.code, 4);

  const fingerprint = await fixture(t);
  let fingerprintReads = 0;
  const fingerprintResult = await run(args(fingerprint), {
    async open(filePath, flags) {
      const handle = await open(filePath, flags);
      if (filePath !== fingerprint.paths.database) return handle;
      return {
        stat: (...values) => handle.stat(...values),
        async read(buffer, ...values) {
          const result = await handle.read(buffer, ...values);
          fingerprintReads += 1;
          if (fingerprintReads > 1 && result.bytesRead > 0) buffer[0] ^= 0xff;
          return result;
        },
        close: (...values) => handle.close(...values)
      };
    }
  });
  assert.equal(fingerprintResult.code, 4);
  assert.equal(fingerprintResult.payload.code, "USERS_BACKFILL_READINESS_DATABASE_CHANGED");
});

test("unexpected verifier issue codes fail closed with sanitized one-line output", async (t) => {
  const data = await fixture(t);
  const marker = "SECRET-user@example.test-/private/path";
  const result = await run(args(data), {
    verifyUserLegacyBackfill() {
      return {
        status: "mismatch",
        expectedUserCount: 1,
        actualUserCount: 1,
        verifiedUserCount: 0,
        mismatchedUserCount: 1,
        issueCodeCounts: [
          { code: "USERNAME_MISMATCH", count: 1 },
          { code: marker, count: 1 }
        ]
      };
    }
  });
  assert.equal(result.code, 5);
  assert.deepEqual(result.payload, {
    ok: false,
    code: "USERS_BACKFILL_READINESS_VERIFICATION_MISMATCH",
    action: "do_not_proceed"
  });
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 1);
  assert.doesNotMatch(result.stderr[0], /SECRET|example\.test|private|USR-|SELECT|sqlite/i);
});

test("signals use exact exits while buffers are wiped and every handle closes", async (t) => {
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const data = await fixture(t);
    const signals = new EventEmitter();
    const retained = [];
    let closes = 0;
    const pending = run(args(data), {
      signalSource: signals,
      async open(filePath, flags) {
        const handle = await open(filePath, flags);
        return {
          stat: (...values) => handle.stat(...values),
          read: (...values) => handle.read(...values),
          async readFile(...values) {
            const bytes = await handle.readFile(...values);
            retained.push(bytes);
            return bytes;
          },
          async close() { closes += 1; return handle.close(); }
        };
      }
    });
    signals.emit(signal);
    const result = await pending;
    assert.equal(result.code, exitCode);
    assert.equal(result.payload.code, "USERS_BACKFILL_READINESS_INTERRUPTED");
    assert.equal(result.stdout.length + result.stderr.length, 1);
    assert.ok(retained.every((bytes) => bytes.every((byte) => byte === 0)));
    assert.ok(closes <= 4);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  }
});

test("database closes, source buffers wipe, and cleanup is shared on success and failure", async (t) => {
  for (const manifest of [null, "0".repeat(64)]) {
    const data = await fixture(t);
    const retained = [];
    let closes = 0;
    let databaseCloses = 0;
    const result = await run(args(data, manifest ? { manifest } : {}), {
      closeSqliteDatabase(database) {
        databaseCloses += 1;
        return closeSqliteDatabase(database);
      },
      async open(filePath, flags) {
        const handle = await open(filePath, flags);
        return {
          stat: (...values) => handle.stat(...values),
          read: (...values) => handle.read(...values),
          async readFile(...values) {
            const bytes = await handle.readFile(...values);
            retained.push(bytes);
            return bytes;
          },
          async close() { closes += 1; return handle.close(); }
        };
      }
    });
    assert.equal(result.code, manifest ? 3 : 0);
    assert.equal(databaseCloses, manifest ? 0 : 1);
    assert.equal(closes, manifest ? 3 : 4);
    assert.ok(retained.every((bytes) => bytes.every((byte) => byte === 0)));
  }
});

test("readiness source has no mutation imports or forbidden database operations", async () => {
  const source = await readFile(new URL("../scripts/check-legacy-user-backfill-readiness.mjs", import.meta.url), "utf8");
  const forbidden = [
    /backfillLegacyUsernames/,
    /backfill-legacy-usernames\.mjs/,
    /userLegacyBackfiller/,
    /(?:^|[^A-Za-z])BEGIN\s+IMMEDIATE(?:[^A-Za-z]|$)/i,
    /\b(?:INSERT\s+INTO|UPDATE\s+[A-Za-z0-9_.]+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|VIEW|INDEX|TRIGGER)|DROP\s+(?:TABLE|VIEW|INDEX|TRIGGER)|ALTER\s+TABLE|VACUUM\b|ATTACH\s+DATABASE|checkpoint\b)/i,
    /journal_mode\s*=/i,
    /immutable\s*=\s*1/i,
    /(?:^|\/)migrate\.mjs/
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
  assert.match(source, /openReadOnlySqliteDatabase/);
  assert.match(source, /createUserLegacyBackfillPlan/);
  assert.match(source, /verifyUserLegacyBackfill/);
  assert.match(source, /disposeUserLegacyBackfillPlan/);
});

async function mutateDatabase(data, callback) {
  const database = await openSqliteDatabase(data.paths.database);
  try {
    callback(database);
    setSyntheticDeleteJournalMode(database);
  } finally {
    closeSqliteDatabase(database);
  }
  assert.deepEqual((await readdir(data.directory)).filter((name) => name.startsWith("users.sqlite")), ["users.sqlite"]);
}

function setSyntheticDeleteJournalMode(database) {
  assert.equal(database.prepare("PRAGMA journal_mode = DELETE").get().journal_mode, "delete");
}

async function evidence(data) {
  const files = [data.paths.users, data.paths.config, data.paths.map, data.paths.database];
  return {
    entries: (await readdir(data.directory)).sort(),
    files: await Promise.all(files.map(async (filePath) => ({
      bytes: await readFile(filePath),
      metadata: stableMetadata(await stat(filePath))
    })))
  };
}

async function assertEvidenceUnchanged(data, before) {
  const after = await evidence(data);
  assert.deepEqual(after.entries, before.entries);
  assert.equal(after.files.length, before.files.length);
  for (let index = 0; index < before.files.length; index += 1) {
    assert.deepEqual(after.files[index].bytes, before.files[index].bytes);
    assert.equal(sha256(after.files[index].bytes), sha256(before.files[index].bytes));
    assert.deepEqual(after.files[index].metadata, before.files[index].metadata);
  }
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function stableMetadata(value) {
  return {
    size: value.size, mode: value.mode, uid: value.uid, gid: value.gid, nlink: value.nlink,
    dev: value.dev, ino: value.ino, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs
  };
}
function changedStat(value, property, replacement) {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (key === property) return replacement;
      const result = Reflect.get(target, key, receiver);
      return typeof result === "function" ? result.bind(target) : result;
    }
  });
}
