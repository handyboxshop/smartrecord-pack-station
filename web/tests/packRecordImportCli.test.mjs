import assert from "node:assert/strict";
import {
  access,
  link as createLink,
  lstat as fsLstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  importPackRecordSnapshot,
  runPackRecordImportCli
} from "../scripts/import-pack-records.mjs";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  runSqliteForeignKeyCheck,
  runSqliteQuickCheck
} from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import { verifyPackRecordImport } from "../src/storage/packRecordImportVerifier.mjs";

const CUSTOMER_LIKE_VALUE = "buyer-secret@example.test";
const CLI_PATH = fileURLToPath(new URL("../scripts/import-pack-records.mjs", import.meta.url));
const SAFE_STAGING_ID_PATTERN = /^[A-Za-z0-9-]+$/;

function validSnapshot() {
  return [
    {
      id: "record-newest",
      awb: "AWB-NEWEST",
      status: "pass",
      itemSummary: CUSTOMER_LIKE_VALUE,
      shareLink: "https://private.example.test/share/customer-token",
      video: {
        fileName: "synthetic.mp4",
        relativePath: "videos/synthetic.mp4",
        bytes: 1234,
        contentType: "video/mp4",
        savedAt: "2026-07-16T01:02:03.000Z"
      }
    },
    {
      id: "record-oldest",
      awb: "AWB-OLDEST",
      status: "warn"
    }
  ];
}

