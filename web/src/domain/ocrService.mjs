import { spawn } from "node:child_process";

export const DEFAULT_OCR_PREPROCESS_TIMEOUT_MS = 120000;
export const DEFAULT_OCR_DIAGNOSTIC_TIMEOUT_MS = 5000;

export function resolveOcrPreprocessTimeout(config = {}) {
  const value = config.preprocessPdf?.timeoutMs;
  if (value === undefined || value === null || value === "") {
    return { timeoutMs: DEFAULT_OCR_PREPROCESS_TIMEOUT_MS, source: "default", valid: true };
  }
  const timeoutMs = Number(value);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return { timeoutMs, source: "configured", valid: true };
  }
  return { timeoutMs: DEFAULT_OCR_PREPROCESS_TIMEOUT_MS, source: "fallback", valid: false };
}

export async function inspectOcrDiagnostics({ ocrConfig, probeRuntime = probeOcrRuntime } = {}) {
  const timeout = resolveOcrPreprocessTimeout(ocrConfig || {});
  const configuration = isOcrConfigured(ocrConfig)
    ? check("ready", "OCR_CONFIGURED", "กำหนดค่า OCR แล้ว")
    : check("not-configured", "OCR_NOT_CONFIGURED", "ยังไม่ได้กำหนดค่า OCR");
  let ocr;
  if (configuration.status !== "ready") {
    ocr = check("not-configured", "OCR_NOT_CONFIGURED", "ยังไม่ได้กำหนดค่า OCR จึงยังตรวจ OCR runtime ไม่ได้");
  } else {
    try {
      const runtime = await probeRuntime({ command: ocrConfig.command || "tesseract" });
      ocr = runtime?.available
        ? check("ready", "OCR_READY", "OCR runtime พร้อมใช้งาน")
        : check("unavailable", "OCR_RUNTIME_UNAVAILABLE", "OCR runtime ไม่พร้อมใช้งานบน server");
    } catch (error) {
      console.error("[diagnostics] OCR runtime probe failed", error?.stack || error?.message || error);
      ocr = check("unavailable", "OCR_DIAGNOSTIC_FAILED", "ตรวจสอบ OCR runtime ไม่สำเร็จ");
    }
  }
  const ocrTimeout = timeout.valid
    ? check("ready", timeout.source === "configured" ? "OCR_TIMEOUT_CONFIGURED" : "OCR_TIMEOUT_DEFAULT", timeout.source === "configured"
      ? `OCR timeout ตั้งค่าไว้ ${timeout.timeoutMs} ms`
      : `OCR timeout ใช้ค่าเริ่มต้น ${timeout.timeoutMs} ms`)
    : check("degraded", "OCR_TIMEOUT_INVALID", `OCR timeout ไม่ถูกต้อง ระบบใช้ค่า fallback ${timeout.timeoutMs} ms`);
  const statuses = [configuration.status, ocr.status, ocrTimeout.status];
  const overallStatus = statuses.includes("unavailable") ? "unavailable" : statuses.includes("degraded") || statuses.includes("not-configured") ? "degraded" : "ready";
  return { checkedAt: new Date().toISOString(), overallStatus, checks: { server: check("ready", "SERVER_READY", "SmartRecord server พร้อมให้บริการ"), ocr, ocrConfiguration: configuration, ocrTimeout } };
}

export async function probeOcrRuntime({
  command,
  timeoutMs = DEFAULT_OCR_DIAGNOSTIC_TIMEOUT_MS,
  spawnProcess = spawn,
  logError = logOcrDiagnosticError
} = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timeout = null;
    let forceKill = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    try {
      child = spawnProcess(command, ["--version"], { stdio: "ignore" });
    } catch (error) {
      logError(error);
      finish({ available: false });
      return;
    }
    child.once("error", (error) => {
      if (error?.code !== "ENOENT") logError(error);
      if (forceKill) clearTimeout(forceKill);
      finish({ available: false });
    });
    child.once("close", (code) => {
      if (forceKill) clearTimeout(forceKill);
      finish({ available: code === 0 });
    });
    const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : DEFAULT_OCR_DIAGNOSTIC_TIMEOUT_MS;
    timeout = setTimeout(() => {
      forceKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          logError(error);
        }
      }, 2000);
      forceKill.unref?.();
      finish({ available: false });
      try {
        child.kill("SIGTERM");
      } catch (error) {
        logError(error);
      }
    }, boundedTimeoutMs);
  });
}

function logOcrDiagnosticError(error) {
  console.error("[diagnostics] OCR runtime probe failed", error?.stack || error?.message || error);
}

function isOcrConfigured(config) {
  return Boolean(config && typeof config === "object" && String(config.engine || "").trim() && String(config.command || "").trim());
}

function check(status, code, message) {
  return { status, code, message };
}

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
  const timeoutMs = resolveOcrPreprocessTimeout(config).timeoutMs;

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    let settled = false;
    let timeout = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => child.kill("SIGKILL"), 2000);
        forceKill.unref?.();
        finish(fail("PDF_PREPROCESSOR_TIMEOUT", `OCRmyPDF ใช้เวลานานเกิน ${timeoutMs}ms และถูกหยุดการทำงาน`));
      }, timeoutMs);
      timeout.unref?.();
    }

    child.stderr.on("data", (chunk) => stderr.push(chunk));

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        if (preprocess.continueOnSoftFail) {
          finish({
            ok: true,
            data: {
              filePath,
              usedPreprocessing: false,
              warnings: [`ยังไม่พบ OCRmyPDF (${command}) ระบบจะข้าม preprocessing และ OCR จากไฟล์ต้นฉบับแทน`]
            }
          });
          return;
        }
        finish(fail("PDF_PREPROCESSOR_NOT_AVAILABLE", `ยังไม่พบ PDF preprocessor (${command}) กรุณาติดตั้ง OCRmyPDF หรือปิด preprocessPdf ก่อน`));
        return;
      }
      finish(fail("PDF_PREPROCESSOR_ERROR", error.message));
    });

    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const stderrText = Buffer.concat(stderr).toString("utf8").trim() || "preprocess PDF ไม่สำเร็จ";
        if (preprocess.continueOnSoftFail) {
          finish({
            ok: true,
            data: {
              filePath,
              usedPreprocessing: false,
              warnings: [`OCRmyPDF ทำงานไม่สำเร็จ ระบบจะ fallback ไปใช้ไฟล์ต้นฉบับแทน: ${stderrText}`]
            }
          });
          return;
        }
        finish(fail("PDF_PREPROCESSOR_ERROR", stderrText));
        return;
      }
      finish({ ok: true, data: { filePath: outputPath, usedPreprocessing: true, warnings: [] } });
    });
  });
}

function fail(code, message) {
  return { ok: false, code, message };
}
