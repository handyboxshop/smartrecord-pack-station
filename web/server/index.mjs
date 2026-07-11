import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthService, toPublicModules, toPublicRoles } from "../src/domain/authService.mjs";
import { createImportService } from "../src/domain/importService.mjs";
import { createLabelService } from "../src/domain/labelService.mjs";
import {
  convertPdfToPngPages,
  inspectOcrDiagnostics,
  preprocessPdfForOcr,
  resolveOcrConfig,
  runTesseractOcr
} from "../src/domain/ocrService.mjs";
import { createPackService, resolveStorageTarget } from "../src/domain/packService.mjs";
import { discoverNasCupsPrinters } from "../src/domain/printerDiscovery.mjs";
import { describeStorageTarget, resolveStorageRoot, verifyStorageDestination } from "../src/domain/storagePath.mjs";
import { parseHttpRange } from "../src/domain/httpRange.mjs";
import { detectPlatform, parseShippingLabelTexts } from "../src/domain/shippingLabelParser.mjs";
import { buildVideoFileLocation } from "../src/domain/videoFileNaming.mjs";
import { validateImageFile } from "../src/domain/imageValidation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const serviceName = "smartrecord-pack-station";
const mode = process.env.NODE_ENV || "development";
const host = process.env.HOST || (mode === "production" ? "0.0.0.0" : "127.0.0.1");
const jsonBodyLimitBytes = Number(process.env.SMARTRECORD_JSON_BODY_LIMIT_BYTES || 2 * 1024 * 1024);
const shutdownTimeoutMs = Number(process.env.SMARTRECORD_SHUTDOWN_TIMEOUT_MS || 10000);
const port = Number(process.env.PORT || 4173);

const configPath = resolveRuntimePath(process.env.SMARTRECORD_CONFIG_PATH, path.join(rootDir, "config", "app-config.example.json"));
const usersPath = resolveRuntimePath(process.env.SMARTRECORD_USERS_PATH, path.join(rootDir, "data", "users.json"));
const ordersPath = resolveRuntimePath(process.env.SMARTRECORD_ORDERS_PATH, path.join(rootDir, "data", "orders.json"));
const syncOrdersPath = resolveRuntimePath(process.env.SMARTRECORD_SYNC_ORDERS_PATH, path.join(rootDir, "data", "sync-orders.json"));
const packRecordsPath = resolveRuntimePath(process.env.SMARTRECORD_PACK_RECORDS_PATH, path.join(rootDir, "data", "pack-records.json"));
const labelsPath = resolveRuntimePath(process.env.SMARTRECORD_LABELS_PATH, path.join(rootDir, "data", "labels.json"));
const appSettingsPath = resolveRuntimePath(process.env.SMARTRECORD_APP_SETTINGS_PATH, path.join(rootDir, "data", "app-settings.json"));

let config;
let users;
let orders;
let syncOrders;
let packRecords;
let labels;
let appSettings;

try {
  config = JSON.parse(await fs.readFile(configPath, "utf8"));
  users = await loadJsonFile(usersPath, null);
  if (users !== null && !Array.isArray(users)) throw new Error("users must be an array");
  orders = await loadJsonFile(ordersPath, {});
  if (!orders || Array.isArray(orders) || typeof orders !== "object") throw new Error("orders must be an object");
  syncOrders = await loadJsonFile(syncOrdersPath, []);
  if (!Array.isArray(syncOrders)) throw new Error("sync orders must be an array");
  packRecords = await loadJsonFile(packRecordsPath, null);
  if (packRecords !== null && !Array.isArray(packRecords)) throw new Error("pack records must be an array");
  labels = await loadJsonFile(labelsPath, []);
  if (!Array.isArray(labels)) throw new Error("labels must be an array");
  appSettings = await loadAppSettings();
  await ensureRuntimeFolders();
} catch (error) {
  logStartupFailure("load runtime data", error);
  process.exit(1);
}

const authService = createAuthService({ config, initialUsers: users });
const packService = createPackService({ config, orders, records: packRecords });
const importService = createImportService({ orders, syncOrders, demoMode: mode !== "production" });
const labelService = createLabelService({ config, initialLabels: labels });
const printerDiscovery = resolvePrinterDiscovery();
const storageVerification = resolveStorageVerification();
const ocrDiagnostics = resolveOcrDiagnostics();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    if (error?.code === "JSON_TOO_LARGE") {
      sendResult(res, {
        ok: false,
        code: "JSON_TOO_LARGE",
        message: `JSON request body must not exceed ${Math.round(jsonBodyLimitBytes / 1024 / 1024)} MB`
      });
      return;
    }
    if (error instanceof SyntaxError) {
      sendResult(res, { ok: false, code: "INVALID_JSON", message: "Invalid JSON request body" });
      return;
    }
    console.error(`[api] unhandled error: ${error?.stack || error?.message || error}`);
    sendJson(res, 500, apiErrorPayload("SERVER_ERROR", "Server error"));
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[startup] Port ${port} on host ${host} is already in use. Stop the old process or run "npm run dev:reset" before starting again.`);
  } else {
    console.error(`[startup] ${serviceName} failed: ${error.code || "UNKNOWN"} ${error.message}`);
  }
  if (!server.listening) process.exit(1);
});

server.listen(port, host, () => {
  const healthUrl = `http://${host}:${port}/api/health`;
  console.log(`[startup] service=${serviceName}`);
  console.log(`[startup] mode=${mode}`);
  console.log(`[startup] host=${host}`);
  console.log(`[startup] port=${port}`);
  console.log(`[startup] routes=GET /api/health, GET /api/config, POST /api/auth/login`);
  console.log(`[startup] health=${healthUrl} ready`);
});

