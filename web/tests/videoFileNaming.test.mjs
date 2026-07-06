import assert from "node:assert/strict";
import test from "node:test";
import { buildVideoFileLocation } from "../src/domain/videoFileNaming.mjs";

test("video file naming uses monthly folder and YYYYMMDD_AWB_STATUS format", () => {
  const result = buildVideoFileLocation({
    awb: "SPX-TH-88213940",
    status: "pass",
    savedAt: new Date(2026, 5, 23, 15, 45, 0)
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.folderName, "2026-06");
  assert.equal(result.data.fileName, "20260623_SPX-TH-88213940_PASS.webm");
});

test("video file naming sanitizes unsafe AWB characters", () => {
  const result = buildVideoFileLocation({
    awb: "../SPX TH/88213940",
    status: "warn",
    savedAt: new Date(2026, 0, 5, 9, 0, 0)
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.folderName, "2026-01");
  assert.equal(result.data.fileName, "20260105_.._SPX_TH_88213940_WARN.webm");
});
