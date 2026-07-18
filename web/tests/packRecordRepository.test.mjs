import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import {
  closeSqliteDatabase,
  openInMemoryDatabase,
  openSqliteDatabase
} from "../src/storage/sqliteDatabase.mjs";
import { importPackRecords } from "../src/storage/packRecordImporter.mjs";
import { verifyPackRecordImport } from "../src/storage/packRecordImportVerifier.mjs";
import * as repositoryModule from "../src/storage/packRecordRepository.mjs";

const {
  PackRecordRepositoryError,
  createPackRecordRepository
} = repositoryModule;
const FIXED_TIME = "2026-07-18T08:00:00.000Z";

function fixedNow() { return new Date(FIXED_TIME); }
function sample(overrides = {}) { return { id: "record-1", awb: "AWB-1", status: "pass", ...overrides }; }

const PUBLIC_RECORD_KEYS = [
  "awb", "durationSeconds", "employeeId", "endedAt", "forceCloseReason", "id", "itemSummary",
  "platform", "shareLink", "sizeMb", "startedAt", "stationId", "status", "storage", "video"
];
const PUBLIC_STORAGE_KEYS = ["host", "label", "provider", "targetId"];
const PUBLIC_VIDEO_KEYS = [
  "bytes", "contentType", "customPath", "externalUrl", "fileName", "mountedRequired",
  "relativePath", "savedAt", "shareLink", "simulated", "sizeMb", "storageHost",
  "storageLabel", "storageMode", "storageTargetId"
];
const INTERNAL_KEYS = new Set(["record_sequence", "source_payload_json", "created_at", "updated_at"]);

function assertPublicRecord(record) {
  assert.deepEqual(Object.keys(record).sort(), PUBLIC_RECORD_KEYS);
  if (record.storage !== null) assert.deepEqual(Object.keys(record.storage).sort(), PUBLIC_STORAGE_KEYS);
  if (record.video !== null) assert.deepEqual(Object.keys(record.video).sort(), PUBLIC_VIDEO_KEYS);
  assertNoInternalKeys(record);
}

function assertNoInternalKeys(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(INTERNAL_KEYS.has(key), false, `unexpected internal key: ${key}`);
    assertNoInternalKeys(child);
  }
}

function expectCode(callback, code) {
  let captured;
  assert.throws(callback, (cause) => {
    captured = cause;
    assert.equal(cause instanceof PackRecordRepositoryError, true);
    assert.equal(cause.name, "PackRecordRepositoryError");
    assert.equal(cause.code, code);
    assert.deepEqual(cause.details, {});
    return true;
  });
  return captured;
}

async function databaseFixture(t, maximumVersion = null) {
  const database = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(database));
  await runSqliteMigrations(database, { maximumVersion, now: fixedNow });
  return database;
}

async function repositoryFixture(t, maximumVersion = null) {
  const database = await databaseFixture(t, maximumVersion);
  return { database, repository: createPackRecordRepository(database, { now: fixedNow }) };
}

test("exports exactly the repository error and synchronous factory", () => {
  assert.deepEqual(Object.keys(repositoryModule).sort(), ["PackRecordRepositoryError", "createPackRecordRepository"]);
  assert.equal(Object.getPrototypeOf(PackRecordRepositoryError.prototype).constructor.name, "SqliteStorageError");
  assert.equal(createPackRecordRepository.constructor.name, "Function");
});

test("rejects invalid databases, unsupported schema, missing tables, and disabled foreign keys", async (t) => {
  expectCode(() => createPackRecordRepository(null), "PACK_RECORD_DATABASE_INVALID");
  const unmigrated = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(unmigrated));
  expectCode(() => createPackRecordRepository(unmigrated), "PACK_RECORD_SCHEMA_VERSION_INVALID");

  const missing = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(missing));
  missing.exec("PRAGMA user_version = 2");
  expectCode(() => createPackRecordRepository(missing), "PACK_RECORD_SCHEMA_MISSING");

  const foreignKeysOff = await databaseFixture(t, 2);
  foreignKeysOff.exec("PRAGMA foreign_keys = OFF");
  expectCode(() => createPackRecordRepository(foreignKeysOff), "PACK_RECORD_FOREIGN_KEYS_DISABLED");
});

test("supports both schema version 2 and the current schema", async (t) => {
  const versionTwo = await repositoryFixture(t, 2);
  const current = await repositoryFixture(t);
  assert.equal(versionTwo.repository.createCompletedRecord(sample()).id, "record-1");
  assert.equal(current.repository.createCompletedRecord(sample()).id, "record-1");
});

