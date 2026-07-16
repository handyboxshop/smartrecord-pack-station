import { validatePackRecordImport } from "./packRecordImportValidator.mjs";
import {
  SqliteStorageError,
  runSqliteForeignKeyCheck,
  runSqliteQuickCheck
} from "./sqliteDatabase.mjs";

const REQUIRED_SCHEMA_VERSION = 2;
const REQUIRED_TABLES = ["pack_records", "pack_record_videos"];

const PARENT_COLUMNS = [
  "id",
  "record_sequence",
  "awb",
  "awb_normalized",
  "platform",
  "employee_id",
  "station_id",
  "started_at",
  "ended_at",
  "duration_seconds",
  "status",
  "item_summary",
  "size_mb",
  "storage_target_id",
  "storage_label",
  "storage_provider",
  "storage_host",
  "share_link",
  "force_close_reason",
  "created_at",
  "updated_at"
];

const VIDEO_COLUMNS = [
  "record_id",
  "file_name",
  "relative_path",
  "bytes",
  "size_mb",
  "content_type",
  "storage_target_id",
  "storage_label",
  "storage_host",
  "storage_mode",
  "mounted_required",
  "simulated",
  "external_url",
  "custom_path",
  "share_link",
  "saved_at"
];

const RECORD_SELECT_SQL = `
  SELECT
    id,
    record_sequence,
    awb,
    awb_normalized,
    platform,
    employee_id,
    station_id,
    started_at,
    ended_at,
    duration_seconds,
    status,
    item_summary,
    size_mb,
    storage_target_id,
    storage_label,
    storage_provider,
    storage_host,
    share_link,
    force_close_reason,
    source_payload_json,
    created_at,
    updated_at
  FROM pack_records
  WHERE id = ?
  LIMIT 1
`;

const VIDEO_SELECT_SQL = `
  SELECT
    record_id,
    file_name,
    relative_path,
    bytes,
    size_mb,
    content_type,
    storage_target_id,
    storage_label,
    storage_host,
    storage_mode,
    mounted_required,
    simulated,
    external_url,
    custom_path,
    share_link,
    saved_at
  FROM pack_record_videos
  WHERE record_id = ?
  LIMIT 1
`;

const RECORD_ISSUE_CODES = new Set([
  "PACK_RECORD_ROW_MISSING",
  "PACK_RECORD_COLUMN_MISMATCH",
  "PACK_RECORD_SOURCE_PAYLOAD_MISSING",
  "PACK_RECORD_SOURCE_PAYLOAD_INVALID",
  "PACK_RECORD_SOURCE_PAYLOAD_MISMATCH",
  "PACK_RECORD_VIDEO_ROW_MISSING",
  "PACK_RECORD_VIDEO_ROW_UNEXPECTED",
  "PACK_RECORD_VIDEO_COLUMN_MISMATCH"
]);

const BATCH_ISSUE_CODES = new Set([
  "PACK_RECORD_ROW_COUNT_MISMATCH",
  "PACK_RECORD_VIDEO_ROW_COUNT_MISMATCH",
  "PACK_RECORD_QUICK_CHECK_FAILED",
  "PACK_RECORD_FOREIGN_KEY_VIOLATION"
]);

const ISSUE_FIELDS = new Set([
  "code",
  "scope",
  "table",
  "column",
  "inputIndex",
  "recordSequence"
]);

const RECORD_ISSUE_ORDER = new Map([
  ["PACK_RECORD_ROW_MISSING", 0],
  ["PACK_RECORD_COLUMN_MISMATCH", 1],
  ["PACK_RECORD_SOURCE_PAYLOAD_MISSING", 2],
  ["PACK_RECORD_SOURCE_PAYLOAD_INVALID", 2],
  ["PACK_RECORD_SOURCE_PAYLOAD_MISMATCH", 2],
  ["PACK_RECORD_VIDEO_ROW_MISSING", 3],
  ["PACK_RECORD_VIDEO_ROW_UNEXPECTED", 3],
  ["PACK_RECORD_VIDEO_COLUMN_MISMATCH", 4]
]);

const BATCH_ISSUE_ORDER = new Map([
  ["PACK_RECORD_ROW_COUNT_MISMATCH", 0],
  ["PACK_RECORD_VIDEO_ROW_COUNT_MISMATCH", 1],
  ["PACK_RECORD_QUICK_CHECK_FAILED", 2],
  ["PACK_RECORD_FOREIGN_KEY_VIOLATION", 3]
]);

