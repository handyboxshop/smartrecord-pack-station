import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));

test("Device Settings presents Browser Print as the local-workstation workflow without fabricated printer status", async () => {
  const [html, app, css] = await Promise.all([
    fs.readFile(path.join(webDir, "public", "index.html"), "utf8"),
    fs.readFile(path.join(webDir, "public", "assets", "app.js"), "utf8"),
    fs.readFile(path.join(webDir, "public", "assets", "styles.css"), "utf8")
  ]);

  assert.match(html, /Browser Print \(แนะนำ\)/);
  assert.match(html, /ระบบปฏิบัติการ/);
  assert.match(html, /การตั้งค่านี้บันทึกเฉพาะเครื่องและ Browser ปัจจุบัน/);
  assert.match(html, /<option value="a4">A4<\/option>/);
  assert.match(html, /<option value="100x150">100x150 mm<\/option>/);
  assert.match(html, /ทดสอบพิมพ์ผ่าน Browser/);
  assert.match(html, /ค้นหาเครื่องพิมพ์บน NAS \/ CUPS/);
  assert.doesNotMatch(html, /ค้นหาเครื่องพิมพ์ในเครื่อง/);
  assert.match(app, /statusChip\(\{ label: "เครื่องพิมพ์ฉลาก: เลือกผ่าน Browser", state: "neutral" \}\)/);
  assert.match(app, /class="deviceChip \$\{escapeHtml\(state\)\}"/);
  assert.doesNotMatch(app, /เครื่องพิมพ์ฉลาก: เลือกผ่าน Browser", state: "disconnected"/);
  assert.doesNotMatch(app, /เครื่องพิมพ์ฉลาก: เลือกผ่าน Browser", state: "connected"/);
  assert.doesNotMatch(app, /isConnectedPrinter|detectedPrinters/);
  assert.match(css, /\.deviceChip\.neutral\s*\{/);
  assert.match(css, /\.deviceChip\.disconnected\s*\{[\s\S]*?\}\s*\.deviceChip\.neutral/s);
});

test("Device Settings separates browser-local choices from NAS/server verification without exposing server paths", async () => {
  const [html, app] = await Promise.all([
    fs.readFile(path.join(webDir, "public", "index.html"), "utf8"),
    fs.readFile(path.join(webDir, "public", "assets", "app.js"), "utf8")
  ]);

  assert.match(html, /บันทึกเฉพาะ Browser\/คอมพิวเตอร์เครื่องนี้/);
  assert.match(html, /ไม่ได้แชร์ไปยัง Pack Station อื่น/);
  assert.match(html, /SmartRecord server บน NAS\/server เท่านั้น/);
  assert.match(app, /status: "not-checked"/);
  assert.match(app, /available: "ยืนยันแล้ว"/);
  assert.match(app, /unavailable: "ปลายทางไม่พร้อมหรือเขียนไม่ได้"/);
  assert.match(app, /"requires-configuration": "ต้องตั้งค่า\/mount"/);
  assert.match(app, /"not-checked": "ยังไม่ตรวจสอบ"/);
  assert.match(app, /const storageConnected = storageStatus === "available"/);
  assert.doesNotMatch(app, /storageConnected = Boolean\(storage\)/);
  assert.doesNotMatch(app, /serverStorage\.actualWritePath|serverStorage\.storageRoot|target\.resolvedLocalPath/);
});
