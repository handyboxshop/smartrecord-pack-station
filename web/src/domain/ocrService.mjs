import { spawn } from "node:child_process";

export function resolveOcrConfig(config = {}, platform = "") {
  const platformConfig = platform && config.platforms && typeof config.platforms === "object"
    ? config.platforms[platform] || {}
    : {};
  const merged = {
    ...config,
    ...platformConfig
  };
  delete merged.platforms;
  return merged;
}

export function buildTesseractArgs(filePath, config = {}) {
  const languages = config.languages || "tha+eng";
  const oem = Number(config.engineMode ?? 1);
  const psm = Number(config.pageSegmentationMode || 6);
  const args = [filePath, "stdout", "-l", languages, "--oem", String(oem), "--psm", String(psm)];
  if (config.tessdataDir) args.push("--tessdata-dir", String(config.tessdataDir));
  if (config.preserveInterwordSpaces) args.push("-c", "preserve_interword_spaces=1");
  if (config.writeDebugImages) args.push("-c", "tessedit_write_images=true");
  if (Array.isArray(config.extraArgs)) {
    for (const arg of config.extraArgs) {
      if (arg !== null && arg !== undefined && String(arg).trim()) args.push(String(arg));
    }
  }
  return args;
}

export function buildPdfToPngArgs(filePath, outputPrefix, config = {}) {
  const dpi = Number(config.pdfDpi || 300);
  const maxPages = Number(config.maxPdfPages || 50);
  return ["-r", String(dpi), "-png", "-f", "1", "-l", String(maxPages), filePath, outputPrefix];
}

export function buildOcrmypdfArgs(filePath, outputPath, config = {}) {
  const preprocess = config.preprocessPdf || {};
  const args = [];
  const languages = config.languages || "tha+eng";
  if (preprocess.skipText !== false) args.push("--skip-text");
  if (preprocess.rotatePages !== false) args.push("--rotate-pages");
  if (preprocess.deskew !== false) args.push("--deskew");
  if (preprocess.cleanFinal !== false) args.push("--clean-final");
  if (preprocess.forceOcr) args.push("--force-ocr");
  if (preprocess.redoOcr) args.push("--redo-ocr");
  if (preprocess.invalidateDigitalSignatures !== false) args.push("--invalidate-digital-signatures");
  if (Number.isInteger(Number(preprocess.optimize))) args.push("--optimize", String(Number(preprocess.optimize)));
  if (languages) args.push("-l", languages);
  if (preprocess.extraArgs && Array.isArray(preprocess.extraArgs)) {
    for (const arg of preprocess.extraArgs) {
      if (arg !== null && arg !== undefined && String(arg).trim()) args.push(String(arg));
    }
  }
  args.push(filePath, outputPath);
  return args;
}

export async function runTesseractOcr({ filePath, config = {} } = {}) {
  if (!filePath) return fail("OCR_FILE_REQUIRED", "ไม่พบไฟล์ใบปะหน้าสำหรับ OCR");
  const command = config.command || "tesseract";
  const args = buildTesseractArgs(filePath, config);
  const languages = config.languages || "tha+eng";

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        resolve(fail("OCR_ENGINE_NOT_AVAILABLE", `ยังไม่พบ OCR engine (${command}) บนเครื่องนี้ กรุณาติดตั้ง Tesseract ก่อนนำเข้าใบปะหน้า`));
        return;
      }
      resolve(fail("OCR_ENGINE_ERROR", error.message));
    });
    child.on("close", (code) => {
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        if (/Error opening data file|Failed loading language|TESSDATA_PREFIX/i.test(stderrText)) {
          resolve(fail("OCR_LANGUAGE_DATA_MISSING", `OCR language data ไม่พร้อมใช้งาน (${languages}) กรุณาตรวจ tessdata และภาษาที่ติดตั้ง`));
          return;
        }
        resolve(fail("OCR_ENGINE_ERROR", stderrText || "OCR engine ทำงานไม่สำเร็จ"));
        return;
      }
      const text = Buffer.concat(stdout).toString("utf8").trim();
      if (!text) {
        resolve(fail("OCR_TEXT_EMPTY", "OCR ไม่พบข้อความในใบปะหน้า"));
        return;
      }
      resolve({ ok: true, data: { text } });
    });
  });
}

export async function convertPdfToPngPages({ filePath, outputPrefix, config = {} } = {}) {
  if (!filePath) return fail("PDF_FILE_REQUIRED", "ไม่พบไฟล์ PDF สำหรับแปลงเป็นรูป");
  if (!outputPrefix) return fail("PDF_OUTPUT_REQUIRED", "ไม่พบปลายทางสำหรับรูป PDF");
  const command = config.pdfCommand || "pdftoppm";
  const maxPages = Number(config.maxPdfPages || 50);
  const args = buildPdfToPngArgs(filePath, outputPrefix, config);

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];

    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        resolve(fail("PDF_CONVERTER_NOT_AVAILABLE", `ยังไม่พบ PDF converter (${command}) กรุณาติดตั้ง Poppler/pdftoppm ก่อนนำเข้า PDF หลายหน้า`));
        return;
      }
      resolve(fail("PDF_CONVERTER_ERROR", error.message));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(fail("PDF_CONVERTER_ERROR", Buffer.concat(stderr).toString("utf8").trim() || "แปลง PDF เป็นรูปไม่สำเร็จ"));
        return;
      }
      resolve({ ok: true, data: { outputPrefix, maxPages } });
    });
  });
}

export async function preprocessPdfForOcr({ filePath, outputPath, config = {} } = {}) {
  if (!filePath) return fail("PDF_FILE_REQUIRED", "ไม่พบไฟล์ PDF สำหรับ preprocess");
  if (!outputPath) return fail("PDF_OUTPUT_REQUIRED", "ไม่พบปลายทางสำหรับ preprocess PDF");
  const preprocess = config.preprocessPdf || {};
  if (!preprocess.enabled) {
    return { ok: true, data: { filePath, usedPreprocessing: false, warnings: [] } };
  }
  const command = preprocess.command || "ocrmypdf";
  const args = buildOcrmypdfArgs(filePath, outputPath, config);

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];

    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        if (preprocess.continueOnSoftFail) {
          resolve({
            ok: true,
            data: {
              filePath,
              usedPreprocessing: false,
              warnings: [`ยังไม่พบ OCRmyPDF (${command}) ระบบจะข้าม preprocessing และ OCR จากไฟล์ต้นฉบับแทน`]
            }
          });
          return;
        }
        resolve(fail("PDF_PREPROCESSOR_NOT_AVAILABLE", `ยังไม่พบ PDF preprocessor (${command}) กรุณาติดตั้ง OCRmyPDF หรือปิด preprocessPdf ก่อน`));
        return;
      }
      resolve(fail("PDF_PREPROCESSOR_ERROR", error.message));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const stderrText = Buffer.concat(stderr).toString("utf8").trim() || "preprocess PDF ไม่สำเร็จ";
        if (preprocess.continueOnSoftFail) {
          resolve({
            ok: true,
            data: {
              filePath,
              usedPreprocessing: false,
              warnings: [`OCRmyPDF ทำงานไม่สำเร็จ ระบบจะ fallback ไปใช้ไฟล์ต้นฉบับแทน: ${stderrText}`]
            }
          });
          return;
        }
        resolve(fail("PDF_PREPROCESSOR_ERROR", stderrText));
        return;
      }
      resolve({ ok: true, data: { filePath: outputPath, usedPreprocessing: true, warnings: [] } });
    });
  });
}

function fail(code, message) {
  return { ok: false, code, message };
}
