import assert from "node:assert/strict";
import test from "node:test";
import { importPackRecords } from "../src/storage/packRecordImporter.mjs";
import * as verifier from "../src/storage/packRecordImportVerifier.mjs";
import {
  closeSqliteDatabase,
  openInMemoryDatabase
} from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";

const {
  PackRecordImportVerificationError,
  buildPackRecordImportVerificationReport,
  verifyPackRecordImport
} = verifier;

const FIXED_TIMESTAMP = "2026-07-15T12:34:56.789Z";

function validRecord(overrides = {}) {
  return { id: "record-1", awb: " AWB-1 ", status: "pass", ...overrides };
}

function importedResult(input, overrides = {}) {
  const expectedVideoRows = input.filter((record) => (
    record.video !== null
    && typeof record.video === "object"
    && !Array.isArray(record.video)
  )).length;
  return input.length === 0
    ? {
        ok: true,
        status: "no-op",
        inputRecordCount: 0,
        insertedPackRecordRows: 0,
        insertedVideoRows: 0,
        batchTimestamp: null,
        recordSequenceFirst: null,
        recordSequenceLast: null,
        ...overrides
      }
    : {
        ok: true,
        status: "imported",
        inputRecordCount: input.length,
        insertedPackRecordRows: input.length,
        insertedVideoRows: expectedVideoRows,
        batchTimestamp: FIXED_TIMESTAMP,
        recordSequenceFirst: input.length - 1,
        recordSequenceLast: 0,
        ...overrides
      };
}

function deeplyFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deeplyFreeze(child);
  }
  return value;
}

function expectVerificationError(callback, code) {
  let captured;
  assert.throws(callback, (error) => {
    captured = error;
    assert.equal(error instanceof PackRecordImportVerificationError, true);
    assert.equal(error.name, "PackRecordImportVerificationError");
    assert.equal(error.code, code);
    assert.equal(typeof error.message, "string");
    assert.equal(Object.getPrototypeOf(error.details), Object.prototype);
    return true;
  });
  return captured;
}

async function migratedDatabase(t) {
  const database = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(database));
  await runSqliteMigrations(database, {
    now: () => new Date(FIXED_TIMESTAMP),
    maximumVersion: 2
  });
  return database;
}

async function importedDatabase(t, input) {
  const database = await migratedDatabase(t);
  const importResult = importPackRecords(database, input, {
    now: () => new Date(FIXED_TIMESTAMP)
  });
  return { database, importResult };
}

function wrapDatabase(database, { prepare, exec } = {}) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return prepare ? prepare(sql, statement) : statement;
    },
    exec(sql) {
      const execute = () => database.exec(sql);
      return exec ? exec(sql, execute) : execute();
    }
  };
}

function tableCount(database, table) {
  const sql = table === "pack_records"
    ? "SELECT COUNT(*) AS count FROM pack_records"
    : "SELECT COUNT(*) AS count FROM pack_record_videos";
  return database.prepare(sql).get().count;
}

function insertExtraParent(database, {
  id = "extra-record",
  awb = "EXTRA-AWB",
  recordSequence = 99
} = {}) {
  database.prepare(`
    INSERT INTO pack_records (
      id, record_sequence, awb, awb_normalized, status,
      source_payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pass', ?, ?, ?)
  `).run(
    id,
    recordSequence,
    awb,
    awb.trim(),
    JSON.stringify({ id, awb, status: "pass" }),
    FIXED_TIMESTAMP,
    FIXED_TIMESTAMP
  );
}

function insertVideo(database, recordId, overrides = {}) {
  const values = {
    fileName: null,
    mountedRequired: null,
    simulated: null,
    ...overrides
  };
  database.prepare(`
    INSERT INTO pack_record_videos (
      record_id, file_name, mounted_required, simulated
    ) VALUES (?, ?, ?, ?)
  `).run(recordId, values.fileName, values.mountedRequired, values.simulated);
}

function publicErrorText(error) {
  return JSON.stringify({ message: error.message, details: error.details });
}

test("exports exactly the required synchronous public API", () => {
  assert.deepEqual(Object.keys(verifier).sort(), [
    "PackRecordImportVerificationError",
    "buildPackRecordImportVerificationReport",
    "verifyPackRecordImport"
  ]);
  assert.equal(
    Object.getPrototypeOf(PackRecordImportVerificationError.prototype).constructor.name,
    "SqliteStorageError"
  );
  assert.equal(verifyPackRecordImport.constructor.name, "Function");
  assert.equal(buildPackRecordImportVerificationReport.constructor.name, "Function");
});