let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, closing ${serviceName}`);

  const timer = setTimeout(() => {
    console.error(`[shutdown] forced exit after ${shutdownTimeoutMs}ms`);
    process.exit(1);
  }, shutdownTimeoutMs);
  timer.unref?.();

  server.close(async (error) => {
    if (error) {
      console.error(`[shutdown] close failed: ${error.message}`);
      process.exit(1);
    }

    try {
      await flushRuntimeState();
      clearTimeout(timer);
      console.log("[shutdown] closed cleanly");
      process.exit(0);
    } catch (flushError) {
      console.error(`[shutdown] final flush failed: ${flushError.message}`);
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: serviceName,
      mode,
      time: new Date().toISOString(),
      port
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, { ok: true, data: getPublicConfig(config) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    sendResult(res, authService.login(await readJson(req)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    sendResult(res, authService.getSession(readBearerToken(req)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    sendResult(res, authService.logout(readBearerToken(req)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    sendResult(res, authService.listUsers(readBearerToken(req)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/users/activity") {
    sendResult(res, authService.listActivity(readBearerToken(req), { email: url.searchParams.get("email") || "" }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    const result = authService.createUser(readBearerToken(req), await readJson(req));
    if (result.ok) await persistUsers();
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users/update") {
    const result = authService.updateUser(readBearerToken(req), await readJson(req));
    if (result.ok) await persistUsers();
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users/permissions") {
    const result = authService.updateUserPermission(readBearerToken(req), await readJson(req));
    if (result.ok) await persistUsers();
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users/delete") {
    const result = authService.deleteUser(readBearerToken(req), await readJson(req));
    if (result.ok) await persistUsers();
    sendResult(res, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/devices/printers") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "settings:manage");
    if (!auth.ok) return sendResult(res, auth);
    sendResult(res, await printerDiscovery());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/devices/diagnostics") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "settings:manage");
    if (!auth.ok) return sendResult(res, auth);
    try {
      sendResult(res, { ok: true, data: await ocrDiagnostics() });
    } catch (error) {
      console.error("[diagnostics] unexpected diagnostic failure", error?.stack || error?.message || error);
      sendResult(res, {
        ok: true,
        data: safeDiagnosticFailure()
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/devices/storage/test") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "settings:manage");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    const storageTarget = resolveStorageTarget(config, body.storageTargetId);
    const result = await storageVerification({
      fs,
      rootDir,
      storageTarget,
      customPath: body.customPath || "",
      logError: (message, error) => console.error(message, error?.stack || error?.message || error)
    });
    if (result.ok) authService.recordActivity(token, {
      action: "storage_test",
      moduleId: "settings",
      targetId: storageTarget.id,
      details: `ตรวจที่จัดเก็บวิดีโอ: ${result.data.targetLabel}`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/prepack-image") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "settings:manage");
    if (!auth.ok) return sendResult(res, auth);
    if (!["owner", "admin"].includes(auth.data.user.roleId)) {
      sendJson(res, 403, apiErrorPayload("SYSTEM_ADMIN_REQUIRED", "เฉพาะ System Admin เท่านั้นที่เปลี่ยนรูปตัวอย่างก่อนเริ่มวิดีโอได้"));
      return;
    }
    const result = await savePrePackGuideImage(req, url, auth.data.user);
    if (result.ok) authService.recordActivity(token, {
      action: "settings_prepack_image_update",
      moduleId: "settings",
      targetId: "prePackGuideImage",
      details: `เปลี่ยนรูปตัวอย่างก่อนเริ่มวิดีโอ ${result.data.width}x${result.data.height}`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pack/start") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "pack:use");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    body.employeeId = auth.data.user.employeeId || body.employeeId;
    const result = packService.startPackSession(body);
    if (result.ok) authService.recordActivity(token, {
      action: "pack_start",
      moduleId: "pack",
      targetId: result.data.awb,
      details: `เริ่มแพค AWB ${result.data.awb}`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pack/scan") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "pack:use");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    const result = packService.scanCode(body);
    if (result.ok || result.code) authService.recordActivity(token, {
      action: result.ok ? "pack_scan" : "pack_scan_rejected",
      moduleId: "pack",
      targetId: result.data?.awb || result.data?.session?.awb || body.sessionId,
      details: `${result.ok ? "สแกน" : "สแกนไม่ผ่าน"}: ${body.code}`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pack/close") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "pack:use");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    const result = packService.closePackSession(body);
    if (result.ok) await persistPackRecords();
    if (result.ok) authService.recordActivity(token, {
      action: result.data.record.status === "pass" ? "pack_close_pass" : "pack_force_close",
      moduleId: "pack",
      targetId: result.data.record.awb,
      details: `ปิดกล่อง ${result.data.record.awb} (${result.data.record.status})`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/reports") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "reports:view");
    if (!auth.ok) return sendResult(res, auth);
    authService.recordActivity(token, {
      action: "reports_view",
      moduleId: "reports",
      details: "เปิดดูรายงาน"
    });
    sendJson(res, 200, { ok: true, data: packService.listRecords() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/video/upload") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "pack:use");
    if (!auth.ok) return sendResult(res, auth);
    const result = await saveUploadedVideo(req, url);
    if (result.ok) authService.recordActivity(token, {
      action: "video_upload",
      moduleId: "pack",
      targetId: url.searchParams.get("awb") || "",
      details: `อัปโหลดวิดีโอ ${result.data.fileName}`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/video/stream/")) {
    await streamUploadedVideo(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/connect/test") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "integrations:manage");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    const result = importService.testConnection(body);
    authService.recordActivity(token, {
      action: "connection_test",
      moduleId: "connect",
      targetId: body.platform,
      details: `ทดสอบ connection ${body.platform}`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/connect/save") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "integrations:manage");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    const result = importService.saveConnection(body);
    if (result.ok) authService.recordActivity(token, {
      action: "connection_save",
      moduleId: "connect",
      targetId: body.platform,
      details: `บันทึก connection ${body.platform}`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/sync") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "integrations:manage");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    const result = importService.sync(body);
    if (result.ok) authService.recordActivity(token, {
      action: "orders_sync",
      moduleId: "connect",
      targetId: body.platform,
      details: `Sync ${result.data.orders.length} orders จาก ${body.platform}`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/import") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "integrations:manage");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    const result = importService.importOrders(body);
    if (result.ok) await persistOrders();
    if (result.ok) authService.recordActivity(token, {
      action: "orders_import",
      moduleId: "connect",
      details: `นำเข้า ${result.data.importedCount} orders`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/manual") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "integrations:manage");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    const result = importService.createManualOrder(body);
    if (result.ok) await persistOrders();
    if (result.ok) authService.recordActivity(token, {
      action: "orders_manual_create",
      moduleId: "connect",
      targetId: result.data.awb,
      details: `สร้างออเดอร์จากแบบฟอร์ม ${result.data.awb}`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/label/import") {
    const token = readBearerToken(req);
    const auth = requireAnyPermission(token, ["integrations:manage", "labels:manage"]);
    if (!auth.ok) return sendResult(res, auth);
    const result = await importShippingLabel(req, url);
    if (result.ok) await persistOrders();
    if (result.ok) authService.recordActivity(token, {
      action: "orders_label_import",
      moduleId: "connect",
      targetId: labelImportTargetId(result.data),
      details: labelImportActivityDetails(result.data)
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/update") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "integrations:manage");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    const result = importService.updateImportedOrder(body);
    const labelSync = result.ok ? labelService.updateLabelsForAwb({
      awb: result.data.awb,
      updates: {
        awb: result.data.awb,
        platform: String(body.platform || "").trim().toLowerCase(),
        orderNumber: result.data.orderNumber,
        customerName: result.data.buyer,
        carrier: result.data.carrier
      }
    }) : null;
    if (result.ok && labelSync?.ok) {
      result.data.updatedLabels = labelSync.data.updatedCount;
    }
    if (result.ok) await persistOrders();
    if (result.ok && labelSync?.ok && labelSync.data.updatedCount > 0) await persistLabels();
    if (result.ok) authService.recordActivity(token, {
      action: "orders_manual_update",
      moduleId: "connect",
      targetId: result.data.awb,
      details: `แก้ไขออเดอร์ที่นำเข้าแล้ว ${result.data.awb} และ sync ใบปะหน้า ${result.data.updatedLabels || 0} รายการ`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/delete") {
    const token = readBearerToken(req);
    const auth = authService.requirePermission(token, "integrations:manage");
    if (!auth.ok) return sendResult(res, auth);
    const body = await readJson(req);
    const result = importService.deleteImportedOrder(body);
    const labelCleanup = result.ok ? labelService.deleteLabelsForAwb({ awb: result.data.awb }) : null;
    if (result.ok && labelCleanup?.ok) {
      result.data.deletedLabels = labelCleanup.data.deletedCount;
    }
    if (result.ok) await persistOrders();
    if (result.ok && labelCleanup?.ok && labelCleanup.data.deletedCount > 0) await persistLabels();
    if (result.ok) authService.recordActivity(token, {
      action: "orders_manual_delete",
      moduleId: "connect",
      targetId: result.data.awb,
      details: `ลบออเดอร์ที่นำเข้าแล้ว ${result.data.awb} และลบใบปะหน้า ${result.data.deletedLabels || 0} รายการ`
    });
    sendResult(res, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/labels") {
    const token = readBearerToken(req);
    const auth = requireAnyPermission(token, ["labels:manage", "integrations:manage"]);
    if (!auth.ok) return sendResult(res, auth);
    sendResult(res, await labelsWithUrls(req));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/labels/file/")) {
    const token = readBearerToken(req);
    const auth = requireAnyPermission(token, ["labels:manage", "integrations:manage"]);
    if (!auth.ok) return sendResult(res, auth);
    await serveLabelFile(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/labels") {
    const token = readBearerToken(req);
    const auth = requireAnyPermission(token, ["labels:manage", "integrations:manage"]);
    if (!auth.ok) return sendResult(res, auth);
    const result = labelService.saveLabel(await readJson(req));
    if (result.ok) await persistLabels();
    if (result.ok) authService.recordActivity(token, {
      action: "label_save",
      moduleId: "labels",
      targetId: result.data.id,
      details: `บันทึกใบปะหน้า ${result.data.id} (${result.data.platform})`
    });
    sendResult(res, result);
    return;
  }

  sendJson(res, 404, apiErrorPayload("NOT_FOUND", "Endpoint not found"));
}

function getPublicConfig(source) {
  return {
    app: source.app,
    station: source.station,
    employees: source.employees,
    packFlow: source.packFlow,
    systemAssets: {
      prePackGuideImage: {
        ...(source.systemAssets?.prePackGuideImage || {}),
        url: appSettings.systemAssets?.prePackGuideImage?.url
          || source.systemAssets?.prePackGuideImage?.defaultUrl
          || "/assets/prepack-label-required.png",
        updatedAt: appSettings.systemAssets?.prePackGuideImage?.updatedAt || null,
        updatedBy: appSettings.systemAssets?.prePackGuideImage?.updatedBy || null
      }
    },
    devices: source.devices,
    upload: {
      provider: source.upload.provider,
      maxVideoSizeMb: source.upload.maxVideoSizeMb,
      simulationSteps: source.upload.simulationSteps,
      defaultStorageTargetId: source.upload.defaultStorageTargetId,
      storageTargets: source.upload.storageTargets.map((target) => ({
        ...describeStorageTarget({ rootDir, storageTarget: target }),
        id: target.id,
        label: target.label,
        provider: target.provider,
        host: target.host,
        isDefault: target.isDefault
      }))
    },
    reports: source.reports,
    integrations: source.integrations,
    ocr: {
      engine: source.ocr?.engine,
      languages: source.ocr?.languages,
      maxLabelFileSizeMb: source.ocr?.maxLabelFileSizeMb
    },
    labelPrint: source.labelPrint,
    auth: {
      modules: toPublicModules(source),
      roles: toPublicRoles(source),
      passwordPolicy: {
        minLength: source.auth.passwordPolicy.minLength
      }
    }
  };
}

async function savePrePackGuideImage(req, url, actor = {}) {
  const imageConfig = config.systemAssets?.prePackGuideImage || {};
  const maxMb = Number(imageConfig.maxImageSizeMb || 5);
  const contentTypeHeader = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const acceptedTypes = imageConfig.acceptedImageTypes || ["image/png", "image/jpeg", "image/webp"];
  if (!acceptedTypes.includes(contentTypeHeader)) {
    return { ok: false, code: "IMAGE_TYPE_UNSUPPORTED", message: "รองรับเฉพาะไฟล์ PNG, JPG หรือ WebP" };
  }

  let bytes;
  try {
    bytes = await readBinary(req, maxMb * 1024 * 1024, "IMAGE_TOO_LARGE");
  } catch (error) {
    if (error.code === "IMAGE_TOO_LARGE") {
      return { ok: false, code: error.code, message: `รูปต้องไม่เกิน ${maxMb} MB` };
    }
    throw error;
  }
  if (bytes.length === 0) return { ok: false, code: "IMAGE_EMPTY", message: "ไม่พบข้อมูลรูปภาพ" };

  const validation = validateImageFile(bytes, contentTypeHeader);
  if (!validation.ok) return validation;

  const ext = safeImageExt(url.searchParams.get("fileName") || "", contentTypeHeader);
  const fileName = `prepack-guide-custom${ext}`;
  const filePath = path.join(publicDir, "assets", fileName);
  if (!filePath.startsWith(path.join(publicDir, "assets"))) {
    return { ok: false, code: "INVALID_IMAGE_PATH", message: "path รูปไม่ถูกต้อง" };
  }

  await fs.writeFile(filePath, bytes);
  const updatedAt = new Date().toISOString();
  const imageUrl = `/assets/${fileName}?v=${encodeURIComponent(updatedAt)}`;
  appSettings = {
    ...appSettings,
    systemAssets: {
      ...(appSettings.systemAssets || {}),
      prePackGuideImage: {
        url: imageUrl,
        updatedAt,
        updatedBy: actor.name || actor.email || "System Admin",
        fileName,
        bytes: bytes.length,
        contentType: contentTypeHeader,
        width: validation.data.width,
        height: validation.data.height
      }
    }
  };
  await writeAppSettings(appSettings);
  return {
    ok: true,
    data: {
      url: imageUrl,
      width: validation.data.width,
      height: validation.data.height,
      bytes: bytes.length,
      updatedAt
    },
    message: "เปลี่ยนรูปตัวอย่างก่อนเริ่มวิดีโอสำเร็จ"
  };
}

async function loadAppSettings() {
  try {
    return JSON.parse(await fs.readFile(appSettingsPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeAppSettings(settings) {
  await writeJsonFile(appSettingsPath, settings);
}

async function flushRuntimeState() {
  const flushTasks = [
    ["users", persistUsers()],
    ["orders", persistOrders()],
    ["packRecords", persistPackRecords()],
    ["labels", persistLabels()],
    ["appSettings", writeAppSettings(appSettings)]
  ];

  const results = await Promise.allSettled(flushTasks.map(([, task]) => task));
  const failures = results
    .map((result, index) => {
      if (result.status === "fulfilled") {
        return null;
      }

      const [name] = flushTasks[index];
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return `${name}: ${reason}`;
    })
    .filter(Boolean);

  if (failures.length > 0) {
    throw new Error(`Failed to flush runtime state: ${failures.join("; ")}`);
  }
}

async function persistUsers() {
  await writeJsonFile(usersPath, authService.listAllUsers());
}

async function persistOrders() {
  await writeJsonFile(ordersPath, orders);
}

async function persistPackRecords() {
  await writeJsonFile(packRecordsPath, packService.listRecords());
}

async function persistLabels() {
  await writeJsonFile(labelsPath, labelService.listAllLabels());
}

async function loadJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

async function ensureRuntimeFolders() {
  const runtimePaths = new Set([
    path.join(rootDir, "local-nas"),
    path.join(rootDir, "local-nas", "videos"),
    path.join(rootDir, "local-nas", "labels")
  ]);

  for (const target of config.upload?.storageTargets || []) {
    if (!target?.localPath) continue;
    const resolved = path.resolve(rootDir, target.localPath);
    if (!resolved.startsWith(rootDir)) continue;
    runtimePaths.add(resolved);
  }

  if (appSettings?.systemAssets?.prePackGuideImage?.fileName) {
    runtimePaths.add(path.join(rootDir, "public", "assets"));
  }

  await Promise.all([...runtimePaths].map((folder) => fs.mkdir(folder, { recursive: true })));
}

async function importShippingLabel(req, url) {
  const maxMb = Number(config.ocr?.maxLabelFileSizeMb || 20);
  const originalName = url.searchParams.get("fileName") || "shipping-label";
  let bytes;
  try {
    bytes = await readBinary(req, maxMb * 1024 * 1024, "LABEL_FILE_TOO_LARGE");
  } catch (error) {
    if (error.code === "LABEL_FILE_TOO_LARGE") {
      return { ok: false, code: error.code, message: `ไฟล์ใบปะหน้าต้องไม่เกิน ${maxMb} MB` };
    }
    throw error;
  }
  if (bytes.length === 0) return { ok: false, code: "LABEL_FILE_EMPTY", message: "ไม่พบไฟล์ใบปะหน้า" };

  const savedAt = new Date();
  const folderName = `${savedAt.getFullYear()}-${String(savedAt.getMonth() + 1).padStart(2, "0")}`;
  const safeName = sanitizeFilePart(path.basename(originalName, path.extname(originalName))) || "shipping-label";
  const ext = safeFileExt(originalName, req.headers["content-type"]);
  const labelsDir = path.join(rootDir, "local-nas", "labels", folderName);
  const fileName = `${toCompactDate(savedAt)}_${safeName}${ext}`;
  const filePath = path.join(labelsDir, fileName);
  if (!filePath.startsWith(labelsDir)) return { ok: false, code: "INVALID_LABEL_PATH", message: "path ใบปะหน้าไม่ถูกต้อง" };
  await fs.mkdir(labelsDir, { recursive: true });
  await fs.writeFile(filePath, bytes);

  const labelFile = {
    fileName,
    relativePath: path.relative(rootDir, filePath),
    bytes: bytes.length,
    contentType: req.headers["content-type"] || contentType(fileName),
    importedAt: savedAt.toISOString()
  };
  const pageFilesResult = await prepareLabelOcrFiles({ filePath, labelsDir, safeName, ext, config: config.ocr || {} });
  if (!pageFilesResult.ok) return { ...pageFilesResult, data: { labelFile } };

  const imported = [];
  const skipped = [];
  const manualCorrections = [];
  const errors = [];
  const warnings = [...(pageFilesResult.data.warnings || [])];
  let labelsChanged = false;
  const genericOcrConfig = resolveOcrConfig(config.ocr || {});
  for (const pageFile of pageFilesResult.data.pages) {
    const ocrResult = await runTesseractOcr({ filePath: pageFile.filePath, config: genericOcrConfig });
    if (!ocrResult.ok) {
      errors.push({ page: pageFile.page, code: ocrResult.code, message: ocrResult.message });
      continue;
    }
    let ocrText = ocrResult.data.text;
    const detectedPlatform = detectPlatform(ocrText);
    if (detectedPlatform) {
      const platformOcrConfig = resolveOcrConfig(config.ocr || {}, detectedPlatform);
      if (ocrConfigChanged(genericOcrConfig, platformOcrConfig)) {
        const rerunResult = await runTesseractOcr({ filePath: pageFile.filePath, config: platformOcrConfig });
        if (rerunResult.ok) {
          ocrText = rerunResult.data.text;
          warnings.push(`หน้า ${pageFile.page}: ใช้ OCR tuning สำหรับ ${detectedPlatform}`);
        } else {
          warnings.push(`หน้า ${pageFile.page}: OCR tuning สำหรับ ${detectedPlatform} ไม่สำเร็จ จึงใช้ผล OCR แบบทั่วไปแทน`);
        }
      }
    }
    const parsedResult = parseShippingLabelTexts(ocrText);
    const parsedLabels = parsedResult.ok
      ? parsedResult.data.labels
      : getRecoverableParsedLabels(parsedResult);
    if (!parsedLabels) {
      errors.push({ page: pageFile.page, code: parsedResult.code, message: parsedResult.message });
      continue;
    }
    for (const [labelIndex, parsed] of parsedLabels.entries()) {
      const pageLabelFile = {
        ...labelFile,
        page: pageFile.page,
        labelIndex: labelIndex + 1,
        pageImageRelativePath: path.relative(rootDir, pageFile.filePath)
      };
      const orderResult = importService.createOrderFromShippingLabel({ parsed, labelFile: pageLabelFile });
      if (!orderResult.ok) {
        const skippedRow = {
          page: pageFile.page,
          labelIndex: labelIndex + 1,
          code: orderResult.code,
          message: orderResult.message,
          parsed: withoutRawText(parsed)
        };
        skipped.push(skippedRow);
        if (orderResult.code === "ORDER_NUMBER_REQUIRED" && skippedRow.parsed?.awb) {
          manualCorrections.push(skippedRow);
        }
        if (shouldRegisterPrintableSkippedLabel(orderResult.code, skippedRow.parsed)) {
          importService.saveDraftLabelImport({
            parsed: skippedRow.parsed,
            labelFile: pageLabelFile,
            code: orderResult.code,
            message: orderResult.message
          });
          const skippedLabelResult = labelService.registerImportedLabel({
            parsed: skippedRow.parsed,
            labelFile: pageLabelFile,
            status: resolveSkippedLabelStatus(orderResult.code)
          });
          if (skippedLabelResult.ok) labelsChanged = true;
        }
        continue;
      }
      const importedLabelResult = labelService.registerImportedLabel({
        parsed: withoutRawText(parsed),
        labelFile: pageLabelFile,
        order: orderResult.data,
        status: "imported"
      });
      if (importedLabelResult.ok) labelsChanged = true;
      imported.push({
        page: pageFile.page,
        labelIndex: labelIndex + 1,
        parsed: withoutRawText(parsed),
        order: orderResult.data
      });
    }
  }

  const totalLabels = imported.length + skipped.length + errors.length;
  if (imported.length === 0 && errors.length > 0 && skipped.length === 0) {
    return {
      ok: false,
      code: "LABEL_IMPORT_FAILED",
      message: "อ่านใบปะหน้าไม่สำเร็จ",
      data: { labelFile, errors }
    };
  }

  if (
    imported.length === 0
    && errors.length === 0
    && manualCorrections.length === 0
    && skipped.length > 0
    && skipped.every((item) => item.code === "ORDER_DUPLICATE_LABEL")
  ) {
    await cleanupRejectedLabelImport({
      sourceFilePath: filePath,
      pageFiles: pageFilesResult.data.pages,
      preprocessedFilePath: pageFilesResult.data.preprocessedFilePath
    });
    return {
      ok: false,
      code: "DUPLICATE_LABEL",
      message: "AWB + เลขออเดอร์ซ้ำในระบบ ไม่สามารถอัปโหลดใบปะหน้านี้ได้",
      data: {
        labelFile,
        skipped,
        manualCorrections,
        errors,
        warnings,
        importedCount: 0,
        skippedCount: skipped.length,
        errorCount: 0,
        totalLabels,
        totalPages: pageFilesResult.data.pages.length
      }
    };
  }

  if (labelsChanged) await persistLabels();

  return {
    ok: true,
    data: {
      parsed: imported[0]?.parsed || skipped[0]?.parsed || null,
      order: imported[0]?.order || null,
      imported,
      skipped,
      manualCorrections,
      errors,
      warnings,
      importedCount: imported.length,
      skippedCount: skipped.length,
      errorCount: errors.length,
      totalLabels,
      totalPages: pageFilesResult.data.pages.length,
      labelFile
    },
    message: imported.length
      ? `นำเข้าใบปะหน้า ${imported.length}/${totalLabels} รายการสำเร็จ`
      : manualCorrections.length
        ? `OCR อ่าน AWB ได้ แต่ยังขาดเลขออเดอร์ ${manualCorrections.length} รายการ`
      : `ไม่มีออเดอร์ใหม่จากใบปะหน้า (${skipped.length} รายการซ้ำ)`
  };
}

async function prepareLabelOcrFiles({ filePath, labelsDir, safeName, ext, config }) {
  if (ext !== ".pdf") return { ok: true, data: { pages: [{ page: 1, filePath }] } };
  const preprocessedPdfPath = path.join(labelsDir, `${safeName}_ocr-ready.pdf`);
  const preprocessResult = await preprocessPdfForOcr({ filePath, outputPath: preprocessedPdfPath, config });
  if (!preprocessResult.ok) return preprocessResult;
  const outputPrefix = path.join(labelsDir, `${safeName}_page`);
  const converted = await convertPdfToPngPages({ filePath: preprocessResult.data.filePath, outputPrefix, config });
  if (!converted.ok) return converted;
  const entries = await fs.readdir(labelsDir);
  const pages = entries
    .filter((entry) => entry.startsWith(`${safeName}_page-`) && entry.endsWith(".png"))
    .map((entry) => {
      const match = /-(\d+)\.png$/i.exec(entry);
      return {
        page: Number(match?.[1] || 0),
        filePath: path.join(labelsDir, entry)
      };
    })
    .filter((page) => page.page > 0)
    .sort((a, b) => a.page - b.page);
  if (pages.length === 0) return { ok: false, code: "PDF_NO_PAGES", message: "แปลง PDF แล้วไม่พบรูปหน้าใบปะหน้า" };
  return {
    ok: true,
    data: {
      pages,
      preprocessedFilePath: preprocessResult.data.filePath !== filePath ? preprocessResult.data.filePath : "",
      warnings: preprocessResult.data.warnings || []
    }
  };
}

async function cleanupRejectedLabelImport({ sourceFilePath = "", pageFiles = [], preprocessedFilePath = "" } = {}) {
  const targets = new Set([
    sourceFilePath,
    preprocessedFilePath,
    ...pageFiles.map((page) => page?.filePath || "")
  ].filter(Boolean));

  await Promise.all([...targets].map(async (target) => {
    try {
      if (!target.startsWith(path.join(rootDir, "local-nas", "labels"))) return;
      await fs.rm(target, { force: true });
    } catch {
      // best-effort cleanup only
    }
  }));
}

function getRecoverableParsedLabels(parsedResult) {
  if (!parsedResult || parsedResult.ok) return null;
  if (parsedResult.code !== "LABEL_ORDER_NOT_FOUND") return null;
  const partial = parsedResult.data;
  if (!partial?.awb) return null;
  return [partial];
}

function ocrConfigChanged(baseConfig, nextConfig) {
  return JSON.stringify(baseConfig || {}) !== JSON.stringify(nextConfig || {});
}

async function saveUploadedVideo(req, url) {
  const recordId = url.searchParams.get("recordId");
  const awb = url.searchParams.get("awb");
  const storageTargetId = url.searchParams.get("storageTargetId");
  const customPath = url.searchParams.get("customPath");
  if (!recordId || !awb) return { ok: false, code: "VIDEO_META_REQUIRED", message: "ต้องมี recordId และ awb" };

  const maxBytes = config.upload.maxVideoSizeMb * 1024 * 1024;
  const bytes = await readBinary(req, maxBytes);
  if (bytes.length === 0) return { ok: false, code: "VIDEO_EMPTY", message: "ไม่พบข้อมูลวิดีโอ" };
  const minBytes = Number(config.upload.minVideoSizeBytes || 0);
  if (minBytes > 0 && bytes.length < minBytes) {
    return {
      ok: false,
      code: "VIDEO_TOO_SMALL",
      message: "ไฟล์วิดีโอเล็กผิดปกติ อาจไม่ได้ถูกบันทึกจากกล้องจริง กรุณาอัดใหม่"
    };
  }

  const safeAwb = sanitizeFilePart(awb);
  const safeRecordId = sanitizeFilePart(recordId);
  const storageTarget = resolveStorageTarget(config, storageTargetId);
  const storageRootResult = resolveStorageRoot({ rootDir, storageTarget, customPath });
  if (!storageRootResult.ok) return storageRootResult;
  const storageRoot = storageRootResult.data.storageRoot;
  const externalUrl = storageRootResult.data.externalUrl || "";
  const record = packService.listRecords().find((candidate) => candidate.id === recordId);
  if (!record) return { ok: false, code: "RECORD_NOT_FOUND", message: "ไม่พบ record สำหรับผูกไฟล์วิดีโอ" };
  const savedAt = new Date();
  const location = buildVideoFileLocation({ awb: safeAwb, status: record.status, savedAt });
  if (!location.ok) return location;
  const monthDir = path.join(storageRoot, location.data.folderName);
  const fileName = location.data.fileName;
  const filePath = path.join(monthDir, fileName);
  if (!filePath.startsWith(storageRoot)) return { ok: false, code: "INVALID_VIDEO_PATH", message: "path วิดีโอไม่ถูกต้อง" };

  await fs.mkdir(monthDir, { recursive: true });
  await fs.writeFile(filePath, bytes);

  const video = {
    fileName,
    relativePath: path.relative(rootDir, filePath),
    bytes: bytes.length,
    sizeMb: Number((bytes.length / 1024 / 1024).toFixed(2)),
    contentType: req.headers["content-type"] || "video/webm",
    storageTargetId: storageTarget.id,
    storageLabel: storageTarget.label,
    storageHost: storageTarget.host,
    storageMode: storageRootResult.data.targetMode || (externalUrl ? "external-cloud-sync" : storageTarget.provider),
    mountedRequired: Boolean(storageRootResult.data.mountedRequired),
    simulated: Boolean(storageRootResult.data.simulated),
    externalUrl,
    customPath: customPath || "",
    shareLink: createVideoStreamUrl(req, safeRecordId),
    savedAt: savedAt.toISOString()
  };
  const attached = packService.attachVideoToRecord({ recordId, video });
  if (!attached.ok) return attached;
  await persistPackRecords();
  return { ok: true, data: video, message: "อัปโหลดไฟล์วิดีโอสำเร็จ" };
}

async function streamUploadedVideo(req, res, url) {
  const recordId = decodeURIComponent(url.pathname.replace("/api/video/stream/", ""));
  const record = packService.listRecords().find((candidate) => candidate.id === recordId);
  if (!record?.video?.relativePath) {
    sendJson(res, 404, apiErrorPayload("VIDEO_NOT_FOUND", "ไม่พบไฟล์วิดีโอจริงสำหรับ record นี้"));
    return;
  }

  const filePath = path.resolve(rootDir, record.video.relativePath);
  if (!filePath.startsWith(rootDir)) {
    sendJson(res, 403, apiErrorPayload("VIDEO_PATH_FORBIDDEN", "path วิดีโอไม่ปลอดภัย"));
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const type = record.video.contentType || "video/webm";
    const range = parseHttpRange(req.headers.range || "", content.length);
    if (!range.ok) {
      res.writeHead(range.code === "RANGE_NOT_SATISFIABLE" ? 416 : 400, {
        "Content-Range": `bytes */${content.length}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store"
      });
      res.end();
      return;
    }
    if (range.data.ranged) {
      const chunk = content.subarray(range.data.start, range.data.end + 1);
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": chunk.length,
        "Content-Range": `bytes ${range.data.start}-${range.data.end}/${content.length}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store"
      });
      res.end(chunk);
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": content.length,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    sendJson(res, 404, apiErrorPayload("VIDEO_FILE_MISSING", "metadata มีวิดีโอ แต่ไม่พบไฟล์บน storage"));
  }
}

function createVideoStreamUrl(req, recordId) {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${port}`;
  return `${protocol}://${host}/api/video/stream/${encodeURIComponent(recordId)}`;
}

