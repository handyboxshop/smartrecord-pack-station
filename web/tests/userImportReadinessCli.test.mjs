import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runUserImportReadinessCli } from "../scripts/check-user-import-readiness.mjs";

function modules() {
  return [
    { id: "pack", label: "Pack", section: "Ops", viewPermission: "pack:use", editPermission: "pack:use" }
  ];
}

function roles() {
  return [{
    id: "packer",
    label: "Packer",
    modulePermissions: [{ moduleId: "pack", canView: true, canEdit: true }]
  }];
}

function user(overrides = {}) {
  return {
    id: "USR-1",
    username: "synthetic-user",
    email: "synthetic@example.test",
    name: "Synthetic User",
    roleId: "packer",
    active: true,
    passwordSalt: "synthetic-salt",
    passwordHash: "a".repeat(64),
    ...overrides
  };
}

async function fixture(t, { users = [user()], config = { auth: { roles: roles(), modules: modules() } }, map = null } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "users-readiness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const usersPath = path.join(directory, "users.json");
  const configPath = path.join(directory, "config.json");
  const mapPath = path.join(directory, "map.json");
  await writeFile(usersPath, JSON.stringify(users));
  await writeFile(configPath, JSON.stringify(config));
  if (map !== null) await writeFile(mapPath, typeof map === "string" ? map : JSON.stringify(map));
  return { directory, usersPath, configPath, mapPath };
}

async function run(argv, dependencies = {}) {
  const stdout = [];
  const stderr = [];
  const code = await runUserImportReadinessCli({
    argv,
    output: (line) => stdout.push(line),
    errorOutput: (line) => stderr.push(line),
    dependencies
  });
  return { code, stdout, stderr };
}

