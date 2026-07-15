import assert from "node:assert/strict";
import test from "node:test";
import * as validator from "../src/storage/packRecordImportValidator.mjs";

const {
  buildPackRecordImportDryRunReport,
  validatePackRecordImport
} = validator;

function validRecord(overrides = {}) {
  return { id: "record-1", awb: "AWB-1", status: "pass", ...overrides };
}

function codes(result, recordIndex = 0) {
  return result.records[recordIndex].issues.map((recordIssue) => recordIssue.code);
}

function issueAt(result, code, recordIndex = 0) {
  return result.records[recordIndex].issues.find((recordIssue) => recordIssue.code === code);
}

function deeplyFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deeplyFreeze(child);
  }
  return value;
}

test("exports exactly the validator and dry-run reporter", () => {
  assert.deepEqual(Object.keys(validator).sort(), [
    "buildPackRecordImportDryRunReport",
    "validatePackRecordImport"
  ]);
});

test("blocks non-array inputs with one batch issue", () => {
  for (const input of [null, undefined, {}, "records", 3]) {
    const result = validatePackRecordImport(input);
    assert.equal(result.ok, false);
    assert.equal(result.inputRecordCount, 0);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.duplicateIdGroups, []);
    assert.deepEqual(result.duplicateAwbGroups, []);
    assert.deepEqual(result.batchIssues.map(({ severity, code, path, recordIndex, details }) => ({
      severity,
      code,
      path,
      recordIndex,
      details
    })), [{
      severity: "error",
      code: "BATCH_NOT_ARRAY",
      path: "$",
      recordIndex: null,
      details: {}
    }]);
  }
});

test("accepts an empty array and builds a zero-row ready report", () => {
  const result = validatePackRecordImport([]);
  assert.deepEqual(result, {
    ok: true,
    inputRecordCount: 0,
    records: [],
    duplicateIdGroups: [],
    duplicateAwbGroups: [],
    batchIssues: []
  });
  assert.deepEqual(buildPackRecordImportDryRunReport(result), {
    mode: "dry-run",
    status: "ready",
    wouldWrite: false,
    inputRecordCount: 0,
    validRecordCount: 0,
    invalidRecordCount: 0,
    plannedPackRecordRows: 0,
    plannedVideoRows: 0,
    errorCount: 0,
    warningCount: 0,
    duplicateIdGroupCount: 0,
    duplicateAwbGroupCount: 0,
    recordSequenceFirst: null,
    recordSequenceLast: null
  });
});

