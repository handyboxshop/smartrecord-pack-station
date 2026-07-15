import {
  buildPackRecordImportDryRunReport,
  validatePackRecordImport
} from "./packRecordImportValidator.mjs";
import {
  SqliteStorageError,
  runInSqliteTransaction
} from "./sqliteDatabase.mjs";

const REQUIRED_SCHEMA_VERSION = 2;
const REQUIRED_TABLES = ["pack_records", "pack_record_videos"];

const SELECT_RECORD_BY_ID_SQL = `
  SELECT id
  FROM pack_records
  WHERE id = ?
  LIMIT 1
`;

const SELECT_RECORD_BY_AWB_SQL = `
  SELECT id
  FROM pack_records
  WHERE awb_normalized = ?
  LIMIT 1
`;

const SELECT_RECORD_BY_SEQUENCE_SQL = `
  SELECT id
  FROM pack_records
  WHERE record_sequence = ?
  LIMIT 1
`;

const INSERT_PACK_RECORD_SQL = `
  INSERT INTO pack_records (
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
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_VIDEO_SQL = `
  INSERT INTO pack_record_videos (
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
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export class PackRecordImportError extends SqliteStorageError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = "PackRecordImportError";
    this.details = isPlainObject(options.details) ? options.details : {};
  }
}

export function importPackRecords(
  database,
  input,
  { now = () => new Date() } = {}
) {
  const validationResult = validatePackRecordImport(input);
  if (!validationResult.ok) {
    throw importError(
      "PACK_RECORD_IMPORT_VALIDATION_FAILED",
      "Pack Record import validation failed; no rows were written.",
      {
        details: {
          validationResult,
          dryRunReport: buildPackRecordImportDryRunReport(validationResult)
        }
      }
    );
  }

  requireDatabase(database);
  verifyDatabasePreconditions(database);

  if (input.length === 0) {
    return {
      ok: true,
      status: "no-op",
      inputRecordCount: 0,
      insertedPackRecordRows: 0,
      insertedVideoRows: 0,
      batchTimestamp: null,
      recordSequenceFirst: null,
      recordSequenceLast: null
    };
  }

  const batchTimestamp = createBatchTimestamp(now);
  const sourcePayloads = serializeSourceRecords(input, validationResult.records);

  let insertedCounts;
  try {
    insertedCounts = runInSqliteTransaction(database, () => {
      const selectById = database.prepare(SELECT_RECORD_BY_ID_SQL);
      const selectByAwb = database.prepare(SELECT_RECORD_BY_AWB_SQL);
      const selectBySequence = database.prepare(SELECT_RECORD_BY_SEQUENCE_SQL);
      const conflicts = collectConflicts(
        validationResult.records,
        selectById,
        selectByAwb,
        selectBySequence
      );

      if (conflicts.length > 0) {
        throw importError(
          "PACK_RECORD_IMPORT_CONFLICT",
          "Pack Record import conflicts with existing rows; no rows were written.",
          { details: { conflicts } }
        );
      }

      const insertPackRecord = database.prepare(INSERT_PACK_RECORD_SQL);
      const insertVideo = database.prepare(INSERT_VIDEO_SQL);
      let insertedPackRecordRows = 0;
      let insertedVideoRows = 0;

      for (const validatedRecord of validationResult.records) {
        const inputIndex = validatedRecord.inputIndex;
        const originalRecord = input[inputIndex];
        const storage = originalRecord.storage;
        const result = insertPackRecord.run(
          originalRecord.id,
          validatedRecord.recordSequence,
          originalRecord.awb,
          validatedRecord.awbNormalized,
          originalRecord.platform ?? null,
          originalRecord.employeeId ?? null,
          originalRecord.stationId ?? null,
          originalRecord.startedAt ?? null,
          originalRecord.endedAt ?? null,
          originalRecord.durationSeconds ?? null,
          originalRecord.status,
          originalRecord.itemSummary ?? null,
          originalRecord.sizeMb ?? null,
          storage?.targetId ?? null,
          storage?.label ?? null,
          storage?.provider ?? null,
          storage?.host ?? null,
          originalRecord.shareLink ?? null,
          originalRecord.forceCloseReason ?? null,
          sourcePayloads[inputIndex],
          batchTimestamp,
          batchTimestamp
        );
        requireSingleChange(result, "pack_records", inputIndex);
        insertedPackRecordRows += 1;
      }

      for (const validatedRecord of validationResult.records) {
        if (!validatedRecord.hasVideo) continue;
        const inputIndex = validatedRecord.inputIndex;
        const originalRecord = input[inputIndex];
        const video = originalRecord.video;
        const result = insertVideo.run(
          originalRecord.id,
          video.fileName ?? null,
          video.relativePath ?? null,
          video.bytes ?? null,
          video.sizeMb ?? null,
          video.contentType ?? null,
          video.storageTargetId ?? null,
          video.storageLabel ?? null,
          video.storageHost ?? null,
          video.storageMode ?? null,
          sqliteBoolean(video.mountedRequired),
          sqliteBoolean(video.simulated),
          video.externalUrl ?? null,
          video.customPath ?? null,
          video.shareLink ?? null,
          video.savedAt ?? null
        );
        requireSingleChange(result, "pack_record_videos", inputIndex);
        insertedVideoRows += 1;
      }

      return { insertedPackRecordRows, insertedVideoRows };
    });
  } catch (cause) {
    if (cause instanceof PackRecordImportError) throw cause;
    if (cause instanceof SqliteStorageError && cause.code === "SQLITE_TRANSACTION_ROLLBACK_FAILED") {
      throw importError(
        "PACK_RECORD_IMPORT_ROLLBACK_FAILED",
        "Pack Record import failed and the transaction could not be rolled back safely.",
        { cause }
      );
    }
    throw importError(
      "PACK_RECORD_IMPORT_TRANSACTION_FAILED",
      "Pack Record import transaction failed; no successful import result is available.",
      { cause }
    );
  }

  return {
    ok: true,
    status: "imported",
    inputRecordCount: input.length,
    insertedPackRecordRows: insertedCounts.insertedPackRecordRows,
    insertedVideoRows: insertedCounts.insertedVideoRows,
    batchTimestamp,
    recordSequenceFirst: input.length - 1,
    recordSequenceLast: 0
  };
}

function requireDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw importError(
      "PACK_RECORD_IMPORT_DATABASE_INVALID",
      "A caller-owned synchronous SQLite database is required."
    );
  }
}

function verifyDatabasePreconditions(database) {
  let userVersion;
  try {
    userVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version);
  } catch (cause) {
    throw databaseCheckError(cause);
  }
  if (userVersion !== REQUIRED_SCHEMA_VERSION) {
    throw importError(
      "PACK_RECORD_IMPORT_SCHEMA_VERSION_INVALID",
      "Pack Record import requires SQLite schema version 2.",
      { details: { expected: REQUIRED_SCHEMA_VERSION, actual: numberOrNull(userVersion) } }
    );
  }

  let foreignKeys;
  try {
    foreignKeys = Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys);
  } catch (cause) {
    throw databaseCheckError(cause);
  }
  if (foreignKeys !== 1) {
    throw importError(
      "PACK_RECORD_IMPORT_FOREIGN_KEYS_DISABLED",
      "Pack Record import requires SQLite foreign key enforcement.",
      { details: { expected: 1, actual: numberOrNull(foreignKeys) } }
    );
  }

  let existingTables;
  try {
    existingTables = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = ? AND name IN (?, ?)
      ORDER BY name
    `).all("table", ...REQUIRED_TABLES).map((row) => row.name);
  } catch (cause) {
    throw databaseCheckError(cause);
  }

  const existingTableSet = new Set(existingTables);
  const missingTables = REQUIRED_TABLES.filter((tableName) => !existingTableSet.has(tableName));
  if (missingTables.length > 0) {
    throw importError(
      "PACK_RECORD_IMPORT_SCHEMA_MISSING",
      "Required Pack Record SQLite tables are missing.",
      { details: { missingTables } }
    );
  }
}

function databaseCheckError(cause) {
  return importError(
    "PACK_RECORD_IMPORT_DATABASE_CHECK_FAILED",
    "Unable to verify the caller-owned SQLite database for Pack Record import.",
    { cause }
  );
}

function createBatchTimestamp(now) {
  try {
    const supplied = now();
    const date = supplied instanceof Date ? supplied : new Date(supplied);
    if (Number.isNaN(date.getTime())) throw new RangeError("Invalid timestamp");
    return date.toISOString();
  } catch (cause) {
    throw importError(
      "PACK_RECORD_IMPORT_TIMESTAMP_INVALID",
      "Pack Record import batch timestamp is invalid.",
      { cause }
    );
  }
}

function serializeSourceRecords(input, validatedRecords) {
  return input.map((originalRecord, inputIndex) => {
    try {
      const sourcePayloadJson = JSON.stringify(originalRecord);
      if (typeof sourcePayloadJson !== "string") throw new TypeError("Source payload is not a JSON string");
      return sourcePayloadJson;
    } catch (cause) {
      throw importError(
        "PACK_RECORD_IMPORT_SOURCE_SERIALIZATION_FAILED",
        "A Pack Record source payload could not be serialized.",
        {
          cause,
          details: {
            inputIndex,
            id: validatedRecords[inputIndex].id
          }
        }
      );
    }
  });
}

function collectConflicts(validatedRecords, selectById, selectByAwb, selectBySequence) {
  const conflicts = [];
  for (const validatedRecord of validatedRecords) {
    appendConflict(
      conflicts,
      selectById.get(validatedRecord.id),
      "PACK_RECORD_ID_EXISTS",
      "id",
      validatedRecord.inputIndex,
      validatedRecord.id
    );
    appendConflict(
      conflicts,
      selectByAwb.get(validatedRecord.awbNormalized),
      "PACK_RECORD_AWB_EXISTS",
      "awbNormalized",
      validatedRecord.inputIndex,
      validatedRecord.awbNormalized
    );
    appendConflict(
      conflicts,
      selectBySequence.get(validatedRecord.recordSequence),
      "PACK_RECORD_SEQUENCE_EXISTS",
      "recordSequence",
      validatedRecord.inputIndex,
      validatedRecord.recordSequence
    );
  }
  return conflicts;
}

function appendConflict(conflicts, existingRow, code, field, inputIndex, value) {
  if (!existingRow) return;
  conflicts.push({
    code,
    field,
    inputIndex,
    value,
    existingRecordId: existingRow.id
  });
}

function requireSingleChange(result, table, inputIndex) {
  if (result?.changes === 1 || result?.changes === 1n) return;
  throw importError(
    "PACK_RECORD_IMPORT_INSERT_COUNT_INVALID",
    "Pack Record import insert did not report exactly one changed row.",
    {
      details: {
        table,
        inputIndex,
        expected: 1,
        actual: changeCountOrNull(result?.changes)
      }
    }
  );
}

function sqliteBoolean(value) {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function changeCountOrNull(value) {
  if (typeof value === "bigint") return value.toString();
  return Number.isFinite(value) ? value : null;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function importError(code, message, options) {
  return new PackRecordImportError(code, message, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
