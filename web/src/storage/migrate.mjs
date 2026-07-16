import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteStorageError,
  runInSqliteTransaction
} from "./sqliteDatabase.mjs";

const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(new URL("./migrations/", import.meta.url));
const MIGRATION_FILE_PATTERN = /^(\d+)_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/;

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum_sha256 TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

export class SqliteMigrationError extends SqliteStorageError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = "SqliteMigrationError";
  }
}

export async function runSqliteMigrations(database, {
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
  now = () => new Date(),
  maximumVersion = null
} = {}) {
  const availableMigrations = await loadMigrations(migrationsDirectory);
  const migrations = selectMigrationsThroughVersion(availableMigrations, maximumVersion);
  const latestSupportedVersion = migrations.at(-1)?.version ?? 0;
  const latestAvailableVersion = availableMigrations.at(-1)?.version ?? 0;
  const currentUserVersion = readUserVersion(database);

  return runInSqliteTransaction(database, () => {
    database.exec(CREATE_MIGRATIONS_TABLE_SQL);
    const appliedRows = database.prepare(`
      SELECT version, name, checksum_sha256, applied_at
      FROM schema_migrations
      ORDER BY version
    `).all();

    validateAppliedMigrations(appliedRows, availableMigrations, latestAvailableVersion);
    const appliedVersionAboveTarget = appliedRows.find(
      (row) => Number(row.version) > latestSupportedVersion
    );
    if (currentUserVersion > latestSupportedVersion || appliedVersionAboveTarget) {
      throw migrationError(
        "SQLITE_SCHEMA_VERSION_UNSUPPORTED",
        `Database schema version ${Math.max(currentUserVersion, Number(appliedVersionAboveTarget?.version || 0))} is newer than supported version ${latestSupportedVersion}.`
      );
    }

    const appliedByVersion = new Map(appliedRows.map((row) => [Number(row.version), row]));
    const insertMigration = database.prepare(`
      INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at)
      VALUES (?, ?, ?, ?)
    `);
    const newlyApplied = [];

    for (const migration of migrations) {
      if (appliedByVersion.has(migration.version)) continue;

      let appliedAt;
      try {
        database.exec(migration.sql);
        appliedAt = toIsoTimestamp(now());
        insertMigration.run(migration.version, migration.name, migration.checksumSha256, appliedAt);
      } catch (cause) {
        if (cause instanceof SqliteMigrationError) throw cause;
        throw migrationError(
          "SQLITE_MIGRATION_APPLY_FAILED",
          `Failed to apply SQLite migration ${migration.name}; all migration changes were rolled back.`,
          cause
        );
      }
      newlyApplied.push({
        version: migration.version,
        name: migration.name,
        checksumSha256: migration.checksumSha256,
        appliedAt
      });
    }

    const currentVersion = migrations
      .filter((migration) => appliedByVersion.has(migration.version) || newlyApplied.some((row) => row.version === migration.version))
      .at(-1)?.version ?? 0;
    database.exec(`PRAGMA user_version = ${currentVersion}`);

    return {
      applied: newlyApplied,
      currentVersion,
      latestSupportedVersion
    };
  });
}

function selectMigrationsThroughVersion(migrations, maximumVersion) {
  if (maximumVersion == null) return migrations;
  if (!Number.isSafeInteger(maximumVersion) || maximumVersion < 1) {
    throw migrationError(
      "SQLITE_MIGRATION_TARGET_INVALID",
      "The maximum SQLite migration version must be a positive safe integer."
    );
  }
  if (!migrations.some((migration) => migration.version === maximumVersion)) {
    throw migrationError(
      "SQLITE_MIGRATION_TARGET_UNAVAILABLE",
      `SQLite migration version ${maximumVersion} is not available.`
    );
  }
  return migrations.filter((migration) => migration.version <= maximumVersion);
}

export function readSqliteSchemaVersion(database) {
  return readUserVersion(database);
}

async function loadMigrations(migrationsDirectory) {
  let entries;
  try {
    entries = await readdir(migrationsDirectory, { withFileTypes: true });
  } catch (cause) {
    throw migrationError(
      "SQLITE_MIGRATIONS_DIRECTORY_UNREADABLE",
      `Unable to read SQLite migrations directory ${migrationsDirectory}.`,
      cause
    );
  }

  const migrationFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => {
      const match = entry.name.match(MIGRATION_FILE_PATTERN);
      if (!match) {
        throw migrationError(
          "SQLITE_MIGRATION_FILENAME_INVALID",
          `Migration filename ${entry.name} must start with a numeric version followed by an underscore.`
        );
      }
      return {
        filename: entry.name,
        version: Number.parseInt(match[1], 10)
      };
    })
    .sort((left, right) => left.version - right.version || left.filename.localeCompare(right.filename));

  for (let index = 1; index < migrationFiles.length; index += 1) {
    if (migrationFiles[index - 1].version === migrationFiles[index].version) {
      throw migrationError(
        "SQLITE_MIGRATION_VERSION_DUPLICATE",
        `Multiple migration files use version ${migrationFiles[index].version}.`
      );
    }
  }

  if (migrationFiles.some((migration) => !Number.isSafeInteger(migration.version) || migration.version < 1)) {
    throw migrationError(
      "SQLITE_MIGRATION_VERSION_INVALID",
      "SQLite migration versions must be positive safe integers."
    );
  }

  return Promise.all(migrationFiles.map(async (migration) => {
    const filePath = path.join(migrationsDirectory, migration.filename);
    let contents;
    try {
      contents = await readFile(filePath);
    } catch (cause) {
      throw migrationError(
        "SQLITE_MIGRATION_FILE_UNREADABLE",
        `Unable to read SQLite migration file ${migration.filename}.`,
        cause
      );
    }
    return {
      version: migration.version,
      name: migration.filename,
      checksumSha256: createHash("sha256").update(contents).digest("hex"),
      sql: contents.toString("utf8")
    };
  }));
}

function validateAppliedMigrations(appliedRows, migrations, latestSupportedVersion) {
  const migrationByVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  for (const row of appliedRows) {
    const version = Number(row.version);
    const migration = migrationByVersion.get(version);
    if (!migration) {
      throw migrationError(
        "SQLITE_MIGRATION_FILE_MISSING",
        `Applied migration version ${version} has no matching migration file.`
      );
    }
    if (version > latestSupportedVersion) {
      throw migrationError(
        "SQLITE_SCHEMA_VERSION_UNSUPPORTED",
        `Applied migration version ${version} is newer than supported version ${latestSupportedVersion}.`
      );
    }
    if (row.name !== migration.name) {
      throw migrationError(
        "SQLITE_MIGRATION_NAME_MISMATCH",
        `Applied migration version ${version} is recorded as ${row.name}, not ${migration.name}.`
      );
    }
    if (row.checksum_sha256 !== migration.checksumSha256) {
      throw migrationError(
        "SQLITE_MIGRATION_CHECKSUM_MISMATCH",
        `Applied migration ${migration.name} has a different SHA-256 checksum; applied migrations must never be edited.`
      );
    }
  }
}

function readUserVersion(database) {
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
  if (!Number.isInteger(version) || version < 0) {
    throw migrationError("SQLITE_USER_VERSION_INVALID", "SQLite PRAGMA user_version is invalid.");
  }
  return version;
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw migrationError("SQLITE_MIGRATION_TIMESTAMP_INVALID", "Migration applied_at timestamp is invalid.");
  }
  return date.toISOString();
}

function migrationError(code, message, cause) {
  return new SqliteMigrationError(code, message, cause ? { cause } : undefined);
}