const ERROR_MESSAGES = {
  PACK_RECORD_IMPORT_VERIFICATION_INPUT_INVALID:
    "Pack Record verification input is invalid.",
  PACK_RECORD_IMPORT_VERIFICATION_RESULT_INVALID:
    "Pack Record import result is invalid for verification.",
  PACK_RECORD_IMPORT_VERIFICATION_DATABASE_INVALID:
    "A caller-owned synchronous SQLite database is required for verification.",
  PACK_RECORD_IMPORT_VERIFICATION_SCHEMA_VERSION_INVALID:
    "Pack Record verification requires SQLite schema version 2.",
  PACK_RECORD_IMPORT_VERIFICATION_FOREIGN_KEYS_DISABLED:
    "Pack Record verification requires SQLite foreign key enforcement.",
  PACK_RECORD_IMPORT_VERIFICATION_SCHEMA_MISSING:
    "Required Pack Record SQLite tables are missing.",
  PACK_RECORD_IMPORT_VERIFICATION_TRANSACTION_BEGIN_FAILED:
    "Unable to begin the Pack Record verification read snapshot.",
  PACK_RECORD_IMPORT_VERIFICATION_QUERY_FAILED:
    "Pack Record verification could not read a complete database snapshot.",
  PACK_RECORD_IMPORT_VERIFICATION_COMMIT_FAILED:
    "Pack Record verification could not commit its read snapshot.",
  PACK_RECORD_IMPORT_VERIFICATION_ROLLBACK_FAILED:
    "Pack Record verification failed and its read snapshot could not be rolled back safely.",
  PACK_RECORD_IMPORT_VERIFICATION_REPORT_INVALID:
    "Pack Record verification result is invalid for reporting."
};

export class PackRecordImportVerificationError extends SqliteStorageError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = "PackRecordImportVerificationError";
    this.details = isPlainObject(options.details) ? { ...options.details } : {};
  }
}

export function verifyPackRecordImport(database, input, importResult) {
  const validationResult = validateInput(input);
  const inputRecordCount = validationResult.inputRecordCount;
  const expectedVideoRows = validationResult.records.reduce(
    (count, record) => count + (record.hasVideo ? 1 : 0),
    0
  );
  const trustedImportResult = validateImportResult(
    importResult,
    inputRecordCount,
    expectedVideoRows
  );
  requireDatabase(database);

  return runInReadSnapshot(database, () => {
    verifyDatabasePreconditions(database);

    const actualPackRecordRows = readTableCount(database, "pack_records");
    const actualVideoRows = readTableCount(database, "pack_record_videos");
    const batchIssues = [];

    if (actualPackRecordRows !== inputRecordCount) {
      batchIssues.push(batchIssue(
        "PACK_RECORD_ROW_COUNT_MISMATCH",
        "pack_records"
      ));
    }
    if (actualVideoRows !== expectedVideoRows) {
      batchIssues.push(batchIssue(
        "PACK_RECORD_VIDEO_ROW_COUNT_MISMATCH",
        "pack_record_videos"
      ));
    }

    const selectRecord = database.prepare(RECORD_SELECT_SQL);
    const selectVideo = database.prepare(VIDEO_SELECT_SQL);
    const records = validationResult.records.map((validatedRecord) => verifyRecord(
      selectRecord,
      selectVideo,
      input[validatedRecord.inputIndex],
      validatedRecord,
      trustedImportResult.batchTimestamp
    ));

    const quickCheck = runSqliteQuickCheck(database);
    const foreignKeyCheck = runSqliteForeignKeyCheck(database);
    const quickCheckOk = quickCheck?.ok === true;
    const foreignKeyViolationCount = normalizeCount(foreignKeyCheck?.violations?.length);

    if (!quickCheckOk) {
      batchIssues.push(batchIssue("PACK_RECORD_QUICK_CHECK_FAILED"));
    }
    if (foreignKeyViolationCount > 0) {
      batchIssues.push(batchIssue("PACK_RECORD_FOREIGN_KEY_VIOLATION"));
    }

    const mismatchedRecordCount = records.reduce(
      (count, record) => count + (record.verified ? 0 : 1),
      0
    );
    const verifiedRecordCount = records.length - mismatchedRecordCount;
    const ok = mismatchedRecordCount === 0 && batchIssues.length === 0;

    return {
      ok,
      status: ok ? "verified" : "mismatch",
      inputRecordCount,
      expectedPackRecordRows: inputRecordCount,
      actualPackRecordRows,
      expectedVideoRows,
      actualVideoRows,
      verifiedRecordCount,
      mismatchedRecordCount,
      batchTimestamp: trustedImportResult.batchTimestamp,
      recordSequenceFirst: trustedImportResult.recordSequenceFirst,
      recordSequenceLast: trustedImportResult.recordSequenceLast,
      integrity: {
        quickCheckOk,
        foreignKeyViolationCount
      },
      records,
      batchIssues
    };
  });
}