async function labelsWithUrls(req) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const listed = labelService.listLabels({
    date: url.searchParams.get("date") || "",
    platform: url.searchParams.get("platform") || ""
  });
  if (!listed.ok) return listed;
  const activeImportedLabels = listed.data.labels.filter((label) => {
    if (label.source !== "connect-import") return false;
    const awb = String(label.awb || "").trim();
    const status = String(label.status || "").trim().toLowerCase();
    return Boolean(awb && status !== "skipped");
  });
  const uniquePrintableLabels = [];
  const seenAwbs = new Set();
  for (const label of activeImportedLabels) {
    const awb = String(label.awb || "").trim();
    if (!awb || seenAwbs.has(awb)) continue;
    seenAwbs.add(awb);
    uniquePrintableLabels.push(label);
  }
  const labels = await Promise.all(uniquePrintableLabels.map(async (label) => {
    if (label.imageDataUrl) return { ...label, imageUrl: "" };
    const imageDataUrl = await labelImageDataUrl(label);
    return {
      ...label,
      imageDataUrl,
      imageUrl: imageDataUrl ? "" : createLabelFileUrl(req, label.id)
    };
  }));
  return {
    ...listed,
    data: {
      labels,
      total: uniquePrintableLabels.length,
      filtered: uniquePrintableLabels.length
    }
  };
}

