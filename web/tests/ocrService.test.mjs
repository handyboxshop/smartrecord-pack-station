import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOcrmypdfArgs,
  buildPdfToPngArgs,
  buildTesseractArgs,
  convertPdfToPngPages,
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