export function buildPackRecordImportVerificationReport(verificationResult) {
  let result;
  try {
    result = validateVerificationResult(verificationResult);
  } catch (cause) {
    if (cause instanceof PackRecordImportVerificationError
      && cause.code === "PACK_RECORD_IMPORT_VERIFICATION_REPORT_INVALID") {
      throw cause;
    }
    throw verificationError(
      "PACK_RECORD_IMPORT_VERIFICATION_REPORT_INVALID",
      { cause }
    );
  }
  const issueCounts = new Map();
  let errorCount = 0;

  for (const record of result.records) {
    for (const recordIssue of record.issues) {
      errorCount += 1;
      issueCounts.set(recordIssue.code, (issueCounts.get(recordIssue.code) ?? 0) + 1);
    }
  }
  for (const currentBatchIssue of result.batchIssues) {
    errorCount += 1;
    issueCounts.set(
      currentBatchIssue.code,
      (issueCounts.get(currentBatchIssue.code) ?? 0) + 1
    );
  }

  const issueCodeCounts = [...issueCounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));

  return {
    mode: "post-import-verification",
    status: result.status,
    wouldWrite: false,
    inputRecordCount: result.inputRecordCount,
    expectedPackRecordRows: result.expectedPackRecordRows,
    actualPackRecordRows: result.actualPackRecordRows,
    expectedVideoRows: result.expectedVideoRows,
    actualVideoRows: result.actualVideoRows,
    verifiedRecordCount: result.verifiedRecordCount,
    mismatchedRecordCount: result.mismatchedRecordCount,
    errorCount,
    issueCodeCounts,
    quickCheckStatus: result.integrity.quickCheckOk ? "ok" : "failed",
    foreignKeyViolationCount: result.integrity.foreignKeyViolationCount,
    batchTimestamp: result.batchTimestamp,
    recordSequenceFirst: result.recordSequenceFirst,
    recordSequenceLast: result.recordSequenceLast
  };
}

function validateInput(input) {
  let validationResult;
  try {
    validationResult = validatePackRecordImport(input);
  } catch (cause) {
    throw verificationError(
      "PACK_RECORD_IMPORT_VERIFICATION_INPUT_INVALID",
      { cause }
    );
  }
  if (validationResult?.ok !== true) {
    throw verificationError("PACK_RECORD_IMPORT_VERIFICATION_INPUT_INVALID");
  }
  return validationResult;
}

function validateImportResult(importResult, inputRecordCount, expectedVideoRows) {
  try {
    return inspectImportResult(importResult, inputRecordCount, expectedVideoRows);
  } catch (cause) {
    if (cause instanceof PackRecordImportVerificationError) throw cause;
    throw verificationError(
      "PACK_RECORD_IMPORT_VERIFICATION_RESULT_INVALID",
      { cause, details: { field: "importResult" } }
    );
  }
}

