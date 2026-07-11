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

async function createPrinterTestRuntime() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smartrecord-printer-test-"));
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.auth.users = [
    testUser("admin@test.local", "admin-password", "admin"),
    testUser("packer@test.local", "pack-password", "packer")
  ];
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
      SMARTRECORD_APP_SETTINGS_PATH: path.join(dir, "app-settings.json")
    }
  };
}

function testUser(email, password, roleId) {
  const passwordSalt = `test-salt-${roleId}`;
  return {
    id: `USR-${roleId.toUpperCase()}`,
    email,
    name: roleId,
    roleId,
    employeeId: null,
    active: true,
    passwordSalt,
    passwordHash: crypto.pbkdf2Sync(password, passwordSalt, 120000, 32, "sha256").toString("hex")
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
