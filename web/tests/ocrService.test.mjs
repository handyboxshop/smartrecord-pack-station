import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  buildOcrmypdfArgs,
  buildPdfToPngArgs,
  buildTesseractArgs,
  convertPdfToPngPages,
  inspectOcrDiagnostics,
  preprocessPdfForOcr,
  probeOcrRuntime,
  resolveOcrPreprocessTimeout,
  resolveOcrConfig
} from "../src/domain/ocrService.mjs";

test("resolveOcrConfig merges per-platform values over generic defaults", () => {
  const base = {
    languages: "tha+eng",
    pageSegmentationMode: 6,
    pdfDpi: 300,
    preserveInterwordSpaces: false,
    platforms: {
      lazada: {
        pdfDpi: 320,
        preserveInterwordSpaces: true
      }
    }
  };

  const lazada = resolveOcrConfig(base, "lazada");
  assert.equal(lazada.languages, "tha+eng");
  assert.equal(lazada.pageSegmentationMode, 6);
  assert.equal(lazada.pdfDpi, 320);
  assert.equal(lazada.preserveInterwordSpaces, true);
  assert.equal("platforms" in lazada, false);
});

test("OCR diagnostics reports configured, unavailable, and invalid timeout states without exposing probe errors", async () => {
  const ready = await inspectOcrDiagnostics({
    ocrConfig: { engine: "tesseract", command: "tesseract", preprocessPdf: { enabled: true, timeoutMs: 5000 } },
    probeRuntime: async () => ({ available: true })
  });
  assert.equal(ready.overallStatus, "ready");
  assert.equal(ready.checks.ocr.code, "OCR_READY");
  assert.equal(ready.checks.ocrTimeout.code, "OCR_TIMEOUT_CONFIGURED");

  const unavailable = await inspectOcrDiagnostics({
    ocrConfig: { engine: "tesseract", command: "tesseract" },
    probeRuntime: async () => ({ available: false })
  });
  assert.equal(unavailable.overallStatus, "unavailable");
  assert.equal(unavailable.checks.ocr.code, "OCR_RUNTIME_UNAVAILABLE");

  const invalid = await inspectOcrDiagnostics({
    ocrConfig: { engine: "tesseract", command: "tesseract", preprocessPdf: { enabled: true, timeoutMs: "bad" } },
    probeRuntime: async () => ({ available: true })
  });
  assert.equal(invalid.overallStatus, "degraded");
  assert.equal(invalid.checks.ocrTimeout.code, "OCR_TIMEOUT_INVALID");
  assert.match(invalid.checks.ocrTimeout.message, /120000/);

  const sanitized = await inspectOcrDiagnostics({
    ocrConfig: { engine: "tesseract", command: "tesseract" },
    probeRuntime: async () => { throw new Error("secret /private/customer/node_modules/tesseract"); }
  });
  assert.equal(sanitized.checks.ocr.code, "OCR_DIAGNOSTIC_FAILED");
  assert.doesNotMatch(JSON.stringify(sanitized), /secret|private|node_modules/i);
});

test("OCR diagnostics keep timeout neutral when OCR is not configured or preprocessing is disabled", async () => {
  const notConfigured = await inspectOcrDiagnostics({ ocrConfig: null });
  assert.equal(notConfigured.checks.ocrTimeout.status, "not-configured");
  assert.equal(notConfigured.checks.ocrTimeout.code, "OCR_TIMEOUT_NOT_CONFIGURED");

  const preprocessingDisabled = await inspectOcrDiagnostics({
    ocrConfig: { engine: "tesseract", command: "tesseract", preprocessPdf: { enabled: false, timeoutMs: 5000 } },
    probeRuntime: async () => ({ available: true })
  });
  assert.equal(preprocessingDisabled.checks.ocr.status, "ready");
  assert.equal(preprocessingDisabled.checks.ocrTimeout.status, "not-configured");
  assert.equal(preprocessingDisabled.checks.ocrTimeout.code, "OCR_PREPROCESSING_DISABLED");
  assert.doesNotMatch(JSON.stringify(preprocessingDisabled), /tesseract|command/i);
});

test("OCR preprocess timeout keeps a positive default when configuration is missing or invalid", () => {
  assert.deepEqual(resolveOcrPreprocessTimeout({}), { timeoutMs: 120000, source: "default", valid: true });
  assert.deepEqual(resolveOcrPreprocessTimeout({ preprocessPdf: { timeoutMs: 0 } }), { timeoutMs: 120000, source: "fallback", valid: false });
});