function shouldRegisterPrintableSkippedLabel(code, parsed) {
  const awb = String(parsed?.awb || "").trim();
  if (!awb) return false;
  return [
    "SKU_REQUIRED",
    "PRODUCT_NAME_REQUIRED",
    "QTY_REQUIRED",
    "ORDER_NUMBER_REQUIRED"
  ].includes(String(code || "").trim());
}

function resolveSkippedLabelStatus(code) {
  const normalized = String(code || "").trim();
  if (normalized === "ORDER_NUMBER_REQUIRED") return "manual-required";
  return "ready";
}

function requireAnyPermission(token, permissions = []) {
  let lastResult = null;
  for (const permission of permissions) {
    const result = authService.requirePermission(token, permission);
    if (result.ok) return result;
    if (!lastResult || ["AUTH_REQUIRED", "SESSION_EXPIRED"].includes(result.code)) lastResult = result;
  }
  return lastResult || apiErrorPayload("FORBIDDEN", "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้");
}

async function labelImageDataUrl(label) {
  const relativePath = label.relativePath || "";
  if (!relativePath) return "";
  const filePath = path.resolve(rootDir, relativePath);
  if (!filePath.startsWith(rootDir)) return "";
  const type = contentType(filePath);
  if (!type.startsWith("image/")) return "";
  try {
    const content = await fs.readFile(filePath);
    return `data:${type};base64,${content.toString("base64")}`;
  } catch {
    return "";
  }
}