function inspectImportResult(importResult, inputRecordCount, expectedVideoRows) {
  if (!isPlainObject(importResult)) {
    throw invalidImportResult("importResult");
  }

  const expected = inputRecordCount === 0
    ? {
        ok: true,
        status: "no-op",
        inputRecordCount: 0,
        insertedPackRecordRows: 0,
        insertedVideoRows: 0,
        batchTimestamp: null,
        recordSequenceFirst: null,
        recordSequenceLast: null
      }
    : {
        ok: true,
        status: "imported",
        inputRecordCount,
        insertedPackRecordRows: inputRecordCount,
        insertedVideoRows: expectedVideoRows,
        recordSequenceFirst: inputRecordCount - 1,
        recordSequenceLast: 0
      };

  for (const [field, expectedValue] of Object.entries(expected)) {
    const descriptor = Object.getOwnPropertyDescriptor(importResult, field);
    if (!descriptor || !("value" in descriptor) || descriptor.value !== expectedValue) {
      throw invalidImportResult(field);
    }
  }

  const timestampDescriptor = Object.getOwnPropertyDescriptor(importResult, "batchTimestamp");
  if (!timestampDescriptor || !("value" in timestampDescriptor)) {
    throw invalidImportResult("batchTimestamp");
  }
  const batchTimestamp = timestampDescriptor.value;
  if (inputRecordCount === 0) {
    if (batchTimestamp !== null) throw invalidImportResult("batchTimestamp");
  } else if (!isCanonicalIsoTimestamp(batchTimestamp)) {
    throw invalidImportResult("batchTimestamp");
  }

  return {
    batchTimestamp,
    recordSequenceFirst: expected.recordSequenceFirst,
    recordSequenceLast: expected.recordSequenceLast
  };
}

function invalidImportResult(field) {
  return verificationError(
    "PACK_RECORD_IMPORT_VERIFICATION_RESULT_INVALID",
    { details: { field } }
  );
}

function requireDatabase(database) {
  try {
    if (database && typeof database.prepare === "function" && typeof database.exec === "function") {
      return;
    }
  } catch (cause) {
    throw verificationError(
      "PACK_RECORD_IMPORT_VERIFICATION_DATABASE_INVALID",
      { cause }
    );
  }
  throw verificationError("PACK_RECORD_IMPORT_VERIFICATION_DATABASE_INVALID");
}

function runInReadSnapshot(database, callback) {
  try {
    database.exec("BEGIN");
  } catch (cause) {
    throw verificationError(
      "PACK_RECORD_IMPORT_VERIFICATION_TRANSACTION_BEGIN_FAILED",
      { cause }
    );
  }

  let result;
  try {
    result = callback();
  } catch (cause) {
    rollbackOrThrow(database, cause);
    if (cause instanceof PackRecordImportVerificationError) throw cause;
    throw verificationError(
      "PACK_RECORD_IMPORT_VERIFICATION_QUERY_FAILED",
      { cause }
    );
  }

  try {
    database.exec("COMMIT");
  } catch (cause) {
    rollbackOrThrow(database, cause);
    throw verificationError(
      "PACK_RECORD_IMPORT_VERIFICATION_COMMIT_FAILED",
      { cause }
    );
  }
  return result;
}

function rollbackOrThrow(database, originalCause) {
  try {
    database.exec("ROLLBACK");
  } catch (rollbackCause) {
    throw verificationError(
      "PACK_RECORD_IMPORT_VERIFICATION_ROLLBACK_FAILED",
      { cause: new AggregateError([originalCause, rollbackCause]) }
    );
  }
}

