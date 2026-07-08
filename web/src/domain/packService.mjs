import crypto from "node:crypto";

export function createPackService({ config, orders, records: initialRecords, now = () => new Date(), idFactory } = {}) {
  if (!config) throw new Error("config is required");
  if (!orders) throw new Error("orders is required");

  const sessions = new Map();
  const records = Array.isArray(initialRecords)
    ? initialRecords
    : (config.reports?.seedHistoricalRecords ? seedHistoricalRecords(config, now) : []);
  const nextId = idFactory ?? (() => crypto.randomUUID());

  function startPackSession({ awb, platform, employeeId, stationId, storageTargetId } = {}) {
    const cleanAwb = String(awb ?? "").trim();
    if (!cleanAwb) return fail("AWB_REQUIRED", "กรุณาสแกนเลข AWB หรือเลขออเดอร์");

    const order = orders[cleanAwb];
    if (!order) return fail("ORDER_NOT_FOUND", "ไม่พบออเดอร์นี้ในระบบ");
    if (config.packFlow?.requireLabelBeforePack && !hasShippingLabel(order)) {
      return fail(
        "LABEL_REQUIRED_BEFORE_PACK",
        "ต้องมีใบปะหน้าจาก Connect / Import ก่อน จึงจะเริ่มสแกน AWB เพื่อแพคได้"
      );
    }
    const selectedPlatform = normalizePlatform(platform || order.platform);
    if (!selectedPlatform) return fail("PLATFORM_REQUIRED", "กรุณาเลือก Platform ก่อนเริ่มแพค");
    const storageTarget = resolveStorageTarget(config, storageTargetId);

    const session = {
      id: nextId(),
      awb: cleanAwb,
      platform: selectedPlatform,
      buyer: order.buyer ?? "",
      employeeId: employeeId || config.employees.defaultEmployeeId,
      stationId: stationId || config.station.defaultStationId,
      storageTargetId: storageTarget.id,
      labelFile: publicLabelFile(order.labelFile),
      startedAt: now().toISOString(),
      status: "packing",
      forceCloseReason: null,
      items: order.items.map((item, index) => ({
        lineId: String(index + 1),
        sku: item.sku,
        name: item.name,
        qty: item.qty,
        barcode: item.barcode,
        scannedQty: 0
      })),
      events: []
    };

    session.events.push(event("session_started", { awb: cleanAwb }, now));
    sessions.set(session.id, session);
    return ok(toPublicSession(session, config));
  }

  function scanCode({ sessionId, code } = {}) {
    const session = sessions.get(String(sessionId ?? ""));
    if (!session) return fail("SESSION_NOT_FOUND", "ไม่พบ pack session");
    if (session.status !== "packing") return fail("SESSION_CLOSED", "session นี้ปิดแล้ว");

    const cleanCode = String(code ?? "").trim();
    if (!cleanCode) return fail("SCAN_CODE_REQUIRED", "ไม่มีข้อมูลบาร์โค้ด");

    const item = session.items.find((candidate) => {
      const sku = String(candidate.sku || "").trim().toLowerCase();
      return candidate.barcode === cleanCode || (sku && sku === cleanCode.toLowerCase());
    });

    const awbMatchesOpenItem = cleanCode === session.awb && item && item.scannedQty < item.qty;
    if (config.packFlow.closeBoxByRescanningAwb && cleanCode === session.awb && !awbMatchesOpenItem) {
      return requestClose(session);
    }

    if (!item) {
      session.events.push(event("scan_rejected", { code: cleanCode, reason: "not_in_order" }, now));
      return fail("ITEM_NOT_IN_ORDER", "ไม่พบสินค้านี้ในออเดอร์", toPublicSession(session, config));
    }

    if (item.scannedQty >= item.qty) {
      session.events.push(event("scan_rejected", { code: cleanCode, sku: item.sku, reason: "over_scan" }, now));
      return fail("ITEM_ALREADY_COMPLETE", "สินค้ารายการนี้สแกนครบแล้ว", toPublicSession(session, config));
    }

    item.scannedQty += 1;
    session.events.push(event("item_scanned", { code: cleanCode, sku: item.sku, scannedQty: item.scannedQty }, now));
    return ok(toPublicSession(session, config), `บันทึกสินค้า: ${item.name}`);
  }

  function closePackSession({ sessionId, force = false, reason = "" } = {}) {
    const session = sessions.get(String(sessionId ?? ""));
    if (!session) return fail("SESSION_NOT_FOUND", "ไม่พบ pack session");
    if (session.status !== "packing") return fail("SESSION_CLOSED", "session นี้ปิดแล้ว");

    const summary = getSummary(session);
    if (summary.missingLineCount > 0) {
      if (!force) return fail("MISSING_ITEMS", "สินค้ายังสแกนไม่ครบ", toPublicSession(session, config));
      if (!config.packFlow.allowForceCloseWithMissingItems) {
        return fail("FORCE_CLOSE_DISABLED", "ระบบไม่อนุญาตให้ปิดกล่องก่อนครบ", toPublicSession(session, config));
      }
      if (config.packFlow.requireReasonForForceClose && !String(reason).trim()) {
        return fail("FORCE_CLOSE_REASON_REQUIRED", "กรุณาระบุเหตุผลในการปิดกล่องก่อนครบ", toPublicSession(session, config));
      }
      session.forceCloseReason = String(reason).trim();
    }

    const endedAt = now();
    session.status = summary.missingLineCount > 0 ? "closed_with_missing_items" : "closed_pass";
    session.endedAt = endedAt.toISOString();
    session.events.push(event("session_closed", { status: session.status }, now));

    const durationSeconds = Math.max(0, Math.round((endedAt.getTime() - new Date(session.startedAt).getTime()) / 1000));
    const storageTarget = resolveStorageTarget(config, session.storageTargetId);
    const record = {
      id: nextId(),
      awb: session.awb,
      platform: session.platform,
      employeeId: session.employeeId,
      stationId: session.stationId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationSeconds,
      status: session.status === "closed_pass" ? "pass" : "warn",
      itemSummary: `${summary.scannedLineCount}/${summary.totalLineCount} รายการ`,
      sizeMb: Number((Math.max(1, durationSeconds) * 1.35 + 4.2).toFixed(1)),
      storage: {
        targetId: session.storageTargetId,
        label: storageTarget.label,
        provider: storageTarget.provider,
        host: storageTarget.host
      },
      shareLink: null,
      forceCloseReason: session.forceCloseReason
    };

    records.unshift(record);
    return ok({ session: toPublicSession(session, config), record });
  }

  function listRecords() {
    return records.map((record) => ({ ...record, storage: { ...record.storage } }));
  }

  function attachVideoToRecord({ recordId, video } = {}) {
    const record = records.find((candidate) => candidate.id === recordId);
    if (!record) return fail("RECORD_NOT_FOUND", "ไม่พบ record สำหรับผูกไฟล์วิดีโอ");
    record.video = { ...video };
    record.shareLink = video.shareLink || record.shareLink || createShareLink(config, record.awb, nextId());
    return ok({ ...record, storage: { ...record.storage }, video: { ...record.video } });
  }

  function getSession(sessionId) {
    const session = sessions.get(String(sessionId ?? ""));
    if (!session) return fail("SESSION_NOT_FOUND", "ไม่พบ pack session");
    return ok(toPublicSession(session, config));
  }

  return {
    startPackSession,
    scanCode,
    closePackSession,
    listRecords,
    getSession,
    attachVideoToRecord
  };
}

