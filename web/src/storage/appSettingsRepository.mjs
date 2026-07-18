import {
  SqliteStorageError,
  runInSqliteTransaction
} from "./sqliteDatabase.mjs";

const SETTINGS_KEY = "application.settings";
const MINIMUM_SCHEMA_VERSION = 1;
const MAX_ATTRIBUTION_LENGTH = 4096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const OPTION_FIELDS = new Set(["now"]);
const INPUT_FIELDS = new Set([
  "fileName",
  "bytes",
  "contentType",
  "width",
  "height",
  "updatedBy",
  "expectedUpdatedAt"
]);
const ROOT_FIELDS = new Set(["systemAssets"]);
const SYSTEM_ASSET_FIELDS = new Set(["prePackGuideImage"]);
const STORED_IMAGE_FIELDS = new Set([
  "updatedBy",
  "fileName",
  "bytes",
  "contentType",
  "width",
  "height"
]);
const FILE_NAME_BY_CONTENT_TYPE = new Map([
  ["image/png", "prepack-guide-custom.png"],
  ["image/jpeg", "prepack-guide-custom.jpg"],
  ["image/webp", "prepack-guide-custom.webp"]
]);

export class AppSettingsRepositoryError extends SqliteStorageError {
  constructor(code, message) {
    super(code, message);
    this.name = "AppSettingsRepositoryError";
    this.details = {};
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: `${this.name}: ${this.message}`
    });
  }
}

export function createAppSettingsRepository(database, options = {}) {
  const now = validateOptions(options);
  validateDatabase(database);
  validateSchema(database);
  const statements = prepareStatements(database);

  function getSettings() {
    let row;
    try {
      row = statements.selectSettings.get(SETTINGS_KEY);
    } catch {
      throw repositoryError(
        "APP_SETTINGS_READ_FAILED",
        "App Settings could not be read."
      );
    }
    return row ? hydrateStoredSettings(row) : null;
  }

  function replacePrePackGuideImage(input) {
    const image = normalizeInput(input);

    try {
      return runInSqliteTransaction(database, () => {
        const currentRow = statements.selectSettings.get(SETTINGS_KEY);
        let currentUpdatedAt = null;

        if (currentRow) {
          currentUpdatedAt = hydrateStoredSettings(currentRow)
            .systemAssets.prePackGuideImage.updatedAt;
          if (image.expectedUpdatedAt !== currentUpdatedAt) {
            throw repositoryError(
              "APP_SETTINGS_CONFLICT",
              "App Settings changed before this replacement could be applied."
            );
          }
        } else if (image.expectedUpdatedAt !== null) {
          throw repositoryError(
            "APP_SETTINGS_CONFLICT",
            "App Settings changed before this replacement could be applied."
          );
        }

        const updatedAt = nextTimestamp(now, currentUpdatedAt);
        const valueJson = JSON.stringify(buildStoredSettings(image));

        if (currentRow) {
          const result = statements.updateSettings.run(
            valueJson,
            updatedAt,
            SETTINGS_KEY,
            image.expectedUpdatedAt
          );
          if (!hasExactlyOneChange(result)) {
            throw repositoryError(
              "APP_SETTINGS_CONFLICT",
              "App Settings changed before this replacement could be applied."
            );
          }
        } else {
          const result = statements.insertSettings.run(
            SETTINGS_KEY,
            valueJson,
            updatedAt
          );
          if (!hasExactlyOneChange(result)) {
            throw repositoryError(
              "APP_SETTINGS_WRITE_FAILED",
              "App Settings could not be saved."
            );
          }
        }

        return buildPublicSettings(image, updatedAt);
      });
    } catch (cause) {
      if (cause instanceof AppSettingsRepositoryError) throw cause;
      throw repositoryError(
        "APP_SETTINGS_WRITE_FAILED",
        "App Settings could not be saved."
      );
    }
  }

  return {
    getSettings,
    replacePrePackGuideImage
  };
}