function createLabelFileUrl(req, labelId) {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${port}`;
  return `${protocol}://${host}/api/labels/file/${encodeURIComponent(labelId)}`;
}

async function serveLabelFile(req, res, url) {
  const labelId = decodeURIComponent(url.pathname.replace("/api/labels/file/", ""));
  const result = labelService.getLabel(labelId);
  if (!result.ok) return sendResult(res, result);
  const label = result.data;
  const relativePath = label.relativePath || label.originalRelativePath || "";
  if (!relativePath) {
    sendJson(res, 404, apiErrorPayload("LABEL_FILE_NOT_FOUND", "ใบปะหน้านี้ไม่มีไฟล์ต้นฉบับ"));
    return;
  }

  const filePath = path.resolve(rootDir, relativePath);
  if (!filePath.startsWith(rootDir)) {
    sendJson(res, 403, apiErrorPayload("LABEL_PATH_FORBIDDEN", "path ใบปะหน้าไม่ปลอดภัย"));
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    sendBuffer(res, 200, content, label.contentType || contentType(filePath));
  } catch {
    sendJson(res, 404, apiErrorPayload("LABEL_FILE_MISSING", "ไม่พบไฟล์ใบปะหน้าบน storage"));
  }
}

async function serveStatic(res, requestPath) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    sendBuffer(res, 200, content, contentType(filePath));
  } catch {
    const fallback = await fs.readFile(path.join(publicDir, "index.html"));
    sendBuffer(res, 200, fallback, "text/html; charset=utf-8");
  }
}