function requestClose(session) {
  const summary = getSummary(session);
  if (summary.missingLineCount > 0) {
    return fail("MISSING_ITEMS", "สินค้ายังสแกนไม่ครบ ต้องยืนยันพร้อมเหตุผลก่อนปิดกล่อง", {
      session: toPublicSession(session),
      missingItems: session.items.filter((item) => item.scannedQty < item.qty)
    });
  }
  return ok({
    closeRequested: true,
    session: toPublicSession(session)
  }, "สแกน AWB ซ้ำแล้ว พร้อมปิดกล่อง");
}

function toPublicSession(session, config = {}) {
  return {
    id: session.id,
    awb: session.awb,
    platform: session.platform,
    buyer: session.buyer,
    employeeId: session.employeeId,
    stationId: session.stationId,
    storageTargetId: session.storageTargetId,
    labelFile: session.labelFile,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    status: session.status,
    forceCloseReason: session.forceCloseReason,
    items: session.items.map((item) => ({ ...item })),
    summary: getSummary(session),
    closeByAwbEnabled: config.packFlow?.closeBoxByRescanningAwb ?? true
  };
}

function getSummary(session) {
  const totalLineCount = session.items.length;
  const scannedLineCount = session.items.filter((item) => item.scannedQty >= item.qty).length;
  const totalQty = session.items.reduce((sum, item) => sum + item.qty, 0);
  const scannedQty = session.items.reduce((sum, item) => sum + item.scannedQty, 0);
  return {
    totalLineCount,
    scannedLineCount,
    missingLineCount: totalLineCount - scannedLineCount,
    totalQty,
    scannedQty,
    progressPct: totalLineCount === 0 ? 0 : Math.round((scannedLineCount / totalLineCount) * 100)
  };
}

