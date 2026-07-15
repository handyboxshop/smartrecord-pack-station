import assert from "node:assert/strict";
import test from "node:test";
import {
  closeSqliteDatabase,
  openInMemoryDatabase
} from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import * as importer from "../src/storage/packRecordImporter.mjs";

const {
  PackRecordImportError,
  importPackRecords
} = importer;

const FIXED_TIMESTAMP = "2026-07-15T12:34:56.789Z";

function validRecord(overrides = {}) {
  return { id: "record-1", awb: "AWB-1", status: "pass", ...overrides };
}

function deeplyFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deeplyFreeze(child);
  }
  return value;
}

function expectImportError(callback, code) {
  let captured;
  assert.throws(callback, (error) => {
    captured = error;
    assert.equal(error instanceof PackRecordImportError, true);
    assert.equal(error.name, "PackRecordImportError");
    assert.equal(error.code, code);
    assert.equal(Object.getPrototypeOf(error.details), Object.prototype);
    return true;
  });
  return captured;
}

async function migratedDatabase(t) {
  const database = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(database));
  await runSqliteMigrations(database, { now: () => new Date(FIXED_TIMESTAMP) });
  return database;
}

async function managedDatabase(t) {
  const database = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(database));
  return database;
}

function seedPackRecord(database, {
  id = "existing",
  recordSequence = 10,
  awb = "EXISTING-AWB",
  awbNormalized = awb.trim()
} = {}) {
  database.prepare(`
    INSERT INTO pack_records (
      id, record_sequence, awb, awb_normalized, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pass', ?, ?)
  `).run(id, recordSequence, awb, awbNormalized, FIXED_TIMESTAMP, FIXED_TIMESTAMP);
}

function tableCount(database, tableName) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
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

test("exports exactly the typed error and synchronous importer", () => {
  assert.deepEqual(Object.keys(importer).sort(), ["PackRecordImportError", "importPackRecords"]);
  assert.equal(Object.getPrototypeOf(PackRecordImportError.prototype).constructor.name, "SqliteStorageError");
  assert.equal(importPackRecords.constructor.name, "Function");
});

test("imports one minimal Pack Record", async (t) => {
  const database = await migratedDatabase(t);
  const result = importPackRecords(database, [validRecord()], {
    now: () => new Date(FIXED_TIMESTAMP)
  });

  assert.deepEqual(result, {
    ok: true,
    status: "imported",
    inputRecordCount: 1,
    insertedPackRecordRows: 1,
    insertedVideoRows: 0,
    batchTimestamp: FIXED_TIMESTAMP,
    recordSequenceFirst: 0,
    recordSequenceLast: 0
  });
  assert.deepEqual({ ...database.prepare(`
    SELECT id, record_sequence, awb, awb_normalized, status, created_at, updated_at
    FROM pack_records
  `).get() }, {
    id: "record-1",
    record_sequence: 0,
    awb: "AWB-1",
    awb_normalized: "AWB-1",
    status: "pass",
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP
  });
});

test("maps every Pack Record column and preserves empty strings", async (t) => {
  const database = await migratedDatabase(t);
  const original = validRecord({
    id: "full-record",
    awb: "  Mixed-AWB  ",
    platform: "",
    employeeId: "employee-1",
    stationId: "station-1",
    startedAt: "2026-07-15T10:00:00.000Z",
    endedAt: "2026-07-15T10:01:30.000Z",
    durationSeconds: 90,
    status: "warn",
    itemSummary: "2 items",
    sizeMb: 12.5,
    storage: {
      targetId: "target-1",
      label: "Main",
      provider: "local",
      host: "station.local"
    },
    shareLink: "",
    forceCloseReason: "manual review"
  });

  importPackRecords(database, [original], { now: () => FIXED_TIMESTAMP });
  const row = database.prepare("SELECT * FROM pack_records").get();
  assert.deepEqual({ ...row }, {
    id: "full-record",
    record_sequence: 0,
    awb: "  Mixed-AWB  ",
    awb_normalized: "Mixed-AWB",
    platform: "",
    employee_id: "employee-1",
    station_id: "station-1",
    started_at: "2026-07-15T10:00:00.000Z",
    ended_at: "2026-07-15T10:01:30.000Z",
    duration_seconds: 90,
    status: "warn",
    item_summary: "2 items",
    size_mb: 12.5,
    storage_target_id: "target-1",
    storage_label: "Main",
    storage_provider: "local",
    storage_host: "station.local",
    share_link: "",
    force_close_reason: "manual review",
    source_payload_json: JSON.stringify(original),
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP
  });
});