test("invalid input is rejected before either database method is called", () => {
  const calls = [];
  const database = {
    prepare() { calls.push("prepare"); },
    exec() { calls.push("exec"); }
  };
  const error = expectVerificationError(
    () => verifyPackRecordImport(database, [{ id: "SECRET-ID" }], {}),
    "PACK_RECORD_IMPORT_VERIFICATION_INPUT_INVALID"
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(error.details, {});
  assert.doesNotMatch(publicErrorText(error), /SECRET-ID/);
});

test("throwing initial input length inspection is translated safely before database access", () => {
  const marker = "RAW-LENGTH-MARKER SQL-ID-AWB-PAYLOAD /secret/path";
  const target = deeplyFreeze([validRecord()]);
  const targetSnapshot = structuredClone(target);
  const calls = [];
  const database = {
    state: "unchanged",
    prepare() { calls.push("prepare"); },
    exec() { calls.push("exec"); }
  };
  let lengthAccessCount = 0;
  const input = new Proxy(target, {
    get(currentTarget, property, receiver) {
      if (property === "length") {
        lengthAccessCount += 1;
        throw new Error(marker);
      }
      return Reflect.get(currentTarget, property, receiver);
    }
  });

  const error = expectVerificationError(
    () => verifyPackRecordImport(database, input, importedResult(target)),
    "PACK_RECORD_IMPORT_VERIFICATION_INPUT_INVALID"
  );

  assert.equal(lengthAccessCount, 1);
  assert.deepEqual(calls, []);
  assert.equal(database.state, "unchanged");
  assert.deepEqual(target, targetSnapshot);
  assert.equal(Object.isFrozen(target), true);
  assert.deepEqual(error.details, {});
  assert.doesNotMatch(publicErrorText(error), /RAW-LENGTH|SQL-ID|AWB|PAYLOAD|\/secret\/path/);
});

test("verified input count is reused without another input length inspection", async (t) => {
  const marker = "RAW-REPEATED-LENGTH-MARKER";
  const inputTarget = deeplyFreeze([validRecord({ video: {} })]);
  const inputSnapshot = structuredClone(inputTarget);
  const { database, importResult } = await importedDatabase(t, inputTarget);
  const importResultSnapshot = structuredClone(importResult);
  const countsBefore = [
    tableCount(database, "pack_records"),
    tableCount(database, "pack_record_videos")
  ];
  let lengthAccessCount = 0;
  const input = new Proxy(inputTarget, {
    get(currentTarget, property, receiver) {
      if (property === "length") {
        lengthAccessCount += 1;
        if (lengthAccessCount > 1) throw new Error(marker);
      }
      return Reflect.get(currentTarget, property, receiver);
    }
  });

  const result = verifyPackRecordImport(database, input, importResult);

  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(lengthAccessCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /RAW-REPEATED-LENGTH/);
  assert.equal(database.prepare("SELECT 1 AS value").get().value, 1);
  assert.deepEqual([
    tableCount(database, "pack_records"),
    tableCount(database, "pack_record_videos")
  ], countsBefore);
  assert.deepEqual(inputTarget, inputSnapshot);
  assert.deepEqual(importResult, importResultSnapshot);
});

test("invalid import results are rejected exactly before database access", () => {
  const input = [validRecord()];
  const fields = [
    "ok",
    "status",
    "inputRecordCount",
    "insertedPackRecordRows",
    "insertedVideoRows",
    "batchTimestamp",
    "recordSequenceFirst",
    "recordSequenceLast"
  ];
  for (const field of fields) {
    const calls = [];
    const database = {
      prepare() { calls.push("prepare"); },
      exec() { calls.push("exec"); }
    };
    const invalid = importedResult(input);
    invalid[field] = field === "batchTimestamp" ? "2026-07-15T12:34:56Z" : "wrong";
    const error = expectVerificationError(
      () => verifyPackRecordImport(database, input, invalid),
      "PACK_RECORD_IMPORT_VERIFICATION_RESULT_INVALID"
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(error.details, { field });
    assert.doesNotMatch(publicErrorText(error), /wrong|2026-07-15T12:34:56Z/);
  }
});

test("throwing import result introspection is translated safely before database access", () => {
  const input = deeplyFreeze([validRecord()]);
  const inputSnapshot = structuredClone(input);
  const marker = "RAW-PROXY-MARKER SQL-ID-AWB-PAYLOAD /secret/path";
  const cases = [
    {
      name: "getPrototypeOf",
      handler: {
        getPrototypeOf() { throw new Error(marker); }
      }
    },
    {
      name: "getOwnPropertyDescriptor",
      handler: {
        getOwnPropertyDescriptor() { throw new Error(marker); }
      }
    }
  ];

  for (const currentCase of cases) {
    const calls = [];
    const database = {
      state: "unchanged",
      prepare() { calls.push("prepare"); },
      exec() { calls.push("exec"); }
    };
    const target = deeplyFreeze(importedResult(input));
    const targetSnapshot = structuredClone(target);
    const importResult = new Proxy(target, currentCase.handler);

    const error = expectVerificationError(
      () => verifyPackRecordImport(database, input, importResult),
      "PACK_RECORD_IMPORT_VERIFICATION_RESULT_INVALID"
    );

    assert.deepEqual(calls, [], currentCase.name);
    assert.equal(database.state, "unchanged", currentCase.name);
    assert.deepEqual(input, inputSnapshot, currentCase.name);
    assert.deepEqual(target, targetSnapshot, currentCase.name);
    assert.equal(Object.isFrozen(target), true, currentCase.name);
    assert.deepEqual(error.details, { field: "importResult" }, currentCase.name);
    assert.doesNotMatch(publicErrorText(error), /RAW-PROXY|SQL-ID|AWB|PAYLOAD|\/secret\/path/);
  }
});

test("empty import result contract is exact and null-prototype objects are accepted", async (t) => {
  const database = await migratedDatabase(t);
  const accepted = Object.assign(Object.create(null), importedResult([]), {
    ignoredFutureProperty: "not-copied"
  });
  assert.equal(verifyPackRecordImport(database, [], accepted).status, "verified");

  for (const [field, value] of [
    ["status", "imported"],
    ["batchTimestamp", FIXED_TIMESTAMP],
    ["recordSequenceFirst", 0],
    ["recordSequenceLast", 0]
  ]) {
    const invalid = importedResult([], { [field]: value });
    expectVerificationError(
      () => verifyPackRecordImport(database, [], invalid),
      "PACK_RECORD_IMPORT_VERIFICATION_RESULT_INVALID"
    );
  }
});

test("canonical ISO timestamps and expected video counts are required", async (t) => {
  const database = await migratedDatabase(t);
  const input = [validRecord({ video: {} })];
  for (const batchTimestamp of [
    "2026-07-15T12:34:56Z",
    "2026-07-15T19:34:56.789+07:00",
    "not-a-date",
    1
  ]) {
    expectVerificationError(
      () => verifyPackRecordImport(
        database,
        input,
        importedResult(input, { batchTimestamp })
      ),
      "PACK_RECORD_IMPORT_VERIFICATION_RESULT_INVALID"
    );
  }
  expectVerificationError(
    () => verifyPackRecordImport(
      database,
      input,
      importedResult(input, { insertedVideoRows: 0 })
    ),
    "PACK_RECORD_IMPORT_VERIFICATION_RESULT_INVALID"
  );
});

test("input and import result remain deeply unchanged", async (t) => {
  const input = deeplyFreeze([validRecord({
    storage: deeplyFreeze({ targetId: "target" }),
    video: deeplyFreeze({ fileName: "clip.mp4" }),
    metadata: deeplyFreeze({ nested: [1, 2, 3] })
  })]);
  const database = await migratedDatabase(t);
  const importResult = importPackRecords(database, input, {
    now: () => new Date(FIXED_TIMESTAMP)
  });
  deeplyFreeze(importResult);

  assert.equal(verifyPackRecordImport(database, input, importResult).ok, true);
  assert.equal(Object.isFrozen(input[0].metadata.nested), true);
  assert.equal(Object.isFrozen(importResult), true);
});

test("database interface validation is typed and safe", () => {
  for (const database of [null, {}, { prepare() {} }, { exec() {} }]) {
    expectVerificationError(
      () => verifyPackRecordImport(database, [], importedResult([])),
      "PACK_RECORD_IMPORT_VERIFICATION_DATABASE_INVALID"
    );
  }
  const marker = "RAW-DATABASE-GETTER SECRET-PATH";
  const database = {};
  Object.defineProperty(database, "prepare", {
    get() { throw new Error(marker); }
  });
  const error = expectVerificationError(
    () => verifyPackRecordImport(database, [], importedResult([])),
    "PACK_RECORD_IMPORT_VERIFICATION_DATABASE_INVALID"
  );
  assert.doesNotMatch(publicErrorText(error), /RAW-DATABASE-GETTER|SECRET-PATH/);
});

test("uses only a deferred BEGIN and read statements, then commits", async (t) => {
  const input = [validRecord({ video: {} })];
  const { database, importResult } = await importedDatabase(t, input);
  const execCalls = [];
  const prepareCalls = [];
  const wrapped = wrapDatabase(database, {
    exec(sql, execute) {
      execCalls.push(sql);
      return execute();
    },
    prepare(sql, statement) {
      prepareCalls.push(sql);
      return statement;
    }
  });

  assert.equal(verifyPackRecordImport(wrapped, input, importResult).ok, true);
  assert.deepEqual(execCalls, ["BEGIN", "COMMIT"]);
  assert.equal(execCalls.includes("BEGIN IMMEDIATE"), false);
  assert.equal(execCalls.includes("BEGIN EXCLUSIVE"), false);
  assert.equal(execCalls.some((sql) => /SAVEPOINT/i.test(sql)), false);
  assert.equal(
    prepareCalls.some((sql) => /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql)),
    false
  );
});

test("a mismatch commits and leaves the caller-owned database open and unchanged", async (t) => {
  const input = [validRecord()];
  const { database, importResult } = await importedDatabase(t, input);
  database.prepare("UPDATE pack_records SET platform = ? WHERE id = ?")
    .run("different", input[0].id);
  const before = [tableCount(database, "pack_records"), tableCount(database, "pack_record_videos")];
  const execCalls = [];
  const wrapped = wrapDatabase(database, {
    exec(sql, execute) {
      execCalls.push(sql);
      return execute();
    }
  });

  const result = verifyPackRecordImport(wrapped, input, importResult);
  assert.equal(result.status, "mismatch");
  assert.deepEqual(execCalls, ["BEGIN", "COMMIT"]);
  assert.deepEqual(
    [tableCount(database, "pack_records"), tableCount(database, "pack_record_videos")],
    before
  );
  assert.equal(database.prepare("SELECT 1 AS value").get().value, 1);
});

test("successful verification leaves the caller-owned database open and row counts unchanged", async (t) => {
  const input = [validRecord({ video: {} })];
  const { database, importResult } = await importedDatabase(t, input);
  const before = [tableCount(database, "pack_records"), tableCount(database, "pack_record_videos")];

  assert.equal(verifyPackRecordImport(database, input, importResult).ok, true);
  assert.deepEqual(
    [tableCount(database, "pack_records"), tableCount(database, "pack_record_videos")],
    before
  );
  assert.equal(database.prepare("SELECT 1 AS value").get().value, 1);
});

test("query and result-construction failures roll back with a safe typed error", async (t) => {
  const input = [validRecord()];
  const { database, importResult } = await importedDatabase(t, input);
  const marker = "RAW-SQLITE-ERROR SECRET-ID SECRET-AWB SECRET-PAYLOAD /secret/path";

  for (const mode of ["prepare", "row-getter"]) {
    const execCalls = [];
    const wrapped = wrapDatabase(database, {
      exec(sql, execute) {
        execCalls.push(sql);
        return execute();
      },
      prepare(sql, statement) {
        if (mode === "prepare" && sql.includes("COUNT(*)") && sql.includes("pack_records")) {
          throw new Error(marker);
        }
        if (mode === "row-getter" && sql.includes("FROM pack_records") && sql.includes("WHERE id")) {
          return {
            get(...values) {
              const row = statement.get(...values);
              Object.defineProperty(row, "platform", {
                get() { throw new Error(marker); }
              });
              return row;
            }
          };
        }
        return statement;
      }
    });
    const error = expectVerificationError(
      () => verifyPackRecordImport(wrapped, input, importResult),
      "PACK_RECORD_IMPORT_VERIFICATION_QUERY_FAILED"
    );
    assert.deepEqual(execCalls, ["BEGIN", "ROLLBACK"]);
    assert.doesNotMatch(publicErrorText(error), /RAW-SQLITE|SECRET|\/secret\/path/);
  }
});

test("rollback, commit, and begin failures have deterministic typed precedence", async (t) => {
  const input = [validRecord()];
  const { database, importResult } = await importedDatabase(t, input);

  const rollbackFailure = wrapDatabase(database, {
    prepare(sql, statement) {
      if (sql.includes("COUNT(*)") && sql.includes("pack_records")) {
        throw new Error("query-marker");
      }
      return statement;
    },
    exec(sql, execute) {
      if (sql === "ROLLBACK") throw new Error("rollback-marker");
      return execute();
    }
  });
  expectVerificationError(
    () => verifyPackRecordImport(rollbackFailure, input, importResult),
    "PACK_RECORD_IMPORT_VERIFICATION_ROLLBACK_FAILED"
  );
  database.exec("ROLLBACK");

  const commitFailure = wrapDatabase(database, {
    exec(sql, execute) {
      if (sql === "COMMIT") throw new Error("commit-marker");
      return execute();
    }
  });
  expectVerificationError(
    () => verifyPackRecordImport(commitFailure, input, importResult),
    "PACK_RECORD_IMPORT_VERIFICATION_COMMIT_FAILED"
  );

  const commitRollbackFailure = wrapDatabase(database, {
    exec(sql, execute) {
      if (sql === "COMMIT") throw new Error("commit-marker");
      if (sql === "ROLLBACK") throw new Error("rollback-marker");
      return execute();
    }
  });
  expectVerificationError(
    () => verifyPackRecordImport(commitRollbackFailure, input, importResult),
    "PACK_RECORD_IMPORT_VERIFICATION_ROLLBACK_FAILED"
  );
  database.exec("ROLLBACK");

  database.exec("BEGIN");
  expectVerificationError(
    () => verifyPackRecordImport(database, input, importResult),
    "PACK_RECORD_IMPORT_VERIFICATION_TRANSACTION_BEGIN_FAILED"
  );
  database.exec("ROLLBACK");
});

test("schema and connection preconditions run inside the snapshot", async (t) => {
  const database = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(database));
  const calls = [];
  const wrapped = wrapDatabase(database, {
    exec(sql, execute) {
      calls.push(sql);
      return execute();
    }
  });
  const versionError = expectVerificationError(
    () => verifyPackRecordImport(wrapped, [], importedResult([])),
    "PACK_RECORD_IMPORT_VERIFICATION_SCHEMA_VERSION_INVALID"
  );
  assert.deepEqual(versionError.details, { expected: 2, actual: 0 });
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK"]);

  database.exec("PRAGMA user_version = 2");
  const missingError = expectVerificationError(
    () => verifyPackRecordImport(database, [], importedResult([])),
    "PACK_RECORD_IMPORT_VERIFICATION_SCHEMA_MISSING"
  );
  assert.deepEqual(missingError.details, {
    missingTables: ["pack_records", "pack_record_videos"]
  });
});

