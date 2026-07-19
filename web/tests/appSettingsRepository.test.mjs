import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import {
  closeSqliteDatabase,
  openInMemoryDatabase,
  openSqliteDatabase
} from "../src/storage/sqliteDatabase.mjs";
import { importPackRecords } from "../src/storage/packRecordImporter.mjs";
import { verifyPackRecordImport } from "../src/storage/packRecordImportVerifier.mjs";
import * as repositoryModule from "../src/storage/appSettingsRepository.mjs";

const {
  AppSettingsRepositoryError,
  createAppSettingsRepository
} = repositoryModule;

const SETTINGS_KEY = "application.settings";
const FIXED_TIME = "2026-07-18T09:00:00.000Z";
const LATER_TIME = "2026-07-18T09:00:01.000Z";
const MAX_TIME = "+275760-09-13T00:00:00.000Z";
const COMPATIBLE_TEMP_STORAGE_METADATA_SQL = `
  CREATE TEMP TABLE storage_metadata (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;
const PUBLIC_IMAGE_KEYS = [
  "bytes",
  "contentType",
  "fileName",
  "height",
  "updatedAt",
  "updatedBy",
  "width"
];
const STORED_IMAGE_KEYS = [
  "bytes",
  "contentType",
  "fileName",
  "height",
  "updatedBy",
  "width"
];

function fixedNow() {
  return new Date(FIXED_TIME);
}

function validInput(overrides = {}) {
  return {
    fileName: "prepack-guide-custom.png",
    bytes: 1024,
    contentType: "image/png",
    width: 640,
    height: 360,
    updatedBy: "Settings Owner",
    expectedUpdatedAt: null,
    ...overrides
  };
}

function validStoredImage(overrides = {}) {
  return {
    updatedBy: "Settings Owner",
    fileName: "prepack-guide-custom.png",
    bytes: 1024,
    contentType: "image/png",
    width: 640,
    height: 360,
    ...overrides
  };
}

function storedDocument(imageOverrides = {}, rootOverrides = {}) {
  return {
    systemAssets: {
      prePackGuideImage: validStoredImage(imageOverrides)
    },
    ...rootOverrides
  };
}

function expectCode(callback, code) {
  let captured;
  assert.throws(callback, (error) => {
    captured = error;
    assert.equal(error instanceof AppSettingsRepositoryError, true);
    assert.equal(error.name, "AppSettingsRepositoryError");
    assert.equal(error.code, code);
    assert.deepEqual(error.details, {});
    assert.equal(error.cause, undefined);
    return true;
  });
  return captured;
}

function assertSanitized(error, markers) {
  const serialized = [
    error.message,
    error.stack,
    String(error.cause || ""),
    JSON.stringify(error),
    inspect(error, { depth: 8 })
  ].join("\n");
  for (const marker of markers) assert.equal(serialized.includes(marker), false, marker);
  assert.equal(error.cause, undefined);
}

function assertPublicShape(settings) {
  assert.deepEqual(Object.keys(settings), ["systemAssets"]);
  assert.deepEqual(Object.keys(settings.systemAssets), ["prePackGuideImage"]);
  assert.deepEqual(
    Object.keys(settings.systemAssets.prePackGuideImage).sort(),
    PUBLIC_IMAGE_KEYS
  );
  assert.equal("url" in settings.systemAssets.prePackGuideImage, false);
  assert.equal("expectedUpdatedAt" in settings.systemAssets.prePackGuideImage, false);
}

async function databaseFixture(t, maximumVersion = 5) {
  const database = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(database));
  await runSqliteMigrations(database, { maximumVersion, now: fixedNow });
  return database;
}

async function repositoryFixture(t, maximumVersion = 5, options = { now: fixedNow }) {
  const database = await databaseFixture(t, maximumVersion);
  return {
    database,
    repository: createAppSettingsRepository(database, options)
  };
}

function putDirectSettings(database, value, updatedAt = FIXED_TIME, { raw = false } = {}) {
  const valueJson = raw ? value : JSON.stringify(value);
  database.prepare(`
    INSERT INTO storage_metadata (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(SETTINGS_KEY, valueJson, updatedAt);
  return { valueJson, updatedAt };
}

function settingsRow(database) {
  return database.prepare(`
    SELECT key, value_json, updated_at
    FROM storage_metadata
    WHERE key = ?
  `).get(SETTINGS_KEY);
}