test("maps every video column", async (t) => {
  const database = await migratedDatabase(t);
  const video = {
    fileName: "clip.mp4",
    relativePath: "videos/clip.mp4",
    bytes: 12345,
    sizeMb: 1.25,
    contentType: "video/mp4",
    storageTargetId: "target-video",
    storageLabel: "Video disk",
    storageHost: "video.local",
    storageMode: "mounted",
    mountedRequired: true,
    simulated: false,
    externalUrl: "https://example.test/video",
    customPath: "/custom/video",
    shareLink: "https://example.test/share",
    savedAt: "2026-07-15T10:01:31.000Z"
  };

  importPackRecords(database, [validRecord({ video })], { now: () => FIXED_TIMESTAMP });
  assert.deepEqual({ ...database.prepare("SELECT * FROM pack_record_videos").get() }, {
    record_id: "record-1",
    file_name: "clip.mp4",
    relative_path: "videos/clip.mp4",
    bytes: 12345,
    size_mb: 1.25,
    content_type: "video/mp4",
    storage_target_id: "target-video",
    storage_label: "Video disk",
    storage_host: "video.local",
    storage_mode: "mounted",
    mounted_required: 1,
    simulated: 0,
    external_url: "https://example.test/video",
    custom_path: "/custom/video",
    share_link: "https://example.test/share",
    saved_at: "2026-07-15T10:01:31.000Z"
  });
});

test("creates an all-null video metadata row for an empty video object", async (t) => {
  const database = await migratedDatabase(t);
  const result = importPackRecords(database, [validRecord({ video: {} })], { now: () => FIXED_TIMESTAMP });
  const row = { ...database.prepare("SELECT * FROM pack_record_videos").get() };

  assert.equal(result.insertedVideoRows, 1);
  assert.equal(row.record_id, "record-1");
  assert.equal(Object.entries(row).filter(([key]) => key !== "record_id").every(([, value]) => value === null), true);
});

test("converts video booleans true, false, and null to SQLite values", async (t) => {
  const database = await migratedDatabase(t);
  importPackRecords(database, [
    validRecord({ id: "true-flags", awb: "A", video: { mountedRequired: true, simulated: true } }),
    validRecord({ id: "false-flags", awb: "B", video: { mountedRequired: false, simulated: false } }),
    validRecord({ id: "null-flags", awb: "C", video: { mountedRequired: null, simulated: null } })
  ], { now: () => FIXED_TIMESTAMP });

  assert.deepEqual(database.prepare(`
    SELECT record_id, mounted_required, simulated
    FROM pack_record_videos ORDER BY record_id
  `).all().map((row) => ({ ...row })), [
    { record_id: "false-flags", mounted_required: 0, simulated: 0 },
    { record_id: "null-flags", mounted_required: null, simulated: null },
    { record_id: "true-flags", mounted_required: 1, simulated: 1 }
  ]);
});

test("preserves relativePath and customPath exactly", async (t) => {
  const database = await migratedDatabase(t);
  const relativePath = String.raw`..\capture//คลิป.mp4`;
  const customPath = String.raw`C:\pack\..\raw//clip`;
  importPackRecords(database, [validRecord({ video: { relativePath, customPath } })], {
    now: () => FIXED_TIMESTAMP
  });

  const row = database.prepare("SELECT relative_path, custom_path FROM pack_record_videos").get();
  assert.equal(row.relative_path, relativePath);
  assert.equal(row.custom_path, customPath);
});

test("keeps top-level and video size and share links independent", async (t) => {
  const database = await migratedDatabase(t);
  importPackRecords(database, [validRecord({
    sizeMb: 10,
    shareLink: "top-level",
    video: { sizeMb: 5, shareLink: "video-level" }
  })], { now: () => FIXED_TIMESTAMP });

  assert.equal(database.prepare("SELECT size_mb FROM pack_records").get().size_mb, 10);
  assert.equal(database.prepare("SELECT share_link FROM pack_records").get().share_link, "top-level");
  assert.equal(database.prepare("SELECT size_mb FROM pack_record_videos").get().size_mb, 5);
  assert.equal(database.prepare("SELECT share_link FROM pack_record_videos").get().share_link, "video-level");
});

