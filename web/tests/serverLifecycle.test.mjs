import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import util from "node:util";
import { startServerLifecycle } from "../server/serverLifecycle.mjs";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  runSqliteForeignKeyCheck,
  runSqliteQuickCheck
} from "../src/storage/sqliteDatabase.mjs";
import { readSqliteSchemaVersion, runSqliteMigrations } from "../src/storage/migrate.mjs";

const sensitiveMarker = "ATTACKER_SECRET_SQL_PATH_CUSTOMER_94731";

test("importing the lifecycle module has no process or server side effects", async () => {
  const beforeSignals = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM")
  };
  const server = http.createServer();

  const imported = await import(`../server/serverLifecycle.mjs?side-effect-check=${Date.now()}`);

  assert.equal(typeof imported.startServerLifecycle, "function");
  assert.equal(server.listening, false);
  assert.deepEqual({
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM")
  }, beforeSignals);
});

test("rejects unknown options and invalid server values before opening or listening", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  let opens = 0;
  const dependencies = fakeDependencies({ openDatabase: () => { opens += 1; return {}; } });

  await expectCode(startServerLifecycle({
    ...validOptions(http.createServer(), temporary.databasePath, dependencies),
    unexpected: true
  }), "SERVER_LIFECYCLE_OPTIONS_INVALID");
  await expectCode(startServerLifecycle({
    ...validOptions(http.createServer(), temporary.databasePath, dependencies),
    server: {}
  }), "SERVER_LIFECYCLE_OPTIONS_INVALID");
  assert.equal(opens, 0);
});

test("rejects blank, relative, NUL, directory, and missing-parent database paths safely", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  for (const databasePath of [undefined, "", "   ", "relative.sqlite", `bad\0${sensitiveMarker}`]) {
    const server = http.createServer();
    await expectCode(startServerLifecycle({
      ...validOptions(server, temporary.databasePath),
      databasePath
    }), "SERVER_SQLITE_PATH_INVALID");
    assert.equal(server.listening, false);
  }

  await expectCode(startServerLifecycle(
    validOptions(http.createServer(), temporary.directory)
  ), "SERVER_SQLITE_PATH_INVALID");

  const missingParentPath = path.join(temporary.directory, "missing", "database.sqlite");
  const missingParentServer = http.createServer();
  await expectCode(startServerLifecycle(
    validOptions(missingParentServer, missingParentPath)
  ), "SERVER_SQLITE_OPEN_FAILED");
  assert.equal(missingParentServer.listening, false);
  await assert.rejects(fs.access(path.dirname(missingParentPath)), { code: "ENOENT" });
});

test("rejects invalid host, port, flush, timeout, and dependency contracts", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  const invalidOverrides = [
    { host: "" },
    { host: "127.0.0.1\nsecret" },
    { port: -1 },
    { port: 65536 },
    { port: 1.5 },
    { port: "0" },
    { flushRuntimeState: null },
    { shutdownTimeoutMs: 0 },
    { shutdownTimeoutMs: Number.MAX_SAFE_INTEGER + 1 },
    { dependencies: null },
    { dependencies: { unknown: () => {} } },
    { dependencies: { openDatabase: true } }
  ];

  for (const override of invalidOverrides) {
    const server = http.createServer();
    await expectCode(startServerLifecycle({
      ...validOptions(server, temporary.databasePath),
      ...override
    }), "SERVER_LIFECYCLE_OPTIONS_INVALID");
    assert.equal(server.listening, false);
  }
});