test("creates and reads complete sanitized field mapping without exposing internal columns", async (t) => {
  const { database, repository } = await repositoryFixture(t, 2);
  const input = sample({
    id: " บันทึก-๑ ", awb: "  Thai AWB-๑  ", platform: "แพลตฟอร์ม ไทย",
    employeeId: "พนักงาน 7", stationId: "สถานี A",
    startedAt: "2026-07-18T07:58:00.000Z", endedAt: "2026-07-18T08:00:00.000Z",
    durationSeconds: 120, status: "warn", itemSummary: "สินค้า ๒ ชิ้น", sizeMb: 1.5,
    storage: { targetId: "nas-main", label: "ดิสก์ หลัก", provider: "local", host: "host ไทย" },
    shareLink: "https://example.test/share/1", forceCloseReason: "ตรวจสอบด้วยมือ",
    video: {
      fileName: "คลิป final.mp4", relativePath: "videos/กรกฎาคม/คลิป final.mp4",
      bytes: 1500, sizeMb: 1.5, contentType: "video/mp4", storageTargetId: "nas-video",
      storageLabel: "วิดีโอ", storageHost: "video.local", storageMode: "mounted",
      mountedRequired: true, simulated: false, externalUrl: "https://example.test/video/1",
      customPath: "custom/videos", shareLink: "https://example.test/stream/1", savedAt: FIXED_TIME
    }
  });
  const snapshot = structuredClone(input);
  const created = repository.createCompletedRecord(input);
  assert.deepEqual(input, snapshot);
  assert.equal(created.id, "บันทึก-๑");
  assert.equal(created.awb, "Thai AWB-๑");
  assert.deepEqual(repository.getRecordById(" บันทึก-๑ "), created);
  assert.deepEqual(repository.getRecordByAwb(" Thai AWB-๑ "), created);
  assertPublicRecord(created);
  assert.equal(database.prepare("SELECT source_payload_json FROM pack_records").get().source_payload_json, null);
});

test("rejects unknown top-level, nested, and repository-option keys without mutating input", async (t) => {
  const { repository } = await repositoryFixture(t, 2);
  for (const value of [
    sample({ unexpected: true }),
    sample({ storage: { targetId: "x", unexpected: true } }),
    sample({ video: { relativePath: "videos/a.mp4", unexpected: true } })
  ]) expectCode(() => repository.createCompletedRecord(value), value.video ? "PACK_RECORD_VIDEO_INVALID" : "PACK_RECORD_INPUT_INVALID");
  expectCode(() => createPackRecordRepository({}, { clock: fixedNow }), "PACK_RECORD_REPOSITORY_OPTIONS_INVALID");
});

test("AWB identity is trimmed and case-sensitive and duplicate conflicts are stable", async (t) => {
  const { repository } = await repositoryFixture(t, 2);
  repository.createCompletedRecord(sample({ id: "one", awb: "  Case-AWB  " }));
  repository.createCompletedRecord(sample({ id: "two", awb: "case-AWB" }));
  expectCode(() => repository.createCompletedRecord(sample({ id: "one", awb: "other" })), "PACK_RECORD_ID_EXISTS");
  expectCode(() => repository.createCompletedRecord(sample({ id: "three", awb: " Case-AWB " })), "PACK_RECORD_AWB_EXISTS");
  assert.equal(repository.getRecordByAwb("Case-AWB").id, "one");
  assert.equal(repository.getRecordByAwb("case-AWB").id, "two");
});

test("record and optional video insertion is atomic and rolls back on video failure", async (t) => {
  const { database, repository } = await repositoryFixture(t, 2);
  database.exec(`
    CREATE TRIGGER reject_new_video BEFORE INSERT ON pack_record_videos
    BEGIN SELECT RAISE(ABORT, 'RAW SQL marker /secret/customer'); END
  `);
  const cause = expectCode(
    () => repository.createCompletedRecord(sample({ video: { relativePath: "videos/a.mp4" } })),
    "PACK_RECORD_CREATE_FAILED"
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pack_records").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pack_record_videos").get().count, 0);
  assert.doesNotMatch(JSON.stringify(cause), /RAW SQL|secret|customer|videos\/a/);
});