function verifyDatabasePreconditions(database) {
  const userVersionValue = database.prepare("PRAGMA user_version").get()?.user_version;
  const userVersion = typeof userVersionValue === "bigint"
    ? Number(userVersionValue)
    : userVersionValue;
  if (userVersion !== REQUIRED_SCHEMA_VERSION) {
    throw verificationError(
      "PACK_RECORD_IMPORT_VERIFICATION_SCHEMA_VERSION_INVALID",
      {
        details: {
          expected: REQUIRED_SCHEMA_VERSION,
          actual: Number.isFinite(userVersion) ? userVersion : null
        }
      }
    );
  }

  const foreignKeysValue = database.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
  const foreignKeys = typeof foreignKeysValue === "bigint"
    ? Number(foreignKeysValue)
    : foreignKeysValue;
  if (foreignKeys !== 1) {
    throw verificationError("PACK_RECORD_IMPORT_VERIFICATION_FOREIGN_KEYS_DISABLED");
  }

  const existingTables = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = ? AND name IN (?, ?)
    ORDER BY name
  `).all("table", ...REQUIRED_TABLES);
  const existingTableNames = new Set(existingTables.map((row) => row.name));
  const missingTables = REQUIRED_TABLES.filter((name) => !existingTableNames.has(name));
  if (missingTables.length > 0) {
    throw verificationError(
      "PACK_RECORD_IMPORT_VERIFICATION_SCHEMA_MISSING",
      { details: { missingTables: [...missingTables] } }
    );
  }
}

function readTableCount(database, table) {
  const sql = table === "pack_records"
    ? "SELECT COUNT(*) AS count FROM pack_records"
    : "SELECT COUNT(*) AS count FROM pack_record_videos";
  return normalizeCount(database.prepare(sql).get()?.count);
}

function normalizeCount(value) {
  const count = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("Invalid sanitized count");
  }
  return count;
}

function verifyRecord(
  selectRecord,
  selectVideo,
  originalRecord,
  validatedRecord,
  batchTimestamp
) {
  const { inputIndex, recordSequence } = validatedRecord;
  const issues = [];
  const parentRow = selectRecord.get(validatedRecord.id);

  if (!parentRow) {
    issues.push(recordIssue(
      "PACK_RECORD_ROW_MISSING",
      "pack_records",
      inputIndex,
      recordSequence
    ));
  } else {
    const expectedParent = expectedParentValues(
      originalRecord,
      validatedRecord,
      batchTimestamp
    );
    for (const column of PARENT_COLUMNS) {
      if (parentRow[column] !== expectedParent[column]) {
        issues.push(recordIssue(
          "PACK_RECORD_COLUMN_MISMATCH",
          "pack_records",
          inputIndex,
          recordSequence,
          column
        ));
      }
    }
    appendSourcePayloadIssue(
      issues,
      parentRow.source_payload_json,
      originalRecord,
      inputIndex,
      recordSequence
    );
  }

  const videoRow = selectVideo.get(validatedRecord.id);
  if (validatedRecord.hasVideo && !videoRow) {
    issues.push(recordIssue(
      "PACK_RECORD_VIDEO_ROW_MISSING",
      "pack_record_videos",
      inputIndex,
      recordSequence
    ));
  } else if (!validatedRecord.hasVideo && videoRow) {
    issues.push(recordIssue(
      "PACK_RECORD_VIDEO_ROW_UNEXPECTED",
      "pack_record_videos",
      inputIndex,
      recordSequence
    ));
  } else if (validatedRecord.hasVideo) {
    const expectedVideo = expectedVideoValues(originalRecord);
    for (const column of VIDEO_COLUMNS) {
      if (videoRow[column] !== expectedVideo[column]) {
        issues.push(recordIssue(
          "PACK_RECORD_VIDEO_COLUMN_MISMATCH",
          "pack_record_videos",
          inputIndex,
          recordSequence,
          column
        ));
      }
    }
  }

  return {
    inputIndex,
    recordSequence,
    verified: issues.length === 0,
    issues
  };
}

function expectedParentValues(record, validatedRecord, batchTimestamp) {
  return {
    id: record.id,
    record_sequence: validatedRecord.recordSequence,
    awb: record.awb,
    awb_normalized: validatedRecord.awbNormalized,
    platform: record.platform ?? null,
    employee_id: record.employeeId ?? null,
    station_id: record.stationId ?? null,
    started_at: record.startedAt ?? null,
    ended_at: record.endedAt ?? null,
    duration_seconds: record.durationSeconds ?? null,
    status: record.status,
    item_summary: record.itemSummary ?? null,
    size_mb: record.sizeMb ?? null,
    storage_target_id: record.storage?.targetId ?? null,
    storage_label: record.storage?.label ?? null,
    storage_provider: record.storage?.provider ?? null,
    storage_host: record.storage?.host ?? null,
    share_link: record.shareLink ?? null,
    force_close_reason: record.forceCloseReason ?? null,
    created_at: batchTimestamp,
    updated_at: batchTimestamp
  };
}

function expectedVideoValues(record) {
  const video = record.video;
  return {
    record_id: record.id,
    file_name: video.fileName ?? null,
    relative_path: video.relativePath ?? null,
    bytes: video.bytes ?? null,
    size_mb: video.sizeMb ?? null,
    content_type: video.contentType ?? null,
    storage_target_id: video.storageTargetId ?? null,
    storage_label: video.storageLabel ?? null,
    storage_host: video.storageHost ?? null,
    storage_mode: video.storageMode ?? null,
    mounted_required: sqliteBoolean(video.mountedRequired),
    simulated: sqliteBoolean(video.simulated),
    external_url: video.externalUrl ?? null,
    custom_path: video.customPath ?? null,
    share_link: video.shareLink ?? null,
    saved_at: video.savedAt ?? null
  };
}

function appendSourcePayloadIssue(
  issues,
  sourcePayloadJson,
  originalRecord,
  inputIndex,
  recordSequence
) {
  if (sourcePayloadJson === null) {
    issues.push(recordIssue(
      "PACK_RECORD_SOURCE_PAYLOAD_MISSING",
      "pack_records",
      inputIndex,
      recordSequence,
      "source_payload_json"
    ));
    return;
  }

  if (typeof sourcePayloadJson !== "string") {
    issues.push(recordIssue(
      "PACK_RECORD_SOURCE_PAYLOAD_INVALID",
      "pack_records",
      inputIndex,
      recordSequence,
      "source_payload_json"
    ));
    return;
  }

  let actualPayload;
  try {
    actualPayload = JSON.parse(sourcePayloadJson);
  } catch {
    issues.push(recordIssue(
      "PACK_RECORD_SOURCE_PAYLOAD_INVALID",
      "pack_records",
      inputIndex,
      recordSequence,
      "source_payload_json"
    ));
    return;
  }

  const expectedPayload = JSON.parse(JSON.stringify(originalRecord));
  if (!jsonValuesEqual(expectedPayload, actualPayload)) {
    issues.push(recordIssue(
      "PACK_RECORD_SOURCE_PAYLOAD_MISMATCH",
      "pack_records",
      inputIndex,
      recordSequence,
      "source_payload_json"
    ));
  }
}

function jsonValuesEqual(left, right) {
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left !== "object") return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!jsonValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !jsonValuesEqual(left[key], right[key])) return false;
  }
  return true;
}

function sqliteBoolean(value) {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function batchIssue(code, table) {
  return table === undefined
    ? { code, scope: "batch" }
    : { code, scope: "batch", table };
}

function recordIssue(code, table, inputIndex, recordSequence, column) {
  return column === undefined
    ? { code, scope: "record", table, inputIndex, recordSequence }
    : { code, scope: "record", table, column, inputIndex, recordSequence };
}

function validateVerificationResult(result) {
  if (!isPlainObject(result)) throw invalidReport();

  const inputRecordCount = requireCount(result.inputRecordCount);
  const expectedPackRecordRows = requireCount(result.expectedPackRecordRows);
  const actualPackRecordRows = requireCount(result.actualPackRecordRows);
  const expectedVideoRows = requireCount(result.expectedVideoRows);
  const actualVideoRows = requireCount(result.actualVideoRows);
  const verifiedRecordCount = requireCount(result.verifiedRecordCount);
  const mismatchedRecordCount = requireCount(result.mismatchedRecordCount);

  if (expectedPackRecordRows !== inputRecordCount
    || expectedVideoRows > inputRecordCount
    || verifiedRecordCount + mismatchedRecordCount !== inputRecordCount) {
    throw invalidReport();
  }
  if (typeof result.ok !== "boolean"
    || (result.status !== "verified" && result.status !== "mismatch")
    || result.ok !== (result.status === "verified")) {
    throw invalidReport();
  }

  validateSequenceMetadata(result, inputRecordCount);
  const integrity = validateIntegrity(result.integrity);
  if (!Array.isArray(result.records) || result.records.length !== inputRecordCount) {
    throw invalidReport();
  }
  if (!Array.isArray(result.batchIssues)) throw invalidReport();

  let derivedVerifiedCount = 0;
  let derivedMismatchedCount = 0;
  const records = result.records.map((record, inputIndex) => {
    const validated = validateReportRecord(record, inputIndex, inputRecordCount);
    if (validated.verified) derivedVerifiedCount += 1;
    else derivedMismatchedCount += 1;
    return validated;
  });
  const batchIssues = validateBatchIssues(result.batchIssues);

  if (derivedVerifiedCount !== verifiedRecordCount
    || derivedMismatchedCount !== mismatchedRecordCount) {
    throw invalidReport();
  }

  const expectedBatchCodes = [];
  if (actualPackRecordRows !== expectedPackRecordRows) {
    expectedBatchCodes.push("PACK_RECORD_ROW_COUNT_MISMATCH");
  }
  if (actualVideoRows !== expectedVideoRows) {
    expectedBatchCodes.push("PACK_RECORD_VIDEO_ROW_COUNT_MISMATCH");
  }
  if (!integrity.quickCheckOk) {
    expectedBatchCodes.push("PACK_RECORD_QUICK_CHECK_FAILED");
  }
  if (integrity.foreignKeyViolationCount > 0) {
    expectedBatchCodes.push("PACK_RECORD_FOREIGN_KEY_VIOLATION");
  }
  if (!arraysEqual(batchIssues.map((issue) => issue.code), expectedBatchCodes)) {
    throw invalidReport();
  }

  const hasIssues = derivedMismatchedCount > 0 || batchIssues.length > 0;
  if (result.ok === hasIssues) throw invalidReport();

  return {
    ok: result.ok,
    status: result.status,
    inputRecordCount,
    expectedPackRecordRows,
    actualPackRecordRows,
    expectedVideoRows,
    actualVideoRows,
    verifiedRecordCount,
    mismatchedRecordCount,
    batchTimestamp: result.batchTimestamp,
    recordSequenceFirst: result.recordSequenceFirst,
    recordSequenceLast: result.recordSequenceLast,
    integrity,
    records,
    batchIssues
  };
}

function validateSequenceMetadata(result, inputRecordCount) {
  if (inputRecordCount === 0) {
    if (result.batchTimestamp !== null
      || result.recordSequenceFirst !== null
      || result.recordSequenceLast !== null) {
      throw invalidReport();
    }
    return;
  }
  if (!isCanonicalIsoTimestamp(result.batchTimestamp)
    || result.recordSequenceFirst !== inputRecordCount - 1
    || result.recordSequenceLast !== 0) {
    throw invalidReport();
  }
}

function validateIntegrity(integrity) {
  if (!isPlainObject(integrity)
    || !hasExactKeys(integrity, ["quickCheckOk", "foreignKeyViolationCount"])
    || typeof integrity.quickCheckOk !== "boolean") {
    throw invalidReport();
  }
  return {
    quickCheckOk: integrity.quickCheckOk,
    foreignKeyViolationCount: requireCount(integrity.foreignKeyViolationCount)
  };
}

function validateReportRecord(record, inputIndex, inputRecordCount) {
  if (!isPlainObject(record)
    || !hasExactKeys(record, ["inputIndex", "recordSequence", "verified", "issues"])
    || record.inputIndex !== inputIndex
    || record.recordSequence !== inputRecordCount - 1 - inputIndex
    || typeof record.verified !== "boolean"
    || !Array.isArray(record.issues)) {
    throw invalidReport();
  }

  let previousOrder = -1;
  let previousColumnOrder = -1;
  const seenIssueKeys = new Set();
  const issues = record.issues.map((issue) => {
    const validated = validateIssue(issue, "record", inputIndex, record.recordSequence);
    const order = RECORD_ISSUE_ORDER.get(validated.code);
    const columnOrder = issueColumnOrder(validated);
    const issueKey = `${validated.code}\u0000${validated.column ?? ""}`;
    if (order < previousOrder
      || (order === previousOrder && columnOrder < previousColumnOrder)
      || seenIssueKeys.has(issueKey)) {
      throw invalidReport();
    }
    previousOrder = order;
    previousColumnOrder = columnOrder;
    seenIssueKeys.add(issueKey);
    return validated;
  });
  validateRecordIssueConsistency(issues);
  if (record.verified !== (issues.length === 0)) throw invalidReport();

  return {
    inputIndex,
    recordSequence: record.recordSequence,
    verified: record.verified,
    issues
  };
}

function validateRecordIssueConsistency(issues) {
  const codes = new Set(issues.map((issue) => issue.code));
  const hasParentMissing = codes.has("PACK_RECORD_ROW_MISSING");
  const hasParentDetail = codes.has("PACK_RECORD_COLUMN_MISMATCH")
    || [...codes].some((code) => code.startsWith("PACK_RECORD_SOURCE_PAYLOAD_"));
  const payloadIssueCount = [...codes]
    .filter((code) => code.startsWith("PACK_RECORD_SOURCE_PAYLOAD_"))
    .length;
  const hasVideoPresenceIssue = codes.has("PACK_RECORD_VIDEO_ROW_MISSING")
    || codes.has("PACK_RECORD_VIDEO_ROW_UNEXPECTED");
  const hasVideoColumnIssue = codes.has("PACK_RECORD_VIDEO_COLUMN_MISMATCH");
  if ((hasParentMissing && hasParentDetail)
    || payloadIssueCount > 1
    || (codes.has("PACK_RECORD_VIDEO_ROW_MISSING")
      && codes.has("PACK_RECORD_VIDEO_ROW_UNEXPECTED"))
    || (hasVideoPresenceIssue && hasVideoColumnIssue)) {
    throw invalidReport();
  }
}

function validateBatchIssues(issues) {
  let previousOrder = -1;
  const seen = new Set();
  return issues.map((issue) => {
    const validated = validateIssue(issue, "batch");
    const order = BATCH_ISSUE_ORDER.get(validated.code);
    if (order < previousOrder || seen.has(validated.code)) throw invalidReport();
    previousOrder = order;
    seen.add(validated.code);
    return validated;
  });
}

function validateIssue(issue, scope, inputIndex, recordSequence) {
  if (!isPlainObject(issue)) throw invalidReport();
  const keys = Object.keys(issue);
  if (keys.some((key) => !ISSUE_FIELDS.has(key))
    || issue.scope !== scope
    || typeof issue.code !== "string") {
    throw invalidReport();
  }

  if (scope === "batch") {
    if (!BATCH_ISSUE_CODES.has(issue.code)) throw invalidReport();
    const expectedTable = issue.code === "PACK_RECORD_ROW_COUNT_MISMATCH"
      ? "pack_records"
      : issue.code === "PACK_RECORD_VIDEO_ROW_COUNT_MISMATCH"
        ? "pack_record_videos"
        : undefined;
    const expectedKeys = expectedTable
      ? ["code", "scope", "table"]
      : ["code", "scope"];
    if (!hasExactKeys(issue, expectedKeys) || issue.table !== expectedTable) {
      throw invalidReport();
    }
    return expectedTable
      ? { code: issue.code, scope: "batch", table: expectedTable }
      : { code: issue.code, scope: "batch" };
  }

  if (!RECORD_ISSUE_CODES.has(issue.code)
    || issue.inputIndex !== inputIndex
    || issue.recordSequence !== recordSequence) {
    throw invalidReport();
  }

  const isParent = issue.code === "PACK_RECORD_ROW_MISSING"
    || issue.code === "PACK_RECORD_COLUMN_MISMATCH"
    || issue.code.startsWith("PACK_RECORD_SOURCE_PAYLOAD_");
  const expectedTable = isParent ? "pack_records" : "pack_record_videos";
  const requiresColumn = issue.code === "PACK_RECORD_COLUMN_MISMATCH"
    || issue.code === "PACK_RECORD_VIDEO_COLUMN_MISMATCH"
    || issue.code.startsWith("PACK_RECORD_SOURCE_PAYLOAD_");
  const expectedKeys = requiresColumn
    ? ["code", "scope", "table", "column", "inputIndex", "recordSequence"]
    : ["code", "scope", "table", "inputIndex", "recordSequence"];
  if (!hasExactKeys(issue, expectedKeys) || issue.table !== expectedTable) {
    throw invalidReport();
  }
  if (issue.code === "PACK_RECORD_COLUMN_MISMATCH" && !PARENT_COLUMNS.includes(issue.column)) {
    throw invalidReport();
  }
  if (issue.code === "PACK_RECORD_VIDEO_COLUMN_MISMATCH" && !VIDEO_COLUMNS.includes(issue.column)) {
    throw invalidReport();
  }
  if (issue.code.startsWith("PACK_RECORD_SOURCE_PAYLOAD_")
    && issue.column !== "source_payload_json") {
    throw invalidReport();
  }

  return requiresColumn
    ? {
        code: issue.code,
        scope: "record",
        table: expectedTable,
        column: issue.column,
        inputIndex,
        recordSequence
      }
    : {
        code: issue.code,
        scope: "record",
        table: expectedTable,
        inputIndex,
        recordSequence
      };
}

function issueColumnOrder(issue) {
  if (issue.code === "PACK_RECORD_COLUMN_MISMATCH") {
    return PARENT_COLUMNS.indexOf(issue.column);
  }
  if (issue.code === "PACK_RECORD_VIDEO_COLUMN_MISMATCH") {
    return VIDEO_COLUMNS.indexOf(issue.column);
  }
  return 0;
}

function requireCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidReport();
  return value;
}

function hasExactKeys(value, expectedKeys) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  if (!arraysEqual([...keys].sort(), [...expectedKeys].sort())) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function invalidReport() {
  return verificationError("PACK_RECORD_IMPORT_VERIFICATION_REPORT_INVALID");
}

function verificationError(code, options) {
  return new PackRecordImportVerificationError(
    code,
    ERROR_MESSAGES[code],
    options
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