test("real startup migrates through version 4, validates integrity, and returns only the approved API", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, source: "json-runtime" }));
  });
  const controller = await startServerLifecycle(validOptions(server, temporary.databasePath));
  t.after(() => controller.close());

  assert.deepEqual(Object.keys(controller).sort(), [
    "address", "close", "migrationsApplied", "schemaVersion", "server"
  ]);
  assert.equal(controller.server, server);
  assert.deepEqual(Object.keys(controller.address).sort(), ["address", "family", "port"]);
  assert.equal(typeof controller.address.address, "string");
  assert.equal(typeof controller.address.family, "string");
  assert.equal(Number.isInteger(controller.address.port), true);
  assert.equal(controller.address.port > 0, true);
  assert.equal(controller.schemaVersion, 4);
  assert.equal(Number.isSafeInteger(controller.migrationsApplied), true);
  assert.equal(controller.migrationsApplied >= 0, true);
  assert.equal("database" in controller, false);
  assert.equal("database" in server, false);

  const inspector = await openSqliteDatabase(temporary.databasePath);
  try {
    assert.equal(readSqliteSchemaVersion(inspector), 4);
    assert.equal(runSqliteQuickCheck(inspector).ok, true);
    assert.equal(runSqliteForeignKeyCheck(inspector).ok, true);
    assert.equal(inspector.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 4);
  } finally {
    closeSqliteDatabase(inspector);
  }

  const response = await requestJson(controller.address.port, "/runtime-check");
  assert.deepEqual(response, { ok: true, source: "json-runtime" });
});

test("startup executes SQLite readiness before listen and preserves caller inputs", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  const events = [];
  const database = { identity: "private" };
  const dependencies = Object.freeze(fakeDependencies({
    openDatabase: async (databasePath, options) => {
      events.push("open");
      assert.equal(databasePath, temporary.databasePath);
      assert.deepEqual(options, { createParentDirectory: false });
      return database;
    },
    runMigrations: async (received, options) => {
      events.push("migrate");
      assert.equal(received, database);
      assert.deepEqual(options, { maximumVersion: 4 });
      return { currentVersion: 4, applied: [{ version: 4 }] };
    },
    runQuickCheck: async () => { events.push("quick"); return { ok: true }; },
    runForeignKeyCheck: async () => { events.push("foreign-key"); return { ok: true }; },
    closeDatabase: async () => { events.push("sqlite-close"); }
  }));
  const server = http.createServer();
  const originalListen = server.listen;
  server.listen = function (...args) {
    events.push("listen");
    return originalListen.apply(this, args);
  };
  const options = Object.freeze(validOptions(server, temporary.databasePath, dependencies));
  const optionKeys = Object.keys(options);

  const controller = await startServerLifecycle(options);
  assert.deepEqual(events, ["open", "migrate", "quick", "foreign-key", "listen"]);
  assert.deepEqual(Object.keys(options), optionKeys);
  assert.equal(controller.server, server);
  assert.equal("identity" in server, false);
  await controller.close();
  assert.equal(events.at(-1), "sqlite-close");
});

test("multiple real lifecycle instances remain isolated", async (t) => {
  const firstTemporary = await temporaryDatabasePath(t, "smartrecord-lifecycle-first-");
  const secondTemporary = await temporaryDatabasePath(t, "smartrecord-lifecycle-second-");
  const first = await startServerLifecycle(validOptions(http.createServer(), firstTemporary.databasePath));
  const second = await startServerLifecycle(validOptions(http.createServer(), secondTemporary.databasePath));

  assert.notEqual(first.address.port, second.address.port);
  assert.notEqual(first.server, second.server);
  await Promise.all([first.close(), second.close()]);
  await fs.access(firstTemporary.databasePath);
  await fs.access(secondTemporary.databasePath);
});

test("open failure never starts the listener", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  const server = http.createServer();
  let listens = 0;
  server.listen = () => { listens += 1; return server; };
  await expectCode(startServerLifecycle(validOptions(server, temporary.databasePath, fakeDependencies({
    openDatabase: async () => { throw new Error(sensitiveMarker); }
  }))), "SERVER_SQLITE_OPEN_FAILED");
  assert.equal(listens, 0);
  assert.equal(server.listening, false);
});