test("list pagination preserves the approved bounds, lookahead cursor, and complete ordering", async (t) => {
  const { database, repository } = await repositoryFixture(t, 2);
  for (let index = 0; index < 503; index += 1) {
    repository.createCompletedRecord(sample({ id: `r-${index}`, awb: `A-${index}` }));
  }
  const defaultPage = repository.listRecords();
  assert.equal(defaultPage.records.length, 100);
  assert.equal(defaultPage.nextBeforeSequence, 403);

  const first = repository.listRecords({ limit: 500 });
  assert.equal(first.records.length, 500);
  assert.equal(first.nextBeforeSequence, 3);
  const second = repository.listRecords({ limit: 500, beforeSequence: first.nextBeforeSequence });
  assert.deepEqual(second.records.map((record) => record.id), ["r-2", "r-1", "r-0"]);
  assert.equal(second.nextBeforeSequence, null);
  assert.equal(first.records.some((record) => second.records.some((candidate) => candidate.id === record.id)), false);
  assert.equal(second.records[0].id, "r-2");

  const acceptedCursor = repository.listRecords({ beforeSequence: 1 });
  assert.deepEqual(acceptedCursor.records.map((record) => record.id), ["r-0"]);
  assert.equal(acceptedCursor.nextBeforeSequence, null);
  expectCode(() => repository.listRecords({ beforeId: "r-1" }), "PACK_RECORD_LIST_OPTIONS_INVALID");
  expectCode(() => repository.listRecords({ beforeSequence: 0 }), "PACK_RECORD_LIST_OPTIONS_INVALID");
  expectCode(() => repository.listRecords({ limit: 501 }), "PACK_RECORD_LIST_OPTIONS_INVALID");

  const everyId = [];
  let beforeSequence;
  do {
    const page = repository.listRecords({ limit: 37, ...(beforeSequence ? { beforeSequence } : {}) });
    everyId.push(...page.records.map((record) => record.id));
    beforeSequence = page.nextBeforeSequence;
  } while (beforeSequence !== null);
  assert.equal(everyId.length, 503);
  assert.equal(new Set(everyId).size, 503);
  assert.deepEqual(everyId, Array.from({ length: 503 }, (_, index) => `r-${502 - index}`));
  assert.deepEqual(database.prepare("SELECT record_sequence FROM pack_records ORDER BY record_sequence").all().slice(0, 4).map((row) => row.record_sequence), [0, 1, 2, 3]);
});

test("an empty list page has no next cursor", async (t) => {
  const { repository } = await repositoryFixture(t, 2);
  assert.deepEqual(repository.listRecords(), { records: [], nextBeforeSequence: null });
});

test("approved list filters use the public names and bounded SQL chronology", async (t) => {
  const { repository } = await repositoryFixture(t, 2);
  repository.createCompletedRecord(sample({
    id: "early", awb: "SEARCH-EARLY", status: "pass", platform: "ไทย",
    employeeId: "EMP-1", startedAt: "2026-07-18T07:00:00.000Z"
  }));
  repository.createCompletedRecord(sample({
    id: "middle", awb: "SEARCH-MIDDLE", status: "pass", platform: "ไทย",
    employeeId: "EMP-1", startedAt: "2026-07-18T08:00:00.000Z"
  }));
  repository.createCompletedRecord(sample({
    id: "late", awb: "OTHER-LATE", status: "warn", platform: "Other",
    employeeId: "EMP-2", startedAt: "2026-07-18T09:00:00.000Z"
  }));
  const page = repository.listRecords({
    search: "SEARCH", status: "pass", platform: "ไทย", employeeId: "EMP-1",
    startedAtFrom: "2026-07-18T07:30:00.000Z",
    startedAtBefore: "2026-07-18T09:00:00.000Z"
  });
  assert.deepEqual(page.records.map((record) => record.id), ["middle"]);
  assert.equal(page.nextBeforeSequence, null);
});

test("creates and replaces exactly one video metadata row and reports a missing parent", async (t) => {
  const { database, repository } = await repositoryFixture(t, 2);
  repository.createCompletedRecord(sample());
  const first = repository.associateVideoMetadata("record-1", { relativePath: "videos/first clip.mp4", bytes: 10 });
  assert.equal(first.video.bytes, 10);
  const second = repository.associateVideoMetadata("record-1", { relativePath: "videos/second clip.mp4", bytes: 20 });
  assert.equal(second.video.relativePath, "videos/second clip.mp4");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pack_record_videos").get().count, 1);
  expectCode(() => repository.associateVideoMetadata("missing", {}), "PACK_RECORD_NOT_FOUND");
});