test("imports, verifies, closes, and promotes a valid snapshot without changing its bytes", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = path.join(directory, "source.json");
  const destinationPath = path.join(directory, "records.sqlite");
  const sourceBytes = Buffer.from(`${JSON.stringify(validSnapshot(), null, 2)}\n`, "utf8");
  await writeFile(sourcePath, sourceBytes);
  const messages = [];
  const errors = [];

  const exitCode = await runPackRecordImportCli({
    argv: [sourcePath, destinationPath],
    output: (message) => messages.push(message),
    errorOutput: (message) => errors.push(message)
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(errors, []);
  assert.match(messages.join("\n"), /^status=success$/m);
  assert.match(messages.join("\n"), /^imported_records=2$/m);
  assert.match(messages.join("\n"), /^imported_videos=1$/m);
  assert.match(messages.join("\n"), /^verified_records=2$/m);
  assert.equal(messages.join("\n").includes(CUSTOMER_LIKE_VALUE), false);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  await access(destinationPath);
  await assert.rejects(access(`${destinationPath}-wal`));
  await assert.rejects(access(`${destinationPath}-shm`));
  assert.deepEqual(await stagingDatabaseNames(directory), []);

  const database = await openSqliteDatabase(destinationPath);
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 2);
    assert.equal(database.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'orders'
    `).get(), undefined);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pack_records").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pack_record_videos").get().count, 1);
    const batchTimestamp = database.prepare(
      "SELECT created_at FROM pack_records ORDER BY record_sequence DESC LIMIT 1"
    ).get().created_at;
    const importResult = {
      ok: true,
      status: "imported",
      inputRecordCount: 2,
      insertedPackRecordRows: 2,
      insertedVideoRows: 1,
      batchTimestamp,
      recordSequenceFirst: 1,
      recordSequenceLast: 0
    };
    const verification = verifyPackRecordImport(database, validSnapshot(), importResult);
    assert.equal(verification.ok, true);
    assert.equal(runSqliteQuickCheck(database).ok, true);
    assert.equal(runSqliteForeignKeyCheck(database).ok, true);
  } finally {
    closeSqliteDatabase(database);
  }
});

test("orchestration returns only safe counts and verification metadata", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "direct.sqlite");

  let closeCalls = 0;
  const result = await importPackRecordSnapshot({
    sourcePath,
    destinationPath,
    dependencies: {
      closeSqliteDatabase(database) {
        closeCalls += 1;
        return closeSqliteDatabase(database);
      }
    }
  });

  assert.equal(result.importResult.insertedPackRecordRows, 2);
  assert.equal(result.importResult.insertedVideoRows, 1);
  assert.equal(result.verificationResult.ok, true);
  assert.equal(result.integrityResult.quickCheck.ok, true);
  assert.equal(result.integrityResult.foreignKeyCheck.ok, true);
  assert.equal(closeCalls, 1);
  assert.equal(result.promotionState, "committed");
});

test("requires source and destination arguments and rejects unknown arguments", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "never-created.sqlite");

  for (const scenario of [
    { argv: [], code: "SOURCE_ARGUMENT_REQUIRED" },
    { argv: [sourcePath], code: "DESTINATION_ARGUMENT_REQUIRED" },
    { argv: [sourcePath, destinationPath, "--unknown"], code: "UNKNOWN_ARGUMENT" },
    { argv: ["--unknown", destinationPath], code: "UNKNOWN_ARGUMENT" }
  ]) {
    const result = await invokeCli(scenario.argv);
    assert.equal(result.exitCode, 1);
    assert.match(result.errors, new RegExp(`code=${scenario.code}`));
    assert.match(result.errors, /Usage: npm run db:import-pack-records/);
    assert.equal(result.errors.includes(sourcePath), false);
  }
  await assert.rejects(access(destinationPath));
});

test("rejects missing and non-file sources before database creation", async (t) => {
  const directory = await temporaryDirectory(t);
  const destinationPath = path.join(directory, "destination.sqlite");

  const missing = await invokeCli([path.join(directory, "missing.json"), destinationPath]);
  assertFailure(missing, "SOURCE_NOT_FOUND");

  const directorySource = path.join(directory, "source-directory");
  await mkdir(directorySource);
  const nonFile = await invokeCli([directorySource, destinationPath]);
  assertFailure(nonFile, "SOURCE_NOT_FILE");
  await assert.rejects(access(destinationPath));
  assert.deepEqual(await stagingDatabaseNames(directory), []);
});

test("rejects an unreadable source deterministically before database creation", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "destination.sqlite");

  const result = await invokeCli([sourcePath, destinationPath], {
    access: async () => {
      const error = new Error("synthetic access failure");
      error.code = "EACCES";
      throw error;
    }
  });

  assertFailure(result, "SOURCE_NOT_READABLE");
  await assert.rejects(access(destinationPath));
});

test("rejects malformed JSON without changing source bytes or creating a database", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = path.join(directory, "malformed.json");
  const destinationPath = path.join(directory, "destination.sqlite");
  const original = Buffer.from(`{ "customer": "${CUSTOMER_LIKE_VALUE}"`, "utf8");
  await writeFile(sourcePath, original);

  const result = await invokeCli([sourcePath, destinationPath]);

  assertFailure(result, "SOURCE_JSON_INVALID");
  assert.equal(result.errors.includes(CUSTOMER_LIKE_VALUE), false);
  assert.deepEqual(await readFile(sourcePath), original);
  await assert.rejects(access(destinationPath));
  assert.deepEqual(await stagingDatabaseNames(directory), []);
});

test("rejects structurally invalid snapshots without leaking payload data", async (t) => {
  const directory = await temporaryDirectory(t);
  const invalidSnapshot = [{ id: CUSTOMER_LIKE_VALUE, status: "pass" }];
  const sourcePath = await writeSnapshot(directory, invalidSnapshot);
  const destinationPath = path.join(directory, "destination.sqlite");
  const original = await readFile(sourcePath);

  const result = await invokeCli([sourcePath, destinationPath]);

  assertFailure(result, "SOURCE_STRUCTURE_INVALID");
  assert.equal(result.errors.includes(CUSTOMER_LIKE_VALUE), false);
  assert.deepEqual(await readFile(sourcePath), original);
  await assert.rejects(access(destinationPath));
  assert.deepEqual(await stagingDatabaseNames(directory), []);
});

test("rejects the same resolved source and destination path", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const original = await readFile(sourcePath);

  const result = await invokeCli([sourcePath, path.join(directory, ".", "source.json")]);

  assertFailure(result, "SOURCE_DESTINATION_SAME");
  assert.deepEqual(await readFile(sourcePath), original);
});

test("never overwrites an existing destination", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "existing.sqlite");
  const existingBytes = Buffer.from("operator-owned-destination", "utf8");
  await writeFile(destinationPath, existingBytes);

  const result = await invokeCli([sourcePath, destinationPath]);

  assertFailure(result, "DESTINATION_EXISTS");
  assert.deepEqual(await readFile(destinationPath), existingBytes);
  assert.deepEqual(await stagingDatabaseNames(directory), []);
});

test("does not create a missing destination parent", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const missingParent = path.join(directory, "missing-parent");
  const destinationPath = path.join(missingParent, "destination.sqlite");

  const result = await invokeCli([sourcePath, destinationPath]);

  assertFailure(result, "DESTINATION_PARENT_NOT_FOUND");
  await assert.rejects(access(missingParent));
});

test("rejects a destination parent that is not a directory", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const parentFile = path.join(directory, "parent-file");
  await writeFile(parentFile, "not a directory");

  const result = await invokeCli([sourcePath, path.join(parentFile, "destination.sqlite")]);

  assertFailure(result, "DESTINATION_PARENT_NOT_DIRECTORY");
  assert.equal((await readFile(parentFile, "utf8")), "not a directory");
});

test("a destination race cannot overwrite the file created by another operator", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "raced.sqlite");
  const operatorBytes = Buffer.from("created-during-import", "utf8");

  const result = await invokeCli([sourcePath, destinationPath], {
    async link(stagingPath, selectedDestinationPath) {
      await writeFile(selectedDestinationPath, operatorBytes, { flag: "wx" });
      return createLink(stagingPath, selectedDestinationPath);
    }
  });

  assertFailure(result, "DESTINATION_EXISTS");
  assert.deepEqual(await readFile(destinationPath), operatorBytes);
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
});

test("an existing-row import conflict closes the database and never promotes it", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "conflict.sqlite");
  let closeCalls = 0;

  const result = await invokeCli([sourcePath, destinationPath], {
    async runSqliteMigrations(database, options) {
      const migrationResult = await runSqliteMigrations(database, options);
      database.prepare(`
        INSERT INTO pack_records (
          id, record_sequence, awb, awb_normalized, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        "record-newest",
        99,
        "SYNTHETIC-CONFLICT",
        "SYNTHETIC-CONFLICT",
        "pass",
        "2026-07-16T00:00:00.000Z",
        "2026-07-16T00:00:00.000Z"
      );
      return migrationResult;
    },
    closeSqliteDatabase(database) {
      closeCalls += 1;
      return closeSqliteDatabase(database);
    }
  });

  assertFailure(result, "PACK_RECORD_IMPORT_CONFLICT");
  assert.equal(result.errors.includes(CUSTOMER_LIKE_VALUE), false);
  assert.equal(result.errors.includes("status=success"), false);
  assert.equal(closeCalls, 1);
  await assert.rejects(access(destinationPath));
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
});