function validateOptions(options) {
  if (!isPlainObject(options)) {
    throw repositoryError(
      "APP_SETTINGS_TIMESTAMP_INVALID",
      "The App Settings repository clock is invalid."
    );
  }
  const keys = ownDataKeys(options);
  if (!keys || keys.some((key) => !OPTION_FIELDS.has(key))) {
    throw repositoryError(
      "APP_SETTINGS_INPUT_INVALID",
      "App Settings input is invalid."
    );
  }
  const now = Object.hasOwn(options, "now") ? options.now : () => new Date();
  if (typeof now !== "function") {
    throw repositoryError(
      "APP_SETTINGS_TIMESTAMP_INVALID",
      "The App Settings repository clock is invalid."
    );
  }
  return now;
}

function validateDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw repositoryError(
      "APP_SETTINGS_DATABASE_INVALID",
      "A caller-owned synchronous SQLite database is required."
    );
  }
}

function validateSchema(database) {
  let version;
  let foreignKeys;
  let table;
  let columns;
  try {
    version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    foreignKeys = Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys);
    table = database.prepare(`
      SELECT type
      FROM main.sqlite_schema
      WHERE name = ?
    `).get("storage_metadata");
    columns = database.prepare("PRAGMA main.table_info(storage_metadata)").all();
  } catch {
    throw repositoryError(
      "APP_SETTINGS_DATABASE_INVALID",
      "The caller-owned SQLite database could not be verified."
    );
  }

  if (!Number.isSafeInteger(version) || version < MINIMUM_SCHEMA_VERSION) {
    throw repositoryError(
      "APP_SETTINGS_SCHEMA_REQUIRED",
      "SQLite schema version 1 or later is required."
    );
  }
  if (foreignKeys !== 1) {
    throw repositoryError(
      "APP_SETTINGS_FOREIGN_KEYS_REQUIRED",
      "SQLite foreign keys must be enabled."
    );
  }
  if (table?.type !== "table" || !hasRequiredColumns(columns)) {
    throw repositoryError(
      "APP_SETTINGS_SCHEMA_REQUIRED",
      "The required App Settings storage schema is unavailable."
    );
  }
}

function hasRequiredColumns(columns) {
  const byName = new Map(columns.map((column) => [column.name, column]));
  const key = byName.get("key");
  const valueJson = byName.get("value_json");
  const updatedAt = byName.get("updated_at");
  return byName.size >= 3
    && String(key?.type || "").toUpperCase() === "TEXT"
    && Number(key?.pk) === 1
    && String(valueJson?.type || "").toUpperCase() === "TEXT"
    && Number(valueJson?.notnull) === 1
    && String(updatedAt?.type || "").toUpperCase() === "TEXT"
    && Number(updatedAt?.notnull) === 1;
}

function prepareStatements(database) {
  try {
    return {
      selectSettings: database.prepare(`
        SELECT value_json, updated_at
        FROM main.storage_metadata
        WHERE key = ?
      `),
      insertSettings: database.prepare(`
        INSERT INTO main.storage_metadata (key, value_json, updated_at)
        VALUES (?, ?, ?)
      `),
      updateSettings: database.prepare(`
        UPDATE main.storage_metadata
        SET value_json = ?, updated_at = ?
        WHERE key = ? AND updated_at = ?
      `)
    };
  } catch {
    throw repositoryError(
      "APP_SETTINGS_DATABASE_INVALID",
      "The caller-owned SQLite database is not usable."
    );
  }
}

function normalizeInput(input) {
  try {
    requireExactObject(input, INPUT_FIELDS);
    const image = normalizeImageMetadata(input);
    if (input.expectedUpdatedAt !== null && !isCanonicalTimestamp(input.expectedUpdatedAt)) {
      throw new TypeError();
    }
    return {
      ...image,
      expectedUpdatedAt: input.expectedUpdatedAt
    };
  } catch {
    throw repositoryError(
      "APP_SETTINGS_INPUT_INVALID",
      "App Settings input is invalid."
    );
  }
}