test("real checksum and unsupported-schema failures rollback before listen", async (t) => {
  for (const corrupt of [
    (database) => database.prepare("UPDATE schema_migrations SET checksum_sha256 = ? WHERE version = 1").run("0".repeat(64)),
    (database) => database.exec("PRAGMA user_version = 5")
  ]) {
    const temporary = await temporaryDatabasePath(t, "smartrecord-lifecycle-migration-failure-");
    const database = await openSqliteDatabase(temporary.databasePath);
    await runSqliteMigrations(database, { maximumVersion: 4 });
    corrupt(database);
    closeSqliteDatabase(database);

    const server = http.createServer();
    await expectCode(startServerLifecycle(validOptions(server, temporary.databasePath)), "SERVER_SQLITE_MIGRATION_FAILED");
    assert.equal(server.listening, false);

    const reopened = await openSqliteDatabase(temporary.databasePath);
    closeSqliteDatabase(reopened);
  }
});

test("migration, quick-check, and foreign-key failures close SQLite exactly once", async (t) => {
  const stages = [
    {
      code: "SERVER_SQLITE_MIGRATION_FAILED",
      override: { runMigrations: async () => { throw new Error(sensitiveMarker); } }
    },
    {
      code: "SERVER_SQLITE_INTEGRITY_FAILED",
      override: { runQuickCheck: async () => ({ ok: false, messages: [sensitiveMarker] }) }
    },
    {
      code: "SERVER_SQLITE_INTEGRITY_FAILED",
      override: { runForeignKeyCheck: async () => { throw new Error(sensitiveMarker); } }
    }
  ];

  for (const stage of stages) {
    const temporary = await temporaryDatabasePath(t, "smartrecord-lifecycle-stage-failure-");
    const server = http.createServer();
    let closes = 0;
    const dependencies = fakeDependencies({
      ...stage.override,
      closeDatabase: async () => { closes += 1; }
    });
    await expectCode(startServerLifecycle(validOptions(server, temporary.databasePath, dependencies)), stage.code);
    assert.equal(closes, 1);
    assert.equal(server.listening, false);
  }
});

test("listen failure closes SQLite once and never falls back to a JSON-only listener", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  const occupied = http.createServer();
  await listen(occupied);
  t.after(() => closeHttpServer(occupied));
  const occupiedAddress = occupied.address();
  assert.equal(typeof occupiedAddress, "object");

  let closes = 0;
  const server = http.createServer();
  const options = validOptions(server, temporary.databasePath, fakeDependencies({
    closeDatabase: async () => { closes += 1; }
  }));
  options.port = occupiedAddress.port;
  await expectCode(startServerLifecycle(options), "SERVER_LISTEN_FAILED");
  assert.equal(closes, 1);
  assert.equal(server.listening, false);
});

test("repeated, concurrent, and already-listening startup claims are rejected", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  let releaseOpen;
  let notifyOpen;
  const openStarted = new Promise((resolve) => { notifyOpen = resolve; });
  const openBlocked = new Promise((resolve) => { releaseOpen = resolve; });
  const server = http.createServer();
  const dependencies = fakeDependencies({
    openDatabase: async () => {
      notifyOpen();
      await openBlocked;
      return {};
    }
  });
  const firstStart = startServerLifecycle(validOptions(server, temporary.databasePath, dependencies));
  await openStarted;
  await expectCode(
    startServerLifecycle(validOptions(server, temporary.databasePath, dependencies)),
    "SERVER_LIFECYCLE_ALREADY_STARTED"
  );
  releaseOpen();
  const controller = await firstStart;
  await expectCode(
    startServerLifecycle(validOptions(server, temporary.databasePath, dependencies)),
    "SERVER_LIFECYCLE_ALREADY_STARTED"
  );
  await controller.close();

  const externalServer = http.createServer();
  await listen(externalServer);
  t.after(() => closeHttpServer(externalServer));
  await expectCode(
    startServerLifecycle(validOptions(externalServer, temporary.databasePath, dependencies)),
    "SERVER_LIFECYCLE_ALREADY_STARTED"
  );
});

