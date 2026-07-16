import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDatabaseMigrationCli } from "../scripts/db-migrate.mjs";

test("migration CLI refuses to choose a default database path", async () => {
  const errors = [];

  const exitCode = await runDatabaseMigrationCli({
    argv: [],
    environment: {},
    output: () => {},
    errorOutput: (message) => errors.push(message)
  });

  assert.equal(exitCode, 1);
  assert.match(errors.join("\n"), /explicit database path is required/i);
});

test("migration CLI applies migrations to an explicit temporary argument path", async (t) => {
  const directory = await temporaryDirectory(t);
  const databasePath = path.join(directory, "argument.sqlite");
  const output = [];

  const exitCode = await runDatabaseMigrationCli({
    argv: [databasePath],
    environment: {},
    output: (message) => output.push(message),
    errorOutput: () => {}
  });

  assert.equal(exitCode, 0);
  await access(databasePath);
  assert.match(output.join("\n"), new RegExp(`database_path=${escapeRegExp(databasePath)}`));
  assert.match(output.join("\n"), /sqlite_version=\d+\.\d+\.\d+/);
  assert.match(
    output.join("\n"),
    /migrations_applied=1:001_storage_foundation\.sql,2:002_pack_records\.sql,3:003_orders_labels\.sql/
  );
  assert.match(output.join("\n"), /schema_version=3/);
  assert.match(output.join("\n"), /quick_check=ok/);
  assert.match(output.join("\n"), /foreign_key_check=ok/);
});

test("migration CLI accepts an explicit temporary environment path", async (t) => {
  const directory = await temporaryDirectory(t);
  const databasePath = path.join(directory, "environment.sqlite");
  const output = [];

  const exitCode = await runDatabaseMigrationCli({
    argv: [],
    environment: { SMARTRECORD_SQLITE_DATABASE_PATH: databasePath },
    output: (message) => output.push(message),
    errorOutput: () => {}
  });

  assert.equal(exitCode, 0);
  await access(databasePath);
  assert.match(output.join("\n"), /schema_version=3/);
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "smartrecord-sqlite-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
