import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));

test("Device Settings presents Browser Print as the local-workstation workflow without fabricated printer status", async () => {
  const [html, app] = await Promise.all([
    fs.readFile(path.join(webDir, "public", "index.html"), "utf8"),
    fs.readFile(path.join(webDir, "public", "assets", "app.js"), "utf8")
  ]);

  assert.match(html, /Browser Print \(แนะนำ\)/);
  assert.match(html, /ระบบปฏิบัติการ/);
  assert.match(html, /การตั้งค่านี้บันทึกเฉพาะเครื่องและ Browser ปัจจุบัน/);
  assert.match(html, /<option value="a4">A4<\/option>/);
  assert.match(html, /<option value="100x150">100x150 mm<\/option>/);
  assert.match(html, /ทดสอบพิมพ์ผ่าน Browser/);
  assert.match(html, /ค้นหาเครื่องพิมพ์บน NAS \/ CUPS/);
  assert.doesNotMatch(html, /ค้นหาเครื่องพิมพ์ในเครื่อง/);
  assert.match(app, /statusChip\(\{ label: "เครื่องพิมพ์ฉลาก: เลือกผ่าน Browser", connected: false \}\)/);
  assert.doesNotMatch(app, /isConnectedPrinter|detectedPrinters/);
});