test("a verification mismatch closes the database and never promotes it", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "verification-failure.sqlite");
  let closeCalls = 0;

  const result = await invokeCli([sourcePath, destinationPath], {
    verifyPackRecordImport() {
      return { ok: false };
    },
    closeSqliteDatabase(database) {
      closeCalls += 1;
      return closeSqliteDatabase(database);
    }
  });

  assertFailure(result, "PACK_RECORD_IMPORT_VERIFICATION_MISMATCH");
  assert.equal(closeCalls, 1);
  await assert.rejects(access(destinationPath));
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
});

test("a migration failure closes the database and never promotes it", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "migration-failure.sqlite");
  let closeCalls = 0;

  const result = await invokeCli([sourcePath, destinationPath], {
    async runSqliteMigrations() {
      throw new Error("synthetic migration failure");
    },
    closeSqliteDatabase(database) {
      closeCalls += 1;
      return closeSqliteDatabase(database);
    }
  });

  assertFailure(result, "SQLITE_MIGRATION_FAILED");
  assert.equal(closeCalls, 1);
  await assert.rejects(access(destinationPath));
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
});

test("a deterministic integrity failure closes the database and never promotes it", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "integrity-failure.sqlite");
  let closeCalls = 0;

  const result = await invokeCli([sourcePath, destinationPath], {
    runSqliteQuickCheck() {
      return { ok: false, messages: [CUSTOMER_LIKE_VALUE] };
    },
    closeSqliteDatabase(database) {
      closeCalls += 1;
      return closeSqliteDatabase(database);
    }
  });

  assertFailure(result, "SQLITE_INTEGRITY_INVALID");
  assert.equal(result.errors.includes(CUSTOMER_LIKE_VALUE), false);
  assert.equal(closeCalls, 1);
  await assert.rejects(access(destinationPath));
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
});