test("disabled foreign keys are rejected inside the snapshot", async (t) => {
  const database = await migratedDatabase(t);
  database.exec("PRAGMA foreign_keys = OFF");
  const error = expectVerificationError(
    () => verifyPackRecordImport(database, [], importedResult([])),
    "PACK_RECORD_IMPORT_VERIFICATION_FOREIGN_KEYS_DISABLED"
  );
  assert.deepEqual(error.details, {});
});

test("empty input verifies only when both Pack Record tables are empty", async (t) => {
  const database = await migratedDatabase(t);
  const emptyResult = verifyPackRecordImport(database, [], importedResult([]));
  assert.deepEqual(emptyResult.records, []);
  assert.equal(emptyResult.ok, true);
  assert.equal(emptyResult.actualPackRecordRows, 0);
  assert.equal(emptyResult.actualVideoRows, 0);
  assert.equal(emptyResult.batchTimestamp, null);

  insertExtraParent(database);
  insertVideo(database, "extra-record");
  const mismatch = verifyPackRecordImport(database, [], importedResult([]));
  assert.deepEqual(mismatch.batchIssues.map(({ code }) => code), [
    "PACK_RECORD_ROW_COUNT_MISMATCH",
    "PACK_RECORD_VIDEO_ROW_COUNT_MISMATCH"
  ]);
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.mismatchedRecordCount, 0);
});