function hydrateStoredSettings(row) {
  try {
    if (typeof row.value_json !== "string" || !isCanonicalTimestamp(row.updated_at)) {
      throw new TypeError();
    }
    const stored = JSON.parse(row.value_json);
    requireExactObject(stored, ROOT_FIELDS);
    requireExactObject(stored.systemAssets, SYSTEM_ASSET_FIELDS);
    requireExactObject(stored.systemAssets.prePackGuideImage, STORED_IMAGE_FIELDS);
    const image = normalizeImageMetadata(stored.systemAssets.prePackGuideImage);
    if (image.updatedBy !== stored.systemAssets.prePackGuideImage.updatedBy) {
      throw new TypeError();
    }
    return buildPublicSettings(image, row.updated_at);
  } catch (cause) {
    if (cause instanceof AppSettingsRepositoryError) throw cause;
    throw repositoryError(
      "APP_SETTINGS_STORED_DATA_INVALID",
      "Stored App Settings data is invalid."
    );
  }
}

function normalizeImageMetadata(value) {
  const updatedBy = normalizeAttribution(value.updatedBy);
  if (typeof value.fileName !== "string" || typeof value.contentType !== "string") {
    throw new TypeError();
  }
  if (CONTROL_CHARACTER_PATTERN.test(value.fileName)
    || FILE_NAME_BY_CONTENT_TYPE.get(value.contentType) !== value.fileName) {
    throw new TypeError();
  }
  return {
    updatedBy,
    fileName: value.fileName,
    bytes: positiveSafeInteger(value.bytes),
    contentType: value.contentType,
    width: positiveSafeInteger(value.width),
    height: positiveSafeInteger(value.height)
  };
}

function normalizeAttribution(value) {
  if (typeof value !== "string") throw new TypeError();
  const normalized = value.trim();
  if (!normalized
    || normalized.length > MAX_ATTRIBUTION_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new TypeError();
  }
  return normalized;
}

function positiveSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError();
  return value;
}

function buildStoredSettings(image) {
  return {
    systemAssets: {
      prePackGuideImage: {
        updatedBy: image.updatedBy,
        fileName: image.fileName,
        bytes: image.bytes,
        contentType: image.contentType,
        width: image.width,
        height: image.height
      }
    }
  };
}

function buildPublicSettings(image, updatedAt) {
  return {
    systemAssets: {
      prePackGuideImage: {
        updatedAt,
        updatedBy: image.updatedBy,
        fileName: image.fileName,
        bytes: image.bytes,
        contentType: image.contentType,
        width: image.width,
        height: image.height
      }
    }
  };
}

function nextTimestamp(now, currentUpdatedAt) {
  let value;
  try {
    value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError();
    let milliseconds = value.getTime();
    let currentMilliseconds = null;
    if (currentUpdatedAt !== null) {
      currentMilliseconds = new Date(currentUpdatedAt).getTime();
      if (milliseconds <= currentMilliseconds) milliseconds = currentMilliseconds + 1;
    }
    const next = new Date(milliseconds);
    const timestamp = next.toISOString();
    if (currentMilliseconds !== null && next.getTime() <= currentMilliseconds) throw new TypeError();
    return timestamp;
  } catch {
    throw repositoryError(
      "APP_SETTINGS_TIMESTAMP_INVALID",
      "The App Settings repository clock is invalid."
    );
  }
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function requireExactObject(value, expectedFields) {
  if (!isPlainObject(value)) throw new TypeError();
  const keys = ownDataKeys(value);
  if (!keys
    || keys.length !== expectedFields.size
    || keys.some((key) => !expectedFields.has(key))
    || [...expectedFields].some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError();
  }
}

function ownDataKeys(value) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
  }
  return keys;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyOneChange(result) {
  return result?.changes === 1 || result?.changes === 1n;
}

function repositoryError(code, message) {
  return new AppSettingsRepositoryError(code, message);
}