test("unsupported hard links fail before commit and preserve staging", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "unsupported.sqlite");

  const result = await invokeCli([sourcePath, destinationPath], {
    async link() {
      const error = new Error("synthetic unsupported hard link");
      error.code = "ENOTSUP";
      throw error;
    }
  });

  assertFailure(result, "HARD_LINK_UNSUPPORTED");
  await assert.rejects(access(destinationPath));
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
  assert.match(readStagingId(result.errors), SAFE_STAGING_ID_PATTERN);
  assert.equal(result.errors.includes(sourcePath), false);
  assert.equal(result.errors.includes(destinationPath), false);
});

test("unlink failure after commit returns success with a cleanup warning", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "cleanup-warning.sqlite");
  const sourceBytes = await readFile(sourcePath);

  const result = await invokeCli([sourcePath, destinationPath], {
    async unlink() {
      const error = new Error("synthetic staging alias cleanup failure");
      error.code = "EPERM";
      throw error;
    }
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^status=success$/m);
  assert.match(result.output, /^cleanup_warning=STAGING_ALIAS_CLEANUP_FAILED$/m);
  assert.equal(result.errors, "");
  assert.match(readStagingId(result.output), SAFE_STAGING_ID_PATTERN);
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);

  const database = await openSqliteDatabase(destinationPath);
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pack_records").get().count, 2);
    assert.equal(runSqliteQuickCheck(database).ok, true);
    assert.equal(runSqliteForeignKeyCheck(database).ok, true);
  } finally {
    closeSqliteDatabase(database);
  }

  const retry = await invokeCli([sourcePath, destinationPath]);
  assertFailure(retry, "DESTINATION_EXISTS");
});

test("post-link identity-check failure remains committed warning success", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "identity-warning.sqlite");
  const sourceBytes = await readFile(sourcePath);
  let linked = false;

  const result = await invokeCli([sourcePath, destinationPath], {
    async link(stagingPath, finalPath) {
      await createLink(stagingPath, finalPath);
      linked = true;
    },
    async lstat(filePath) {
      if (linked && String(filePath).endsWith("identity-warning.sqlite")) {
        throw new Error("synthetic\n\u001b[31m final identity failure");
      }
      return fsLstat(filePath);
    }
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^status=success$/m);
  assert.match(
    result.output,
    /^cleanup_warning=COMMITTED_DESTINATION_IDENTITY_CHECK_FAILED$/m
  );
  assert.equal(result.errors, "");
  assert.match(readStagingId(result.output), SAFE_STAGING_ID_PATTERN);
  assert.equal(result.output.includes("\u001b"), false);
  assert.equal(result.output.includes("synthetic\n"), false);
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);

  const database = await openSqliteDatabase(destinationPath);
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pack_records").get().count, 2);
  } finally {
    closeSqliteDatabase(database);
  }

  const retry = await invokeCli([sourcePath, destinationPath]);
  assertFailure(retry, "DESTINATION_EXISTS");
});

test("checkpoint failure closes the database and prevents promotion", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "checkpoint-failure.sqlite");
  let closeCalls = 0;

  const result = await invokeCli([sourcePath, destinationPath], {
    checkpointSqliteDatabase() {
      throw new Error("synthetic checkpoint failure");
    },
    closeSqliteDatabase(database) {
      closeCalls += 1;
      return closeSqliteDatabase(database);
    }
  });

  assertFailure(result, "SQLITE_CHECKPOINT_FAILED");
  assert.equal(closeCalls, 1);
  await assert.rejects(access(destinationPath));
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
});

test("reported close failure prevents promotion without false success", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "close-failure.sqlite");
  let closeCalls = 0;

  const result = await invokeCli([sourcePath, destinationPath], {
    closeSqliteDatabase(database) {
      closeCalls += 1;
      closeSqliteDatabase(database);
      throw new Error("synthetic close result failure");
    }
  });

  assertFailure(result, "SQLITE_CLOSE_FAILED");
  assert.equal(closeCalls, 1);
  await assert.rejects(access(destinationPath));
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
});

test("a reported WAL sidecar after close prevents promotion", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "sidecar-remains.sqlite");

  const result = await invokeCli([sourcePath, destinationPath], {
    async lstat(filePath) {
      if (String(filePath).endsWith("-wal")) return {};
      return fsLstat(filePath);
    }
  });

  assertFailure(result, "SQLITE_SIDECAR_REMAINS");
  await assert.rejects(access(destinationPath));
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
});