test("stores source_payload_json as exact JSON.stringify output", async (t) => {
  const database = await migratedDatabase(t);
  const original = validRecord({ storage: { label: "Disk" }, video: { fileName: "clip.mp4" } });
  importPackRecords(database, [original], { now: () => FIXED_TIMESTAMP });

  assert.equal(
    database.prepare("SELECT source_payload_json FROM pack_records").get().source_payload_json,
    JSON.stringify(original)
  );
});

test("preserves unknown and reserved fields inside source_payload_json", async (t) => {
  const database = await migratedDatabase(t);
  const original = validRecord({
    unknownTop: { nested: [1, true, null] },
    awbNormalized: "untrusted",
    recordSequence: 999,
    sourcePayloadJson: "untrusted",
    createdAt: "untrusted",
    updatedAt: "untrusted"
  });
  importPackRecords(database, [original], { now: () => FIXED_TIMESTAMP });

  assert.deepEqual(
    JSON.parse(database.prepare("SELECT source_payload_json FROM pack_records").get().source_payload_json),
    original
  );
});

test("reserved fields cannot override mapped importer-owned columns", async (t) => {
  const database = await migratedDatabase(t);
  const original = validRecord({
    awb: "  TRUSTED-AWB  ",
    awbNormalized: "UNTRUSTED-AWB",
    recordSequence: 999,
    sourcePayloadJson: "untrusted payload",
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-02T00:00:00.000Z"
  });
  importPackRecords(database, [original], { now: () => FIXED_TIMESTAMP });

  const row = database.prepare(`
    SELECT awb_normalized, record_sequence, source_payload_json, created_at, updated_at
    FROM pack_records
  `).get();
  assert.equal(row.awb_normalized, "TRUSTED-AWB");
  assert.equal(row.record_sequence, 0);
  assert.equal(row.source_payload_json, JSON.stringify(original));
  assert.equal(row.created_at, FIXED_TIMESTAMP);
  assert.equal(row.updated_at, FIXED_TIMESTAMP);
});

test("uses one batch timestamp for every Pack Record row", async (t) => {
  const database = await migratedDatabase(t);
  importPackRecords(database, [
    validRecord({ id: "newest", awb: "A" }),
    validRecord({ id: "oldest", awb: "B" })
  ], { now: () => new Date(FIXED_TIMESTAMP) });

  assert.deepEqual(database.prepare(`
    SELECT created_at, updated_at FROM pack_records ORDER BY record_sequence DESC
  `).all().map((row) => ({ ...row })), [
    { created_at: FIXED_TIMESTAMP, updated_at: FIXED_TIMESTAMP },
    { created_at: FIXED_TIMESTAMP, updated_at: FIXED_TIMESTAMP }
  ]);
});

test("calls now exactly once for a non-empty batch", async (t) => {
  const database = await migratedDatabase(t);
  let calls = 0;
  importPackRecords(database, [
    validRecord({ id: "1", awb: "A" }),
    validRecord({ id: "2", awb: "B" })
  ], {
    now() {
      calls += 1;
      return FIXED_TIMESTAMP;
    }
  });
  assert.equal(calls, 1);
});

test("rejects an invalid now value before starting a transaction", async (t) => {
  const database = await migratedDatabase(t);
  let beginCalls = 0;
  const wrapped = wrapDatabase(database, {
    exec(sql, execute) {
      if (sql === "BEGIN IMMEDIATE") beginCalls += 1;
      return execute();
    }
  });

  expectImportError(
    () => importPackRecords(wrapped, [validRecord()], { now: () => "not-a-date" }),
    "PACK_RECORD_IMPORT_TIMESTAMP_INVALID"
  );
  assert.equal(beginCalls, 0);
  assert.equal(tableCount(database, "pack_records"), 0);
});

test("returns the exact no-op result for an empty valid batch", async (t) => {
  const database = await migratedDatabase(t);
  assert.deepEqual(importPackRecords(database, []), {
    ok: true,
    status: "no-op",
    inputRecordCount: 0,
    insertedPackRecordRows: 0,
    insertedVideoRows: 0,
    batchTimestamp: null,
    recordSequenceFirst: null,
    recordSequenceLast: null
  });
});