async function readJson(req, maxBytes = jsonBodyLimitBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("JSON request body too large");
      error.code = "JSON_TOO_LARGE";
      error.maxBytes = maxBytes;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

async function readBinary(req, maxBytes, tooLargeCode = "VIDEO_TOO_LARGE") {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(tooLargeCode);
      error.code = tooLargeCode;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sanitizeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function safeFileExt(fileName, type = "") {
  const ext = path.extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".pdf"].includes(ext)) return ext;
  if (String(type).includes("png")) return ".png";
  if (String(type).includes("jpeg")) return ".jpg";
  if (String(type).includes("webp")) return ".webp";
  if (String(type).includes("pdf")) return ".pdf";
  return ".png";
}

function safeImageExt(fileName, type = "") {
  const ext = path.extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  if (String(type).includes("jpeg")) return ".jpg";
  if (String(type).includes("webp")) return ".webp";
  return ".png";
}

function toCompactDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
}

function withoutRawText(parsed) {
  const { rawText, ...publicParsed } = parsed;
  return publicParsed;
}

function labelImportTargetId(data = {}) {
  const importedAwb = data.imported?.find((entry) => entry.order?.awb)?.order.awb;
  const skippedAwb = data.skipped?.find((entry) => entry.parsed?.awb)?.parsed.awb;
  return importedAwb || skippedAwb || data.order?.awb || "";
}

