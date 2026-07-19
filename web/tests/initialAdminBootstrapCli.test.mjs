import assert from "node:assert/strict";
import { access, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { PassThrough, Readable, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInitialAdminBootstrapCli } from "../scripts/bootstrap-initial-admin.mjs";
import { verifyPasswordCredentials } from "../src/domain/passwordCredentials.mjs";
import {
  closeSqliteDatabase,
  openSqliteDatabase
} from "../src/storage/sqliteDatabase.mjs";

test("help is safe and opens no database", async () => {
  const output = captureStream();
  let opens = 0;
  const exitCode = await runInitialAdminBootstrapCli({
    argv: ["--help"],
    stdout: output.stream,
    stderr: captureStream().stream,
    dependencies: { openDatabase: async () => { opens += 1; } }
  });
  assert.equal(exitCode, 0);
  assert.equal(opens, 0);
  assert.match(output.text(), /^Usage:/);
});

test("missing, duplicate, positional, unknown, forbidden, and password argv flags fail before opening", async () => {
  const scenarios = [
    [],
    ["value"],
    ["--unknown"],
    ["--password", "secret"],
    ["--force"],
    ["--database", "/tmp/a", "--database", "/tmp/b"],
    ["--help", "--password-stdin"],
    ["--database"]
  ];
  for (const argv of scenarios) {
    const error = captureStream();
    let opens = 0;
    const exitCode = await runInitialAdminBootstrapCli({
      argv,
      stdout: captureStream().stream,
      stderr: error.stream,
      dependencies: { openDatabase: async () => { opens += 1; } }
    });
    assert.equal(exitCode, 2);
    assert.equal(opens, 0);
    assert.match(error.text(), /code=BOOTSTRAP_USAGE_INVALID/);
    assert.match(error.text(), /committed=false/);
  }
});

test("non-TTY requires explicit password stdin and accepts exactly one bounded line", async (t) => {
  const directory = await temporaryDirectory(t);
  const base = validArgv(path.join(directory, "stdin.sqlite"));
  const missingFlag = captureStream();
  assert.equal(await runInitialAdminBootstrapCli({
    argv: base,
    stdin: Readable.from(["StrongPassword123!\n"]),
    stdout: captureStream().stream,
    stderr: missingFlag.stream
  }), 2);
  assert.match(missingFlag.text(), /BOOTSTRAP_PASSWORD_INPUT_FAILED/);

  for (const bytes of ["StrongPassword123!", "StrongPassword123!\nextra\n", `${"x".repeat(1100)}\n`]) {
    const error = captureStream();
    const exitCode = await runInitialAdminBootstrapCli({
      argv: [...base, "--password-stdin"],
      stdin: Readable.from([bytes]),
      stdout: captureStream().stream,
      stderr: error.stream
    });
    assert.equal(exitCode, 2);
    assert.match(error.text(), /BOOTSTRAP_PASSWORD_INPUT_FAILED/);
  }
});

test("TTY password entry is hidden, confirmed, and restores terminal mode", async (t) => {
  const directory = await temporaryDirectory(t);
  const password = "Interactive-Password-🔐";
  const stdin = interactiveInput([`${password}\n`, `${password}\n`]);
  const stdout = captureStream();
  const stderr = captureStream();
  let receivedPassword;
  let closes = 0;
  const exitCode = await runInitialAdminBootstrapCli({
    argv: validArgv(path.join(directory, "interactive.sqlite")),
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: successfulDependencies({
      openDatabase: async (databasePath) => openSqliteDatabase(databasePath),
      bootstrapInitialAdmin: async (database, input) => { receivedPassword = input.password; },
      closeDatabase: async (database) => { closes += 1; closeSqliteDatabase(database); }
    })
  });

  assert.equal(exitCode, 0);
  assert.equal(receivedPassword, password);
  assert.equal(closes, 1);
  assert.deepEqual(stdin.rawModes, [true, false, true, false]);
  assert.match(stderr.text(), /^Password: \nConfirm password: \n$/);
  assert.equal(stderr.text().includes(password), false);
  assert.match(stdout.text(), /code=INITIAL_ADMIN_CREATED/);
});

test("TTY mismatch, stream failure, SIGINT, and SIGTERM restore terminal mode before failure", async (t) => {
  const directory = await temporaryDirectory(t);
  const scenarios = [
    { input: interactiveInput(["FirstPassword!\n", "SecondPassword!\n"]), code: "BOOTSTRAP_PASSWORD_INPUT_FAILED", exitCode: 2 },
    { input: interactiveInput([new Error("private stream failure")]), code: "BOOTSTRAP_PASSWORD_INPUT_FAILED", exitCode: 2 },
    { input: interactiveInput([Buffer.from([3])]), code: "BOOTSTRAP_INTERRUPTED", exitCode: 130 },
    { input: interactiveInput([{ signal: "SIGTERM" }]), code: "BOOTSTRAP_INTERRUPTED", exitCode: 143 }
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const stderr = captureStream();
    let opens = 0;
    const exitCode = await runInitialAdminBootstrapCli({
      argv: validArgv(path.join(directory, `terminal-${index}.sqlite`)),
      stdin: scenario.input,
      stdout: captureStream().stream,
      stderr: stderr.stream,
      dependencies: { openDatabase: async () => { opens += 1; } }
    });
    assert.equal(exitCode, scenario.exitCode);
    assert.equal(opens, 0);
    assert.match(stderr.text(), new RegExp(`code=${scenario.code}`));
    assert.equal(scenario.input.isRaw, false);
    assert.equal(scenario.input.rawModes.at(-1), false);
    assert.equal(stderr.text().includes("private stream failure"), false);
  }
});

test("a signal observed after SQLite opens closes once and reports uncommitted interruption", async (t) => {
  const directory = await temporaryDirectory(t);
  const stderr = captureStream();
  let closes = 0;
  const exitCode = await runInitialAdminBootstrapCli({
    argv: [...validArgv(path.join(directory, "signal-after-open.sqlite")), "--password-stdin"],
    stdin: Readable.from(["StrongPassword123!\n"]),
    stdout: captureStream().stream,
    stderr: stderr.stream,
    dependencies: successfulDependencies({
      openDatabase: async (databasePath) => openSqliteDatabase(databasePath),
      runMigrations: async () => {
        process.emit("SIGTERM");
        return { currentVersion: 5, applied: [] };
      },
      closeDatabase: async (database) => { closes += 1; closeSqliteDatabase(database); }
    })
  });
  assert.equal(exitCode, 143);
  assert.equal(closes, 1);
  assert.equal(stderr.text(), "status=failed\ncode=BOOTSTRAP_INTERRUPTED\ncommitted=false\n");
});

test("a signal observed after bootstrap commit closes once and reports committed interruption", async (t) => {
  const directory = await temporaryDirectory(t);
  const stderr = captureStream();
  let closes = 0;
  const exitCode = await runInitialAdminBootstrapCli({
    argv: [...validArgv(path.join(directory, "signal-after-commit.sqlite")), "--password-stdin"],
    stdin: Readable.from(["StrongPassword123!\n"]),
    stdout: captureStream().stream,
    stderr: stderr.stream,
    dependencies: successfulDependencies({
      openDatabase: async (databasePath) => openSqliteDatabase(databasePath),
      bootstrapInitialAdmin: async () => { process.emit("SIGINT"); },
      closeDatabase: async (database) => { closes += 1; closeSqliteDatabase(database); }
    })
  });
  assert.equal(exitCode, 130);
  assert.equal(closes, 1);
  assert.equal(stderr.text(), "status=failed\ncode=BOOTSTRAP_INTERRUPTED\ncommitted=true\n");
});

test("real file bootstrap migrates to schema 5 and emits no sensitive data", async (t) => {
  const directory = await temporaryDirectory(t);
  const databasePath = path.join(directory, "owner.sqlite");
  const password = "Strong-Password-🔐";
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runInitialAdminBootstrapCli({
    argv: [...validArgv(databasePath), "--password-stdin"],
    stdin: Readable.from([`${password}\n`]),
    stdout: stdout.stream,
    stderr: stderr.stream
  });
  assert.equal(exitCode, 0);
  assert.equal(stdout.text(), "status=success\ncode=INITIAL_ADMIN_CREATED\ncommitted=true\n");
  assert.equal(stderr.text(), "");
  for (const marker of [password, databasePath, "Initial.Owner", "Owner@Example.Test", "Initial Owner"]) {
    assert.equal(`${stdout.text()}${stderr.text()}`.includes(marker), false);
  }
  await access(databasePath);
  await assert.rejects(access(`${databasePath}-wal`));
  await assert.rejects(access(`${databasePath}-shm`));

  const database = await openSqliteDatabase(databasePath);
  try {
    assert.equal(database.prepare("PRAGMA main.user_version").get().user_version, 5);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.schema_migrations").get().count, 5);
    const user = database.prepare("SELECT * FROM main.users").get();
    assert.equal(user.username, "Initial.Owner");
    assert.equal(user.role_id, "owner");
    assert.equal(verifyPasswordCredentials(password, {
      passwordSalt: user.password_salt,
      passwordHash: user.password_hash
    }), true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.user_module_permissions").get().count, 6);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.user_audit_logs").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM main.user_activity_logs").get().count, 1);
  } finally {
    closeSqliteDatabase(database);
  }
});

test("an existing user returns not allowed with committed=false", async (t) => {
  const directory = await temporaryDirectory(t);
  const databasePath = path.join(directory, "existing.sqlite");
  const first = await runInitialAdminBootstrapCli({
    argv: [...validArgv(databasePath), "--password-stdin"],
    stdin: Readable.from(["StrongPassword123!\n"]),
    stdout: captureStream().stream,
    stderr: captureStream().stream
  });
  assert.equal(first, 0);
  const error = captureStream();
  const second = await runInitialAdminBootstrapCli({
    argv: [...validArgv(databasePath, "Second.Owner", "second@example.test"), "--password-stdin"],
    stdin: Readable.from(["StrongPassword456!\n"]),
    stdout: captureStream().stream,
    stderr: error.stream
  });
  assert.equal(second, 5);
  assert.equal(error.text(), "status=failed\ncode=BOOTSTRAP_NOT_ALLOWED\ncommitted=false\n");
});

test("path validation rejects relative, missing-parent, directory, and symlink targets", async (t) => {
  const directory = await temporaryDirectory(t);
  const realTarget = path.join(directory, "real.sqlite");
  const database = await openSqliteDatabase(realTarget);
  closeSqliteDatabase(database);
  const linkTarget = path.join(directory, "link.sqlite");
  await symlink(realTarget, linkTarget);
  for (const databasePath of [
    "relative.sqlite",
    path.join(directory, "missing", "db.sqlite"),
    directory,
    linkTarget
  ]) {
    const error = captureStream();
    const exitCode = await runInitialAdminBootstrapCli({
      argv: [...validArgv(databasePath), "--password-stdin"],
      stdin: Readable.from(["StrongPassword123!\n"]),
      stdout: captureStream().stream,
      stderr: error.stream
    });
    assert.equal(exitCode, 2);
    assert.match(error.text(), /BOOTSTRAP_DATABASE_PATH_INVALID/);
  }
});

test("migration and integrity failures close exactly once and remain sanitized", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const scenario of ["migration", "integrity"]) {
    const databasePath = path.join(directory, `${scenario}.sqlite`);
    let database;
    let closes = 0;
    const error = captureStream();
    const dependencies = {
      openDatabase: async (value) => { database = await openSqliteDatabase(value); return database; },
      closeDatabase: (value) => { closes += 1; return closeSqliteDatabase(value); }
    };
    if (scenario === "migration") dependencies.runMigrations = async () => { throw new Error("private migration"); };
    else dependencies.runQuickCheck = () => ({ ok: false, messages: ["private integrity"] });
    const exitCode = await runInitialAdminBootstrapCli({
      argv: [...validArgv(databasePath), "--password-stdin"],
      stdin: Readable.from(["StrongPassword123!\n"]),
      stdout: captureStream().stream,
      stderr: error.stream,
      dependencies
    });
    assert.equal(exitCode, 4);
    assert.equal(closes, 1);
    assert.equal(error.text().includes("private"), false);
  }
});