test("exports exactly the typed error and synchronous factory", () => {
  assert.deepEqual(Object.keys(repositoryModule).sort(), [
    "AppSettingsRepositoryError",
    "createAppSettingsRepository"
  ]);
  assert.equal(
    Object.getPrototypeOf(AppSettingsRepositoryError.prototype).constructor.name,
    "SqliteStorageError"
  );
  assert.equal(createAppSettingsRepository.constructor.name, "Function");
});

test("rejects missing or invalid database handles with sanitized errors", () => {
  for (const database of [null, undefined, {}, { prepare() {} }, { exec() {} }]) {
    expectCode(
      () => createAppSettingsRepository(database),
      "APP_SETTINGS_DATABASE_INVALID"
    );
  }
  const rawMarker = "RAW SQLITE /private/customer credential";
  const error = expectCode(
    () => createAppSettingsRepository({
      prepare() { throw new Error(rawMarker); },
      exec() {}
    }),
    "APP_SETTINGS_DATABASE_INVALID"
  );
  assertSanitized(error, [rawMarker, "/private/customer", "credential"]);
});

test("requires schema version 1 and the exact required table characteristics", async (t) => {
  const unmigrated = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(unmigrated));
  expectCode(
    () => createAppSettingsRepository(unmigrated),
    "APP_SETTINGS_SCHEMA_REQUIRED"
  );

  const invalidSchemas = [
    "CREATE TABLE storage_metadata (key TEXT PRIMARY KEY, updated_at TEXT NOT NULL)",
    "CREATE TABLE storage_metadata (key TEXT, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE storage_metadata (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT NOT NULL)",
    "CREATE TABLE storage_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT)"
  ];
  for (const sql of invalidSchemas) {
    const database = await openInMemoryDatabase();
    t.after(() => closeSqliteDatabase(database));
    database.exec("PRAGMA user_version = 1");
    database.exec(sql);
    expectCode(
      () => createAppSettingsRepository(database),
      "APP_SETTINGS_SCHEMA_REQUIRED"
    );
    assert.equal(database.prepare("SELECT 1 AS value").get().value, 1);
  }
});

test("schema validation inspects main even when TEMP has a compatible shadow", async (t) => {
  const valid = await databaseFixture(t, 1);
  valid.exec(COMPATIBLE_TEMP_STORAGE_METADATA_SQL);
  assert.equal(
    createAppSettingsRepository(valid, { now: fixedNow }).getSettings(),
    null
  );

  const missingMain = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(missingMain));
  missingMain.exec("PRAGMA user_version = 1");
  missingMain.exec(COMPATIBLE_TEMP_STORAGE_METADATA_SQL);
  expectCode(
    () => createAppSettingsRepository(missingMain, { now: fixedNow }),
    "APP_SETTINGS_SCHEMA_REQUIRED"
  );

  const incompatibleMain = await openInMemoryDatabase();
  t.after(() => closeSqliteDatabase(incompatibleMain));
  incompatibleMain.exec("PRAGMA user_version = 1");
  incompatibleMain.exec(`
    CREATE TABLE main.storage_metadata (
      key TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL
    )
  `);
  incompatibleMain.exec(COMPATIBLE_TEMP_STORAGE_METADATA_SQL);
  expectCode(
    () => createAppSettingsRepository(incompatibleMain, { now: fixedNow }),
    "APP_SETTINGS_SCHEMA_REQUIRED"
  );
});

test("accepts schema versions 1 through 5 and higher compatible versions", async (t) => {
  for (const version of [1, 2, 3, 4, 5]) {
    const database = await databaseFixture(t, version);
    const repository = createAppSettingsRepository(database, { now: fixedNow });
    assert.equal(repository.getSettings(), null);
  }
  const higher = await databaseFixture(t, 1);
  higher.exec("PRAGMA user_version = 99");
  assert.equal(
    createAppSettingsRepository(higher, { now: fixedNow }).getSettings(),
    null
  );
});

test("requires foreign keys and leaves caller-owned databases open after failures", async (t) => {
  const database = await databaseFixture(t, 1);
  database.exec("PRAGMA foreign_keys = OFF");
  expectCode(
    () => createAppSettingsRepository(database),
    "APP_SETTINGS_FOREIGN_KEYS_REQUIRED"
  );
  assert.equal(database.prepare("SELECT 1 AS value").get().value, 1);
});