test("close returns one exact Promise and flushes once before closing SQLite", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  const events = [];
  const server = http.createServer();
  const controller = await startServerLifecycle({
    ...validOptions(server, temporary.databasePath, fakeDependencies({
      closeDatabase: async () => { events.push("sqlite-close"); }
    })),
    flushRuntimeState: async () => { events.push("json-flush"); }
  });

  const firstClose = controller.close();
  const secondClose = controller.close("SIGTERM");
  assert.equal(firstClose, secondClose);
  assert.equal(await firstClose, undefined);
  assert.deepEqual(events, ["json-flush", "sqlite-close"]);
  assert.equal(controller.close(), firstClose);
});

test("shutdown stops accepting connections and waits for in-flight work before cleanup", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  let releaseRequest;
  let notifyRequest;
  const requestStarted = new Promise((resolve) => { notifyRequest = resolve; });
  const requestBlocked = new Promise((resolve) => { releaseRequest = resolve; });
  const events = [];
  const server = http.createServer(async (_request, response) => {
    events.push("request-start");
    notifyRequest();
    await requestBlocked;
    response.end("finished");
    events.push("request-finish");
  });
  const controller = await startServerLifecycle({
    ...validOptions(server, temporary.databasePath, fakeDependencies({
      closeDatabase: async () => { events.push("sqlite-close"); }
    })),
    flushRuntimeState: async () => { events.push("json-flush"); },
    shutdownTimeoutMs: 1000
  });

  const inFlight = requestText(controller.address.port);
  await requestStarted;
  const closing = controller.close();
  const rejectedNewRequest = assert.rejects(requestText(controller.address.port));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["request-start"]);
  releaseRequest();
  assert.equal(await inFlight, "finished");
  await Promise.all([closing, rejectedNewRequest]);
  assert.deepEqual(events, ["request-start", "request-finish", "json-flush", "sqlite-close"]);
});

test("drain timeout terminates connections, then continues JSON and SQLite cleanup", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  let notifyRequest;
  const requestStarted = new Promise((resolve) => { notifyRequest = resolve; });
  const events = [];
  const server = http.createServer(() => {
    events.push("request-start");
    notifyRequest();
  });
  const controller = await startServerLifecycle({
    ...validOptions(server, temporary.databasePath, fakeDependencies({
      closeDatabase: async () => { events.push("sqlite-close"); }
    })),
    flushRuntimeState: async () => { events.push("json-flush"); },
    shutdownTimeoutMs: 30
  });
  const inFlight = requestText(controller.address.port).catch((error) => error);
  await requestStarted;

  await expectCode(controller.close(), "SERVER_SHUTDOWN_TIMEOUT");
  assert.equal((await inFlight) instanceof Error, true);
  assert.deepEqual(events, ["request-start", "json-flush", "sqlite-close"]);
  assert.equal(server.listening, false);
});

test("shutdown error precedence is deterministic and later cleanup is always attempted", async (t) => {
  const scenarios = [
    {
      expected: "SERVER_SQLITE_CLOSE_FAILED",
      flush: async () => {},
      close: async () => { throw new Error(sensitiveMarker); }
    },
    {
      expected: "SERVER_SHUTDOWN_FAILED",
      flush: async () => { throw new Error(sensitiveMarker); },
      close: async (events) => { events.push("sqlite-close"); }
    },
    {
      expected: "SERVER_SHUTDOWN_FAILED",
      flush: async () => { throw new Error(sensitiveMarker); },
      close: async () => { throw new Error(sensitiveMarker); }
    }
  ];

  for (const scenario of scenarios) {
    const temporary = await temporaryDatabasePath(t, "smartrecord-lifecycle-shutdown-failure-");
    const events = [];
    const controller = await startServerLifecycle({
      ...validOptions(http.createServer(), temporary.databasePath, fakeDependencies({
        closeDatabase: () => scenario.close(events)
      })),
      flushRuntimeState: scenario.flush
    });
    await expectCode(controller.close(), scenario.expected);
    if (scenario.expected === "SERVER_SHUTDOWN_FAILED" && events.length) {
      assert.deepEqual(events, ["sqlite-close"]);
    }
  }
});