test("staging collision does not claim the pre-existing artifact", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "collision-destination.sqlite");
  const stagingId = "collision-safe-id";
  const collisionPath = path.join(
    directory,
    `.smartrecord-pack-records.staging-${stagingId}.sqlite`
  );
  const existingBytes = Buffer.from("pre-existing-staging-artifact", "utf8");
  await writeFile(collisionPath, existingBytes);

  const result = await invokeCli([sourcePath, destinationPath], {
    randomUUID: () => stagingId
  });

  assertFailure(result, "STAGING_COLLISION");
  assert.equal(result.errors.includes("staging_id="), false);
  assert.equal(result.errors.includes(stagingId), false);
  assert.deepEqual(await readFile(collisionPath), existingBytes);
  await assert.rejects(access(destinationPath));
});

test("unsafe source and destination basenames cannot inject log output", async (t) => {
  const directory = await temporaryDirectory(t);
  const unsafeFragment = "unsafe\n\u001b[31m-customer";
  const sourcePath = path.join(directory, `${unsafeFragment}.json`);
  const destinationPath = path.join(directory, `${unsafeFragment}.sqlite`);
  const sourceBytes = Buffer.from(`${JSON.stringify(validSnapshot())}\n`, "utf8");
  await writeFile(sourcePath, sourceBytes);

  const result = await invokeCli([sourcePath, destinationPath], {
    async link() {
      const error = new Error("synthetic unsupported hard link");
      error.code = "ENOTSUP";
      throw error;
    }
  });

  assertFailure(result, "HARD_LINK_UNSUPPORTED");
  assert.equal(result.errors.includes("\u001b"), false);
  assert.equal(result.errors.includes("unsafe\n"), false);
  assert.equal(result.errors.includes("customer"), false);
  assert.match(readStagingId(result.errors), SAFE_STAGING_ID_PATTERN);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
});

test("staging identity mismatch fails before database open and promotion", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "identity-mismatch.sqlite");

  const result = await invokeCli([sourcePath, destinationPath], {
    async lstat(filePath) {
      const stats = await fsLstat(filePath);
      if (!String(filePath).includes(".staging-")) return stats;
      return new Proxy(stats, {
        get(target, property) {
          if (property === "ino") return Number(target.ino) + 1;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  });

  assertFailure(result, "STAGING_IDENTITY_MISMATCH");
  await assert.rejects(access(destinationPath));
  assert.equal((await stagingDatabaseNames(directory)).length, 1);
});

test("direct CLI execution uses argv and process exit codes", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = await writeSnapshot(directory, validSnapshot());
  const destinationPath = path.join(directory, "subprocess.sqlite");
  const sourceBytes = await readFile(sourcePath);

  const success = await runCliProcess([sourcePath, destinationPath]);
  assert.equal(success.code, 0);
  assert.match(success.stdout, /^status=success$/m);
  assert.equal(success.stderr.includes(CUSTOMER_LIKE_VALUE), false);
  assert.equal(success.stdout.includes(sourcePath), false);
  assert.equal(success.stdout.includes(destinationPath), false);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  await access(destinationPath);

  const invalid = await runCliProcess([]);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /code=SOURCE_ARGUMENT_REQUIRED/);
  assert.match(invalid.stderr, /Usage: npm run db:import-pack-records/);
});

async function invokeCli(argv, dependencies = {}) {
  const output = [];
  const errors = [];
  const exitCode = await runPackRecordImportCli({
    argv,
    dependencies,
    output: (message) => output.push(message),
    errorOutput: (message) => errors.push(message)
  });
  return {
    exitCode,
    output: output.join("\n"),
    errors: errors.join("\n")
  };
}

function assertFailure(result, code) {
  assert.equal(result.exitCode, 1);
  assert.match(result.errors, /status=failed/);
  assert.match(result.errors, new RegExp(`code=${code}`));
  assert.equal(result.output.includes("status=success"), false);
}

function readStagingId(output) {
  const match = output.match(/^staging_id=([^\n]+)$/m);
  assert.ok(match, "expected one safe staging identifier");
  return match[1];
}

function runCliProcess(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...argv], {
      cwd: path.dirname(CLI_PATH),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "smartrecord-pack-import-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeSnapshot(directory, snapshot) {
  const sourcePath = path.join(directory, "source.json");
  await writeFile(sourcePath, `${JSON.stringify(snapshot)}\n`, "utf8");
  return sourcePath;
}

async function stagingDatabaseNames(directory) {
  return (await readdir(directory)).filter((name) => name.includes(".staging-"));
}