test("missing settings read is pure and ignores unrelated metadata", async (t) => {
  const { database, repository } = await repositoryFixture(t, 1);
  database.prepare(`
    INSERT INTO storage_metadata (key, value_json, updated_at)
    VALUES (?, ?, ?)
  `).run("station.profile", JSON.stringify({ station: "synthetic" }), FIXED_TIME);

  assert.equal(repository.getSettings(), null);
  assert.equal(settingsRow(database), undefined);
  assert.deepEqual({ ...database.prepare(`
    SELECT key, value_json, updated_at FROM storage_metadata WHERE key = ?
  `).get("station.profile") }, {
    key: "station.profile",
    value_json: JSON.stringify({ station: "synthetic" }),
    updated_at: FIXED_TIME
  });
});

test("first replacement stores and returns only the approved exact shapes", async (t) => {
  const { database, repository } = await repositoryFixture(t, 1);
  const input = validInput({ updatedBy: "  Settings Owner  " });
  const snapshot = structuredClone(input);
  const created = repository.replacePrePackGuideImage(input);

  assert.deepEqual(input, snapshot);
  assert.deepEqual(created, {
    systemAssets: {
      prePackGuideImage: {
        updatedAt: FIXED_TIME,
        updatedBy: "Settings Owner",
        fileName: "prepack-guide-custom.png",
        bytes: 1024,
        contentType: "image/png",
        width: 640,
        height: 360
      }
    }
  });
  assertPublicShape(created);
  assert.deepEqual(repository.getSettings(), created);

  const row = settingsRow(database);
  assert.equal(row.key, SETTINGS_KEY);
  assert.equal(row.updated_at, FIXED_TIME);
  const stored = JSON.parse(row.value_json);
  assert.deepEqual(Object.keys(stored), ["systemAssets"]);
  assert.deepEqual(Object.keys(stored.systemAssets), ["prePackGuideImage"]);
  assert.deepEqual(
    Object.keys(stored.systemAssets.prePackGuideImage).sort(),
    STORED_IMAGE_KEYS
  );
  assert.equal("updatedAt" in stored.systemAssets.prePackGuideImage, false);
  assert.equal("url" in stored.systemAssets.prePackGuideImage, false);
  assert.equal("defaultUrl" in stored.systemAssets.prePackGuideImage, false);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM storage_metadata WHERE key = ?
  `).get(SETTINGS_KEY).count, 1);
});

test("TEMP shadow cannot redirect persistent settings reads or writes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "smartrecord-app-settings-shadow-"));
  const databasePath = path.join(directory, "settings.sqlite");
  let database = await openSqliteDatabase(databasePath);
  t.after(async () => {
    if (database) closeSqliteDatabase(database);
    await rm(directory, { recursive: true, force: true });
  });

  await runSqliteMigrations(database, { maximumVersion: 1, now: fixedNow });
  database.exec(COMPATIBLE_TEMP_STORAGE_METADATA_SQL);
  const times = [new Date(FIXED_TIME), new Date(LATER_TIME)];
  const repository = createAppSettingsRepository(database, {
    now: () => times.shift()
  });

  const created = repository.replacePrePackGuideImage(validInput());
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM main.storage_metadata
    WHERE key = ?
  `).get(SETTINGS_KEY).count, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM temp.storage_metadata
  `).get().count, 0);

  const replaced = repository.replacePrePackGuideImage(validInput({
    bytes: 2048,
    expectedUpdatedAt: created.systemAssets.prePackGuideImage.updatedAt
  }));
  assert.equal(
    replaced.systemAssets.prePackGuideImage.updatedAt,
    LATER_TIME
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM main.storage_metadata
    WHERE key = ?
  `).get(SETTINGS_KEY).count, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM temp.storage_metadata
  `).get().count, 0);

  database.prepare(`
    INSERT INTO temp.storage_metadata (key, value_json, updated_at)
    VALUES (?, ?, ?)
  `).run(
    SETTINGS_KEY,
    JSON.stringify(storedDocument({ bytes: 9999 })),
    FIXED_TIME
  );
  assert.deepEqual(repository.getSettings(), replaced);

  closeSqliteDatabase(database);
  database = null;
  database = await openSqliteDatabase(databasePath);
  const reopenedRepository = createAppSettingsRepository(database, { now: fixedNow });
  assert.deepEqual(reopenedRepository.getSettings(), replaced);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM main.storage_metadata
    WHERE key = ?
  `).get(SETTINGS_KEY).count, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM temp.sqlite_schema
    WHERE name = 'storage_metadata'
  `).get().count, 0);
  closeSqliteDatabase(database);
  database = null;
});

test("rejects non-plain, unknown, missing, accessor, symbol, and wrong-type inputs", async (t) => {
  const { database, repository } = await repositoryFixture(t, 1);
  const missing = validInput();
  delete missing.height;
  const accessor = validInput();
  Object.defineProperty(accessor, "width", { enumerable: true, get: () => 640 });
  const symbol = validInput();
  symbol[Symbol("private")] = true;
  const invalid = [
    null,
    undefined,
    [],
    "settings",
    1,
    new Date(),
    validInput({ unexpected: true }),
    missing,
    accessor,
    symbol,
    validInput({ fileName: null }),
    validInput({ contentType: null }),
    validInput({ expectedUpdatedAt: undefined }),
    validInput({ expectedUpdatedAt: "2026-07-18T16:00:00.000+07:00" }),
    validInput({ expectedUpdatedAt: "2026-07-18T09:00:00Z" }),
    validInput({ expectedUpdatedAt: "not-a-time" })
  ];
  for (const input of invalid) {
    expectCode(
      () => repository.replacePrePackGuideImage(input),
      "APP_SETTINGS_INPUT_INVALID"
    );
  }
  assert.equal(settingsRow(database), undefined);
});

test("normalizes bounded human-readable attribution and rejects unsafe values", async (t) => {
  const accepted = await repositoryFixture(t, 1);
  const maximum = "A".repeat(4096);
  const created = accepted.repository.replacePrePackGuideImage(
    validInput({ updatedBy: `  ${maximum}  ` })
  );
  assert.equal(created.systemAssets.prePackGuideImage.updatedBy, maximum);

  const rejected = await repositoryFixture(t, 1);
  for (const updatedBy of [
    "",
    "   ",
    "A".repeat(4097),
    "actor\0name",
    "actor\nname",
    "actor\u007fname",
    { name: "actor" },
    ["actor"],
    7,
    null
  ]) {
    expectCode(
      () => rejected.repository.replacePrePackGuideImage(validInput({ updatedBy })),
      "APP_SETTINGS_INPUT_INVALID"
    );
  }
  assert.equal(settingsRow(rejected.database), undefined);
});

test("accepts only the exact server-generated PNG, JPEG, and WebP basenames", async (t) => {
  const { repository } = await repositoryFixture(t, 1);
  const combinations = [
    ["prepack-guide-custom.png", "image/png"],
    ["prepack-guide-custom.jpg", "image/jpeg"],
    ["prepack-guide-custom.webp", "image/webp"]
  ];
  let expectedUpdatedAt = null;
  for (const [fileName, contentType] of combinations) {
    const result = repository.replacePrePackGuideImage(validInput({
      fileName,
      contentType,
      expectedUpdatedAt
    }));
    assert.equal(result.systemAssets.prePackGuideImage.fileName, fileName);
    assert.equal(result.systemAssets.prePackGuideImage.contentType, contentType);
    expectedUpdatedAt = result.systemAssets.prePackGuideImage.updatedAt;
  }
});

test("rejects filename mismatches and every unsafe filename form before mutation", async (t) => {
  const { database, repository } = await repositoryFixture(t, 1);
  const invalid = [
    ["prepack-guide-custom.png", "image/jpeg"],
    ["prepack-guide-custom.jpg", "image/webp"],
    ["prepack-guide-custom.jpeg", "image/jpeg"],
    ["PREPACK-GUIDE-CUSTOM.PNG", "image/png"],
    ["/prepack-guide-custom.png", "image/png"],
    ["../prepack-guide-custom.png", "image/png"],
    ["assets/prepack-guide-custom.png", "image/png"],
    ["assets\\prepack-guide-custom.png", "image/png"],
    ["https://example.test/prepack-guide-custom.png", "image/png"],
    ["prepack-guide-custom.png?v=1", "image/png"],
    ["prepack-guide-custom.png#asset", "image/png"],
    ["C:\\prepack-guide-custom.png", "image/png"],
    ["\\\\server\\prepack-guide-custom.png", "image/png"],
    ["prepack-guide-custom\0.png", "image/png"],
    ["prepack-guide-custom\n.png", "image/png"],
    ["prepack-guide-custom.png", "image/gif"]
  ];
  for (const [fileName, contentType] of invalid) {
    expectCode(
      () => repository.replacePrePackGuideImage(validInput({ fileName, contentType })),
      "APP_SETTINGS_INPUT_INVALID"
    );
  }
  assert.equal(settingsRow(database), undefined);
});

test("enforces positive-safe-integer metadata for every numeric field", async (t) => {
  const accepted = await repositoryFixture(t, 1);
  const created = accepted.repository.replacePrePackGuideImage(validInput({
    bytes: Number.MAX_SAFE_INTEGER,
    width: Number.MAX_SAFE_INTEGER,
    height: Number.MAX_SAFE_INTEGER
  }));
  assert.equal(created.systemAssets.prePackGuideImage.bytes, Number.MAX_SAFE_INTEGER);

  const rejected = await repositoryFixture(t, 1);
  const invalidNumbers = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    1n,
    null,
    [],
    {}
  ];
  for (const field of ["bytes", "width", "height"]) {
    for (const value of invalidNumbers) {
      expectCode(
        () => rejected.repository.replacePrePackGuideImage(validInput({ [field]: value })),
        "APP_SETTINGS_INPUT_INVALID"
      );
    }
  }
  assert.equal(settingsRow(rejected.database), undefined);
});

test("enforces initial and replacement optimistic-concurrency tokens", async (t) => {
  const { database, repository } = await repositoryFixture(t, 1, {
    now: () => new Date(LATER_TIME)
  });
  expectCode(
    () => repository.replacePrePackGuideImage(validInput({ expectedUpdatedAt: FIXED_TIME })),
    "APP_SETTINGS_CONFLICT"
  );
  assert.equal(settingsRow(database), undefined);

  const created = repository.replacePrePackGuideImage(validInput());
  const revision = created.systemAssets.prePackGuideImage.updatedAt;
  const before = { ...settingsRow(database) };
  for (const expectedUpdatedAt of [null, FIXED_TIME, "2026-07-18T09:00:02.000Z"]) {
    expectCode(
      () => repository.replacePrePackGuideImage(validInput({
        bytes: 2048,
        expectedUpdatedAt
      })),
      "APP_SETTINGS_CONFLICT"
    );
    assert.deepEqual({ ...settingsRow(database) }, before);
  }

  const replaced = repository.replacePrePackGuideImage(validInput({
    bytes: 2048,
    expectedUpdatedAt: revision
  }));
  assert.equal(replaced.systemAssets.prePackGuideImage.bytes, 2048);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM storage_metadata WHERE key = ?
  `).get(SETTINGS_KEY).count, 1);
});

