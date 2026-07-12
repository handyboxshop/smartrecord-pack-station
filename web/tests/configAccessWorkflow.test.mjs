import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));

test("login boot requests only public config before session restoration", async () => {
  const app = await fs.readFile(path.join(webDir, "public", "assets", "app.js"), "utf8");
  const boot = functionBody(app, "async function boot()", "function bindEvents()");

  assert.match(boot, /api\("\/api\/config\/public"\)/);
  assert.doesNotMatch(boot, /api\("\/api\/config"\)/);
  assert.match(boot, /bindEvents\(\);[\s\S]*await restoreSession\(\);/);
});

test("login and restored sessions load authenticated config only after authentication succeeds", async () => {
  const app = await fs.readFile(path.join(webDir, "public", "assets", "app.js"), "utf8");
  const restore = functionBody(app, "async function restoreSession()", "async function login(event)");
  const login = functionBody(app, "async function login(event)", "async function logout()");
  const authenticatedLoader = functionBody(app, "async function loadAuthenticatedConfig()", "function initializeAuthenticatedConfig()");

  assert.match(restore, /api\("\/api\/auth\/me"\)[\s\S]*state\.currentUser = result\.data\.user;[\s\S]*loadAuthenticatedConfig\(\)/);
  assert.match(login, /api\("\/api\/auth\/login"[\s\S]*state\.authToken = result\.data\.token;[\s\S]*loadAuthenticatedConfig\(\)/);
  assert.match(authenticatedLoader, /api\("\/api\/config"\)/);
  assert.match(app, /state\.config = null;[\s\S]*showLogin\("ออกจากระบบแล้ว"\)/);
});

test("permission-specific config initialization tolerates omitted sections", async () => {
  const app = await fs.readFile(path.join(webDir, "public", "assets", "app.js"), "utf8");

  assert.match(app, /state\.config\?\.station\?\.defaultStationId \|\| "-"/);
  assert.match(app, /if \(can\("settings:manage"\)\)[\s\S]*loadDeviceSettings\(\)/);
  assert.match(app, /if \(can\("integrations:manage"\)\) renderConnectCards\(\)/);
  assert.match(app, /state\.config\?\.upload\?\.simulationSteps \|\| \[\]/);
  assert.match(app, /state\.config\?\.devices\?\.camera\?\.options \|\| \[\]/);
});

function functionBody(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing ${start}`);
  assert.ok(endIndex > startIndex, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}
