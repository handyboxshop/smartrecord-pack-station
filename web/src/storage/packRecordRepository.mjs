import {
  SqliteStorageError,
  runInSqliteTransaction
} from "./sqliteDatabase.mjs";

const MINIMUM_SCHEMA_VERSION = 2;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_TEXT_LENGTH = 4096;
const REQUIRED_TABLES = ["pack_records", "pack_record_videos"];
const RECORD_FIELDS = new Set([
  "id", "awb", "platform", "employeeId", "stationId", "startedAt", "endedAt",
  "durationSeconds", "status", "itemSummary", "sizeMb", "storage", "shareLink",
  "forceCloseReason", "video"
]);
const STORAGE_FIELDS = new Set(["targetId", "label", "provider", "host"]);
const VIDEO_FIELDS = new Set([
  "fileName", "relativePath", "bytes", "sizeMb", "contentType", "storageTargetId",
  "storageLabel", "storageHost", "storageMode", "mountedRequired", "simulated",
  "externalUrl", "customPath", "shareLink", "savedAt"
]);
const SUMMARY_FILTER_FIELDS = new Set([
  "search", "status", "platform", "employeeId", "stationId", "startedFrom", "startedTo",
  "endedFrom", "endedTo", "hasVideo"
]);
const LIST_FIELDS = new Set([
  "limit", "beforeSequence", "search", "status", "platform", "employeeId",
  "startedAtFrom", "startedAtBefore"
]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ISO_WITH_TIMEZONE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

const RECORD_COLUMNS = `
  r.id, r.record_sequence, r.awb, r.awb_normalized, r.platform, r.employee_id,
  r.station_id, r.started_at, r.ended_at, r.duration_seconds, r.status, r.item_summary,
  r.size_mb, r.storage_target_id, r.storage_label, r.storage_provider, r.storage_host,
  r.share_link, r.force_close_reason, r.created_at, r.updated_at,
  v.record_id AS video_record_id, v.file_name AS video_file_name,
  v.relative_path AS video_relative_path, v.bytes AS video_bytes, v.size_mb AS video_size_mb,
  v.content_type AS video_content_type, v.storage_target_id AS video_storage_target_id,
  v.storage_label AS video_storage_label, v.storage_host AS video_storage_host,
  v.storage_mode AS video_storage_mode, v.mounted_required AS video_mounted_required,
  v.simulated AS video_simulated, v.external_url AS video_external_url,
  v.custom_path AS video_custom_path, v.share_link AS video_share_link,
  v.saved_at AS video_saved_at
`;

export class PackRecordRepositoryError extends SqliteStorageError {
  constructor(code, message) {
    super(code, message);
    this.name = "PackRecordRepositoryError";
    this.details = {};
  }
}

export function createPackRecordRepository(database, options = {}) {
  validateOptions(options);
  validateDatabase(database);
  validateDatabasePreconditions(database);
  const now = options.now ?? (() => new Date());
  const statements = prepareStatements(database);

  function createCompletedRecord(input) {
    const record = normalizeRecordInput(input);
    const timestamp = currentTimestamp(now);
    try {
      return runInSqliteTransaction(database, () => {
        if (statements.selectIdentityById.get(record.id)) {
          throw error("PACK_RECORD_ID_EXISTS", "The Pack Record id already exists.");
        }
        if (statements.selectIdentityByAwb.get(record.awb)) {
          throw error("PACK_RECORD_AWB_EXISTS", "The Pack Record AWB already exists.");
        }
        const maximum = normalizeSqliteInteger(statements.selectMaximumSequence.get()?.maximum_sequence);
        if (maximum >= Number.MAX_SAFE_INTEGER) {
          throw error("PACK_RECORD_SEQUENCE_EXHAUSTED", "A Pack Record sequence cannot be allocated.");
        }
        const sequence = maximum + 1;
        const result = statements.insertRecord.run(
          record.id, sequence, record.awb, record.awb, record.platform, record.employeeId,
          record.stationId, record.startedAt, record.endedAt, record.durationSeconds, record.status,
          record.itemSummary, record.sizeMb, record.storage?.targetId ?? null,
          record.storage?.label ?? null, record.storage?.provider ?? null,
          record.storage?.host ?? null, record.shareLink, record.forceCloseReason,
          timestamp, timestamp
        );
        requireOneChange(result, "PACK_RECORD_CREATE_FAILED", "The Pack Record could not be stored.");
        if (record.video !== null) insertVideo(record.id, record.video);
        return readRecordById(record.id);
      });
    } catch (cause) {
      if (cause instanceof PackRecordRepositoryError) throw cause;
      return translateCreateFailure(record, cause);
    }
  }

  function getRecordById(id) {
    const cleanId = requiredText(id, "PACK_RECORD_ID_INVALID", "A valid Pack Record id is required.", 512);
    return readSafely(() => {
      const row = statements.selectById.get(cleanId);
      return row ? hydrateRecord(row) : null;
    });
  }

  function getRecordByAwb(awb) {
    const cleanAwb = requiredText(awb, "PACK_RECORD_AWB_INVALID", "A valid Pack Record AWB is required.", 512);
    return readSafely(() => {
      const row = statements.selectByAwb.get(cleanAwb);
      return row ? hydrateRecord(row) : null;
    });
  }

  function listRecords(options = {}) {
    const normalized = normalizeListOptions(options);
    return readSafely(() => {
      const { where, parameters } = buildWhere(normalized, { includeCursor: true });
      const sql = `
        SELECT ${RECORD_COLUMNS}
        FROM pack_records r
        LEFT JOIN pack_record_videos v ON v.record_id = r.id
        ${where}
        ORDER BY r.record_sequence DESC
        LIMIT ?
      `;
      const rows = database.prepare(sql).all(...parameters, normalized.limit + 1);
      const hasMore = rows.length > normalized.limit;
      const returnedRows = hasMore ? rows.slice(0, normalized.limit) : rows;
      const records = returnedRows.map(hydrateRecord);
      const nextBeforeSequence = hasMore
        ? requirePublicCursor(returnedRows.at(-1)?.record_sequence)
        : null;
      return { records, nextBeforeSequence };
    });
  }

  function summarizeRecords(filters = {}) {
    const normalized = normalizeFilters(filters);
    return readSafely(() => {
      const { where, parameters } = buildWhere(normalized);
      const row = database.prepare(`
        SELECT
          COUNT(*) AS total_records,
          COALESCE(SUM(CASE WHEN r.status = 'pass' THEN 1 ELSE 0 END), 0) AS pass_records,
          COALESCE(SUM(CASE WHEN r.status = 'warn' THEN 1 ELSE 0 END), 0) AS warn_records,
          COALESCE(SUM(CASE WHEN v.record_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS records_with_video,
          COALESCE(SUM(r.duration_seconds), 0) AS total_duration_seconds,
          COALESCE(SUM(r.size_mb), 0) AS total_size_mb
        FROM pack_records r
        LEFT JOIN pack_record_videos v ON v.record_id = r.id
        ${where}
      `).get(...parameters);
      const summary = {
        totalRecords: summaryInteger(row?.total_records),
        passRecords: summaryInteger(row?.pass_records),
        warnRecords: summaryInteger(row?.warn_records),
        recordsWithVideo: summaryInteger(row?.records_with_video),
        totalDurationSeconds: summaryInteger(row?.total_duration_seconds),
        totalSizeMb: summaryNumber(row?.total_size_mb)
      };
      if (summary.passRecords + summary.warnRecords !== summary.totalRecords
        || summary.recordsWithVideo > summary.totalRecords) {
        throw error("PACK_RECORD_STORED_DATA_INVALID", "Stored Pack Record data is invalid.");
      }
      return summary;
    });
  }

  function associateVideoMetadata(recordId, input) {
    const cleanId = requiredText(recordId, "PACK_RECORD_ID_INVALID", "A valid Pack Record id is required.", 512);
    const video = normalizeVideo(input, { nullable: false });
    try {
      return runInSqliteTransaction(database, () => {
        if (!statements.selectIdentityById.get(cleanId)) {
          throw error("PACK_RECORD_NOT_FOUND", "The Pack Record does not exist.");
        }
        const result = statements.upsertVideo.run(cleanId, ...videoParameters(video));
        requireOneChange(result, "PACK_RECORD_VIDEO_WRITE_FAILED", "Video metadata could not be stored.");
        return readRecordById(cleanId);
      });
    } catch (cause) {
      if (cause instanceof PackRecordRepositoryError) throw cause;
      throw error("PACK_RECORD_VIDEO_WRITE_FAILED", "Video metadata could not be stored.");
    }
  }

  function readRecordById(id) {
    const row = statements.selectById.get(id);
    if (!row) throw error("PACK_RECORD_READ_FAILED", "The stored Pack Record could not be read.");
    return hydrateRecord(row);
  }

  function insertVideo(recordId, video) {
    const result = statements.insertVideo.run(recordId, ...videoParameters(video));
    requireOneChange(result, "PACK_RECORD_CREATE_FAILED", "The Pack Record could not be stored.");
  }

  function translateCreateFailure(record) {
    try {
      if (statements.selectIdentityById.get(record.id)) {
        throw error("PACK_RECORD_ID_EXISTS", "The Pack Record id already exists.");
      }
      if (statements.selectIdentityByAwb.get(record.awb)) {
        throw error("PACK_RECORD_AWB_EXISTS", "The Pack Record AWB already exists.");
      }
    } catch (cause) {
      if (cause instanceof PackRecordRepositoryError) throw cause;
    }
    throw error("PACK_RECORD_CREATE_FAILED", "The Pack Record could not be stored.");
  }

  return {
    createCompletedRecord,
    getRecordById,
    getRecordByAwb,
    listRecords,
    summarizeRecords,
    associateVideoMetadata
  };
}

function prepareStatements(database) {
  try {
    const select = `
      SELECT ${RECORD_COLUMNS}
      FROM pack_records r
      LEFT JOIN pack_record_videos v ON v.record_id = r.id
    `;
    return {
      selectIdentityById: database.prepare("SELECT id FROM pack_records WHERE id = ? LIMIT 1"),
      selectIdentityByAwb: database.prepare("SELECT id FROM pack_records WHERE awb_normalized = ? COLLATE BINARY LIMIT 1"),
      selectMaximumSequence: database.prepare("SELECT COALESCE(MAX(record_sequence), -1) AS maximum_sequence FROM pack_records"),
      selectById: database.prepare(`${select} WHERE r.id = ? LIMIT 1`),
      selectByAwb: database.prepare(`${select} WHERE r.awb_normalized = ? COLLATE BINARY LIMIT 1`),
      insertRecord: database.prepare(`
        INSERT INTO pack_records (
          id, record_sequence, awb, awb_normalized, platform, employee_id, station_id,
          started_at, ended_at, duration_seconds, status, item_summary, size_mb,
          storage_target_id, storage_label, storage_provider, storage_host, share_link,
          force_close_reason, source_payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `),
      insertVideo: database.prepare(`
        INSERT INTO pack_record_videos (
          record_id, file_name, relative_path, bytes, size_mb, content_type, storage_target_id,
          storage_label, storage_host, storage_mode, mounted_required, simulated, external_url,
          custom_path, share_link, saved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      upsertVideo: database.prepare(`
        INSERT INTO pack_record_videos (
          record_id, file_name, relative_path, bytes, size_mb, content_type, storage_target_id,
          storage_label, storage_host, storage_mode, mounted_required, simulated, external_url,
          custom_path, share_link, saved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(record_id) DO UPDATE SET
          file_name = excluded.file_name, relative_path = excluded.relative_path,
          bytes = excluded.bytes, size_mb = excluded.size_mb, content_type = excluded.content_type,
          storage_target_id = excluded.storage_target_id, storage_label = excluded.storage_label,
          storage_host = excluded.storage_host, storage_mode = excluded.storage_mode,
          mounted_required = excluded.mounted_required, simulated = excluded.simulated,
          external_url = excluded.external_url, custom_path = excluded.custom_path,
          share_link = excluded.share_link, saved_at = excluded.saved_at
      `)
    };
  } catch {
    throw error("PACK_RECORD_DATABASE_INVALID", "The caller-owned SQLite database is not usable.");
  }
}

function validateOptions(options) {
  assertPlainObject(options, "PACK_RECORD_REPOSITORY_OPTIONS_INVALID", "Repository options are invalid.");
  assertAllowedFields(options, new Set(["now"]), "PACK_RECORD_REPOSITORY_OPTIONS_INVALID", "Repository options are invalid.");
  if (options.now !== undefined && typeof options.now !== "function") {
    throw error("PACK_RECORD_REPOSITORY_OPTIONS_INVALID", "Repository options are invalid.");
  }
}

function validateDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw error("PACK_RECORD_DATABASE_INVALID", "A caller-owned synchronous SQLite database is required.");
  }
}

function validateDatabasePreconditions(database) {
  try {
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (!Number.isSafeInteger(version) || version < MINIMUM_SCHEMA_VERSION) {
      throw error("PACK_RECORD_SCHEMA_VERSION_INVALID", "SQLite schema version 2 or later is required.");
    }
    const foreignKeys = Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys);
    if (foreignKeys !== 1) {
      throw error("PACK_RECORD_FOREIGN_KEYS_DISABLED", "SQLite foreign key enforcement is required.");
    }
    const rows = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (?, ?)
    `).all(...REQUIRED_TABLES);
    const names = new Set(rows.map((row) => row.name));
    if (REQUIRED_TABLES.some((name) => !names.has(name))) {
      throw error("PACK_RECORD_SCHEMA_MISSING", "Required Pack Record tables are missing.");
    }
  } catch (cause) {
    if (cause instanceof PackRecordRepositoryError) throw cause;
    throw error("PACK_RECORD_DATABASE_CHECK_FAILED", "The SQLite database could not be verified.");
  }
}

function normalizeRecordInput(input) {
  assertPlainObject(input, "PACK_RECORD_INPUT_INVALID", "Pack Record input is invalid.");
  assertAllowedFields(input, RECORD_FIELDS, "PACK_RECORD_INPUT_INVALID", "Pack Record input contains an unsupported field.");
  const record = {
    id: requiredText(input.id, "PACK_RECORD_INPUT_INVALID", "A Pack Record id is required.", 512),
    awb: requiredText(input.awb, "PACK_RECORD_INPUT_INVALID", "A Pack Record AWB is required.", 512),
    platform: optionalText(input.platform),
    employeeId: optionalText(input.employeeId),
    stationId: optionalText(input.stationId),
    startedAt: optionalWriteTimestamp(input.startedAt),
    endedAt: optionalWriteTimestamp(input.endedAt),
    durationSeconds: optionalSafeInteger(input.durationSeconds),
    status: input.status,
    itemSummary: optionalText(input.itemSummary),
    sizeMb: optionalNonnegativeNumber(input.sizeMb),
    storage: normalizeStorage(input.storage),
    shareLink: optionalText(input.shareLink),
    forceCloseReason: optionalText(input.forceCloseReason),
    video: input.video == null ? null : normalizeVideo(input.video, { nullable: false })
  };
  if (record.status !== "pass" && record.status !== "warn") {
    throw error("PACK_RECORD_INPUT_INVALID", "Pack Record status is invalid.");
  }
  assertChronology(record.startedAt, record.endedAt);
  if (record.video?.savedAt && record.startedAt
    && Date.parse(record.video.savedAt) < Date.parse(record.startedAt)) {
    throw error("PACK_RECORD_INPUT_INVALID", "Pack Record timestamp chronology is invalid.");
  }
  return record;
}

function normalizeStorage(value) {
  if (value == null) return null;
  assertPlainObject(value, "PACK_RECORD_INPUT_INVALID", "Pack Record storage is invalid.");
  assertAllowedFields(value, STORAGE_FIELDS, "PACK_RECORD_INPUT_INVALID", "Pack Record storage contains an unsupported field.");
  return {
    targetId: optionalText(value.targetId), label: optionalText(value.label),
    provider: optionalText(value.provider), host: optionalText(value.host)
  };
}

function normalizeVideo(value, { nullable }) {
  if (value == null && nullable) return null;
  assertPlainObject(value, "PACK_RECORD_VIDEO_INVALID", "Video metadata is invalid.");
  assertAllowedFields(value, VIDEO_FIELDS, "PACK_RECORD_VIDEO_INVALID", "Video metadata contains an unsupported field.");
  const video = {
    fileName: optionalText(value.fileName, "PACK_RECORD_VIDEO_INVALID"),
    relativePath: optionalText(value.relativePath, "PACK_RECORD_VIDEO_INVALID"),
    bytes: optionalSafeInteger(value.bytes, "PACK_RECORD_VIDEO_INVALID"),
    sizeMb: optionalNonnegativeNumber(value.sizeMb, "PACK_RECORD_VIDEO_INVALID"),
    contentType: optionalText(value.contentType, "PACK_RECORD_VIDEO_INVALID"),
    storageTargetId: optionalText(value.storageTargetId, "PACK_RECORD_VIDEO_INVALID"),
    storageLabel: optionalText(value.storageLabel, "PACK_RECORD_VIDEO_INVALID"),
    storageHost: optionalText(value.storageHost, "PACK_RECORD_VIDEO_INVALID"),
    storageMode: optionalText(value.storageMode, "PACK_RECORD_VIDEO_INVALID"),
    mountedRequired: optionalBoolean(value.mountedRequired),
    simulated: optionalBoolean(value.simulated),
    externalUrl: optionalText(value.externalUrl, "PACK_RECORD_VIDEO_INVALID"),
    customPath: optionalText(value.customPath, "PACK_RECORD_VIDEO_INVALID"),
    shareLink: optionalText(value.shareLink, "PACK_RECORD_VIDEO_INVALID"),
    savedAt: optionalWriteTimestamp(value.savedAt, "PACK_RECORD_VIDEO_INVALID")
  };
  if (video.fileName !== null) assertSafeFileName(video.fileName);
  if (video.relativePath !== null) assertSafeRelativePath(video.relativePath);
  if (video.customPath !== null) assertSafeRelativePath(video.customPath);
  return video;
}

function normalizeListOptions(options) {
  assertPlainObject(options, "PACK_RECORD_LIST_OPTIONS_INVALID", "Pack Record list options are invalid.");
  assertAllowedFields(options, LIST_FIELDS, "PACK_RECORD_LIST_OPTIONS_INVALID", "Pack Record list options contain an unsupported field.");
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw error("PACK_RECORD_LIST_OPTIONS_INVALID", "The Pack Record list limit is invalid.");
  }
  const beforeSequence = options.beforeSequence ?? null;
  if (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) {
    throw error("PACK_RECORD_LIST_OPTIONS_INVALID", "The Pack Record list cursor is invalid.");
  }
  const filters = {
    search: optionalText(options.search, "PACK_RECORD_LIST_OPTIONS_INVALID") ?? "",
    status: optionalText(options.status, "PACK_RECORD_LIST_OPTIONS_INVALID") ?? "",
    platform: optionalText(options.platform, "PACK_RECORD_LIST_OPTIONS_INVALID") ?? "",
    employeeId: optionalText(options.employeeId, "PACK_RECORD_LIST_OPTIONS_INVALID") ?? "",
    stationId: "",
    startedFrom: optionalReadTimestamp(options.startedAtFrom, "PACK_RECORD_LIST_OPTIONS_INVALID"),
    startedBefore: optionalReadTimestamp(options.startedAtBefore, "PACK_RECORD_LIST_OPTIONS_INVALID"),
    startedTo: null,
    endedFrom: null,
    endedTo: null,
    hasVideo: null
  };
  if (filters.status && filters.status !== "pass" && filters.status !== "warn") {
    throw error("PACK_RECORD_LIST_OPTIONS_INVALID", "Pack Record list options are invalid.");
  }
  assertChronology(filters.startedFrom, filters.startedBefore, "PACK_RECORD_LIST_OPTIONS_INVALID");
  return { ...filters, limit, beforeSequence };
}

function normalizeFilters(filters) {
  assertPlainObject(filters, "PACK_RECORD_FILTERS_INVALID", "Pack Record filters are invalid.");
  assertAllowedFields(filters, SUMMARY_FILTER_FIELDS, "PACK_RECORD_FILTERS_INVALID", "Pack Record filters contain an unsupported field.");
  return normalizeFilterValues(filters, "PACK_RECORD_FILTERS_INVALID");
}

function normalizeFilterValues(value, code) {
  const result = {
    search: optionalText(value.search, code) ?? "",
    status: optionalText(value.status, code) ?? "",
    platform: optionalText(value.platform, code) ?? "",
    employeeId: optionalText(value.employeeId, code) ?? "",
    stationId: optionalText(value.stationId, code) ?? "",
    startedFrom: optionalReadTimestamp(value.startedFrom, code),
    startedTo: optionalReadTimestamp(value.startedTo, code),
    endedFrom: optionalReadTimestamp(value.endedFrom, code),
    endedTo: optionalReadTimestamp(value.endedTo, code),
    hasVideo: value.hasVideo ?? null
  };
  if (result.status && result.status !== "pass" && result.status !== "warn") throw error(code, "Pack Record filters are invalid.");
  if (result.hasVideo !== null && typeof result.hasVideo !== "boolean") throw error(code, "Pack Record filters are invalid.");
  assertChronology(result.startedFrom, result.startedTo, code);
  assertChronology(result.endedFrom, result.endedTo, code);
  return result;
}

function buildWhere(filters, { includeCursor = false } = {}) {
  const clauses = [];
  const parameters = [];
  if (includeCursor && filters.beforeSequence !== null) {
    clauses.push("r.record_sequence < ?");
    parameters.push(filters.beforeSequence);
  }
  if (filters.search) {
    const escaped = `%${escapeLike(filters.search)}%`;
    clauses.push(`(
      r.awb LIKE ? ESCAPE '\\' OR r.platform LIKE ? ESCAPE '\\'
      OR r.employee_id LIKE ? ESCAPE '\\' OR r.station_id LIKE ? ESCAPE '\\'
      OR r.item_summary LIKE ? ESCAPE '\\'
    )`);
    parameters.push(escaped, escaped, escaped, escaped, escaped);
  }
  for (const [field, column] of [["status", "r.status"], ["platform", "r.platform"], ["employeeId", "r.employee_id"], ["stationId", "r.station_id"]]) {
    if (filters[field]) { clauses.push(`${column} = ? COLLATE BINARY`); parameters.push(filters[field]); }
  }
  for (const [field, column, operator] of [
    ["startedFrom", "r.started_at", ">="], ["startedTo", "r.started_at", "<="],
    ["startedBefore", "r.started_at", "<"],
    ["endedFrom", "r.ended_at", ">="], ["endedTo", "r.ended_at", "<="]
  ]) {
    if (filters[field]) { clauses.push(`julianday(${column}) ${operator} julianday(?)`); parameters.push(filters[field]); }
  }
  if (filters.hasVideo !== null) clauses.push(filters.hasVideo ? "v.record_id IS NOT NULL" : "v.record_id IS NULL");
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", parameters };
}

function hydrateRecord(row) {
  try {
    const sequence = normalizeSqliteInteger(row.record_sequence);
    if (sequence < 0) throw new TypeError();
    const originalAwb = storedRequiredText(row.awb);
    const normalizedAwb = storedRequiredText(row.awb_normalized);
    const record = {
      id: storedRequiredText(row.id),
      awb: normalizedAwb,
      platform: storedOptionalText(row.platform),
      employeeId: storedOptionalText(row.employee_id),
      stationId: storedOptionalText(row.station_id),
      startedAt: storedOptionalTimestamp(row.started_at),
      endedAt: storedOptionalTimestamp(row.ended_at),
      durationSeconds: storedOptionalSafeInteger(row.duration_seconds),
      status: row.status,
      itemSummary: storedOptionalText(row.item_summary),
      sizeMb: storedOptionalNumber(row.size_mb),
      storage: null,
      shareLink: storedOptionalText(row.share_link),
      forceCloseReason: storedOptionalText(row.force_close_reason),
      video: null
    };
    if (normalizedAwb !== originalAwb.trim()) throw new TypeError();
    if (record.status !== "pass" && record.status !== "warn") throw new TypeError();
    const createdAt = storedOptionalTimestamp(row.created_at);
    const updatedAt = storedOptionalTimestamp(row.updated_at);
    if (createdAt === null || updatedAt === null || Date.parse(updatedAt) < Date.parse(createdAt)) throw new TypeError();
    assertChronology(record.startedAt, record.endedAt, "PACK_RECORD_READ_FAILED");
    const storageValues = [row.storage_target_id, row.storage_label, row.storage_provider, row.storage_host];
    if (storageValues.some((item) => item !== null)) {
      record.storage = {
        targetId: storedOptionalText(row.storage_target_id), label: storedOptionalText(row.storage_label),
        provider: storedOptionalText(row.storage_provider), host: storedOptionalText(row.storage_host)
      };
    }
    if (row.video_record_id !== null) record.video = hydrateVideo(row, record.id);
    return record;
  } catch {
    throw error("PACK_RECORD_STORED_DATA_INVALID", "Stored Pack Record data is invalid.");
  }
}

function hydrateVideo(row, recordId) {
  if (storedRequiredText(row.video_record_id) !== recordId) throw new TypeError();
  return {
    fileName: storedOptionalText(row.video_file_name),
    relativePath: storedOptionalText(row.video_relative_path),
    bytes: storedOptionalSafeInteger(row.video_bytes),
    sizeMb: storedOptionalNumber(row.video_size_mb),
    contentType: storedOptionalText(row.video_content_type),
    storageTargetId: storedOptionalText(row.video_storage_target_id),
    storageLabel: storedOptionalText(row.video_storage_label),
    storageHost: storedOptionalText(row.video_storage_host),
    storageMode: storedOptionalText(row.video_storage_mode),
    mountedRequired: storedOptionalBoolean(row.video_mounted_required),
    simulated: storedOptionalBoolean(row.video_simulated),
    externalUrl: storedOptionalText(row.video_external_url),
    customPath: storedOptionalText(row.video_custom_path),
    shareLink: storedOptionalText(row.video_share_link),
    savedAt: storedOptionalTimestamp(row.video_saved_at)
  };
}

function videoParameters(video) {
  return [
    video.fileName, video.relativePath, video.bytes, video.sizeMb, video.contentType,
    video.storageTargetId, video.storageLabel, video.storageHost, video.storageMode,
    sqliteBoolean(video.mountedRequired), sqliteBoolean(video.simulated), video.externalUrl,
    video.customPath, video.shareLink, video.savedAt
  ];
}

function readSafely(callback, code = "PACK_RECORD_READ_FAILED", message = "The Pack Record could not be read.") {
  try { return callback(); } catch (cause) {
    if (cause instanceof PackRecordRepositoryError) throw cause;
    throw error(code, message);
  }
}

function requiredText(value, code, message, maximum = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") throw error(code, message);
  const clean = value.trim();
  if (!clean || clean.length > maximum || CONTROL_CHARACTER_PATTERN.test(clean)) throw error(code, message);
  return clean;
}

function optionalText(value, code = "PACK_RECORD_INPUT_INVALID") {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw error(code, "A Pack Record text field is invalid.");
  }
  return value;
}

function optionalSafeInteger(value, code = "PACK_RECORD_INPUT_INVALID") {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw error(code, "A Pack Record number is invalid.");
  return value;
}

function optionalNonnegativeNumber(value, code = "PACK_RECORD_INPUT_INVALID") {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw error(code, "A Pack Record number is invalid.");
  return value;
}

function optionalBoolean(value) {
  if (value == null) return null;
  if (typeof value !== "boolean") throw error("PACK_RECORD_VIDEO_INVALID", "A video flag is invalid.");
  return value;
}

function optionalWriteTimestamp(value, code = "PACK_RECORD_INPUT_INVALID") {
  if (value == null) return null;
  if (!isIsoTimestamp(value) || !value.endsWith("Z") || new Date(value).toISOString() !== value) {
    throw error(code, "A canonical UTC timestamp is required.");
  }
  return value;
}

function optionalReadTimestamp(value, code) {
  if (value == null || value === "") return null;
  if (!isIsoTimestamp(value)) throw error(code, "A timestamp filter is invalid.");
  return value;
}

function currentTimestamp(now) {
  try {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError();
    return date.toISOString();
  } catch {
    throw error("PACK_RECORD_TIMESTAMP_INVALID", "The repository clock returned an invalid timestamp.");
  }
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = value.match(ISO_WITH_TIMEZONE_PATTERN);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0); const offsetMinute = Number(offsetMinuteText ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function assertChronology(first, second, code = "PACK_RECORD_INPUT_INVALID") {
  if (first && second && Date.parse(second) < Date.parse(first)) throw error(code, "Pack Record timestamp chronology is invalid.");
}

function assertSafeFileName(value) {
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    throw error("PACK_RECORD_VIDEO_INVALID", "The video path is invalid.");
  }
}

function assertSafeRelativePath(value) {
  if (!value || value.startsWith("/") || value.startsWith("\\") || value.includes("\\")
    || /^[A-Za-z]:/.test(value) || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw error("PACK_RECORD_VIDEO_INVALID", "The video path is invalid.");
  }
}

function storedRequiredText(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) throw new TypeError();
  return value;
}