test("two real repository writers using one revision allow one success and one conflict", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "smartrecord-app-settings-cas-"));
  const databasePath = path.join(directory, "settings.sqlite");
  const firstDatabase = await openSqliteDatabase(databasePath);
  await runSqliteMigrations(firstDatabase, { maximumVersion: 1, now: fixedNow });
  const secondDatabase = await openSqliteDatabase(databasePath);
  t.after(async () => {
    closeSqliteDatabase(secondDatabase);
    closeSqliteDatabase(firstDatabase);
    await rm(directory, { recursive: true, force: true });
  });

  const first = createAppSettingsRepository(firstDatabase, { now: fixedNow });
  const second = createAppSettingsRepository(secondDatabase, {
    now: () => new Date(LATER_TIME)
  });
  const created = first.replacePrePackGuideImage(validInput());
  const revision = created.systemAssets.prePackGuideImage.updatedAt;
  assert.equal(second.getSettings().systemAssets.prePackGuideImage.updatedAt, revision);

  const winner = first.replacePrePackGuideImage(validInput({
    bytes: 2048,
    expectedUpdatedAt: revision
  }));
  expectCode(
    () => second.replacePrePackGuideImage(validInput({
      bytes: 4096,
      expectedUpdatedAt: revision
    })),
    "APP_SETTINGS_CONFLICT"
  );
  assert.deepEqual(second.getSettings(), winner);
});