test("minimal, null, and complete mappings verify exactly", async (t) => {
  const input = [
    validRecord({ id: "minimal", awb: " MINIMAL ", platform: null, storage: null }),
    validRecord({
      id: "complete",
      awb: " COMPLETE ",
      platform: "marketplace",
      employeeId: "employee",
      stationId: "station",
      startedAt: "2026-07-15T11:00:00.000Z",
      endedAt: "2026-07-15T11:01:05.000Z",
      durationSeconds: 65,
      status: "warn",
      itemSummary: "two items",
      sizeMb: 12.5,
      storage: {
        targetId: "target",
        label: "NAS",
        provider: "smb",
        host: "host"
      },
      shareLink: "https://example.invalid/share",
      forceCloseReason: "operator",
      video: {
        fileName: "clip.mp4",
        relativePath: "clips/clip.mp4",
        bytes: 1024,
        sizeMb: 1.25,
        contentType: "video/mp4",
        storageTargetId: "target",
        storageLabel: "NAS",
        storageHost: "host",
        storageMode: "mounted",
        mountedRequired: true,
        simulated: false,
        externalUrl: "https://example.invalid/video",
        customPath: "custom/path",
        shareLink: "https://example.invalid/video/share",
        savedAt: "2026-07-15T11:01:05.000Z"
      }
    })
  ];
  const { database, importResult } = await importedDatabase(t, input);
  const result = verifyPackRecordImport(database, input, importResult);

  assert.equal(result.ok, true);
  assert.equal(result.expectedPackRecordRows, 2);
  assert.equal(result.actualPackRecordRows, 2);
  assert.equal(result.expectedVideoRows, 1);
  assert.equal(result.actualVideoRows, 1);
  assert.deepEqual(result.records.map(({ inputIndex, recordSequence }) => ({
    inputIndex,
    recordSequence
  })), [
    { inputIndex: 0, recordSequence: 1 },
    { inputIndex: 1, recordSequence: 0 }
  ]);
  assert.equal(result.batchTimestamp, FIXED_TIMESTAMP);
  assert.equal(result.recordSequenceFirst, 1);
  assert.equal(result.recordSequenceLast, 0);
});

