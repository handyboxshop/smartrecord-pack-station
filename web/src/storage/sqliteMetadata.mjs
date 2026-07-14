import {
  SqliteStorageError,
  runInSqliteTransaction
} from "./sqliteDatabase.mjs";

const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

export class SqliteMetadataError extends SqliteStorageError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = "SqliteMetadataError";
  }
}

export function readStorageMetadata(database, key) {
  const validatedKey = validateMetadataKey(key);
  const row = database.prepare(`
    SELECT key, value_json, updated_at
    FROM storage_metadata
    WHERE key = ?
  `).get(validatedKey);
  return row ? parseMetadataRow(row) : null;
}

export function setStorageMetadata(database, key, value, { now = () => new Date() } = {}) {
  const validatedKey = validateMetadataKey(key);
  const valueJson = serializeMetadataValue(value);
  const updatedAt = toIsoTimestamp(now());

  return runInSqliteTransaction(database, () => {
    database.prepare(`
      INSERT INTO storage_metadata (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(validatedKey, valueJson, updatedAt);

    return {
      key: validatedKey,
      value: JSON.parse(valueJson),
      updatedAt
    };
  });
}

export function removeStorageMetadata(database, key) {
  const validatedKey = validateMetadataKey(key);
  return runInSqliteTransaction(database, () => {
    const result = database.prepare("DELETE FROM storage_metadata WHERE key = ?").run(validatedKey);
    return Number(result.changes) > 0;
  });
}

export function listStorageMetadata(database) {
  return database.prepare(`
    SELECT key, value_json, updated_at
    FROM storage_metadata
    ORDER BY key
  `).all().map(parseMetadataRow);
}

export function validateMetadataKey(key) {
  if (typeof key !== "string" || !METADATA_KEY_PATTERN.test(key)) {
    throw metadataError(
      "SQLITE_METADATA_KEY_INVALID",
      "Metadata keys must start with a letter and contain only letters, numbers, dot, underscore, colon, or hyphen (maximum 128 characters)."
    );
  }
  return key;
}

function serializeMetadataValue(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw metadataError("SQLITE_METADATA_VALUE_INVALID", "Metadata value must be JSON-serializable.", cause);
  }
  if (serialized === undefined) {
    throw metadataError("SQLITE_METADATA_VALUE_INVALID", "Metadata value must be JSON-serializable.");
  }
  return serialized;
}

function parseMetadataRow(row) {
  try {
    return {
      key: row.key,
      value: JSON.parse(row.value_json),
      updatedAt: row.updated_at
    };
  } catch (cause) {
    throw metadataError(
      "SQLITE_METADATA_JSON_INVALID",
      `Stored metadata for key ${row.key} does not contain valid JSON.`,
      cause
    );
  }
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw metadataError("SQLITE_METADATA_TIMESTAMP_INVALID", "Metadata updated_at timestamp is invalid.");
  }
  return date.toISOString();
}

function metadataError(code, message, cause) {
  return new SqliteMetadataError(code, message, cause ? { cause } : undefined);
}
