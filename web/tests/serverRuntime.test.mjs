import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
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

async function startServer(port) {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd,
    env: { ...process.env, PORT: String(port) },
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

function requestJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
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
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