test("empty video objects and SQLite boolean/null mappings verify", async (t) => {
  const input = [
    validRecord({ id: "empty-video", awb: "EMPTY-VIDEO", video: {} }),
    validRecord({
      id: "boolean-video",
      awb: "BOOLEAN-VIDEO",
      video: { mountedRequired: true, simulated: false }
    }),
    validRecord({
      id: "null-video",
      awb: "NULL-VIDEO",
      video: { mountedRequired: null, simulated: null }
    })
  ];
  const { database, importResult } = await importedDatabase(t, input);
  assert.equal(verifyPackRecordImport(database, input, importResult).ok, true);
  assert.deepEqual(
    database.prepare(`
      SELECT record_id, mounted_required, simulated
      FROM pack_record_videos ORDER BY record_id
    `).all().map((row) => ({ ...row })),
    [
      { record_id: "boolean-video", mounted_required: 1, simulated: 0 },
      { record_id: "empty-video", mounted_required: null, simulated: null },
      { record_id: "null-video", mounted_required: null, simulated: null }
    ]
  );
});

test("missing parents and parent column differences produce safe ordered issues", async (t) => {
  const input = [
    validRecord({ id: "missing", awb: "MISSING" }),
    validRecord({ id: "different", awb: "DIFFERENT", platform: "expected", itemSummary: "expected" })
  ];
  const { database, importResult } = await importedDatabase(t, input);
  database.prepare("DELETE FROM pack_records WHERE id = ?").run("missing");
  database.prepare(`
    UPDATE pack_records SET platform = ?, item_summary = ? WHERE id = ?
  `).run("actual", "actual", "different");

  const result = verifyPackRecordImport(database, input, importResult);
  assert.deepEqual(result.records[0].issues.map(({ code }) => code), [
    "PACK_RECORD_ROW_MISSING"
  ]);
  assert.deepEqual(result.records[1].issues.map(({ code, column }) => ({ code, column })), [
    { code: "PACK_RECORD_COLUMN_MISMATCH", column: "platform" },
    { code: "PACK_RECORD_COLUMN_MISMATCH", column: "item_summary" }
  ]);
  assert.equal(result.verifiedRecordCount, 0);
  assert.equal(result.mismatchedRecordCount, 2);
  assert.doesNotMatch(
    JSON.stringify(result),
    /"missing"|"different"|:"expected"|:"actual"/
  );
});

test("an unrelated extra parent is a batch-only mismatch", async (t) => {
  const input = [validRecord()];
  const { database, importResult } = await importedDatabase(t, input);
  insertExtraParent(database);

  const result = verifyPackRecordImport(database, input, importResult);
  assert.equal(result.records[0].verified, true);
  assert.equal(result.verifiedRecordCount, 1);
  assert.equal(result.mismatchedRecordCount, 0);
  assert.deepEqual(result.batchIssues.map(({ code }) => code), [
    "PACK_RECORD_ROW_COUNT_MISMATCH"
  ]);
});