function parseOnly(lines) {
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test("help alone succeeds with static text and does not inspect dependencies", async () => {
  const result = await run(["--help"], {
    lstat() { throw new Error("must not run"); },
    readFile() { throw new Error("must not run"); }
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr.length, 0);
  assert.equal(result.stdout.length, 1);
  assert.match(result.stdout[0], /^Usage:/);
  assert.doesNotMatch(result.stdout[0], /\/Users|cwd|SMARTRECORD/);
});

test("valid required flags produce one deterministic ready JSON line", async (t) => {
  const files = await fixture(t);
  const result = await run(["--users", files.usersPath, "--config", files.configPath]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr.length, 0);
  const payload = parseOnly(result.stdout);
  assert.equal(payload.code, "USERS_READINESS_READY");
  assert.equal(payload.report.status, "ready");
});

test("valid explicit and supported custom password policies remain ready", async (t) => {
  for (const passwordPolicy of [
    { minLength: 8, hashAlgorithm: "pbkdf2-sha256", iterations: 120000 },
    { hashAlgorithm: "pbkdf2-sha256", iterations: 1 }
  ]) {
    const files = await fixture(t, {
      config: { auth: { roles: roles(), modules: modules(), passwordPolicy } }
    });
    const result = await run(["--users", files.usersPath, "--config", files.configPath]);
    assert.equal(result.code, 0);
    assert.equal(parseOnly(result.stdout).code, "USERS_READINESS_READY");
    assert.equal(result.stderr.length, 0);
  }
});

test("invalid password policy returns only the stable config error without policy leakage", async (t) => {
  const marker = "SECRET-UNSUPPORTED-POLICY-MARKER";
  const files = await fixture(t, {
    config: {
      auth: {
        roles: roles(),
        modules: modules(),
        passwordPolicy: { hashAlgorithm: marker, iterations: 10_000_001 }
      }
    }
  });
  const result = await run(["--users", files.usersPath, "--config", files.configPath]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.deepEqual(parseOnly(result.stderr), { code: "USERS_READINESS_CONFIG_INVALID" });
  assert.doesNotMatch(result.stderr[0], /SECRET|UNSUPPORTED|POLICY|MARKER|10000001|users\.json|config\.json/);
});

test("empty Users JSON is blocked once without output or filesystem mutation", async (t) => {
  const files = await fixture(t, { users: [] });
  const beforeMembers = (await readdir(files.directory)).sort();
  const result = await run(["--users", files.usersPath, "--config", files.configPath]);
  const afterMembers = (await readdir(files.directory)).sort();
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.deepEqual(beforeMembers, afterMembers);
  assert.deepEqual(parseOnly(result.stderr), {
    code: "USERS_READINESS_BLOCKED",
    report: {
      ok: false,
      status: "blocked",
      inputUserCount: 0,
      importableUserCount: 0,
      activeUserCount: 0,
      inactiveUserCount: 0,
      legacyEmailCount: 0,
      requiredUsernameAssignmentCount: 0,
      errorCount: 1,
      warningCount: 0,
      omittedIssueCount: 0,
      issueLimitReached: false,
      issues: [{ severity: "error", code: "USERS_INPUT_EMPTY", userIndex: null, field: null }]
    }
  });
  assert.doesNotMatch(result.stderr[0], /users\.json|config\.json|Synthetic|credential|password|bootstrap|sqlite|database/i);
});

test("optional username map supplies, but never generates, a missing username", async (t) => {
  const source = user();
  delete source.username;
  const files = await fixture(t, { users: [source], map: { "USR-1": "approved-user" } });
  const result = await run([
    "--username-map", files.mapPath,
    "--config", files.configPath,
    "--users", files.usersPath
  ]);
  assert.equal(result.code, 0);
  assert.equal(parseOnly(result.stdout).report.requiredUsernameAssignmentCount, 0);
});

test("missing, duplicate, unknown, inline, positional, help-conflict, and relative flags fail usage", async () => {
  const cases = [
    [],
    ["--users", "/tmp/users.json"],
    ["--users", "/tmp/a", "--users", "/tmp/b", "--config", "/tmp/c"],
    ["--unknown", "/tmp/a", "--config", "/tmp/c"],
    ["--users=/tmp/a", "--config", "/tmp/c"],
    ["positional", "/tmp/a", "--config", "/tmp/c"],
    ["--help", "--users", "/tmp/a", "--config", "/tmp/c"],
    ["--users", "relative.json", "--config", "/tmp/c"],
    ["--users", "/tmp/a", "--config", " "]
  ];
  for (const argv of cases) {
    const result = await run(argv);
    assert.equal(result.code, 1);
    assert.deepEqual(parseOnly(result.stderr), { code: "USERS_READINESS_USAGE_INVALID" });
    assert.equal(result.stdout.length, 0);
  }
});

test("missing file, directory, symlink, unreadable file, and oversized file fail safely", async (t) => {
  const files = await fixture(t);
  const missing = path.join(files.directory, "missing.json");
  const link = path.join(files.directory, "users-link.json");
  await symlink(files.usersPath, link);
  const oversized = path.join(files.directory, "oversized.json");
  await writeFile(oversized, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));

  for (const usersPath of [missing, files.directory, link, oversized]) {
    const result = await run(["--users", usersPath, "--config", files.configPath]);
    assert.equal(result.code, 1);
    assert.deepEqual(parseOnly(result.stderr), { code: "USERS_READINESS_SOURCE_READ_FAILED" });
  }

  const unreadable = await run(["--users", files.usersPath, "--config", files.configPath], {
    readFile() { throw new Error("EACCES SECRET PATH"); }
  });
  assert.deepEqual(parseOnly(unreadable.stderr), { code: "USERS_READINESS_SOURCE_READ_FAILED" });
  assert.doesNotMatch(unreadable.stderr[0], /EACCES|SECRET|users\.json/);
});

test("fatal UTF-8 decoding rejects invalid bytes", async (t) => {
  const files = await fixture(t);
  await writeFile(files.usersPath, Buffer.from([0xc3, 0x28]));
  const result = await run(["--users", files.usersPath, "--config", files.configPath]);
  assert.deepEqual(parseOnly(result.stderr), { code: "USERS_READINESS_SOURCE_READ_FAILED" });
});

test("malformed users, config, and map JSON use stable operational codes", async (t) => {
  const files = await fixture(t, { map: "{" });
  await writeFile(files.usersPath, "{");
  let result = await run(["--users", files.usersPath, "--config", files.configPath]);
  assert.deepEqual(parseOnly(result.stderr), { code: "USERS_READINESS_SOURCE_JSON_INVALID" });

  await writeFile(files.usersPath, JSON.stringify([user()]));
  await writeFile(files.configPath, "{");
  result = await run(["--users", files.usersPath, "--config", files.configPath]);
  assert.deepEqual(parseOnly(result.stderr), { code: "USERS_READINESS_CONFIG_INVALID" });

  await writeFile(files.configPath, JSON.stringify({ auth: { roles: roles(), modules: modules() } }));
  result = await run(["--users", files.usersPath, "--config", files.configPath, "--username-map", files.mapPath]);
  assert.deepEqual(parseOnly(result.stderr), { code: "USERS_READINESS_USERNAME_MAP_INVALID" });
});

test("config shape and duplicate assignment keys fail before readiness reporting", async (t) => {
  const files = await fixture(t, { config: { auth: {} }, map: "{\"USR-1\":\"first-user\",\"USR-1\":\"second-user\"}" });
  let result = await run(["--users", files.usersPath, "--config", files.configPath]);
  assert.deepEqual(parseOnly(result.stderr), { code: "USERS_READINESS_CONFIG_INVALID" });

  await writeFile(files.configPath, JSON.stringify({ auth: { roles: roles(), modules: modules() } }));
  result = await run(["--users", files.usersPath, "--config", files.configPath, "--username-map", files.mapPath]);
  assert.deepEqual(parseOnly(result.stderr), { code: "USERS_READINESS_USERNAME_MAP_INVALID" });
});

test("blocked readiness writes exactly one safe stderr line and returns one", async (t) => {
  const source = user({ username: undefined, active: false });
  const files = await fixture(t, { users: [source] });
  const result = await run(["--users", files.usersPath, "--config", files.configPath]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  const payload = parseOnly(result.stderr);
  assert.equal(payload.code, "USERS_READINESS_BLOCKED");
  assert.equal(payload.report.status, "blocked");
  assert.equal(payload.report.inactiveUserCount, 1);
  assert.equal(payload.report.requiredUsernameAssignmentCount, 1);
});

test("paths, identities, roles, employee data, credentials, SQL, and raw causes never leak", async (t) => {
  const marker = "SECRET-MARKER";
  const files = await fixture(t, {
    users: [user({
      id: marker,
      username: marker,
      email: marker,
      name: marker,
      roleId: marker,
      employeeName: marker,
      employeeId: marker,
      passwordSalt: marker,
      passwordHash: marker
    })]
  });
  const result = await run(["--users", files.usersPath, "--config", files.configPath]);
  const surface = result.stderr.join("\n");
  assert.doesNotMatch(surface, /SECRET|MARKER|users\.json|config\.json|SELECT|SQL|Synthetic|packer|example\.test|salt/);
});

test("source, config, and map bytes and metadata remain unchanged", async (t) => {
  const files = await fixture(t, { map: {} });
  const paths = [files.usersPath, files.configPath, files.mapPath];
  const before = await Promise.all(paths.map(async (filePath) => ({
    bytes: await readFile(filePath),
    metadata: await stat(filePath)
  })));
  const result = await run(["--users", files.usersPath, "--config", files.configPath, "--username-map", files.mapPath]);
  assert.equal(result.code, 0);
  const after = await Promise.all(paths.map(async (filePath) => ({
    bytes: await readFile(filePath),
    metadata: await stat(filePath)
  })));
  for (let index = 0; index < paths.length; index += 1) {
    assert.deepEqual(after[index].bytes, before[index].bytes);
    assert.equal(after[index].metadata.size, before[index].metadata.size);
    assert.equal(after[index].metadata.mtimeMs, before[index].metadata.mtimeMs);
    assert.equal(after[index].metadata.ino, before[index].metadata.ino);
  }
});

test("internal dependency failures are sanitized and exact", async (t) => {
  const files = await fixture(t);
  const result = await run(["--users", files.usersPath, "--config", files.configPath], {
    analyzeUserImportReadiness() { throw new Error("RAW SQL /private/path SECRET"); }
  });
  assert.equal(result.code, 1);
  assert.deepEqual(parseOnly(result.stderr), { code: "USERS_READINESS_INTERNAL_FAILED" });
  assert.doesNotMatch(result.stderr[0], /RAW|SQL|private|SECRET/);
});

test("CLI source has no SQLite import, database open, file write, or process.exit call", async () => {
  const source = await readFile(new URL("../scripts/check-user-import-readiness.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /better-sqlite3|node:sqlite|openSqliteDatabase|writeFile|appendFile|bootstrapInitial|createInitial|process\.exit\s*\(/i);
  assert.match(source, /process\.exitCode\s*=/);
});