test("close failure after commit reports committed state and never retries", async (t) => {
  const directory = await temporaryDirectory(t);
  const databasePath = path.join(directory, "close.sqlite");
  const error = captureStream();
  let closeCalls = 0;
  const exitCode = await runInitialAdminBootstrapCli({
    argv: [...validArgv(databasePath), "--password-stdin"],
    stdin: Readable.from(["StrongPassword123!\n"]),
    stdout: captureStream().stream,
    stderr: error.stream,
    dependencies: {
      closeDatabase: (database) => {
        closeCalls += 1;
        closeSqliteDatabase(database);
        throw new Error("private close");
      }
    }
  });
  assert.equal(exitCode, 7);
  assert.equal(closeCalls, 1);
  assert.equal(error.text(), "status=failed\ncode=BOOTSTRAP_DATABASE_CLOSE_FAILED\ncommitted=true\naction=do_not_retry_normal_bootstrap\n");
});

test("dependency allowlist rejects unknown and non-function seams", async () => {
  for (const dependencies of [{ unknown: () => {} }, { openDatabase: true }]) {
    const error = captureStream();
    const exitCode = await runInitialAdminBootstrapCli({
      argv: ["--help"], stdout: captureStream().stream, stderr: error.stream, dependencies
    });
    assert.equal(exitCode, 2);
    assert.match(error.text(), /BOOTSTRAP_USAGE_INVALID/);
  }
});