test("empty batch does not call now or start a transaction", async (t) => {
  const database = await migratedDatabase(t);
  let nowCalls = 0;
  let beginCalls = 0;
  const wrapped = wrapDatabase(database, {
    exec(sql, execute) {
      if (sql === "BEGIN IMMEDIATE") beginCalls += 1;
      return execute();
    }
  });

  const result = importPackRecords(wrapped, [], { now: () => { nowCalls += 1; return FIXED_TIMESTAMP; } });
  assert.equal(result.status, "no-op");
  assert.equal(nowCalls, 0);
  assert.equal(beginCalls, 0);
});

test("validation failure does not inspect the database", () => {
  let databaseReads = 0;
  const inaccessibleDatabase = new Proxy({}, {
    get() {
      databaseReads += 1;
      throw new Error("database must not be touched");
    }
  });
  const error = expectImportError(
    () => importPackRecords(inaccessibleDatabase, [{ id: "invalid" }]),
    "PACK_RECORD_IMPORT_VALIDATION_FAILED"
  );

  assert.equal(databaseReads, 0);
  assert.equal(error.details.validationResult.ok, false);
  assert.equal(error.details.dryRunReport.status, "blocked");
});

test("rejects invalid database objects after validation", () => {
  for (const database of [null, {}, { prepare() {} }, { exec() {} }]) {
    expectImportError(
      () => importPackRecords(database, [validRecord()], { now: () => FIXED_TIMESTAMP }),
      "PACK_RECORD_IMPORT_DATABASE_INVALID"
    );
  }
});

