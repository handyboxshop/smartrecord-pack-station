import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(rootDir, "..", "config", "app-config.example.json");

test("integrations.bulkImportConfirmThreshold is defined centrally and is a positive integer", async () => {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const threshold = config.integrations?.bulkImportConfirmThreshold;
  assert.equal(typeof threshold, "number");
  assert.ok(Number.isInteger(threshold) && threshold > 0, "threshold ต้องเป็นจำนวนเต็มบวก");
});

test("labelPrint config is defined centrally and labels permission is role-based", async () => {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.deepEqual(config.labelPrint?.enabledPlatforms, ["shopee", "tiktok", "lazada"]);
  assert.ok(config.labelPrint.acceptedImageTypes.includes("image/png"));
  assert.equal(typeof config.labelPrint.maxImageSizeMb, "number");
  assert.ok(config.auth.modules.some((module) => module.id === "labels" && module.viewPermission === "labels:manage"));
  assert.ok(config.auth.roles.find((role) => role.id === "admin").modulePermissions.some((permission) => permission.moduleId === "labels" && permission.canEdit));
});

test("pre-pack guide image rules are defined centrally", async () => {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const image = config.systemAssets?.prePackGuideImage;
  assert.equal(image.defaultUrl, "/assets/prepack-label-required.png");
  assert.equal(typeof image.maxImageSizeMb, "number");
  assert.ok(image.acceptedImageTypes.includes("image/png"));
  assert.equal(image.requiredAspectRatio, undefined);
});

test("pack flow disables force close with missing items by default", async () => {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.packFlow?.allowForceCloseWithMissingItems, false);
});

test("ocr config supports optional preprocessing and per-platform tuning", async () => {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.ocr?.preprocessPdf?.command, "ocrmypdf");
  assert.equal(typeof config.ocr?.preprocessPdf?.continueOnSoftFail, "boolean");
  assert.equal(config.ocr?.platforms?.shopee?.pageSegmentationMode, 6);
  assert.equal(config.ocr?.platforms?.lazada?.pdfDpi, 320);
  assert.equal(config.ocr?.platforms?.tiktok?.pageSegmentationMode, 11);
});