test("HTTP close failure returns the generic shutdown code and still runs later cleanup", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  const events = [];
  const server = http.createServer();
  const controller = await startServerLifecycle({
    ...validOptions(server, temporary.databasePath, fakeDependencies({
      closeDatabase: async () => { events.push("sqlite-close"); }
    })),
    flushRuntimeState: async () => { events.push("json-flush"); }
  });
  const originalClose = server.close.bind(server);
  server.close = (callback) => originalClose(() => callback(new Error(sensitiveMarker)));

  await expectCode(controller.close(), "SERVER_SHUTDOWN_FAILED");
  assert.deepEqual(events, ["json-flush", "sqlite-close"]);
});

test("invalid shutdown reasons are bounded, memoized, and do not skip cleanup", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  let flushes = 0;
  let closes = 0;
  const controller = await startServerLifecycle({
    ...validOptions(http.createServer(), temporary.databasePath, fakeDependencies({
      closeDatabase: async () => { closes += 1; }
    })),
    flushRuntimeState: async () => { flushes += 1; }
  });
  const first = controller.close(`${sensitiveMarker}${"x".repeat(200)}`);
  const second = controller.close("SIGTERM");
  assert.equal(first, second);
  await expectCode(first, "SERVER_LIFECYCLE_OPTIONS_INVALID");
  assert.equal(flushes, 1);
  assert.equal(closes, 1);
});

test("lifecycle-owned listeners are removed and real SQLite artifacts close cleanly", async (t) => {
  const temporary = await temporaryDatabasePath(t);
  const server = http.createServer();
  const listenerCounts = {
    error: server.listenerCount("error"),
    listening: server.listenerCount("listening")
  };
  const controller = await startServerLifecycle(validOptions(server, temporary.databasePath));
  assert.equal(server.listenerCount("error"), listenerCounts.error);
  assert.equal(server.listenerCount("listening"), listenerCounts.listening);

  await controller.close();
  assert.equal(server.listenerCount("error"), listenerCounts.error);
  assert.equal(server.listenerCount("listening"), listenerCounts.listening);
  const artifacts = (await fs.readdir(temporary.directory)).filter((name) => /-(?:wal|shm|journal)$/u.test(name));
  assert.deepEqual(artifacts, []);
  await fs.rm(temporary.directory, { recursive: true });
  temporary.cleaned = true;
  await assert.rejects(fs.access(temporary.directory), { code: "ENOENT" });
});