test("missing, unexpected, and different video rows are per-record mismatches", async (t) => {
  const input = [
    validRecord({ id: "missing-video", awb: "MISSING-VIDEO", video: { fileName: "one.mp4" } }),
    validRecord({ id: "unexpected-video", awb: "UNEXPECTED-VIDEO" }),
    validRecord({ id: "different-video", awb: "DIFFERENT-VIDEO", video: { fileName: "expected.mp4" } })
  ];
  const { database, importResult } = await importedDatabase(t, input);
  database.prepare("DELETE FROM pack_record_videos WHERE record_id = ?").run("missing-video");
  insertVideo(database, "unexpected-video", { fileName: "unexpected.mp4" });
  database.prepare("UPDATE pack_record_videos SET file_name = ? WHERE record_id = ?")
    .run("actual.mp4", "different-video");

  const result = verifyPackRecordImport(database, input, importResult);
  assert.deepEqual(result.records.map((record) => record.issues.map(({ code, column }) => ({
    code,
    ...(column === undefined ? {} : { column })
  }))), [
    [{ code: "PACK_RECORD_VIDEO_ROW_MISSING" }],
    [{ code: "PACK_RECORD_VIDEO_ROW_UNEXPECTED" }],
    [{ code: "PACK_RECORD_VIDEO_COLUMN_MISMATCH", column: "file_name" }]
  ]);
  assert.equal(result.actualVideoRows, 2);
  assert.equal(result.expectedVideoRows, 2);
});

test("an unrelated extra video remains a batch-only mismatch for expected records", async (t) => {
  const input = [validRecord()];
  const { database, importResult } = await importedDatabase(t, input);
  database.exec("PRAGMA foreign_keys = OFF");
  insertVideo(database, "orphan-extra");
  database.exec("PRAGMA foreign_keys = ON");

  const result = verifyPackRecordImport(database, input, importResult);
  assert.equal(result.records[0].verified, true);
  assert.equal(result.mismatchedRecordCount, 0);
  assert.deepEqual(result.batchIssues.map(({ code }) => code), [
    "PACK_RECORD_VIDEO_ROW_COUNT_MISMATCH",
    "PACK_RECORD_FOREIGN_KEY_VIOLATION"
  ]);
});

test("source payload comparison is semantic and ignores object key order", async (t) => {
  const input = [validRecord({ metadata: { alpha: 1, beta: [2, 3] } })];
  const { database, importResult } = await importedDatabase(t, input);
  const reordered = {
    metadata: { beta: [2, 3], alpha: 1 },
    status: input[0].status,
    awb: input[0].awb,
    id: input[0].id
  };
  database.prepare("UPDATE pack_records SET source_payload_json = ? WHERE id = ?")
    .run(JSON.stringify(reordered), input[0].id);

  assert.equal(verifyPackRecordImport(database, input, importResult).ok, true);
});

test("array order, missing, malformed, and different source payloads mismatch safely", async (t) => {
  const marker = "SECRET-PAYLOAD-MARKER";
  const input = [validRecord({ metadata: { marker, values: [1, 2] } })];
  const cases = [
    {
      code: "PACK_RECORD_SOURCE_PAYLOAD_MISSING",
      value: null
    },
    {
      code: "PACK_RECORD_SOURCE_PAYLOAD_MISMATCH",
      value: JSON.stringify(validRecord({ metadata: { marker, values: [2, 1] } }))
    },
    {
      code: "PACK_RECORD_SOURCE_PAYLOAD_MISMATCH",
      value: JSON.stringify(validRecord({ metadata: { marker, values: [1, 2], extra: true } }))
    }
  ];

  for (const currentCase of cases) {
    const database = await migratedDatabase(t);
    const importResult = importPackRecords(database, input, {
      now: () => new Date(FIXED_TIMESTAMP)
    });
    database.prepare("UPDATE pack_records SET source_payload_json = ? WHERE id = ?")
      .run(currentCase.value, input[0].id);
    const result = verifyPackRecordImport(database, input, importResult);
    assert.equal(result.records[0].issues[0].code, currentCase.code);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
    assert.doesNotMatch(
      JSON.stringify(buildPackRecordImportVerificationReport(result)),
      new RegExp(marker)
    );
    closeSqliteDatabase(database);
  }

  const { database, importResult } = await importedDatabase(t, input);
  const malformedWrapper = wrapDatabase(database, {
    prepare(sql, statement) {
      if (sql.includes("source_payload_json") && sql.includes("WHERE id")) {
        return {
          get(...values) {
            return { ...statement.get(...values), source_payload_json: `{${marker}` };
          }
        };
      }
      return statement;
    }
  });
  const malformed = verifyPackRecordImport(malformedWrapper, input, importResult);
  assert.equal(
    malformed.records[0].issues[0].code,
    "PACK_RECORD_SOURCE_PAYLOAD_INVALID"
  );
  assert.doesNotMatch(JSON.stringify(malformed), new RegExp(marker));
});