test("same or earlier clocks advance exactly one millisecond", async (t) => {
  const times = [
    new Date(FIXED_TIME),
    new Date(FIXED_TIME),
    new Date("2026-07-18T08:59:00.000Z")
  ];
  const { repository } = await repositoryFixture(t, 1, {
    now: () => times.shift()
  });
  const first = repository.replacePrePackGuideImage(validInput());
  assert.equal(first.systemAssets.prePackGuideImage.updatedAt, FIXED_TIME);
  const second = repository.replacePrePackGuideImage(validInput({
    bytes: 2,
    expectedUpdatedAt: FIXED_TIME
  }));
  assert.equal(second.systemAssets.prePackGuideImage.updatedAt, "2026-07-18T09:00:00.001Z");
  const third = repository.replacePrePackGuideImage(validInput({
    bytes: 3,
    expectedUpdatedAt: second.systemAssets.prePackGuideImage.updatedAt
  }));
  assert.equal(third.systemAssets.prePackGuideImage.updatedAt, "2026-07-18T09:00:00.002Z");
});

test("monotonic revision crosses the four-digit year boundary canonically", async (t) => {
  const { database } = await repositoryFixture(t, 1);
  const boundary = "9999-12-31T23:59:59.999Z";
  putDirectSettings(database, storedDocument(), boundary);
  const repository = createAppSettingsRepository(database, {
    now: () => new Date(boundary)
  });
  const replaced = repository.replacePrePackGuideImage(validInput({
    expectedUpdatedAt: boundary
  }));
  assert.equal(
    replaced.systemAssets.prePackGuideImage.updatedAt,
    "+010000-01-01T00:00:00.000Z"
  );
});