function labelImportActivityDetails(data = {}) {
  const importedCount = data.importedCount ?? data.imported?.length ?? 0;
  const skippedCount = data.skippedCount ?? data.skipped?.length ?? 0;
  const errorCount = data.errorCount ?? data.errors?.length ?? 0;
  const firstPlatform = data.imported?.find((entry) => entry.parsed?.platformLabel)?.parsed.platformLabel
    || data.skipped?.find((entry) => entry.parsed?.platformLabel)?.parsed.platformLabel
    || data.parsed?.platformLabel
    || "-";
  return `นำเข้าใบปะหน้า ${importedCount} ใหม่ / ${skippedCount} ซ้ำ / ${errorCount} error (${firstPlatform})`;
}

function resolveRuntimePath(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(rootDir, value);
}

function readBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || "";
}

function resolvePrinterDiscovery() {
  if (mode === "test" && process.env.SMARTRECORD_TEST_PRINTER_DISCOVERY === "success") {
    return async () => ({
      ok: true,
      data: {
        printers: [{
          id: "system:test-cups-printer",
          label: "Test CUPS Printer",
          systemName: "test-cups-printer",
          source: "system"
        }]
      },
      message: "พบเครื่องพิมพ์ NAS / CUPS 1 เครื่อง"
    });
  }
  return discoverNasCupsPrinters;
}

