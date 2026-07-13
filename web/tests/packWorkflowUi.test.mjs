import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));

test("incomplete AWB rescans show status without offering a force-close modal", async () => {
  const [html, app] = await Promise.all([
    fs.readFile(path.join(webDir, "public", "index.html"), "utf8"),
    fs.readFile(path.join(webDir, "public", "assets", "app.js"), "utf8")
  ]);

  assert.match(app, /result\.code === "AWB_RESCAN_BLOCKED"/);
  assert.match(app, /toast\(result\.message\)/);
  assert.doesNotMatch(app, /showForceCloseDialog|force:\s*true/);
  assert.doesNotMatch(app, /forceCloseDialog\.addEventListener/);
  assert.doesNotMatch(html, /forceCloseDialog|forceReason|confirmForceBtn/);
});

test("the Start Pack field is AWB-only and failed starts cannot begin capture", async () => {
  const [html, app] = await Promise.all([
    fs.readFile(path.join(webDir, "public", "index.html"), "utf8"),
    fs.readFile(path.join(webDir, "public", "assets", "app.js"), "utf8")
  ]);
  const startFormId = html.indexOf('id="startForm"');
  const startForm = html.slice(html.lastIndexOf("<form", startFormId), html.indexOf("</form>", startFormId));
  const startSession = app.slice(app.indexOf("async function startSession"), app.indexOf("async function scanCode"));

  assert.match(startForm, /เลข AWB เท่านั้น/);
  assert.match(startForm, /สแกนหรือกรอกเลข AWB/);
  assert.doesNotMatch(startForm, /Order ID/i);
  assert.ok(startSession.indexOf("if (!result.ok)") < startSession.indexOf("await startCamera()"));
  assert.match(startSession, /if \(!result\.ok\) \{[\s\S]*?toast\(result\.message\);[\s\S]*?return;/);
});