function validArgv(databasePath, username = "Initial.Owner", email = "Owner@Example.Test") {
  return [
    "--database", databasePath,
    "--username", username,
    "--email", email,
    "--display-name", "Initial Owner"
  ];
}

function captureStream() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, encoding, callback) {
        value += chunk.toString();
        callback();
      }
    }),
    text: () => value
  };
}

function interactiveInput(events) {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.isRaw = false;
  stream.rawModes = [];
  let index = 0;
  stream.setRawMode = (enabled) => {
    stream.isRaw = enabled;
    stream.rawModes.push(enabled);
    if (!enabled || index >= events.length) return stream;
    const event = events[index];
    index += 1;
    setImmediate(() => {
      if (event instanceof Error) stream.emit("error", event);
      else if (event?.signal) process.emit(event.signal);
      else stream.write(event);
    });
    return stream;
  };
  return stream;
}

function successfulDependencies(overrides = {}) {
  return {
    openDatabase: async () => ({}),
    runMigrations: async () => ({ currentVersion: 5, applied: [] }),
    runQuickCheck: () => ({ ok: true }),
    runForeignKeyCheck: () => ({ ok: true }),
    closeDatabase: async () => {},
    bootstrapInitialAdmin: async () => {},
    ...overrides
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "smartrecord-bootstrap-cli-"));
  t.after(async () => {
    for (const entry of await import("node:fs/promises").then((module) => module.readdir(directory).catch(() => []))) {
      if (entry.endsWith("-wal") || entry.endsWith("-shm")) {
        const stats = await lstat(path.join(directory, entry));
        assert.equal(stats.isFile(), true);
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