test("translates database precondition query failures safely", () => {
  const database = {
    prepare() {
      throw new Error("secret database check failure");
    },
    exec() {}
  };
  const error = expectImportError(
    () => importPackRecords(database, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_DATABASE_CHECK_FAILED"
  );
  assert.doesNotMatch(error.message, /secret|PRAGMA|SELECT/i);
});

test("stops database precondition checks at the first invalid prerequisite", () => {
  let schemaVersionPrepareCalls = 0;
  const invalidVersionDatabase = {
    prepare(sql) {
      schemaVersionPrepareCalls += 1;
      if (sql === "PRAGMA user_version") return { get: () => ({ user_version: 1 }) };
      throw new Error("later checks must not run");
    },
    exec() {}
  };
  expectImportError(
    () => importPackRecords(invalidVersionDatabase, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_SCHEMA_VERSION_INVALID"
  );
  assert.equal(schemaVersionPrepareCalls, 1);

  let foreignKeyPrepareCalls = 0;
  const disabledForeignKeysDatabase = {
    prepare(sql) {
      foreignKeyPrepareCalls += 1;
      if (sql === "PRAGMA user_version") return { get: () => ({ user_version: 2 }) };
      if (sql === "PRAGMA foreign_keys") return { get: () => ({ foreign_keys: 0 }) };
      throw new Error("schema checks must not run");
    },
    exec() {}
  };
  expectImportError(
    () => importPackRecords(disabledForeignKeysDatabase, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_FOREIGN_KEYS_DISABLED"
  );
  assert.equal(foreignKeyPrepareCalls, 2);
});

test("rejects schema versions lower than 2", async (t) => {
  const database = await managedDatabase(t);
  database.exec("PRAGMA user_version = 1");
  const error = expectImportError(
    () => importPackRecords(database, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_SCHEMA_VERSION_INVALID"
  );
  assert.deepEqual(error.details, { expected: 2, actual: 1 });
});

test("rejects schema versions higher than 2", async (t) => {
  const database = await managedDatabase(t);
  database.exec("PRAGMA user_version = 3");
  const error = expectImportError(
    () => importPackRecords(database, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_SCHEMA_VERSION_INVALID"
  );
  assert.deepEqual(error.details, { expected: 2, actual: 3 });
});

test("rejects databases with foreign keys disabled", async (t) => {
  const database = await migratedDatabase(t);
  database.exec("PRAGMA foreign_keys = OFF");
  const error = expectImportError(
    () => importPackRecords(database, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_FOREIGN_KEYS_DISABLED"
  );
  assert.deepEqual(error.details, { expected: 1, actual: 0 });
});

test("reports missing pack_records only", async (t) => {
  const database = await managedDatabase(t);
  database.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE pack_record_videos (record_id TEXT PRIMARY KEY);
  `);
  const error = expectImportError(
    () => importPackRecords(database, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_SCHEMA_MISSING"
  );
  assert.deepEqual(error.details, { missingTables: ["pack_records"] });
});

test("reports missing pack_record_videos only", async (t) => {
  const database = await managedDatabase(t);
  database.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE pack_records (id TEXT PRIMARY KEY);
  `);
  const error = expectImportError(
    () => importPackRecords(database, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_SCHEMA_MISSING"
  );
  assert.deepEqual(error.details, { missingTables: ["pack_record_videos"] });
});

test("detects an existing Pack Record id", async (t) => {
  const database = await migratedDatabase(t);
  seedPackRecord(database, { id: "record-1", recordSequence: 10, awb: "EXISTING" });
  const error = expectImportError(
    () => importPackRecords(database, [validRecord({ awb: "NEW" })], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_CONFLICT"
  );
  assert.deepEqual(error.details.conflicts, [{
    code: "PACK_RECORD_ID_EXISTS",
    field: "id",
    inputIndex: 0,
    value: "record-1",
    existingRecordId: "record-1"
  }]);
});

test("detects an existing normalized AWB", async (t) => {
  const database = await migratedDatabase(t);
  seedPackRecord(database, { id: "existing", recordSequence: 10, awb: "NORMALIZED" });
  const error = expectImportError(
    () => importPackRecords(database, [validRecord({ id: "new", awb: " NORMALIZED " })], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_CONFLICT"
  );
  assert.deepEqual(error.details.conflicts, [{
    code: "PACK_RECORD_AWB_EXISTS",
    field: "awbNormalized",
    inputIndex: 0,
    value: "NORMALIZED",
    existingRecordId: "existing"
  }]);
});

test("detects an existing record sequence", async (t) => {
  const database = await migratedDatabase(t);
  seedPackRecord(database, { id: "existing", recordSequence: 0, awb: "EXISTING" });
  const error = expectImportError(
    () => importPackRecords(database, [validRecord({ id: "new", awb: "NEW" })], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_CONFLICT"
  );
  assert.deepEqual(error.details.conflicts, [{
    code: "PACK_RECORD_SEQUENCE_EXISTS",
    field: "recordSequence",
    inputIndex: 0,
    value: 0,
    existingRecordId: "existing"
  }]);
});

test("collects multiple conflicts in input and field order", async (t) => {
  const database = await migratedDatabase(t);
  seedPackRecord(database, { id: "first", recordSequence: 1, awb: "AWB-FIRST" });
  seedPackRecord(database, { id: "second", recordSequence: 0, awb: "AWB-SECOND" });
  const error = expectImportError(
    () => importPackRecords(database, [
      validRecord({ id: "first", awb: " AWB-FIRST " }),
      validRecord({ id: "second", awb: "AWB-SECOND" })
    ], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_CONFLICT"
  );

  assert.deepEqual(error.details.conflicts.map(({ code, field, inputIndex, value, existingRecordId }) => ({
    code,
    field,
    inputIndex,
    value,
    existingRecordId
  })), [
    { code: "PACK_RECORD_ID_EXISTS", field: "id", inputIndex: 0, value: "first", existingRecordId: "first" },
    { code: "PACK_RECORD_AWB_EXISTS", field: "awbNormalized", inputIndex: 0, value: "AWB-FIRST", existingRecordId: "first" },
    { code: "PACK_RECORD_SEQUENCE_EXISTS", field: "recordSequence", inputIndex: 0, value: 1, existingRecordId: "first" },
    { code: "PACK_RECORD_ID_EXISTS", field: "id", inputIndex: 1, value: "second", existingRecordId: "second" },
    { code: "PACK_RECORD_AWB_EXISTS", field: "awbNormalized", inputIndex: 1, value: "AWB-SECOND", existingRecordId: "second" },
    { code: "PACK_RECORD_SEQUENCE_EXISTS", field: "recordSequence", inputIndex: 1, value: 0, existingRecordId: "second" }
  ]);
});

test("conflicts insert zero new rows", async (t) => {
  const database = await migratedDatabase(t);
  seedPackRecord(database, { id: "record-1", recordSequence: 10, awb: "EXISTING" });
  expectImportError(
    () => importPackRecords(database, [validRecord({ awb: "NEW", video: {} })], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_CONFLICT"
  );
  assert.equal(tableCount(database, "pack_records"), 1);
  assert.equal(tableCount(database, "pack_record_videos"), 0);
});

test("internal batch duplicates fail validation before database access", () => {
  let databaseReads = 0;
  const inaccessibleDatabase = new Proxy({}, {
    get() {
      databaseReads += 1;
      throw new Error("database must not be touched");
    }
  });
  expectImportError(
    () => importPackRecords(inaccessibleDatabase, [
      validRecord({ id: "same", awb: "A" }),
      validRecord({ id: "same", awb: "B" })
    ]),
    "PACK_RECORD_IMPORT_VALIDATION_FAILED"
  );
  assert.equal(databaseReads, 0);
});

test("inserts all parent rows before the first video row", async (t) => {
  const database = await migratedDatabase(t);
  database.exec(`
    CREATE TRIGGER require_all_parents_before_video
    BEFORE INSERT ON pack_record_videos
    WHEN (SELECT COUNT(*) FROM pack_records) <> 2
    BEGIN
      SELECT RAISE(ABORT, 'parents must be inserted first');
    END;
  `);
  const result = importPackRecords(database, [
    validRecord({ id: "first", awb: "A", video: {} }),
    validRecord({ id: "second", awb: "B", video: {} })
  ], { now: () => FIXED_TIMESTAMP });

  assert.equal(result.insertedPackRecordRows, 2);
  assert.equal(result.insertedVideoRows, 2);
});

test("a synthetic video insert failure rolls back all parent and video rows", async (t) => {
  const database = await migratedDatabase(t);
  database.exec(`
    CREATE TRIGGER fail_second_video
    BEFORE INSERT ON pack_record_videos
    WHEN NEW.record_id = 'second'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic secret video failure');
    END;
  `);
  expectImportError(
    () => importPackRecords(database, [
      validRecord({ id: "first", awb: "A", video: {} }),
      validRecord({ id: "second", awb: "B", video: {} })
    ], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_TRANSACTION_FAILED"
  );

  assert.equal(tableCount(database, "pack_records"), 0);
  assert.equal(tableCount(database, "pack_record_videos"), 0);
});

test("a synthetic second parent failure rolls back the first parent", async (t) => {
  const database = await migratedDatabase(t);
  database.exec(`
    CREATE TRIGGER fail_second_parent
    BEFORE INSERT ON pack_records
    WHEN NEW.id = 'second'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic secret parent failure');
    END;
  `);
  expectImportError(
    () => importPackRecords(database, [
      validRecord({ id: "first", awb: "A" }),
      validRecord({ id: "second", awb: "B" })
    ], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_TRANSACTION_FAILED"
  );
  assert.equal(tableCount(database, "pack_records"), 0);
});

test("guards against insert results that do not report exactly one change", async (t) => {
  const database = await migratedDatabase(t);
  const wrapped = wrapDatabase(database, {
    prepare(sql, statement) {
      if (!/INSERT INTO pack_records\s*\(/.test(sql)) return statement;
      return {
        run(...values) {
          statement.run(...values);
          return { changes: 0 };
        }
      };
    }
  });
  const error = expectImportError(
    () => importPackRecords(wrapped, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_INSERT_COUNT_INVALID"
  );

  assert.deepEqual(error.details, {
    table: "pack_records",
    inputIndex: 0,
    expected: 1,
    actual: 0
  });
  assert.equal(tableCount(database, "pack_records"), 0);
});

test("unexpected database errors use a safe public importer message", async (t) => {
  const database = await migratedDatabase(t);
  database.exec(`
    CREATE TRIGGER fail_with_secret
    BEFORE INSERT ON pack_records
    BEGIN
      SELECT RAISE(ABORT, 'raw secret sqlite failure');
    END;
  `);
  const error = expectImportError(
    () => importPackRecords(database, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_TRANSACTION_FAILED"
  );
  assert.doesNotMatch(error.message, /secret|sqlite|constraint|INSERT/i);
  assert.deepEqual(error.details, {});
});

test("translates transaction-helper rollback failures", async (t) => {
  const database = await migratedDatabase(t);
  seedPackRecord(database, { id: "record-1", recordSequence: 10, awb: "EXISTING" });
  let rollbackAttempts = 0;
  const wrapped = wrapDatabase(database, {
    exec(sql, execute) {
      if (sql === "ROLLBACK") {
        rollbackAttempts += 1;
        throw new Error("raw secret rollback failure");
      }
      return execute();
    }
  });
  const error = expectImportError(
    () => importPackRecords(wrapped, [validRecord({ awb: "NEW" })], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_ROLLBACK_FAILED"
  );

  assert.equal(rollbackAttempts, 1);
  assert.doesNotMatch(error.message, /secret|sqlite|ROLLBACK/i);
});

test("reports source serialization failure before transaction", async (t) => {
  const database = await migratedDatabase(t);
  let jsonStringifyCalls = 0;
  let beginCalls = 0;
  const original = new Proxy(validRecord({ id: "serialization-failure" }), {
    get(target, property, receiver) {
      if (property === "toJSON") {
        jsonStringifyCalls += 1;
        if (jsonStringifyCalls === 2) throw new Error("raw secret serialization failure");
        return undefined;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const wrapped = wrapDatabase(database, {
    exec(sql, execute) {
      if (sql === "BEGIN IMMEDIATE") beginCalls += 1;
      return execute();
    }
  });
  const error = expectImportError(
    () => importPackRecords(wrapped, [original], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_SOURCE_SERIALIZATION_FAILED"
  );

  assert.deepEqual(error.details, { inputIndex: 0, id: "serialization-failure" });
  assert.equal(beginCalls, 0);
  assert.equal(tableCount(database, "pack_records"), 0);
});

test("never mutates deeply frozen input", async (t) => {
  const database = await migratedDatabase(t);
  const input = deeplyFreeze([validRecord({
    awb: " AWB-1 ",
    storage: { targetId: "target", unknownStorage: "snapshot" },
    video: { relativePath: String.raw`a\b/c.mp4`, simulated: false },
    unknownTop: { nested: [1, 2, 3] }
  })]);
  const before = JSON.stringify(input);
  assert.doesNotThrow(() => importPackRecords(database, input, { now: () => FIXED_TIMESTAMP }));
  assert.equal(JSON.stringify(input), before);
});

test("leaves the caller-owned database open after success", async (t) => {
  const database = await migratedDatabase(t);
  importPackRecords(database, [validRecord()], { now: () => FIXED_TIMESTAMP });
  assert.equal(database.prepare("SELECT 1 AS usable").get().usable, 1);
});

test("leaves the caller-owned database open after failure", async (t) => {
  const database = await migratedDatabase(t);
  seedPackRecord(database, { id: "record-1", recordSequence: 10 });
  expectImportError(
    () => importPackRecords(database, [validRecord({ awb: "NEW" })], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_CONFLICT"
  );
  assert.equal(database.prepare("SELECT 1 AS usable").get().usable, 1);
});

test("does not run migrations or change an unmigrated database", async (t) => {
  const database = await managedDatabase(t);
  expectImportError(
    () => importPackRecords(database, [validRecord()], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_SCHEMA_VERSION_INVALID"
  );
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 0);
  assert.deepEqual(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all(), []);
});

test("returns deterministic success counts and newest-first sequence bounds", async (t) => {
  const database = await migratedDatabase(t);
  const result = importPackRecords(database, [
    validRecord({ id: "newest", awb: "A", video: {} }),
    validRecord({ id: "middle", awb: "B" }),
    validRecord({ id: "oldest", awb: "C", video: {} })
  ], { now: () => FIXED_TIMESTAMP });

  assert.deepEqual(result, {
    ok: true,
    status: "imported",
    inputRecordCount: 3,
    insertedPackRecordRows: 3,
    insertedVideoRows: 2,
    batchTimestamp: FIXED_TIMESTAMP,
    recordSequenceFirst: 2,
    recordSequenceLast: 0
  });
  assert.deepEqual(database.prepare(`
    SELECT id, record_sequence FROM pack_records ORDER BY record_sequence DESC
  `).all().map((row) => ({ ...row })), [
    { id: "newest", record_sequence: 2 },
    { id: "middle", record_sequence: 1 },
    { id: "oldest", record_sequence: 0 }
  ]);
});

test("never returns partial success when a later row fails", async (t) => {
  const database = await migratedDatabase(t);
  database.exec(`
    CREATE TRIGGER fail_third_parent
    BEFORE INSERT ON pack_records
    WHEN NEW.id = 'third'
    BEGIN
      SELECT RAISE(ABORT, 'late synthetic failure');
    END;
  `);
  expectImportError(
    () => importPackRecords(database, [
      validRecord({ id: "first", awb: "A" }),
      validRecord({ id: "second", awb: "B" }),
      validRecord({ id: "third", awb: "C" })
    ], { now: () => FIXED_TIMESTAMP }),
    "PACK_RECORD_IMPORT_TRANSACTION_FAILED"
  );
  assert.equal(tableCount(database, "pack_records"), 0);
  assert.equal(tableCount(database, "pack_record_videos"), 0);
});
