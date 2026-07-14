import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  closeSqliteDatabase,
  getSqliteRuntimeVersion,
  openSqliteDatabase,
  runSqliteForeignKeyCheck,
  runSqliteQuickCheck
} from "../src/storage/sqliteDatabase.mjs";
import {
  readSqliteSchemaVersion,
  runSqliteMigrations
} from "../src/storage/migrate.mjs";

const DATABASE_PATH_ENVIRONMENT_VARIABLE = "SMARTRECORD_SQLITE_DATABASE_PATH";

export async function runDatabaseMigrationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  output = console.log,
  errorOutput = console.error
} = {}) {
  let database;
  let exitCode = 0;

  try {
    const databasePath = readExplicitDatabasePath(argv, environment);
    database = await openSqliteDatabase(databasePath);
    const migrationResult = await runSqliteMigrations(database);
    const quickCheck = runSqliteQuickCheck(database);
    const foreignKeyCheck = runSqliteForeignKeyCheck(database);

    output(`database_path=${path.resolve(databasePath)}`);
    output(`sqlite_version=${getSqliteRuntimeVersion(database)}`);
    output(`migrations_applied=${formatAppliedMigrations(migrationResult.applied)}`);
    output(`schema_version=${readSqliteSchemaVersion(database)}`);
    output(`quick_check=${quickCheck.ok ? "ok" : quickCheck.messages.join(",")}`);
    output(`foreign_key_check=${foreignKeyCheck.ok ? "ok" : JSON.stringify(foreignKeyCheck.violations)}`);
    if (!quickCheck.ok || !foreignKeyCheck.ok) {
      errorOutput("[db:migrate] SQLite integrity validation failed.");
      exitCode = 1;
    }
  } catch (cause) {
    errorOutput(`[db:migrate] ${cause.code ? `${cause.code}: ` : ""}${cause.message}`);
    exitCode = 1;
  } finally {
    if (database) {
      try {
        closeSqliteDatabase(database);
      } catch (cause) {
        errorOutput(`[db:migrate] ${cause.code ? `${cause.code}: ` : ""}${cause.message}`);
        exitCode = 1;
      }
    }
  }

  return exitCode;
}

function readExplicitDatabasePath(argv, environment) {
  if (argv.length > 1) {
    throw new Error(
      `Usage: npm run db:migrate -- <database-path> or set ${DATABASE_PATH_ENVIRONMENT_VARIABLE}.`
    );
  }

  const argumentPath = argv[0]?.trim();
  const environmentPath = environment[DATABASE_PATH_ENVIRONMENT_VARIABLE]?.trim();
  const databasePath = argumentPath || environmentPath;
  if (!databasePath) {
    throw new Error(
      `An explicit database path is required. Pass one argument or set ${DATABASE_PATH_ENVIRONMENT_VARIABLE}.`
    );
  }
  return databasePath;
}

function formatAppliedMigrations(appliedMigrations) {
  if (appliedMigrations.length === 0) return "none";
  return appliedMigrations.map((migration) => `${migration.version}:${migration.name}`).join(",");
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  process.exitCode = await runDatabaseMigrationCli();
}