test("every public lifecycle error surface is sanitized", async (t) => {
  const errors = [];
  const capture = async (promise) => {
    try {
      await promise;
      assert.fail("expected lifecycle error");
    } catch (error) {
      errors.push(error);
      return error;
    }
  };

  const invalidTemporary = await temporaryDatabasePath(t, `smartrecord-${sensitiveMarker}-`);
  await capture(startServerLifecycle({ marker: sensitiveMarker }));
  await capture(startServerLifecycle(validOptions(http.createServer(), `relative-${sensitiveMarker}.sqlite`)));
  await capture(startServerLifecycle(validOptions(http.createServer(), invalidTemporary.databasePath, fakeDependencies({
    openDatabase: async () => { throw new Error(sensitiveMarker); }
  }))));
  await capture(startServerLifecycle(validOptions(http.createServer(), invalidTemporary.databasePath, fakeDependencies({
    runMigrations: async () => { throw new Error(sensitiveMarker); }
  }))));
  await capture(startServerLifecycle(validOptions(http.createServer(), invalidTemporary.databasePath, fakeDependencies({
    runQuickCheck: async () => { throw new Error(sensitiveMarker); }
  }))));

  const claimServer = http.createServer();
  const claimed = await startServerLifecycle(validOptions(claimServer, invalidTemporary.databasePath, fakeDependencies()));
  await capture(startServerLifecycle(validOptions(claimServer, invalidTemporary.databasePath, fakeDependencies())));
  await claimed.close();

  const occupied = http.createServer();
  await listen(occupied);
  const occupiedAddress = occupied.address();
  const conflictOptions = validOptions(http.createServer(), invalidTemporary.databasePath, fakeDependencies());
  conflictOptions.port = occupiedAddress.port;
  await capture(startServerLifecycle(conflictOptions));
  await closeHttpServer(occupied);

  const sqliteCloseController = await startServerLifecycle(validOptions(
    http.createServer(),
    invalidTemporary.databasePath,
    fakeDependencies({ closeDatabase: async () => { throw new Error(sensitiveMarker); } })
  ));
  await capture(sqliteCloseController.close());

  const flushController = await startServerLifecycle({
    ...validOptions(http.createServer(), invalidTemporary.databasePath, fakeDependencies()),
    flushRuntimeState: async () => { throw new Error(sensitiveMarker); }
  });
  await capture(flushController.close());

  let notifyHanging;
  const hanging = new Promise((resolve) => { notifyHanging = resolve; });
  const timeoutServer = http.createServer(() => notifyHanging());
  const timeoutController = await startServerLifecycle({
    ...validOptions(timeoutServer, invalidTemporary.databasePath, fakeDependencies()),
    shutdownTimeoutMs: 20
  });
  const hangingRequest = requestText(timeoutController.address.port).catch(() => undefined);
  await hanging;
  await capture(timeoutController.close());
  await hangingRequest;

  const expectedCodes = new Set([
    "SERVER_LIFECYCLE_OPTIONS_INVALID",
    "SERVER_SQLITE_PATH_INVALID",
    "SERVER_SQLITE_OPEN_FAILED",
    "SERVER_SQLITE_MIGRATION_FAILED",
    "SERVER_SQLITE_INTEGRITY_FAILED",
    "SERVER_LIFECYCLE_ALREADY_STARTED",
    "SERVER_LISTEN_FAILED",
    "SERVER_SQLITE_CLOSE_FAILED",
    "SERVER_SHUTDOWN_FAILED",
    "SERVER_SHUTDOWN_TIMEOUT"
  ]);
  assert.deepEqual(new Set(errors.map((error) => error.code)), expectedCodes);

  for (const error of errors) {
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error), []);
    assert.equal(JSON.stringify(error), "{}");
    for (const surface of [error.message, error.stack, util.inspect(error)]) {
      assert.doesNotMatch(surface, new RegExp(sensitiveMarker, "u"));
      assert.doesNotMatch(surface, /serverLifecycle\.mjs|\/Users\/|node_modules|\.sqlite/u);
    }
  }
});

function validOptions(server, databasePath, dependencies) {
  return {
    server,
    databasePath,
    host: "127.0.0.1",
    port: 0,
    flushRuntimeState: async () => {},
    shutdownTimeoutMs: 500,
    ...(dependencies ? { dependencies } : {})
  };
}

function fakeDependencies(overrides = {}) {
  return {
    openDatabase: async () => ({}),
    runMigrations: async () => ({ currentVersion: 4, applied: [] }),
    runQuickCheck: async () => ({ ok: true }),
    runForeignKeyCheck: async () => ({ ok: true }),
    closeDatabase: async () => {},
    ...overrides
  };
}

async function temporaryDatabasePath(t, prefix = "smartrecord-server-lifecycle-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const resource = { directory, databasePath: path.join(directory, "lifecycle.sqlite"), cleaned: false };
  t.after(async () => {
    if (!resource.cleaned) await fs.rm(directory, { recursive: true, force: true });
  });
  return resource;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function requestText(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/",
      agent: false,
      headers: { Connection: "close" }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
  });
}

async function requestJson(port, pathname) {
  return JSON.parse(await requestTextPath(port, pathname));
}

function requestTextPath(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      agent: false,
      headers: { Connection: "close" }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
  });
}