test("accepts safe Unicode relative video paths and rejects unsafe path forms", async (t) => {
  const { repository } = await repositoryFixture(t, 2);
  repository.createCompletedRecord(sample({ video: { relativePath: "videos/ไทย คลิป.mp4", customPath: "archive/2026 07" } }));
  const unsafe = [
    "/absolute/a.mp4", "../a.mp4", "nested/../../a.mp4", "nested\\a.mp4",
    "C:/absolute/a.mp4", "//server/share/a.mp4", "videos//a.mp4", "videos/./a.mp4",
    "videos/a\0.mp4", "videos/a\n.mp4"
  ];
  unsafe.forEach((relativePath, index) => expectCode(
    () => repository.createCompletedRecord(sample({ id: `unsafe-${index}`, awb: `unsafe-${index}`, video: { relativePath } })),
    "PACK_RECORD_VIDEO_INVALID"
  ));
});

test("requires canonical UTC timestamps for writes and enforces chronology", async (t) => {
  const { repository } = await repositoryFixture(t, 2);
  for (const startedAt of ["2026-07-18T08:00:00Z", "2026-07-18T15:00:00.000+07:00", "not-a-date"]) {
    expectCode(() => repository.createCompletedRecord(sample({ startedAt })), "PACK_RECORD_INPUT_INVALID");
  }
  expectCode(() => repository.createCompletedRecord(sample({
    startedAt: FIXED_TIME, endedAt: "2026-07-18T07:59:59.000Z"
  })), "PACK_RECORD_INPUT_INVALID");
  expectCode(() => repository.createCompletedRecord(sample({
    startedAt: FIXED_TIME, video: { savedAt: "2026-07-18T07:59:59.000Z" }
  })), "PACK_RECORD_INPUT_INVALID");
});

test("hydrates valid imported timezone-offset timestamps on schema version 2", async (t) => {
  const { database, repository } = await repositoryFixture(t, 2);
  const record = sample({
    startedAt: "2026-07-18T14:00:00+07:00",
    endedAt: "2026-07-18T14:01:00+07:00",
    video: { savedAt: "2026-07-18T14:01:01+07:00", customPath: "/legacy/import/path" }
  });
  importPackRecords(database, [record], { now: fixedNow });
  assert.equal(repository.getRecordById("record-1").startedAt, record.startedAt);
  assert.equal(repository.getRecordById("record-1").video.customPath, "/legacy/import/path");
});

test("literal substring search escapes percent, underscore, and backslash", async (t) => {
  const { repository } = await repositoryFixture(t, 2);
  repository.createCompletedRecord(sample({ id: "percent", awb: "BOX%100" }));
  repository.createCompletedRecord(sample({ id: "underscore", awb: "BOX_100" }));
  repository.createCompletedRecord(sample({ id: "ordinary", awb: "BOXA100" }));
  assert.deepEqual(repository.listRecords({ search: "%" }).records.map((row) => row.id), ["percent"]);
  assert.deepEqual(repository.listRecords({ search: "_" }).records.map((row) => row.id), ["underscore"]);
  assert.deepEqual(repository.listRecords({ search: "\\" }), { records: [], nextBeforeSequence: null });
});

test("filters and summaries use the same SQL semantics", async (t) => {
  const { repository } = await repositoryFixture(t, 2);
  repository.createCompletedRecord(sample({ id: "one", awb: "A1", platform: "ไทย", durationSeconds: 10, sizeMb: 1 }));
  repository.createCompletedRecord(sample({ id: "two", awb: "A2", platform: "ไทย", status: "warn", durationSeconds: 20, sizeMb: 2, video: {} }));
  repository.createCompletedRecord(sample({ id: "three", awb: "A3", platform: "Other", durationSeconds: 30, sizeMb: 3 }));
  assert.deepEqual(repository.listRecords({ platform: "ไทย" }).records.map((row) => row.id), ["two", "one"]);
  assert.deepEqual(repository.summarizeRecords({ platform: "ไทย" }), {
    totalRecords: 2, passRecords: 1, warnRecords: 1, recordsWithVideo: 1,
    totalDurationSeconds: 30, totalSizeMb: 3
  });
  expectCode(() => repository.listRecords({ hasVideo: true }), "PACK_RECORD_LIST_OPTIONS_INVALID");
  assert.equal(repository.summarizeRecords({ hasVideo: true }).totalRecords, 1);
});