test("quick-check failures and foreign-key diagnostics are sanitized and ordered", async (t) => {
  const input = [validRecord()];
  const { database, importResult } = await importedDatabase(t, input);
  const marker = "RAW-DIAGNOSTIC SECRET-ROW-ID";
  const wrapped = wrapDatabase(database, {
    prepare(sql, statement) {
      if (sql.trim() === "PRAGMA quick_check") {
        return { all: () => [{ quick_check: marker }] };
      }
      if (sql.trim() === "PRAGMA foreign_key_check") {
        return {
          all: () => [
            { table: marker, rowid: marker, parent: marker, fkid: 0 },
            { table: marker, rowid: marker, parent: marker, fkid: 1 }
          ]
        };
      }
      return statement;
    }
  });

  const result = verifyPackRecordImport(wrapped, input, importResult);
  assert.deepEqual(result.integrity, {
    quickCheckOk: false,
    foreignKeyViolationCount: 2
  });
  assert.deepEqual(result.batchIssues.map(({ code }) => code), [
    "PACK_RECORD_QUICK_CHECK_FAILED",
    "PACK_RECORD_FOREIGN_KEY_VIOLATION"
  ]);
  assert.doesNotMatch(JSON.stringify(result), /RAW-DIAGNOSTIC|SECRET-ROW-ID/);
});

test("integrity helper SQL failures are operational query failures", async (t) => {
  const input = [validRecord()];
  const { database, importResult } = await importedDatabase(t, input);
  for (const pragma of ["PRAGMA quick_check", "PRAGMA foreign_key_check"]) {
    const wrapped = wrapDatabase(database, {
      prepare(sql, statement) {
        if (sql.trim() === pragma) throw new Error("RAW-INTEGRITY-SQL-ERROR");
        return statement;
      }
    });
    const error = expectVerificationError(
      () => verifyPackRecordImport(wrapped, input, importResult),
      "PACK_RECORD_IMPORT_VERIFICATION_QUERY_FAILED"
    );
    assert.doesNotMatch(publicErrorText(error), /RAW-INTEGRITY-SQL-ERROR/);
  }
});

test("result and issue ordering is deterministic across batch, record, and integrity issues", async (t) => {
  const input = [validRecord({
    platform: "expected",
    itemSummary: "expected",
    video: { fileName: "expected.mp4", contentType: "video/mp4" }
  })];
  const { database, importResult } = await importedDatabase(t, input);
  database.prepare(`
    UPDATE pack_records SET platform = ?, item_summary = ?, source_payload_json = ? WHERE id = ?
  `).run("actual", "actual", JSON.stringify(validRecord()), input[0].id);
  database.prepare(`
    UPDATE pack_record_videos SET file_name = ?, content_type = ? WHERE record_id = ?
  `).run("actual.mp4", "application/octet-stream", input[0].id);
  insertExtraParent(database);

  const wrapped = wrapDatabase(database, {
    prepare(sql, statement) {
      if (sql.trim() === "PRAGMA quick_check") {
        return { all: () => [{ quick_check: "not-ok" }] };
      }
      return statement;
    }
  });
  const result = verifyPackRecordImport(wrapped, input, importResult);

  assert.deepEqual(result.batchIssues.map(({ code }) => code), [
    "PACK_RECORD_ROW_COUNT_MISMATCH",
    "PACK_RECORD_QUICK_CHECK_FAILED"
  ]);
  assert.deepEqual(result.records[0].issues.map(({ code, column }) => ({ code, column })), [
    { code: "PACK_RECORD_COLUMN_MISMATCH", column: "platform" },
    { code: "PACK_RECORD_COLUMN_MISMATCH", column: "item_summary" },
    { code: "PACK_RECORD_SOURCE_PAYLOAD_MISMATCH", column: "source_payload_json" },
    { code: "PACK_RECORD_VIDEO_COLUMN_MISMATCH", column: "file_name" },
    { code: "PACK_RECORD_VIDEO_COLUMN_MISMATCH", column: "content_type" }
  ]);
});

test("reporter is pure, deterministic, sanitized, and allowlisted", async (t) => {
  const input = [validRecord({ platform: "expected" })];
  const { database, importResult } = await importedDatabase(t, input);
  database.prepare("UPDATE pack_records SET platform = ? WHERE id = ?")
    .run("actual", input[0].id);
  insertExtraParent(database);
  const result = verifyPackRecordImport(database, input, importResult);
  result.unknownTopLevel = "SECRET-TOP-LEVEL";
  const snapshot = structuredClone(result);
  deeplyFreeze(result);

  const first = buildPackRecordImportVerificationReport(result);
  const second = buildPackRecordImportVerificationReport(result);
  assert.deepEqual(first, second);
  assert.deepEqual(structuredClone(result), snapshot);
  assert.deepEqual(first, {
    mode: "post-import-verification",
    status: "mismatch",
    wouldWrite: false,
    inputRecordCount: 1,
    expectedPackRecordRows: 1,
    actualPackRecordRows: 2,
    expectedVideoRows: 0,
    actualVideoRows: 0,
    verifiedRecordCount: 0,
    mismatchedRecordCount: 1,
    errorCount: 2,
    issueCodeCounts: [
      { code: "PACK_RECORD_COLUMN_MISMATCH", count: 1 },
      { code: "PACK_RECORD_ROW_COUNT_MISMATCH", count: 1 }
    ],
    quickCheckStatus: "ok",
    foreignKeyViolationCount: 0,
    batchTimestamp: FIXED_TIMESTAMP,
    recordSequenceFirst: 0,
    recordSequenceLast: 0
  });
  assert.equal(Object.hasOwn(first, "records"), false);
  assert.equal(Object.hasOwn(first, "batchIssues"), false);
  assert.doesNotMatch(JSON.stringify(first), /SECRET-TOP-LEVEL|:"expected"|:"actual"/);
});

