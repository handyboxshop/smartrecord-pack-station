import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const configPath = path.join(cwd, "config", "app-config.example.json");
let portSeed = 43170 + (process.pid % 200);

test("GET /api/health returns stable JSON payload", async (t) => {
  const port = nextPort();
  const server = await startServer(port);
  t.after(() => stopServer(server));

  const response = await requestJson(port, "/api/health");

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.body.ok, true);
  assert.equal(response.body.service, "smartrecord-pack-station");
  assert.equal(response.body.port, port);
  assert.match(response.body.time, /^\d{4}-\d{2}-\d{2}T/);
});

test("unknown API route returns JSON NOT_FOUND instead of HTML", async (t) => {
  const port = nextPort();
  const server = await startServer(port);
  t.after(() => stopServer(server));

  const response = await requestJson(port, "/api/does-not-exist");

  assert.equal(response.status, 404);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "NOT_FOUND");
  assert.equal(response.body.error, "NOT_FOUND");
});

test("auth-required API returns JSON contract for expired or missing session", async (t) => {
  const port = nextPort();
  const server = await startServer(port);
  t.after(() => stopServer(server));

  const response = await requestJson(port, "/api/auth/me");

  assert.equal(response.status, 401);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "AUTH_REQUIRED");
  assert.equal(response.body.error, "AUTH_REQUIRED");
  assert.equal(response.body.message, "Please login again");
});

test("public config exposes only minimal login-safe app fields", async (t) => {
  const port = nextPort();
  const server = await startServer(port);
  t.after(() => stopServer(server));

  const response = await requestJson(port, "/api/config/public");

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.data, {
    app: {
      name: "SmartRecord Pack Station",
      defaultLocale: "th-TH",
      timezone: "Asia/Bangkok"
    }
  });
  for (const forbiddenKey of [
    "branding", "employees", "station", "systemAssets", "auth", "devices", "upload",
    "reports", "integrations", "ocr", "labelPrint", "packFlow"
  ]) {
    assert.equal(forbiddenKey in response.body.data, false, `public config must omit ${forbiddenKey}`);
  }
});

test("authenticated config rejects missing, invalid, and expired sessions", async (t) => {
  const port = nextPort();
  const runtime = await createPrinterTestRuntime("", "", { sessionTtlHours: -1 });
  const server = await startServer(port, runtime.env);
  t.after(async () => {
    await stopServer(server);
    await fs.rm(runtime.dir, { recursive: true, force: true });
  });

  const missing = await requestJson(port, "/api/config");
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, "AUTH_REQUIRED");

  const invalid = await requestJson(port, "/api/config", {
    headers: { Authorization: "Bearer invalid-session-token" }
  });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.code, "AUTH_REQUIRED");

  const expiredSession = await login(port, "packer@test.local", "pack-password");
  const expired = await requestJson(port, "/api/config", {
    headers: { Authorization: `Bearer ${expiredSession.token}` }
  });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, "SESSION_EXPIRED");
});