test("rejects invalid clocks and never calls the clock for rejected input or conflicts", async (t) => {
  const database = await databaseFixture(t, 1);
  expectCode(
    () => createAppSettingsRepository(database, { now: null }),
    "APP_SETTINGS_TIMESTAMP_INVALID"
  );
  expectCode(
    () => createAppSettingsRepository(database, null),
    "APP_SETTINGS_TIMESTAMP_INVALID"
  );

  for (const value of ["2026-07-18T09:00:00.000Z", new Date(Number.NaN), null]) {
    const repository = createAppSettingsRepository(database, { now: () => value });
    expectCode(
      () => repository.replacePrePackGuideImage(validInput()),
      "APP_SETTINGS_TIMESTAMP_INVALID"
    );
    assert.equal(settingsRow(database), undefined);
  }

  let calls = 0;
  const repository = createAppSettingsRepository(database, {
    now: () => {
      calls += 1;
      return new Date(FIXED_TIME);
    }
  });
  expectCode(
    () => repository.replacePrePackGuideImage(validInput({ bytes: 0 })),
    "APP_SETTINGS_INPUT_INVALID"
  );
  expectCode(
    () => repository.replacePrePackGuideImage(validInput({ expectedUpdatedAt: LATER_TIME })),
    "APP_SETTINGS_CONFLICT"
  );
  assert.equal(calls, 0);
});