test("malformed direct-SQL rows fail closed with sanitized read errors", async (t) => {
  const { database, repository } = await repositoryFixture(t, 2);
  database.prepare(`
    INSERT INTO pack_records (
      id, record_sequence, awb, awb_normalized, started_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("RAW-SECRET-ID", 0, "CUSTOMER-AWB", "CUSTOMER-AWB", "invalid timestamp", "pass", FIXED_TIME, FIXED_TIME);
  const cause = expectCode(() => repository.getRecordById("RAW-SECRET-ID"), "PACK_RECORD_STORED_DATA_INVALID");
  assert.doesNotMatch(JSON.stringify(cause), /RAW|SECRET|CUSTOMER|invalid timestamp|SELECT|pack_records/);
});

test("caller-owned temporary database remains open after repository operations", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "smartrecord-pack-repository-"));
  const databasePath = path.join(directory, "repository.sqlite");
  const database = await openSqliteDatabase(databasePath);
  t.after(async () => { closeSqliteDatabase(database); await rm(directory, { recursive: true, force: true }); });
  await runSqliteMigrations(database, { maximumVersion: 2, now: fixedNow });
  const repository = createPackRecordRepository(database, { now: fixedNow });
  repository.createCompletedRecord(sample());
  assert.equal(database.prepare("SELECT 1 AS value").get().value, 1);
});

test("Phase 4B schema-version-2 import and verifier remain compatible with repository reads", async (t) => {
  const database = await databaseFixture(t, 2);
  const input = [sample({
    id: "imported-1", awb: "  IMPORTED-AWB  ", startedAt: "2026-07-18T14:00:00+07:00",
    endedAt: "2026-07-18T14:01:00+07:00", video: { relativePath: "legacy/videos/clip.mp4" }
  })];
  const importResult = importPackRecords(database, input, { now: fixedNow });
  const verification = verifyPackRecordImport(database, input, importResult);
  assert.equal(verification.ok, true);
  const repository = createPackRecordRepository(database, { now: fixedNow });
  const byId = repository.getRecordById("imported-1");
  const byAwb = repository.getRecordByAwb("IMPORTED-AWB");
  const listed = repository.listRecords().records[0];
  assert.equal(byId.awb, "IMPORTED-AWB");
  assert.equal(byAwb.awb, "IMPORTED-AWB");
  assert.equal(listed.awb, "IMPORTED-AWB");
  assert.equal(database.prepare("SELECT awb FROM pack_records WHERE id = ?").get("imported-1").awb, "  IMPORTED-AWB  ");
  expectCode(
    () => repository.createCompletedRecord(sample({ id: "duplicate-awb", awb: " IMPORTED-AWB " })),
    "PACK_RECORD_AWB_EXISTS"
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pack_records").get().count, 1);
  repository.createCompletedRecord(sample({ id: "live-1", awb: "LIVE-AWB" }));
  assert.deepEqual(repository.listRecords().records.map((record) => record.id), ["live-1", "imported-1"]);
});

test("every record-returning method exposes only approved public object keys", async (t) => {
  const { repository } = await repositoryFixture(t, 2);
  const created = repository.createCompletedRecord(sample({
    storage: { targetId: "target", label: "label", provider: "local", host: "host" },
    video: { relativePath: "videos/initial.mp4" }
  }));
  const byId = repository.getRecordById("record-1");
  const byAwb = repository.getRecordByAwb("AWB-1");
  const listed = repository.listRecords().records[0];
  const associated = repository.associateVideoMetadata("record-1", { relativePath: "videos/replaced.mp4" });
  [created, byId, byAwb, listed, associated].forEach(assertPublicRecord);
});

test("operational read failures use the approved stable read code", async (t) => {
  const { database, repository } = await repositoryFixture(t, 2);
  closeSqliteDatabase(database);
  expectCode(() => repository.getRecordById("record-1"), "PACK_RECORD_READ_FAILED");
});

test("database and clock failures never leak SQL messages, paths, or record values", async (t) => {
  const { database } = await repositoryFixture(t, 2);
  const repository = createPackRecordRepository(database, {
    now() { throw new Error("RAW SQL CUSTOMER-AWB /private/secret.sqlite"); }
  });
  const cause = expectCode(() => repository.createCompletedRecord(sample({ awb: "CUSTOMER-AWB" })), "PACK_RECORD_TIMESTAMP_INVALID");
  assert.doesNotMatch(JSON.stringify(cause), /RAW SQL|CUSTOMER|private|secret|sqlite/);
});