test("preprocessPdfForOcr keeps timeout protection for missing and invalid configuration", async () => {
  for (const [timeoutMs, expectedTimeout] of [
    [undefined, 120000],
    [0, 120000],
    [-1, 120000],
    ["invalid", 120000],
    [4500, 4500]
  ]) {
    const child = fakePreprocessChild();
    const scheduledTimeouts = [];
    const config = { preprocessPdf: { enabled: true } };
    if (timeoutMs !== undefined) config.preprocessPdf.timeoutMs = timeoutMs;
    const resultPromise = preprocessPdfForOcr({
      filePath: "fixture.pdf",
      outputPath: "fixture-output.pdf",
      config,
      spawnProcess: () => child,
      setTimeoutFn: (callback, delay) => {
        scheduledTimeouts.push(delay);
        return { callback, unref() {} };
      },
      clearTimeoutFn: () => {}
    });
    child.emit("close", 0);
    const result = await resultPromise;
    assert.equal(result.ok, true);
    assert.equal(result.data.usedPreprocessing, true);
    assert.equal(scheduledTimeouts[0], expectedTimeout);
  }
});

test("OCR runtime diagnostic probe is bounded and never returns command or error details", async () => {
  const successfulChild = fakeChild();
  const success = probeOcrRuntime({
    command: "/private/ocr-secret-command",
    spawnProcess: () => successfulChild,
    logError: () => assert.fail("successful probe must not log an error")
  });
  successfulChild.emit("close", 0);
  assert.deepEqual(await success, { available: true });

  const unavailableChild = fakeChild();
  const unavailable = probeOcrRuntime({
    command: "/private/ocr-secret-command",
    spawnProcess: () => unavailableChild,
    logError: () => {}
  });
  unavailableChild.emit("error", Object.assign(new Error("failed /private/ocr-secret-command"), { code: "ENOENT", path: "/private/ocr-secret-command" }));
  assert.deepEqual(await unavailable, { available: false });

  const timeoutChild = fakeChild();
  const timeoutPromise = probeOcrRuntime({
    command: "/private/ocr-secret-command",
    timeoutMs: 10,
    spawnProcess: () => timeoutChild,
    logError: () => {}
  });
  await delay(20);
  const timeout = await timeoutPromise;
  assert.deepEqual(timeout, { available: false });
  assert.deepEqual(timeoutChild.kills, ["SIGTERM"]);
  timeoutChild.emit("close", 0);
  assert.deepEqual(timeout, { available: false });

  const unexpected = await probeOcrRuntime({
    command: "/private/ocr-secret-command",
    spawnProcess: () => { throw new Error("secret /private/ocr-secret-command node_modules"); },
    logError: () => {}
  });
  assert.deepEqual(unexpected, { available: false });
  assert.doesNotMatch(JSON.stringify({ success: await success, unavailable: await unavailable, timeout, unexpected }), /secret|private|command|node_modules/i);
});

function fakeChild() {
  const child = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => child.kills.push(signal);
  return child;
}

function fakePreprocessChild() {
  const child = fakeChild();
  child.stderr = new EventEmitter();
  return child;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("buildTesseractArgs includes language, engine, psm and optional flags", () => {
  const args = buildTesseractArgs("/tmp/label.png", {
    languages: "tha+eng",
    engineMode: 1,
    pageSegmentationMode: 11,
    tessdataDir: "/opt/tessdata",
    preserveInterwordSpaces: true,
    extraArgs: ["-c", "user_defined_dpi=300"]
  });

  assert.deepEqual(args, [
    "/tmp/label.png",
    "stdout",
    "-l",
    "tha+eng",
    "--oem",
    "1",
    "--psm",
    "11",
    "--tessdata-dir",
    "/opt/tessdata",
    "-c",
    "preserve_interword_spaces=1",
    "-c",
    "user_defined_dpi=300"
  ]);
});

test("buildPdfToPngArgs uses 300 DPI by default", () => {
  const args = buildPdfToPngArgs("/tmp/labels.pdf", "/tmp/label_page", {});
  assert.deepEqual(args, ["-r", "300", "-png", "-f", "1", "-l", "50", "/tmp/labels.pdf", "/tmp/label_page"]);
});

test("convertPdfToPngPages returns outputPrefix and maxPages after converter success", async () => {
  const result = await convertPdfToPngPages({
    filePath: "/tmp/labels.pdf",
    outputPrefix: "/tmp/label_page",
    config: {
      pdfCommand: "true",
      maxPdfPages: 12
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.outputPrefix, "/tmp/label_page");
  assert.equal(result.data.maxPages, 12);
});

test("buildOcrmypdfArgs includes safe preprocess defaults and input output paths", () => {
  const args = buildOcrmypdfArgs("/tmp/source.pdf", "/tmp/output.pdf", {
    languages: "tha+eng",
    preprocessPdf: {
      enabled: true,
      rotatePages: true,
      deskew: true,
      cleanFinal: true,
      skipText: true,
      optimize: 0,
      continueOnSoftFail: true
    }
  });

  assert.deepEqual(args, [
    "--skip-text",
    "--rotate-pages",
    "--deskew",
    "--clean-final",
    "--invalidate-digital-signatures",
    "--optimize",
    "0",
    "-l",
    "tha+eng",
    "/tmp/source.pdf",
    "/tmp/output.pdf"
  ]);
});