test("malformed stored data is rejected before the clock and remains unchanged", async (t) => {
  const database = await databaseFixture(t, 1);
  const valueJson = JSON.stringify(storedDocument({ bytes: 0 }));
  database.prepare(`
    INSERT INTO main.storage_metadata (key, value_json, updated_at)
    VALUES (?, ?, ?)
  `).run(SETTINGS_KEY, valueJson, FIXED_TIME);
  const before = {
    key: SETTINGS_KEY,
    value_json: valueJson,
    updated_at: FIXED_TIME
  };
  let calls = 0;
  const repository = createAppSettingsRepository(database, {
    now: () => {
      calls += 1;
      return new Date(LATER_TIME);
    }
  });

  expectCode(
    () => repository.replacePrePackGuideImage(validInput({
      expectedUpdatedAt: FIXED_TIME
    })),
    "APP_SETTINGS_STORED_DATA_INVALID"
  );
  assert.equal(calls, 0);
  assert.deepEqual({ ...database.prepare(`
    SELECT key, value_json, updated_at
    FROM main.storage_metadata
    WHERE key = ?
  `).get(SETTINGS_KEY) }, before);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM main.storage_metadata
    WHERE key = ?
  `).get(SETTINGS_KEY).count, 1);
});

test("fails safely when the maximum canonical timestamp cannot advance", async (t) => {
  const { database } = await repositoryFixture(t, 1);
  putDirectSettings(database, storedDocument(), MAX_TIME);
  const before = { ...settingsRow(database) };
  const repository = createAppSettingsRepository(database, {
    now: () => new Date(MAX_TIME)
  });
  expectCode(
    () => repository.replacePrePackGuideImage(validInput({ expectedUpdatedAt: MAX_TIME })),
    "APP_SETTINGS_TIMESTAMP_INVALID"
  );
  assert.deepEqual({ ...settingsRow(database) }, before);
});

test("forced insert and update failures roll back completely and stay sanitized", async (t) => {
  const insertFixture = await repositoryFixture(t, 1);
  insertFixture.database.exec(`
    CREATE TRIGGER reject_app_settings_insert
    BEFORE INSERT ON storage_metadata
    WHEN NEW.key = '${SETTINGS_KEY}'
    BEGIN SELECT RAISE(ABORT, 'RAW INSERT /secret/customer'); END
  `);
  const insertError = expectCode(
    () => insertFixture.repository.replacePrePackGuideImage(validInput()),
    "APP_SETTINGS_WRITE_FAILED"
  );
  assert.equal(settingsRow(insertFixture.database), undefined);
  assertSanitized(insertError, ["RAW INSERT", "/secret/customer"]);

  const updateFixture = await repositoryFixture(t, 1);
  const created = updateFixture.repository.replacePrePackGuideImage(validInput());
  const before = { ...settingsRow(updateFixture.database) };
  updateFixture.database.exec(`
    CREATE TRIGGER reject_app_settings_update
    BEFORE UPDATE ON storage_metadata
    WHEN NEW.key = '${SETTINGS_KEY}'
    BEGIN SELECT RAISE(ABORT, 'RAW UPDATE credential actor'); END
  `);
  const updateError = expectCode(
    () => updateFixture.repository.replacePrePackGuideImage(validInput({
      bytes: 2048,
      expectedUpdatedAt: created.systemAssets.prePackGuideImage.updatedAt
    })),
    "APP_SETTINGS_WRITE_FAILED"
  );
  assert.deepEqual({ ...settingsRow(updateFixture.database) }, before);
  assertSanitized(updateError, ["RAW UPDATE", "credential actor"]);
});

test("direct-SQL malformed semantic JSON fails closed without rewriting", async (t) => {
  const { database, repository } = await repositoryFixture(t, 1);
  const invalidDocuments = [
    null,
    true,
    7,
    "settings",
    [],
    {},
    { unexpected: true },
    storedDocument({}, { unexpected: true }),
    { systemAssets: null },
    { systemAssets: [] },
    { systemAssets: {} },
    { systemAssets: { prePackGuideImage: null } },
    { systemAssets: { prePackGuideImage: [] } },
    { systemAssets: { prePackGuideImage: { ...validStoredImage(), unexpected: true } } },
    storedDocument({ updatedBy: " actor " }),
    storedDocument({ updatedBy: { name: "private actor" } }),
    storedDocument({ fileName: "../prepack-guide-custom.png" }),
    storedDocument({ fileName: "prepack-guide-custom.jpg", contentType: "image/png" }),
    storedDocument({ contentType: "image/gif" }),
    storedDocument({ bytes: 0 }),
    storedDocument({ bytes: Number.MAX_SAFE_INTEGER + 1 }),
    storedDocument({ width: 1.5 }),
    storedDocument({ height: null })
  ];
  const missingImageKey = storedDocument();
  delete missingImageKey.systemAssets.prePackGuideImage.height;
  invalidDocuments.push(missingImageKey);

  for (const document of invalidDocuments) {
    const before = putDirectSettings(database, document);
    const error = expectCode(
      () => repository.getSettings(),
      "APP_SETTINGS_STORED_DATA_INVALID"
    );
    assert.deepEqual({ ...settingsRow(database) }, {
      key: SETTINGS_KEY,
      value_json: before.valueJson,
      updated_at: before.updatedAt
    });
    assertSanitized(error, ["private actor", "../prepack-guide-custom.png"]);
  }
});

test("direct-SQL malformed JSON and noncanonical timestamps fail closed", async (t) => {
  const { database, repository } = await repositoryFixture(t, 1);
  database.exec("PRAGMA ignore_check_constraints = ON");
  const malformed = "{RAW malformed JSON /private/path";
  putDirectSettings(database, malformed, FIXED_TIME, { raw: true });
  database.exec("PRAGMA ignore_check_constraints = OFF");
  const malformedError = expectCode(
    () => repository.getSettings(),
    "APP_SETTINGS_STORED_DATA_INVALID"
  );
  assertSanitized(malformedError, [malformed, "/private/path"]);

  const invalidTimestamps = [
    "",
    "not-a-time",
    "2026-07-18T09:00:00Z",
    "2026-07-18T16:00:00.000+07:00",
    "2026-02-30T09:00:00.000Z"
  ];
  for (const updatedAt of invalidTimestamps) {
    const before = putDirectSettings(database, storedDocument(), updatedAt);
    const error = expectCode(
      () => repository.getSettings(),
      "APP_SETTINGS_STORED_DATA_INVALID"
    );
    assert.deepEqual({ ...settingsRow(database) }, {
      key: SETTINGS_KEY,
      value_json: before.valueJson,
      updated_at: updatedAt
    });
    assertSanitized(error, updatedAt ? [updatedAt] : []);
  }
});

test("operational read failures are sanitized and the caller database remains usable", async (t) => {
  const { database, repository } = await repositoryFixture(t, 1);
  database.exec("DROP TABLE storage_metadata");
  const error = expectCode(
    () => repository.getSettings(),
    "APP_SETTINGS_READ_FAILED"
  );
  assertSanitized(error, ["storage_metadata", "SELECT", "no such table"]);
  assert.equal(database.prepare("SELECT 1 AS value").get().value, 1);
});

test("public errors are stable and sanitized through every inspection surface", async (t) => {
  const { database, repository } = await repositoryFixture(t, 1);
  const markers = [
    "prepack-guide-custom.png",
    "Recognizable Private Actor",
    FIXED_TIME,
    "/private/customer/path",
    "credential-token",
    "SELECT value_json"
  ];
  const inputError = expectCode(
    () => repository.replacePrePackGuideImage(validInput({
      fileName: "/private/customer/path/prepack-guide-custom.png",
      updatedBy: "Recognizable Private Actor"
    })),
    "APP_SETTINGS_INPUT_INVALID"
  );
  assertSanitized(inputError, markers);

  putDirectSettings(database, storedDocument({
    updatedBy: "Recognizable Private Actor",
    fileName: "/private/customer/path/prepack-guide-custom.png"
  }));
  const storedError = expectCode(
    () => repository.getSettings(),
    "APP_SETTINGS_STORED_DATA_INVALID"
  );
  assertSanitized(storedError, markers);
});

test("repository exposes no generic mutation, deletion, URL, or cross-domain methods", async (t) => {
  const { repository } = await repositoryFixture(t, 1);
  assert.deepEqual(Object.keys(repository).sort(), [
    "getSettings",
    "replacePrePackGuideImage"
  ]);
  for (const method of [
    "get",
    "getByKey",
    "set",
    "upsert",
    "patch",
    "replaceSettings",
    "delete",
    "remove",
    "createStorageTarget",
    "updateStorageTarget",
    "removeStorageTarget",
    "generateUrl",
    "writeAuditLog"
  ]) assert.equal(repository[method], undefined);
});

test("repository source has no runtime, filesystem, environment, or physical dependency", async () => {
  const sourcePath = fileURLToPath(
    new URL("../src/storage/appSettingsRepository.mjs", import.meta.url)
  );
  const source = await readFile(sourcePath, "utf8");
  for (const pattern of [
    /node:fs/,
    /node:path/,
    /process\.env/,
    /server\/index/,
    /app-config/,
    /localStorage/,
    /NAS/,
    /printer/i,
    /camera/i,
    /OCR/,
    /video/i,
    /writeFile/,
    /readFile/
  ]) assert.doesNotMatch(source, pattern);
});

test("Phase 4B schema-version-2 import, verification, repository use, and upgrade remain compatible", async (t) => {
  const database = await databaseFixture(t, 2);
  const sourceRecords = [{
    id: "phase-4b-record",
    awb: "  PHASE-4B-AWB  ",
    status: "pass",
    startedAt: "2026-07-18T16:00:00+07:00",
    endedAt: "2026-07-18T16:01:00+07:00"
  }];
  const importResult = importPackRecords(database, sourceRecords, { now: fixedNow });
  assert.equal(verifyPackRecordImport(database, sourceRecords, importResult).ok, true);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);

  const repository = createAppSettingsRepository(database, { now: fixedNow });
  const settings = repository.replacePrePackGuideImage(validInput());
  assertPublicShape(settings);
  assert.equal(verifyPackRecordImport(database, sourceRecords, importResult).ok, true);

  const migrationResult = await runSqliteMigrations(database, { now: fixedNow });
  assert.deepEqual(migrationResult.applied.map((migration) => migration.version), [3, 4, 5]);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 5);
  assert.deepEqual(
    createAppSettingsRepository(database, { now: fixedNow }).getSettings(),
    settings
  );
  const repeated = await runSqliteMigrations(database, { now: fixedNow });
  assert.deepEqual(repeated.applied, []);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 5);
});

test("caller-owned file database remains usable and temporary artifacts stay outside the repository", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "smartrecord-app-settings-repository-"));
  const databasePath = path.join(directory, "repository.sqlite");
  const database = await openSqliteDatabase(databasePath);
  t.after(async () => {
    closeSqliteDatabase(database);
    await rm(directory, { recursive: true, force: true });
  });
  await runSqliteMigrations(database, { maximumVersion: 1, now: fixedNow });
  const repository = createAppSettingsRepository(database, { now: fixedNow });
  repository.replacePrePackGuideImage(validInput());
  expectCode(
    () => repository.replacePrePackGuideImage(validInput()),
    "APP_SETTINGS_CONFLICT"
  );
  assert.equal(database.prepare("SELECT 1 AS value").get().value, 1);
  assert.equal(databasePath.startsWith(path.resolve(tmpdir())), true);
});