test("authenticated config is filtered by each user's permissions without a global pack gate", async (t) => {
  const port = nextPort();
  const runtime = await createPrinterTestRuntime();
  const server = await startServer(port, runtime.env);
  t.after(async () => {
    await stopServer(server);
    await fs.rm(runtime.dir, { recursive: true, force: true });
  });

  const packer = await login(port, "packer@test.local", "pack-password");
  const packerConfig = await authenticatedConfig(port, packer.token);
  assert.ok(packerConfig.station);
  assert.ok(packerConfig.employees);
  assert.ok(packerConfig.packFlow);
  assert.ok(packerConfig.systemAssets?.prePackGuideImage?.url);
  assert.deepEqual(Object.keys(packerConfig.upload).sort(), [
    "defaultStorageTargetId", "simulationSteps", "storageTargets"
  ]);
  assert.ok(packerConfig.upload.simulationSteps.length > 0);
  assert.ok(packerConfig.upload.defaultStorageTargetId);
  assert.ok(packerConfig.upload.storageTargets.length > 0);
  for (const target of packerConfig.upload.storageTargets) {
    assert.deepEqual(Object.keys(target).sort(), ["id", "isDefault", "label", "provider"]);
  }
  assert.equal(packerConfig.reports, undefined);
  assert.equal(packerConfig.devices, undefined);
  assert.equal(packerConfig.ocr, undefined);
  for (const forbiddenField of [
    "host", "localPath", "customPath", "mountStatus", "mountedRequired", "simulated",
    "externalUrl", "diagnostics"
  ]) {
    assert.equal(JSON.stringify(packerConfig.upload).includes(`\"${forbiddenField}\"`), false);
  }

  const auditor = await login(port, "auditor@test.local", "audit-password");
  const auditorConfig = await authenticatedConfig(port, auditor.token);
  assert.ok(auditorConfig.reports);
  assert.equal(auditorConfig.station, undefined);
  assert.equal(auditorConfig.employees, undefined);
  assert.equal(auditorConfig.packFlow, undefined);
  assert.equal(auditorConfig.devices, undefined);
  assert.equal(auditorConfig.upload, undefined);
  assert.equal(auditorConfig.integrations, undefined);
  assert.equal(auditorConfig.auth.roles, undefined);

  const reportOnly = await login(port, "reports@test.local", "reports-password");
  const reportOnlyConfig = await authenticatedConfig(port, reportOnly.token);
  assert.ok(reportOnlyConfig.reports);
  for (const forbiddenSection of [
    "station", "employees", "packFlow", "systemAssets", "devices", "upload", "ocr",
    "integrations", "labelPrint"
  ]) {
    assert.equal(reportOnlyConfig[forbiddenSection], undefined);
  }
  assert.equal(reportOnlyConfig.auth.roles, undefined);
  assert.equal(reportOnlyConfig.auth.passwordPolicy, undefined);

  const settingsUser = await login(port, "settings@test.local", "settings-password");
  const settingsConfig = await authenticatedConfig(port, settingsUser.token);
  assert.ok(settingsConfig.devices);
  assert.ok(settingsConfig.upload);
  assert.ok(settingsConfig.ocr);
  assert.equal(settingsConfig.reports, undefined);
  assert.equal(settingsConfig.integrations, undefined);
  assert.equal(settingsConfig.auth.roles, undefined);

  const admin = await login(port, "admin@test.local", "admin-password");
  const adminConfig = await authenticatedConfig(port, admin.token);
  assert.ok(adminConfig.auth.roles);
  assert.deepEqual(adminConfig.auth.passwordPolicy, { minLength: 8 });

  const owner = await login(port, "owner@test.local", "owner-password");
  const ownerConfig = await authenticatedConfig(port, owner.token);
  assert.ok(ownerConfig.station);
  assert.ok(ownerConfig.reports);
  assert.ok(ownerConfig.devices);
  assert.ok(ownerConfig.integrations);
  assert.ok(ownerConfig.labelPrint);
  assert.ok(ownerConfig.auth.roles);
});

test("Packer pre-pack guide response is an exact allowlist and cannot leak metadata", async (t) => {
  const port = nextPort();
  const runtime = await createPrinterTestRuntime();
  const config = JSON.parse(await fs.readFile(path.join(runtime.dir, "app-config.json"), "utf8"));
  config.systemAssets.prePackGuideImage.syntheticFutureField = "future-field-must-not-leak";
  await fs.writeFile(path.join(runtime.dir, "app-config.json"), JSON.stringify(config));
  await fs.writeFile(path.join(runtime.dir, "app-settings.json"), JSON.stringify({
    systemAssets: {
      prePackGuideImage: {
        url: "/assets/prepack-guide-custom.webp?v=fixture",
        updatedAt: "2026-07-12T10:11:12.000Z",
        updatedBy: { name: "Recognizable Fixture Actor", email: "fixture.actor@example.test" },
        fileName: "prepack-guide-custom.webp",
        bytes: 12345,
        contentType: "image/webp",
        width: 1600,
        height: 900,
        syntheticFutureField: "future-runtime-field-must-not-leak"
      }
    }
  }));
  const server = await startServer(port, runtime.env);
  t.after(async () => {
    await stopServer(server);
    await fs.rm(runtime.dir, { recursive: true, force: true });
  });

  const packer = await login(port, "packer@test.local", "pack-password");
  const response = await requestJson(port, "/api/config", {
    headers: { Authorization: `Bearer ${packer.token}` }
  });
  const guide = response.body.data.systemAssets.prePackGuideImage;

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(guide).sort(), ["url"]);
  assert.deepEqual(guide, { url: "/assets/prepack-guide-custom.webp?v=fixture" });
  for (const forbiddenField of [
    "updatedAt", "updatedBy", "fileName", "bytes", "contentType", "width", "height",
    "acceptedImageTypes", "maxImageSizeMb", "defaultUrl", "syntheticFutureField"
  ]) {
    assert.equal(forbiddenField in guide, false, `Packer guide must omit ${forbiddenField}`);
  }
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /Recognizable Fixture Actor|fixture\.actor@example\.test/);
});