test("accepts minimal pass and warn records", () => {
  const result = validatePackRecordImport([
    validRecord(),
    validRecord({ id: "record-2", awb: "AWB-2", status: "warn" })
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.records.map((record) => record.importable), [true, true]);
  assert.deepEqual(result.records.map((record) => record.issues), [[], []]);
});

test("reports missing, wrong-type, and empty ids", () => {
  const missing = validatePackRecordImport([{ awb: "A", status: "pass" }]);
  const wrongType = validatePackRecordImport([validRecord({ id: 1 })]);
  const empty = validatePackRecordImport([validRecord({ id: " \t" })]);
  assert.deepEqual(codes(missing), ["ID_REQUIRED"]);
  assert.deepEqual(codes(wrongType), ["ID_INVALID_TYPE"]);
  assert.deepEqual(codes(empty), ["ID_EMPTY"]);
  assert.equal(empty.records[0].id, " \t");
});

test("accepts seed_0 without UUID validation", () => {
  const result = validatePackRecordImport([validRecord({ id: "seed_0" })]);
  assert.equal(result.ok, true);
  assert.equal(result.records[0].id, "seed_0");
});

test("reports missing, wrong-type, empty, and whitespace-only awbs", () => {
  const missing = validatePackRecordImport([{ id: "1", status: "pass" }]);
  const wrongType = validatePackRecordImport([validRecord({ awb: 1 })]);
  const empty = validatePackRecordImport([validRecord({ awb: "" })]);
  const whitespace = validatePackRecordImport([validRecord({ awb: " \n" })]);
  assert.deepEqual(codes(missing), ["AWB_REQUIRED"]);
  assert.deepEqual(codes(wrongType), ["AWB_INVALID_TYPE"]);
  assert.deepEqual(codes(empty), ["AWB_EMPTY"]);
  assert.deepEqual(codes(whitespace), ["AWB_EMPTY"]);
});

test("normalizes awb with exact String(value).trim behavior while preserving raw awb", () => {
  const rawAwb = "\t AbC-001 \n";
  const result = validatePackRecordImport([validRecord({ awb: rawAwb })]);
  assert.equal(result.records[0].awb, rawAwb);
  assert.equal(result.records[0].awbNormalized, "AbC-001");
});

test("treats normalized awb uniqueness as case-sensitive", () => {
  const result = validatePackRecordImport([
    validRecord({ id: "1", awb: "abc" }),
    validRecord({ id: "2", awb: "ABC" })
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.duplicateAwbGroups, []);
});

test("rejects every status other than exact pass or warn", () => {
  for (const status of [undefined, null, "PASS", "", 1, true]) {
    const record = validRecord({ status });
    if (status === undefined) delete record.status;
    const result = validatePackRecordImport([record]);
    assert.deepEqual(codes(result), ["STATUS_INVALID"]);
    assert.equal(issueAt(result, "STATUS_INVALID").path, "$[0].status");
  }
});

test("accepts absent, null, and empty optional strings", () => {
  const optionalFields = [
    "platform",
    "employeeId",
    "stationId",
    "itemSummary",
    "shareLink",
    "forceCloseReason"
  ];
  const withNulls = validRecord();
  const withEmptyStrings = validRecord({ id: "2", awb: "B" });
  for (const field of optionalFields) {
    withNulls[field] = null;
    withEmptyStrings[field] = "";
  }
  assert.equal(validatePackRecordImport([
    validRecord({ id: "1", awb: "A" }),
    withNulls,
    withEmptyStrings
  ]).ok, true);
});

test("rejects wrong optional string types with field-specific paths", () => {
  const result = validatePackRecordImport([validRecord({
    platform: 1,
    employeeId: false,
    stationId: {},
    itemSummary: [],
    shareLink: 2,
    forceCloseReason: true
  })]);
  assert.deepEqual(codes(result), [
    "PLATFORM_INVALID_TYPE",
    "EMPLOYEE_ID_INVALID_TYPE",
    "STATION_ID_INVALID_TYPE",
    "ITEM_SUMMARY_INVALID_TYPE",
    "SHARE_LINK_INVALID_TYPE",
    "FORCE_CLOSE_REASON_INVALID_TYPE"
  ]);
});

test("accepts valid timestamps with Z or an explicit offset", () => {
  const result = validatePackRecordImport([validRecord({
    startedAt: "2026-07-15T01:02:03.456Z",
    endedAt: "2026-07-15T08:02:04+07:00",
    video: { savedAt: "2026-07-15T01:02:03-05:30" }
  })]);
  assert.equal(result.ok, true);
});

test("rejects invalid timestamps and timestamps without timezones", () => {
  const result = validatePackRecordImport([validRecord({
    startedAt: "2026-02-30T01:02:03Z",
    endedAt: "2026-07-15T01:02:03",
    video: { savedAt: "not-a-date" }
  })]);
  assert.deepEqual(codes(result), [
    "STARTED_AT_INVALID_TIMESTAMP",
    "ENDED_AT_INVALID_TIMESTAMP",
    "VIDEO_SAVED_AT_INVALID_TIMESTAMP"
  ]);
});

test("rejects endedAt earlier than startedAt", () => {
  const result = validatePackRecordImport([validRecord({
    startedAt: "2026-07-15T01:00:01Z",
    endedAt: "2026-07-15T01:00:00Z"
  })]);
  assert.deepEqual(codes(result), ["ENDED_AT_BEFORE_STARTED_AT"]);
  assert.equal(issueAt(result, "ENDED_AT_BEFORE_STARTED_AT").path, "$[0].endedAt");
});

test("accepts durationSeconds safe-integer boundaries", () => {
  const result = validatePackRecordImport([
    validRecord({ id: "1", awb: "A", durationSeconds: 0 }),
    validRecord({ id: "2", awb: "B", durationSeconds: Number.MAX_SAFE_INTEGER }),
    validRecord({ id: "3", awb: "C", durationSeconds: null })
  ]);
  assert.equal(result.ok, true);
});

test("rejects invalid durationSeconds values with specific codes", () => {
  const valuesAndCodes = [
    ["1", "DURATION_SECONDS_INVALID_TYPE"],
    [NaN, "DURATION_SECONDS_NOT_FINITE"],
    [Infinity, "DURATION_SECONDS_NOT_FINITE"],
    [-1, "DURATION_SECONDS_NEGATIVE"],
    [1.5, "DURATION_SECONDS_NOT_SAFE_INTEGER"],
    [Number.MAX_SAFE_INTEGER + 1, "DURATION_SECONDS_NOT_SAFE_INTEGER"]
  ];
  for (const [durationSeconds, code] of valuesAndCodes) {
    assert.deepEqual(codes(validatePackRecordImport([validRecord({ durationSeconds })])), [code]);
  }
});

test("accepts top-level sizeMb boundaries and rejects invalid values", () => {
  assert.equal(validatePackRecordImport([
    validRecord({ id: "1", awb: "A", sizeMb: 0 }),
    validRecord({ id: "2", awb: "B", sizeMb: 1.25 }),
    validRecord({ id: "3", awb: "C", sizeMb: null })
  ]).ok, true);
  assert.deepEqual(codes(validatePackRecordImport([validRecord({ sizeMb: "1" })])), ["SIZE_MB_INVALID_TYPE"]);
  assert.deepEqual(codes(validatePackRecordImport([validRecord({ sizeMb: Infinity })])), ["SIZE_MB_NOT_FINITE"]);
  assert.deepEqual(codes(validatePackRecordImport([validRecord({ sizeMb: -0.1 })])), ["SIZE_MB_NEGATIVE"]);
});

test("accepts absent and null storage but rejects non-plain storage", () => {
  assert.equal(validatePackRecordImport([
    validRecord({ id: "1", awb: "A" }),
    validRecord({ id: "2", awb: "B", storage: null })
  ]).ok, true);
  for (const storage of [[], "disk", new Map(), new Date()]) {
    const result = validatePackRecordImport([validRecord({ storage })]);
    assert.equal(result.ok, false);
    assert.equal(result.records[0].issues[0].path, "$[0].storage");
  }
});

test("accepts every storage string field and null", () => {
  const result = validatePackRecordImport([validRecord({
    storage: { targetId: "target", label: null, provider: "local", host: "station" }
  })]);
  assert.equal(result.ok, true);
});

test("rejects storage field types and sorts unknown storage warnings", () => {
  const result = validatePackRecordImport([validRecord({
    storage: { targetId: 1, label: false, provider: [], host: {}, zeta: 1, alpha: 2 }
  })]);
  assert.deepEqual(codes(result), [
    "STORAGE_TARGET_ID_INVALID_TYPE",
    "STORAGE_LABEL_INVALID_TYPE",
    "STORAGE_PROVIDER_INVALID_TYPE",
    "STORAGE_HOST_INVALID_TYPE",
    "UNKNOWN_FIELD",
    "UNKNOWN_FIELD"
  ]);
  assert.deepEqual(result.records[0].issues.slice(-2).map((recordIssue) => recordIssue.path), [
    "$[0].storage.alpha",
    "$[0].storage.zeta"
  ]);
});

test("accepts absent and null video but rejects non-plain video", () => {
  const accepted = validatePackRecordImport([
    validRecord({ id: "1", awb: "A" }),
    validRecord({ id: "2", awb: "B", video: null })
  ]);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.records.map((record) => record.hasVideo), [false, false]);
  assert.deepEqual(codes(validatePackRecordImport([validRecord({ video: [] })])), ["VIDEO_INVALID_TYPE"]);
  assert.deepEqual(codes(validatePackRecordImport([validRecord({ video: "clip" })])), ["VIDEO_INVALID_TYPE"]);
  assert.deepEqual(codes(validatePackRecordImport([validRecord({ video: new Set() })])), ["FIELD_NOT_SERIALIZABLE"]);
});

test("accepts every known video field", () => {
  const result = validatePackRecordImport([validRecord({
    video: {
      fileName: "clip.mp4",
      relativePath: "videos/clip.mp4",
      bytes: 123,
      sizeMb: 1.5,
      contentType: "video/mp4",
      storageTargetId: "target",
      storageLabel: "Disk",
      storageHost: "station",
      storageMode: "local",
      mountedRequired: true,
      simulated: false,
      externalUrl: "https://example.invalid/clip",
      customPath: "/clips",
      shareLink: "https://example.invalid/share",
      savedAt: "2026-07-15T01:02:03Z"
    }
  })]);
  assert.equal(result.ok, true);
  assert.equal(result.records[0].hasVideo, true);
});

test("rejects wrong types for every known video string field", () => {
  const fields = [
    "fileName",
    "relativePath",
    "contentType",
    "storageTargetId",
    "storageLabel",
    "storageHost",
    "storageMode",
    "externalUrl",
    "customPath",
    "shareLink"
  ];
  const video = Object.fromEntries(fields.map((field) => [field, 1]));
  const result = validatePackRecordImport([validRecord({ video })]);
  assert.deepEqual(result.records[0].issues.map((recordIssue) => recordIssue.path), fields.map(
    (field) => `$[0].video.${field}`
  ));
});

test("validates video.bytes safe-integer boundaries", () => {
  assert.equal(validatePackRecordImport([
    validRecord({ id: "1", awb: "A", video: { bytes: 0 } }),
    validRecord({ id: "2", awb: "B", video: { bytes: Number.MAX_SAFE_INTEGER } }),
    validRecord({ id: "3", awb: "C", video: { bytes: null } })
  ]).ok, true);
  const valuesAndCodes = [
    ["1", "VIDEO_BYTES_INVALID_TYPE"],
    [Infinity, "VIDEO_BYTES_NOT_FINITE"],
    [-1, "VIDEO_BYTES_NEGATIVE"],
    [1.25, "VIDEO_BYTES_NOT_SAFE_INTEGER"],
    [Number.MAX_SAFE_INTEGER + 1, "VIDEO_BYTES_NOT_SAFE_INTEGER"]
  ];
  for (const [bytes, code] of valuesAndCodes) {
    assert.deepEqual(codes(validatePackRecordImport([validRecord({ video: { bytes } })])), [code]);
  }
});

test("validates video.sizeMb boundaries independently", () => {
  assert.equal(validatePackRecordImport([
    validRecord({ id: "1", awb: "A", video: { sizeMb: 0 } }),
    validRecord({ id: "2", awb: "B", video: { sizeMb: 2.5 } }),
    validRecord({ id: "3", awb: "C", video: { sizeMb: null } })
  ]).ok, true);
  assert.deepEqual(codes(validatePackRecordImport([validRecord({ video: { sizeMb: false } })])), ["VIDEO_SIZE_MB_INVALID_TYPE"]);
  assert.deepEqual(codes(validatePackRecordImport([validRecord({ video: { sizeMb: -1 } })])), ["VIDEO_SIZE_MB_NEGATIVE"]);
  assert.deepEqual(codes(validatePackRecordImport([validRecord({ video: { sizeMb: NaN } })])), ["VIDEO_SIZE_MB_NOT_FINITE"]);
});

test("accepts boolean or null video flags and rejects numeric zero and one", () => {
  assert.equal(validatePackRecordImport([validRecord({
    video: { mountedRequired: true, simulated: null }
  })]).ok, true);
  const result = validatePackRecordImport([validRecord({
    video: { mountedRequired: 1, simulated: 0 }
  })]);
  assert.deepEqual(codes(result), [
    "VIDEO_MOUNTED_REQUIRED_INVALID_TYPE",
    "VIDEO_SIMULATED_INVALID_TYPE"
  ]);
});

test("leaves relativePath byte-for-byte unchanged", () => {
  const relativePath = String.raw`..\capture//folder/คลิป.mp4`;
  const input = [validRecord({ video: { relativePath } })];
  validatePackRecordImport(input);
  assert.equal(input[0].video.relativePath, relativePath);
});

test("keeps top-level and video size and shareLink validation independent", () => {
  const result = validatePackRecordImport([validRecord({
    sizeMb: 10,
    shareLink: "top-level",
    video: { sizeMb: 5, shareLink: "video-level" }
  })]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.records[0].issues, []);
});

test("emits one sorted warning for each supplied reserved field", () => {
  const result = validatePackRecordImport([validRecord({
    updatedAt: "supplied",
    sourcePayloadJson: "supplied",
    recordSequence: 999,
    createdAt: "supplied",
    awbNormalized: "supplied"
  })]);
  assert.equal(result.ok, true);
  assert.deepEqual(codes(result), Array(5).fill("DERIVED_FIELD_IGNORED"));
  assert.deepEqual(result.records[0].issues.map((recordIssue) => recordIssue.path), [
    "$[0].awbNormalized",
    "$[0].createdAt",
    "$[0].recordSequence",
    "$[0].sourcePayloadJson",
    "$[0].updatedAt"
  ]);
  assert.equal(result.records[0].recordSequence, 0);
  assert.equal(result.records[0].awbNormalized, "AWB-1");
});

test("emits sorted unknown warnings at top-level, storage, and video paths", () => {
  const result = validatePackRecordImport([validRecord({
    zTop: 1,
    aTop: 2,
    storage: { zStorage: 1, aStorage: 2 },
    video: { storagePath: "legacy", durationSecs: 3 }
  })]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.records[0].issues.map(({ code, path }) => ({ code, path })), [
    { code: "UNKNOWN_FIELD", path: "$[0].aTop" },
    { code: "UNKNOWN_FIELD", path: "$[0].storage.aStorage" },
    { code: "UNKNOWN_FIELD", path: "$[0].storage.zStorage" },
    { code: "UNKNOWN_FIELD", path: "$[0].video.durationSecs" },
    { code: "UNKNOWN_FIELD", path: "$[0].video.storagePath" },
    { code: "UNKNOWN_FIELD", path: "$[0].zTop" }
  ]);
});

test("reports a circular reference once at the record path and stops that record", () => {
  const record = validRecord();
  record.nested = { back: record };
  const result = validatePackRecordImport([record]);
  assert.deepEqual(codes(result), ["RECORD_NOT_SERIALIZABLE"]);
  assert.equal(result.records[0].issues[0].path, "$[0]");
  assert.equal(result.records[0].issues[0].severity, "error");
});

test("reports BigInt, function, symbol, and undefined at exact paths", () => {
  const result = validatePackRecordImport([validRecord({
    unknownBigInt: 1n,
    unknownFunction: () => {},
    unknownSymbol: Symbol("value"),
    unknownUndefined: undefined
  })]);
  assert.deepEqual(result.records[0].issues.map(({ code, path }) => ({ code, path })), [
    { code: "FIELD_NOT_SERIALIZABLE", path: "$[0].unknownBigInt" },
    { code: "FIELD_NOT_SERIALIZABLE", path: "$[0].unknownFunction" },
    { code: "FIELD_NOT_SERIALIZABLE", path: "$[0].unknownSymbol" },
    { code: "FIELD_UNDEFINED_VALUE", path: "$[0].unknownUndefined" }
  ]);
});

test("uses known numeric codes for non-finite known fields and generic codes for unknown numbers", () => {
  const result = validatePackRecordImport([validRecord({
    durationSeconds: NaN,
    sizeMb: Infinity,
    video: { bytes: -Infinity, sizeMb: NaN },
    unknownNumber: Infinity,
    unknownObject: { sizeMb: -Infinity }
  })]);
  assert.deepEqual(result.records[0].issues.map(({ code, path }) => ({ code, path })), [
    { code: "DURATION_SECONDS_NOT_FINITE", path: "$[0].durationSeconds" },
    { code: "SIZE_MB_NOT_FINITE", path: "$[0].sizeMb" },
    { code: "VIDEO_BYTES_NOT_FINITE", path: "$[0].video.bytes" },
    { code: "VIDEO_SIZE_MB_NOT_FINITE", path: "$[0].video.sizeMb" },
    { code: "FIELD_NOT_SERIALIZABLE", path: "$[0].unknownNumber" },
    { code: "FIELD_NOT_SERIALIZABLE", path: "$[0].unknownObject.sizeMb" },
    { code: "UNKNOWN_FIELD", path: "$[0].unknownObject" }
  ]);
});

test("rejects unsupported nested objects at their exact paths", () => {
  const result = validatePackRecordImport([validRecord({
    unknownObject: { value: new Date("2026-07-15T00:00:00Z") },
    unknownArray: [1, new Map()]
  })]);
  assert.deepEqual(result.records[0].issues.slice(0, 2).map(({ code, path }) => ({ code, path })), [
    { code: "FIELD_NOT_SERIALIZABLE", path: "$[0].unknownArray[1]" },
    { code: "FIELD_NOT_SERIALIZABLE", path: "$[0].unknownObject.value" }
  ]);
  assert.deepEqual(result.records[0].issues.slice(2).map((recordIssue) => recordIssue.code), [
    "UNKNOWN_FIELD",
    "UNKNOWN_FIELD"
  ]);
});

test("rejects non-plain record entries without throwing", () => {
  class RecordInstance {}
  const result = validatePackRecordImport([null, [], new Date(), new Map(), new Set(), new RecordInstance()]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.records.map((record) => codes(result, record.inputIndex)),
    Array.from({ length: 6 }, () => ["RECORD_NOT_PLAIN_OBJECT"]));
});

test("does not mutate deeply frozen valid input", () => {
  const input = deeplyFreeze([validRecord({
    awb: " AWB-1 ",
    storage: { targetId: "target", unknown: { nested: [1, 2, 3] } },
    video: { relativePath: String.raw`a\b/c.mp4`, simulated: false }
  })]);
  const before = JSON.stringify(input);
  assert.doesNotThrow(() => validatePackRecordImport(input));
  assert.equal(JSON.stringify(input), before);
});

test("assigns newest-first sequences to valid and invalid records", () => {
  const result = validatePackRecordImport([
    validRecord({ id: "1", awb: "A" }),
    { id: "2", awb: "B", status: "invalid" },
    null
  ]);
  assert.deepEqual(result.records.map(({ inputIndex, recordSequence, importable }) => ({
    inputIndex,
    recordSequence,
    importable
  })), [
    { inputIndex: 0, recordSequence: 2, importable: true },
    { inputIndex: 1, recordSequence: 1, importable: false },
    { inputIndex: 2, recordSequence: 0, importable: false }
  ]);
});

test("groups duplicate ids once with every ascending source index", () => {
  const result = validatePackRecordImport([
    validRecord({ id: "same", awb: "A" }),
    validRecord({ id: "other", awb: "B" }),
    validRecord({ id: "same", awb: "C" }),
    validRecord({ id: "same", awb: "D" })
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.duplicateIdGroups.map(({ severity, code, path, recordIndex, details }) => ({
    severity,
    code,
    path,
    recordIndex,
    details
  })), [{
    severity: "error",
    code: "DUPLICATE_RECORD_ID",
    path: "$[0].id",
    recordIndex: 0,
    details: { value: "same", indexes: [0, 2, 3] }
  }]);
  assert.deepEqual(result.records.map((record) => record.importable), [true, true, true, true]);
});

test("groups duplicate normalized awbs once with every ascending source index", () => {
  const result = validatePackRecordImport([
    validRecord({ id: "1", awb: " DUP " }),
    validRecord({ id: "2", awb: "X" }),
    validRecord({ id: "3", awb: "DUP" }),
    validRecord({ id: "4", awb: "\tDUP\n" })
  ]);
  assert.deepEqual(result.duplicateAwbGroups.map(({ code, path, recordIndex, details }) => ({
    code,
    path,
    recordIndex,
    details
  })), [{
    code: "DUPLICATE_AWB_NORMALIZED",
    path: "$[0].awb",
    recordIndex: 0,
    details: { value: "DUP", indexes: [0, 2, 3] }
  }]);
});

test("excludes invalid ids and awbs from duplicate grouping", () => {
  const result = validatePackRecordImport([
    validRecord({ id: "", awb: " " }),
    validRecord({ id: "", awb: " " })
  ]);
  assert.deepEqual(result.duplicateIdGroups, []);
  assert.deepEqual(result.duplicateAwbGroups, []);
});

test("orders multiple duplicate groups by first index within id then awb collections", () => {
  const result = validatePackRecordImport([
    validRecord({ id: "id-b", awb: "awb-b" }),
    validRecord({ id: "id-a", awb: "awb-a" }),
    validRecord({ id: "id-a", awb: "awb-b" }),
    validRecord({ id: "id-b", awb: "awb-a" })
  ]);
  assert.deepEqual(result.duplicateIdGroups.map((group) => group.details), [
    { value: "id-b", indexes: [0, 3] },
    { value: "id-a", indexes: [1, 2] }
  ]);
  assert.deepEqual(result.duplicateAwbGroups.map((group) => group.details), [
    { value: "awb-b", indexes: [0, 2] },
    { value: "awb-a", indexes: [1, 3] }
  ]);
});

test("orders errors, unknown warnings, and reserved warnings deterministically", () => {
  const result = validatePackRecordImport([{
    id: "",
    awb: " ",
    platform: 1,
    status: "bad",
    storage: { targetId: 1, z: 1, a: 1 },
    video: { bytes: -1, z: 1, a: 1 },
    zeta: 1,
    alpha: 1,
    createdAt: "ignored",
    awbNormalized: "ignored"
  }]);
  assert.deepEqual(result.records[0].issues.map(({ severity, code, path }) => ({ severity, code, path })), [
    { severity: "error", code: "ID_EMPTY", path: "$[0].id" },
    { severity: "error", code: "AWB_EMPTY", path: "$[0].awb" },
    { severity: "error", code: "PLATFORM_INVALID_TYPE", path: "$[0].platform" },
    { severity: "error", code: "STATUS_INVALID", path: "$[0].status" },
    { severity: "error", code: "STORAGE_TARGET_ID_INVALID_TYPE", path: "$[0].storage.targetId" },
    { severity: "error", code: "VIDEO_BYTES_NEGATIVE", path: "$[0].video.bytes" },
    { severity: "warning", code: "UNKNOWN_FIELD", path: "$[0].alpha" },
    { severity: "warning", code: "UNKNOWN_FIELD", path: "$[0].storage.a" },
    { severity: "warning", code: "UNKNOWN_FIELD", path: "$[0].storage.z" },
    { severity: "warning", code: "UNKNOWN_FIELD", path: "$[0].video.a" },
    { severity: "warning", code: "UNKNOWN_FIELD", path: "$[0].video.z" },
    { severity: "warning", code: "UNKNOWN_FIELD", path: "$[0].zeta" },
    { severity: "warning", code: "DERIVED_FIELD_IGNORED", path: "$[0].awbNormalized" },
    { severity: "warning", code: "DERIVED_FIELD_IGNORED", path: "$[0].createdAt" }
  ]);
});

test("suppresses a warning when serialization fails at the same path", () => {
  const result = validatePackRecordImport([validRecord({
    unknown: 1n,
    createdAt: undefined
  })]);
  assert.deepEqual(result.records[0].issues.map(({ code, path }) => ({ code, path })), [
    { code: "FIELD_NOT_SERIALIZABLE", path: "$[0].unknown" },
    { code: "FIELD_UNDEFINED_VALUE", path: "$[0].createdAt" }
  ]);
});

test("builds ready dry-run counts and plans video rows from hasVideo", () => {
  const validation = validatePackRecordImport([
    validRecord({ id: "1", awb: "A", video: {} }),
    validRecord({ id: "2", awb: "B", video: null }),
    validRecord({ id: "3", awb: "C" })
  ]);
  const report = buildPackRecordImportDryRunReport(validation);
  assert.deepEqual(report, {
    mode: "dry-run",
    status: "ready",
    wouldWrite: false,
    inputRecordCount: 3,
    validRecordCount: 3,
    invalidRecordCount: 0,
    plannedPackRecordRows: 3,
    plannedVideoRows: 1,
    errorCount: 0,
    warningCount: 0,
    duplicateIdGroupCount: 0,
    duplicateAwbGroupCount: 0,
    recordSequenceFirst: 2,
    recordSequenceLast: 0
  });
});

test("builds blocked dry-run counts with zero planned rows", () => {
  const validation = validatePackRecordImport([
    validRecord({ id: "same", awb: "DUP", unknown: true, video: {} }),
    validRecord({ id: "same", awb: " DUP " }),
    { id: "bad", awb: "BAD", status: "invalid" }
  ]);
  const report = buildPackRecordImportDryRunReport(validation);
  assert.equal(report.status, "blocked");
  assert.equal(report.validRecordCount, 2);
  assert.equal(report.invalidRecordCount, 1);
  assert.equal(report.plannedPackRecordRows, 0);
  assert.equal(report.plannedVideoRows, 0);
  assert.equal(report.warningCount, 1);
  assert.equal(report.duplicateIdGroupCount, 1);
  assert.equal(report.duplicateAwbGroupCount, 1);
  assert.equal(report.errorCount, 3);
  assert.equal(report.wouldWrite, false);
});

test("includes batch errors in dry-run errorCount", () => {
  const report = buildPackRecordImportDryRunReport(validatePackRecordImport({}));
  assert.equal(report.status, "blocked");
  assert.equal(report.errorCount, 1);
  assert.equal(report.plannedPackRecordRows, 0);
});

test("reporter derives results without revalidating an original input", () => {
  const validationOnly = {
    ok: true,
    inputRecordCount: 1,
    records: [{ importable: true, hasVideo: true, issues: [] }],
    duplicateIdGroups: [],
    duplicateAwbGroups: [],
    batchIssues: []
  };
  const report = buildPackRecordImportDryRunReport(validationOnly);
  assert.equal(report.status, "ready");
  assert.equal(report.plannedPackRecordRows, 1);
  assert.equal(report.plannedVideoRows, 1);
});

test("reporter does not mutate a deeply frozen validation result", () => {
  const validation = deeplyFreeze(validatePackRecordImport([
    validRecord({ video: {}, unknown: "warning" })
  ]));
  const before = JSON.stringify(validation);
  assert.doesNotThrow(() => buildPackRecordImportDryRunReport(validation));
  assert.equal(JSON.stringify(validation), before);
});