test("verified reports preserve exact zero-error counting semantics", async (t) => {
  const input = [validRecord()];
  const { database, importResult } = await importedDatabase(t, input);
  const report = buildPackRecordImportVerificationReport(
    verifyPackRecordImport(database, input, importResult)
  );
  assert.equal(report.status, "verified");
  assert.equal(report.errorCount, 0);
  assert.deepEqual(report.issueCodeCounts, []);
  assert.equal(report.quickCheckStatus, "ok");
  assert.equal(report.wouldWrite, false);
});

test("report issue counts include record and batch issues in lexical code order", async (t) => {
  const input = [validRecord({ platform: "expected", video: {} })];
  const { database, importResult } = await importedDatabase(t, input);
  database.prepare("UPDATE pack_records SET platform = ? WHERE id = ?")
    .run("actual", input[0].id);
  database.prepare("DELETE FROM pack_record_videos WHERE record_id = ?").run(input[0].id);
  insertExtraParent(database);
  const result = verifyPackRecordImport(database, input, importResult);
  const report = buildPackRecordImportVerificationReport(result);

  assert.equal(report.errorCount, 4);
  assert.deepEqual(report.issueCodeCounts, [
    { code: "PACK_RECORD_COLUMN_MISMATCH", count: 1 },
    { code: "PACK_RECORD_ROW_COUNT_MISMATCH", count: 1 },
    { code: "PACK_RECORD_VIDEO_ROW_COUNT_MISMATCH", count: 1 },
    { code: "PACK_RECORD_VIDEO_ROW_MISSING", count: 1 }
  ]);
});

test("reporter rejects malformed counts, flags, sequences, timestamps, and arrays", async (t) => {
  const input = [validRecord()];
  const { database, importResult } = await importedDatabase(t, input);
  const valid = verifyPackRecordImport(database, input, importResult);
  const mutations = [
    (value) => { value.ok = false; },
    (value) => { value.status = "mismatch"; },
    (value) => { value.inputRecordCount = -1; },
    (value) => { value.expectedPackRecordRows = 2; },
    (value) => { value.expectedVideoRows = 2; },
    (value) => { value.verifiedRecordCount = 0; },
    (value) => { value.recordSequenceFirst = 1; },
    (value) => { value.recordSequenceLast = null; },
    (value) => { value.batchTimestamp = "2026-07-15T12:34:56Z"; },
    (value) => { value.records = {}; },
    (value) => { value.batchIssues = {}; },
    (value) => { value.integrity.quickCheckOk = "yes"; },
    (value) => { value.integrity.foreignKeyViolationCount = -1; }
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    expectVerificationError(
      () => buildPackRecordImportVerificationReport(malformed),
      "PACK_RECORD_IMPORT_VERIFICATION_REPORT_INVALID"
    );
  }
});

test("reporter rejects inconsistent records and unsafe or malformed issues", async (t) => {
  const input = [validRecord({ platform: "expected" })];
  const { database, importResult } = await importedDatabase(t, input);
  database.prepare("UPDATE pack_records SET platform = ? WHERE id = ?")
    .run("actual", input[0].id);
  const valid = verifyPackRecordImport(database, input, importResult);
  const mutations = [
    (value) => { value.records[0].inputIndex = 1; },
    (value) => { value.records[0].recordSequence = 1; },
    (value) => { value.records[0].verified = true; },
    (value) => { value.records[0].issues[0].scope = "batch"; },
    (value) => { value.records[0].issues[0].code = "UNKNOWN"; },
    (value) => { value.records[0].issues[0].table = "other"; },
    (value) => { value.records[0].issues[0].column = "secret_column"; },
    (value) => { value.records[0].issues[0].expected = "SECRET-VALUE"; },
    (value) => { value.records[0].issues.push({ ...value.records[0].issues[0] }); },
    (value) => { value.records[0].issues[0][Symbol("unsafe")] = "SECRET-VALUE"; },
    (value) => {
      Object.defineProperty(value.records[0].issues[0], "unsafe", {
        value: "SECRET-VALUE"
      });
    },
    (value) => { value.batchIssues.push({ code: "UNKNOWN", scope: "batch" }); }
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    const error = expectVerificationError(
      () => buildPackRecordImportVerificationReport(malformed),
      "PACK_RECORD_IMPORT_VERIFICATION_REPORT_INVALID"
    );
    assert.doesNotMatch(publicErrorText(error), /SECRET-VALUE|secret_column/);
  }
});

test("reporter converts unexpected inspection failures to a safe report error", () => {
  const marker = "RAW-GETTER-ERROR SECRET-ID /secret/path";
  const result = Object.create(null);
  Object.defineProperty(result, "inputRecordCount", {
    enumerable: true,
    get() { throw new Error(marker); }
  });
  const error = expectVerificationError(
    () => buildPackRecordImportVerificationReport(result),
    "PACK_RECORD_IMPORT_VERIFICATION_REPORT_INVALID"
  );
  assert.doesNotMatch(publicErrorText(error), /RAW-GETTER|SECRET-ID|\/secret\/path/);
});