function resolveStorageVerification() {
  const fixture = mode === "test" ? process.env.SMARTRECORD_TEST_STORAGE_VERIFICATION : "";
  if (!fixture) return verifyStorageDestination;
  return async ({ storageTarget }) => {
    const targetLabel = storageTarget?.label || "ปลายทางจัดเก็บ";
    if (fixture === "success") {
      return {
        ok: true,
        data: {
          status: "available",
          targetLabel,
          writable: true,
          message: "SmartRecord server ตรวจสอบปลายทางจัดเก็บและเขียนไฟล์ทดสอบได้"
        }
      };
    }
    if (fixture === "mount-unavailable") {
      return {
        ok: false,
        code: "STORAGE_MOUNT_UNAVAILABLE",
        message: "ปลายทาง NAS ยังต้องตั้งค่าหรือ mount บน SmartRecord server ก่อนตรวจสอบได้"
      };
    }
    if (fixture === "not-writable") {
      return {
        ok: false,
        code: "STORAGE_NOT_WRITABLE",
        message: "ปลายทางจัดเก็บไม่อนุญาตให้ SmartRecord server เขียนไฟล์"
      };
    }
    return {
      ok: false,
      code: "STORAGE_VERIFICATION_FAILED",
      message: "ตรวจสอบปลายทางจัดเก็บไม่สำเร็จ กรุณาลองใหม่หรือตรวจการตั้งค่าบน server"
    };
  };
}

function resolveOcrDiagnostics() {
  const fixture = mode === "test" ? process.env.SMARTRECORD_TEST_OCR_DIAGNOSTICS : "";
  if (!fixture) return () => inspectOcrDiagnostics({ ocrConfig: config.ocr });
  return async () => {
    if (fixture === "not-configured") return inspectOcrDiagnostics({ ocrConfig: null });
    if (fixture === "unavailable") return inspectOcrDiagnostics({
      ocrConfig: config.ocr,
      probeRuntime: async () => ({ available: false })
    });
    if (fixture === "invalid-timeout") return inspectOcrDiagnostics({
      ocrConfig: { ...config.ocr, preprocessPdf: { ...config.ocr?.preprocessPdf, enabled: true, timeoutMs: "invalid" } },
      probeRuntime: async () => ({ available: true })
    });
    if (fixture === "unexpected") return inspectOcrDiagnostics({
      ocrConfig: config.ocr,
      probeRuntime: async () => { throw new Error(`diagnostic secret at ${process.cwd()} node_modules`); }
    });
    return inspectOcrDiagnostics({
      ocrConfig: { ...config.ocr, preprocessPdf: { ...config.ocr?.preprocessPdf, enabled: true } },
      probeRuntime: async () => ({ available: true })
    });
  };
}

function safeDiagnosticFailure() {
  return {
    checkedAt: new Date().toISOString(),
    overallStatus: "unavailable",
    checks: {
      server: { status: "ready", code: "SERVER_READY", message: "SmartRecord server พร้อมให้บริการ" },
      ocr: { status: "unavailable", code: "OCR_DIAGNOSTIC_FAILED", message: "ตรวจสอบ OCR runtime ไม่สำเร็จ" },
      ocrConfiguration: { status: "degraded", code: "OCR_DIAGNOSTIC_FAILED", message: "ตรวจสอบการตั้งค่า OCR ไม่สำเร็จ" },
      ocrTimeout: { status: "degraded", code: "OCR_DIAGNOSTIC_FAILED", message: "ตรวจสอบ OCR timeout ไม่สำเร็จ" }
    }
  };
}

function sendResult(res, result) {
  sendJson(res, statusForResult(result), normalizeApiResult(result));
}

function sendJson(res, status, payload) {
  sendText(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function normalizeApiResult(result = {}) {
  if (result.ok) return result;
  const code = result.code || result.error || "API_ERROR";
  const message = authErrorMessage(code, result.message);
  return {
    ...result,
    ok: false,
    code,
    error: code,
    message
  };
}

function apiErrorPayload(code, message, extra = {}) {
  return normalizeApiResult({
    ok: false,
    code,
    message,
    ...extra
  });
}

function authErrorMessage(code, message) {
  if (code === "AUTH_REQUIRED" || code === "SESSION_EXPIRED") return "Please login again";
  return message || "Request failed";
}

function statusForResult(result = {}) {
  if (result.ok) return 200;
  const code = result.code || result.error || "";
  if (code === "AUTH_REQUIRED" || code === "SESSION_EXPIRED" || code === "INVALID_LOGIN") return 401;
  if (code === "FORBIDDEN" || code === "SYSTEM_ADMIN_REQUIRED" || code.endsWith("_FORBIDDEN")) return 403;
  if (code === "NOT_FOUND" || code.endsWith("_NOT_FOUND")) return 404;
  if (code.endsWith("_EXISTS")) return 409;
  if (code.endsWith("_TOO_LARGE")) return 413;
  if (code === "SERVER_ERROR") return 500;
  return 400;
}

function logStartupFailure(step, error) {
  console.error(`[startup] ${serviceName} failed during ${step}`);
  console.error(`[startup] mode=${mode} host=${host} port=${port}`);
  console.error(`[startup] ${error?.stack || error?.message || error}`);
}

function sendBuffer(res, status, payload, type) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function sendText(res, status, payload, type) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  return "text/html; charset=utf-8";
}