function createShareLink(config, awb, id) {
  const safeAwb = awb.replace(/[^a-zA-Z0-9-]/g, "");
  return `${config.shareLinks.publicBaseUrl}/v/${safeAwb}-${String(id).slice(0, 8)}`;
}

export function resolveStorageTarget(config, storageTargetId) {
  const targets = config.upload?.storageTargets ?? [];
  const fallbackId = config.upload?.defaultStorageTargetId;
  const target = targets.find((candidate) => candidate.id === storageTargetId)
    ?? targets.find((candidate) => candidate.id === fallbackId)
    ?? targets.find((candidate) => candidate.isDefault)
    ?? targets[0]
    ?? {
      id: "legacy-nas",
      label: "NAS",
      provider: config.upload.provider,
      host: config.upload.nasHost,
      localPath: config.upload.localNasPath
    };
  return target;
}

function seedHistoricalRecords(config, now) {
  const count = config.reports?.seedHistoricalCount ?? 26;
  const employees = config.employees?.list ?? [{ id: config.employees.defaultEmployeeId, name: config.employees.defaultEmployeeName }];
  const platforms = ["Shopee", "Lazada", "custom"];
  const prefixes = { Shopee: "SPX-TH-", Lazada: "LZD-2026-", custom: "ORD-MANUAL-" };
  const base = now();
  return Array.from({ length: count }, (_, index) => {
    const platform = platforms[index % platforms.length];
    const durationSeconds = 38 + (index * 17) % 155;
    const employee = employees[index % employees.length];
    const timestamp = new Date(base.getTime() - (index % 30) * 86400000 - (index % 8) * 3600000);
    const awb = `${prefixes[platform]}${String(10000000 + index * 738291).slice(0, 8)}`;
    return {
      id: `seed_${index}`,
      awb,
      platform,
      employeeId: `${employee.name} (${employee.id})`,
      stationId: config.station.defaultStationId,
      startedAt: timestamp.toISOString(),
      endedAt: new Date(timestamp.getTime() + durationSeconds * 1000).toISOString(),
      durationSeconds,
      status: index % 13 === 0 ? "warn" : "pass",
      itemSummary: `${2 + (index % 4)} รายการ`,
      sizeMb: Number((durationSeconds * 1.35 + (index % 6)).toFixed(1)),
      storage: {
        provider: config.upload.provider,
        host: config.upload.nasHost
      },
      shareLink: createShareLink(config, awb, `seed${index}`),
      forceCloseReason: index % 13 === 0 ? "ข้อมูลตัวอย่าง: ปิดก่อนครบ" : null
    };
  });
}

function normalizePlatform(platform) {
  const value = String(platform ?? "").trim();
  const normalized = value.toLowerCase().replace(/\s+/g, "");
  const aliases = {
    shopee: "Shopee",
    lazada: "Lazada",
    tiktok: "Tiktok",
    tiktokshop: "Tiktok",
    custom: "custom",
    "3pl": "custom",
    "ทั่วไป": "custom"
  };
  return aliases[normalized] || "";
}

function hasShippingLabel(order) {
  const labelFile = order?.labelFile;
  return Boolean(labelFile && (labelFile.relativePath || labelFile.pageImageRelativePath || labelFile.fileName));
}

function publicLabelFile(labelFile) {
  if (!labelFile) return null;
  return {
    fileName: labelFile.fileName || "",
    relativePath: labelFile.pageImageRelativePath || labelFile.relativePath || "",
    importedAt: labelFile.importedAt || "",
    contentType: labelFile.contentType || ""
  };
}

function event(type, payload, now) {
  return {
    type,
    payload,
    at: now().toISOString()
  };
}

function ok(data, message = "") {
  return { ok: true, data, message };
}

function fail(code, message, data = null) {
  return { ok: false, code, message, data };
}
