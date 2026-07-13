import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));

test("Start Pack moves pre-pack guidance into the user manual dialog", async () => {
  const [html, app] = await Promise.all([
    fs.readFile(path.join(webDir, "public", "index.html"), "utf8"),
    fs.readFile(path.join(webDir, "public", "assets", "app.js"), "utf8")
  ]);

  assert.doesNotMatch(html, /<aside class="prePackGuide"/);
  assert.doesNotMatch(html, /id="prePackGuideImg"/);
  assert.match(html, /id="openUserManualBtn">คู่มือการใช้งาน/);
  assert.match(html, /<dialog id="userManualDialog">/);
  assert.ok(html.includes("<h3>ก่อนเริ่มแพคออเดอร์</h3>"));
  assert.ok(html.includes("<p>ใบปะหน้าต้องอยู่ในเฟรม</p>"));
  assert.match(html, /id="userManualPrePackGuideImg"/);
  for (const item of [
    "มีใบปะหน้าจากระบบแล้ว",
    "วางใบปะหน้าให้กล้องเห็น",
    "กล่องและสินค้าอยู่ในพื้นที่แพค"
  ]) {
    assert.match(html, new RegExp(item));
  }
  const manualMarkup = html.slice(html.indexOf('<dialog id="userManualDialog">'));
  assert.ok(
    manualMarkup.indexOf("<h3>ก่อนเริ่มแพคออเดอร์</h3>") < manualMarkup.indexOf("<h3>เริ่มแพคออเดอร์</h3>"),
    "the pre-pack section must precede Start Pack instructions in the manual"
  );
  assert.match(app, /openUserManualBtn\?\.addEventListener\("click", \(\) => el\.userManualDialog\?\.showModal\(\)\)/);
  assert.match(app, /userManualPrePackGuideImg/);
  assert.match(app, /systemAssets\?\.prePackGuideImage\?\.url \|\| "\/assets\/prepack-label-required\.png"/);
});