function storedOptionalText(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) throw new TypeError();
  return value;
}

function storedOptionalTimestamp(value) {
  if (value === null) return null;
  if (!isIsoTimestamp(value)) throw new TypeError();
  return value;
}

function normalizeSqliteInteger(value) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number)) throw new TypeError();
  return number;
}

function storedOptionalSafeInteger(value) {
  if (value === null) return null;
  const number = normalizeSqliteInteger(value);
  if (number < 0) throw new TypeError();
  return number;
}

function storedOptionalNumber(value) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError();
  return value;
}

function storedOptionalBoolean(value) {
  if (value === null) return null;
  const number = normalizeSqliteInteger(value);
  if (number !== 0 && number !== 1) throw new TypeError();
  return Boolean(number);
}

function summaryInteger(value) {
  const number = normalizeSqliteInteger(value);
  if (number < 0) throw new TypeError();
  return number;
}

function summaryNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError();
  return value;
}

function requirePublicCursor(value) {
  const sequence = normalizeSqliteInteger(value);
  if (sequence < 1) throw error("PACK_RECORD_STORED_DATA_INVALID", "Stored Pack Record data is invalid.");
  return sequence;
}

function sqliteBoolean(value) { return value === null ? null : value ? 1 : 0; }
function escapeLike(value) { return value.replace(/[\\%_]/g, "\\$&"); }

function requireOneChange(result, code, message) {
  if (result?.changes !== 1 && result?.changes !== 1n) throw error(code, message);
}

function assertPlainObject(value, code, message) {
  if (value === null || typeof value !== "object") throw error(code, message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw error(code, message);
}

function assertAllowedFields(value, allowed, code, message) {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw error(code, message);
}

function error(code, message) { return new PackRecordRepositoryError(code, message); }