test("NAS/CUPS printer route requires settings:manage", async (t) => {
  const port = nextPort();
  const runtime = await createPrinterTestRuntime();
  const server = await startServer(port, runtime.env);
  t.after(async () => {
    await stopServer(server);
    await fs.rm(runtime.dir, { recursive: true, force: true });
  });

  const unauthenticated = await requestJson(port, "/api/devices/printers");
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.code, "AUTH_REQUIRED");

  const packer = await login(port, "packer@test.local", "pack-password");
  const forbidden = await requestJson(port, "/api/devices/printers", {
    headers: { Authorization: `Bearer ${packer.token}` }
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "FORBIDDEN");

  const admin = await login(port, "admin@test.local", "admin-password");
  const authorized = await requestJson(port, "/api/devices/printers", {
    headers: { Authorization: `Bearer ${admin.token}` }
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.ok, true);
  assert.deepEqual(authorized.body.data, {
    printers: [{
      id: "system:test-cups-printer",
      label: "Test CUPS Printer",
      systemName: "test-cups-printer",
      source: "system"
    }]
  });
});

test("OCR system diagnostics requires settings:manage, is sanitized, and does not write runtime data", async (t) => {
  for (const [fixture, expected] of [
    ["ready", { overallStatus: "ready", ocrCode: "OCR_READY" }],
    ["not-configured", { overallStatus: "degraded", ocrCode: "OCR_NOT_CONFIGURED" }],
    ["unavailable", { overallStatus: "unavailable", ocrCode: "OCR_RUNTIME_UNAVAILABLE" }],
    ["invalid-timeout", { overallStatus: "degraded", ocrCode: "OCR_READY", timeoutCode: "OCR_TIMEOUT_INVALID" }],
    ["unexpected", { overallStatus: "unavailable", ocrCode: "OCR_DIAGNOSTIC_FAILED" }]
  ]) {
    const port = nextPort();
    const runtime = await createPrinterTestRuntime("", fixture);
    const before = await runtimeFilesSnapshot(runtime.dir);
    const server = await startServer(port, runtime.env);
    try {
      const unauthenticated = await requestJson(port, "/api/devices/diagnostics");
      assert.equal(unauthenticated.status, 401);
      assert.equal(unauthenticated.body.code, "AUTH_REQUIRED");

      const packer = await login(port, "packer@test.local", "pack-password");
      const forbidden = await requestJson(port, "/api/devices/diagnostics", {
        headers: { Authorization: `Bearer ${packer.token}` }
      });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.body.code, "FORBIDDEN");

      const admin = await login(port, "admin@test.local", "admin-password");
      const response = await requestJson(port, "/api/devices/diagnostics", {
        headers: { Authorization: `Bearer ${admin.token}` }
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.data.overallStatus, expected.overallStatus);
      assert.equal(response.body.data.checks.ocr.code, expected.ocrCode);
      if (expected.timeoutCode) assert.equal(response.body.data.checks.ocrTimeout.code, expected.timeoutCode);
      const payload = JSON.stringify(response.body);
      assert.doesNotMatch(payload, /diagnostic secret|process\.cwd|node_modules|errno|stack|process\.env|private\//i);
      assert.match(response.body.data.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      assert.deepEqual(await runtimeFilesSnapshot(runtime.dir), before);
      await stopServer(server);
      await fs.rm(runtime.dir, { recursive: true, force: true });
    }
  }
});

test("OCR diagnostic fixtures are ignored outside NODE_ENV=test", async (t) => {
  const port = nextPort();
  const runtime = await createPrinterTestRuntime("", "ready", {
    mode: "production",
    ocrCommand: "smartrecord-test-ocr-command-not-installed"
  });
  const server = await startServer(port, runtime.env);
  t.after(async () => {
    await stopServer(server);
    await fs.rm(runtime.dir, { recursive: true, force: true });
  });

  const admin = await login(port, "admin@test.local", "admin-password");
  const response = await requestJson(port, "/api/devices/diagnostics", {
    headers: { Authorization: `Bearer ${admin.token}` }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.overallStatus, "unavailable");
  assert.equal(response.body.data.checks.ocr.code, "OCR_RUNTIME_UNAVAILABLE");
});

test("HTTP shipping-label import persists an AWB-only fallback order that can start packing", async (t) => {
  const runtime = await createPrinterTestRuntime();
  const ocrCommand = path.join(runtime.dir, "fake-ocr.sh");
  await fs.writeFile(ocrCommand, `#!/bin/sh
printf '%s\\n' 'TH42078XMSOF1F'
`);
  await fs.chmod(ocrCommand, 0o755);
  const config = JSON.parse(await fs.readFile(path.join(runtime.dir, "app-config.json"), "utf8"));
  config.ocr.command = ocrCommand;
  await fs.writeFile(path.join(runtime.dir, "app-config.json"), JSON.stringify(config));

  const port = nextPort();
  const server = await startServer(port, runtime.env);
  t.after(async () => {
    await stopServer(server);
    await fs.rm(runtime.dir, { recursive: true, force: true });
  });

  const admin = await login(port, "admin@test.local", "admin-password");
  const imported = await requestRaw(port, "/api/orders/label/import?fileName=awb-only.png", {
    method: "POST",
    headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "image/png" },
    body: Buffer.from("not-an-image-needed-by-fake-ocr")
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.ok, true);
  assert.equal(imported.body.data.importedCount, 1);
  assert.equal(imported.body.data.order.awb, "TH42078XMSOF1F");
  assert.equal(imported.body.data.order.orderNumber, "AWB-TH42078XMSOF1F");
  assert.equal(imported.body.data.order.reviewRequired, true);

  const persistedOrders = JSON.parse(await fs.readFile(path.join(runtime.dir, "orders.json"), "utf8"));
  assert.equal(persistedOrders.TH42078XMSOF1F.reviewRequired, true);
  assert.equal(persistedOrders.TH42078XMSOF1F.orderNumber, "AWB-TH42078XMSOF1F");

  const packer = await login(port, "packer@test.local", "pack-password");
  const started = await requestJson(port, "/api/pack/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${packer.token}`, "Content-Type": "application/json" },
    body: { awb: "TH42078XMSOF1F" }
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.ok, true);
});

test("storage verification enforces settings:manage and returns only safe status payloads", async (t) => {
  for (const [fixture, expected] of [
    ["success", { status: 200, code: undefined, storageStatus: "available" }],
    ["mount-unavailable", { status: 400, code: "STORAGE_MOUNT_UNAVAILABLE" }],
    ["not-writable", { status: 400, code: "STORAGE_NOT_WRITABLE" }],
    ["unexpected", { status: 400, code: "STORAGE_VERIFICATION_FAILED" }]
  ]) {
    const port = nextPort();
    const runtime = await createPrinterTestRuntime(fixture);
    const server = await startServer(port, runtime.env);
    const serializedFixturePath = runtime.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      const unauthenticated = await requestJson(port, "/api/devices/storage/test", {
        method: "POST",
        body: { storageTargetId: "local-machine" }
      });
      assert.equal(unauthenticated.status, 401);
      assert.equal(unauthenticated.body.code, "AUTH_REQUIRED");

      const packer = await login(port, "packer@test.local", "pack-password");
      const forbidden = await requestJson(port, "/api/devices/storage/test", {
        method: "POST",
        headers: { Authorization: `Bearer ${packer.token}` },
        body: { storageTargetId: "local-machine" }
      });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.body.code, "FORBIDDEN");

      const admin = await login(port, "admin@test.local", "admin-password");
      const response = await requestJson(port, "/api/devices/storage/test", {
        method: "POST",
        headers: { Authorization: `Bearer ${admin.token}` },
        body: { storageTargetId: "local-machine" }
      });
      assert.equal(response.status, expected.status);
      assert.equal(response.body.code, expected.code);
      if (expected.storageStatus) assert.equal(response.body.data.status, expected.storageStatus);
      const payload = JSON.stringify(response.body);
      assert.doesNotMatch(payload, new RegExp(serializedFixturePath));
      assert.doesNotMatch(payload, /storageRoot|actualWritePath|resolvedLocalPath|errno|stack|process\.cwd|node_modules/i);

      const authenticatedConfigResponse = await requestJson(port, "/api/config", {
        headers: { Authorization: `Bearer ${admin.token}` }
      });
      assert.equal(authenticatedConfigResponse.status, 200);
      assert.doesNotMatch(JSON.stringify(authenticatedConfigResponse.body.data.upload.storageTargets), /localPath|resolvedLocalPath|actualWritePath|storageRoot/i);
    } finally {
      await stopServer(server);
      await fs.rm(runtime.dir, { recursive: true, force: true });
    }
  }
});

test("starting a second server on the same port fails clearly", async (t) => {
  const port = nextPort();
  const primary = await startServer(port);
  t.after(() => stopServer(primary));

  const secondary = spawn(process.execPath, ["server/index.mjs"], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  secondary.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  secondary.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      secondary.kill("SIGKILL");
      reject(new Error("secondary server did not exit after port conflict"));
    }, 5000);
    secondary.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    secondary.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.equal(exitCode, 1);
  assert.match(output.join(""), /already in use|Port .* is already in use/i);
});

function nextPort() {
  portSeed += 1;
  return portSeed;
}

async function startServer(port, env = {}) {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  await waitForServerReady(port, child, output);
  return { child, output };
}

async function waitForServerReady(port, child, output) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early: ${output.join("")}`);
    }
    try {
      const response = await requestJson(port, "/api/health");
      if (response.status === 200) return;
    } catch {
      // retry until ready
    }
    await delay(100);
  }
  throw new Error(`server did not become ready: ${output.join("")}`);
}

function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return Promise.resolve();
  server.child.kill("SIGTERM");
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
      resolve();
    }, 2000);
    server.child.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function requestJson(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${pathname}`, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: JSON.parse(text)
          });
        } catch (error) {
          reject(new Error(`response is not JSON: ${error.message} :: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function requestRaw(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${pathname}`, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode || 0, headers: res.headers, body: JSON.parse(text) });
        } catch (error) {
          reject(new Error(`response is not JSON: ${error.message} :: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(port, email, password) {
  const response = await requestJson(port, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { email, password }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  return response.body.data;
}

async function authenticatedConfig(port, token) {
  const response = await requestJson(port, "/api/config", {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  return response.body.data;
}

async function createPrinterTestRuntime(storageFixture = "", ocrFixture = "", { mode = "test", ocrCommand = "", sessionTtlHours } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smartrecord-printer-test-"));
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.auth.users = [
    testUser("admin@test.local", "admin-password", "admin"),
    testUser("owner@test.local", "owner-password", "owner"),
    testUser("packer@test.local", "pack-password", "packer"),
    testUser("auditor@test.local", "audit-password", "auditor"),
    testUser("settings@test.local", "settings-password", "custom", [{ moduleId: "settings", canView: true, canEdit: true }]),
    testUser("reports@test.local", "reports-password", "custom", [{ moduleId: "reports", canView: true, canEdit: false }])
  ];
  if (sessionTtlHours !== undefined) config.auth.session.ttlHours = sessionTtlHours;
  if (ocrCommand) config.ocr.command = ocrCommand;
  const runtimeConfigPath = path.join(dir, "app-config.json");
  await fs.writeFile(runtimeConfigPath, JSON.stringify(config));
  await Promise.all([
    fs.writeFile(path.join(dir, "orders.json"), "{}"),
    fs.writeFile(path.join(dir, "sync-orders.json"), "[]"),
    fs.writeFile(path.join(dir, "pack-records.json"), "[]"),
    fs.writeFile(path.join(dir, "labels.json"), "[]")
  ]);
  return {
    dir,
    env: {
      SMARTRECORD_CONFIG_PATH: runtimeConfigPath,
      SMARTRECORD_USERS_PATH: path.join(dir, "missing-users.json"),
      SMARTRECORD_ORDERS_PATH: path.join(dir, "orders.json"),
      SMARTRECORD_SYNC_ORDERS_PATH: path.join(dir, "sync-orders.json"),
      SMARTRECORD_PACK_RECORDS_PATH: path.join(dir, "pack-records.json"),
      SMARTRECORD_LABELS_PATH: path.join(dir, "labels.json"),
      SMARTRECORD_APP_SETTINGS_PATH: path.join(dir, "app-settings.json"),
      NODE_ENV: mode,
      SMARTRECORD_TEST_PRINTER_DISCOVERY: "success",
      SMARTRECORD_TEST_STORAGE_VERIFICATION: storageFixture,
      SMARTRECORD_TEST_OCR_DIAGNOSTICS: ocrFixture
    }
  };
}

async function runtimeFilesSnapshot(dir) {
  const names = ["orders.json", "sync-orders.json", "pack-records.json", "labels.json", "app-settings.json"];
  return Promise.all(names.map(async (name) => {
    try {
      return [name, await fs.readFile(path.join(dir, name), "utf8")];
    } catch (error) {
      if (error.code === "ENOENT") return [name, null];
      throw error;
    }
  }));
}

function testUser(email, password, roleId, modulePermissions) {
  const passwordSalt = `test-salt-${roleId}`;
  return {
    id: `USR-${email.split("@")[0].toUpperCase()}`,
    email,
    name: roleId,
    roleId,
    modulePermissions,
    employeeId: null,
    active: true,
    passwordSalt,
    passwordHash: crypto.pbkdf2Sync(password, passwordSalt, 120000, 32, "sha256").toString("hex")
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
