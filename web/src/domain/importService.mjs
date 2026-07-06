import { findAwbsByOrderNumber, validateOrderIdentity } from "./orderIdentityService.mjs";

const PLATFORM_LABELS = {
  shopee: "Shopee",
  lazada: "Lazada",
  tiktok: "TikTok Shop",
  custom: "ทั่วไป",
  "3pl": "ทั่วไป"
};

export function createImportService({ orders, syncOrders, demoMode = false } = {}) {
  if (!orders) throw new Error("orders is required");
  if (!syncOrders) throw new Error("syncOrders is required");

  const pool = syncOrders.map((order) => ({ ...order, alreadyIn: Boolean(orders[order.awb] || order.alreadyIn) }));
  const draftLabelImports = [];
  const connectionStatus = { shopee: false, lazada: false, tiktok: false, "3pl": false };

  function testConnection({ platform } = {}) {
    if (!connectionStatus[platform]) {
      return ok(mockConnection(platform));
    }
    return ok({ ...mockConnection(platform), saved: true });
  }

  function saveConnection({ platform } = {}) {
    if (!Object.hasOwn(connectionStatus, platform)) return fail("PLATFORM_NOT_SUPPORTED", "ไม่รองรับแพลตฟอร์มนี้");
    connectionStatus[platform] = true;
    return ok({ platform, connected: true });
  }

  function sync({ platform = "all", status = "ready" } = {}) {
    let result = [...draftLabelImports, ...pool];
    if (platform !== "all") result = result.filter((order) => order.platform === platform);
    if (status !== "all") result = result.filter((order) => order.status === status);
    return ok({
      orders: result.map((order) => toSyncOrder(order)),
      connected: { ...connectionStatus }
    });
  }

function toSyncOrder(order) {
  const storedOrder = orders[order.awb];
  const firstItem = storedOrder?.items?.[0];
  const orderItemLines = Array.isArray(order.itemLines)
    ? order.itemLines.length
    : (order.itemLines || order.items || 0);
  return {
    ...order,
    alreadyIn: Boolean(storedOrder || order.alreadyIn),
      platformLabel: storedOrder?.platform || PLATFORM_LABELS[order.platform] || order.platform,
      buyer: storedOrder?.buyer || order.buyer || "",
      orderNumber: storedOrder?.orderNumber || order.orderNumber || "",
      carrier: storedOrder?.carrier || order.carrier || "",
      importedAt: storedOrder?.importedAt || storedOrder?.labelFile?.importedAt || order.importedAt || "",
      itemLines: storedOrder?.items?.length || orderItemLines,
      sku: firstItem?.sku || order.sku || "",
      productName: firstItem?.name || order.productName || "",
      barcode: firstItem?.barcode || order.barcode || ""
    };
  }

  function importOrders({ awbs = [] } = {}) {
    const imported = [];
    const skipped = [];
    const importedAt = new Date().toISOString();
    for (const awb of awbs) {
      const meta = pool.find((order) => order.awb === awb);
      if (!meta) {
        skipped.push({ awb, reason: "not_found" });
        continue;
      }
      const identityFailure = validateOrderIdentity({ orders, awb, orderNumber: meta.orderNumber });
      if (identityFailure) {
        skipped.push({
          awb,
          reason: "duplicate_or_conflict",
          code: identityFailure.code,
          message: identityFailure.message,
          orderNumber: meta.orderNumber || ""
        });
        meta.alreadyIn = true;
        continue;
      }
      const linkedAwbs = findAwbsByOrderNumber({ orders, orderNumber: meta.orderNumber });
      const allowMultiAwb = linkedAwbs.length > 0;
      const itemsResult = resolveOrderItems({ meta, awb, itemLines: meta.itemLines, count: meta.items, demoMode });
      if (!itemsResult.ok) {
        skipped.push({
          awb,
          reason: "item_validation_failed",
          code: itemsResult.code,
          message: itemsResult.message,
          orderNumber: meta.orderNumber || ""
        });
        continue;
      }
      orders[awb] = {
        platform: PLATFORM_LABELS[meta.platform] ?? "ทั่วไป",
        buyer: meta.buyer,
        orderNumber: meta.orderNumber || "",
        carrier: meta.carrier || "",
        importedAt,
        items: itemsResult.data
      };
      meta.alreadyIn = true;
      meta.importedAt = importedAt;
      imported.push({
        awb,
        platform: orders[awb].platform,
        itemLines: orders[awb].items.length,
        allowMultiAwb,
        linkedOrderNumber: meta.orderNumber || "",
        linkedAwbs
      });
    }
    return ok({ imported, skipped, importedCount: imported.length });
  }

  function createManualOrder({ awb = "", platform = "custom", buyer = "", items = 1, orderNumber = "", carrier = "", itemLines = [], labelFile = null, allowBlankSku = false } = {}) {
    const cleanAwb = String(awb).trim();
    const cleanPlatform = String(platform).trim().toLowerCase();
    const cleanBuyer = String(buyer).trim();
    const cleanOrderNumber = String(orderNumber || "").trim();
    const itemCount = Number(items);
    const cleanedItemLines = normalizeItemLinesWithOptions(itemLines, cleanAwb, { allowBlankSku });

    if (!cleanAwb) return fail("AWB_REQUIRED", "กรุณากรอกเลข AWB / Order ID");
    if (!Object.hasOwn(PLATFORM_LABELS, cleanPlatform)) return fail("PLATFORM_NOT_SUPPORTED", "ไม่รองรับแพลตฟอร์มนี้");
    if (!cleanBuyer) return fail("BUYER_REQUIRED", "กรุณากรอกชื่อลูกค้า / ร้านค้า");
    const identityFailure = validateOrderIdentity({ orders, awb: cleanAwb, orderNumber: cleanOrderNumber });
    if (identityFailure) return identityFailure;
    const itemsResult = resolveOrderItems({
      awb: cleanAwb,
      itemLines: cleanedItemLines,
      count: itemCount,
      demoMode,
      allowBlankSku
    });
    if (!itemsResult.ok) return itemsResult;

    const meta = {
      awb: cleanAwb,
      platform: cleanPlatform,
      buyer: cleanBuyer,
      items: itemsResult.data.length,
      status: "ready",
      orderNumber: cleanOrderNumber,
      carrier: String(carrier || "").trim(),
      labelFile,
      importedAt: labelFile?.importedAt || new Date().toISOString()
    };
    const linkedAwbs = findAwbsByOrderNumber({ orders, orderNumber: cleanOrderNumber });
    const allowMultiAwb = Boolean(cleanOrderNumber && linkedAwbs.length);

    orders[cleanAwb] = {
      platform: PLATFORM_LABELS[cleanPlatform] ?? "ทั่วไป",
      buyer: cleanBuyer,
      orderNumber: meta.orderNumber,
      carrier: meta.carrier,
      labelFile,
      importedAt: meta.importedAt,
      items: itemsResult.data
    };
    pool.unshift({ ...meta, alreadyIn: true, manual: true, labelImport: Boolean(labelFile) });

    const successMessage = allowMultiAwb
      ? `เพิ่มพัสดุใหม่ ${cleanAwb} ให้กับออเดอร์เดิม ${cleanOrderNumber}`
      : "";

    return ok({
      awb: cleanAwb,
      platform: orders[cleanAwb].platform,
      buyer: cleanBuyer,
      orderNumber: meta.orderNumber,
      carrier: meta.carrier,
      itemLines: orders[cleanAwb].items.length,
      importedAt: meta.importedAt,
      labelFile,
      allowMultiAwb,
      linkedAwbs
    }, successMessage);
  }

  function createOrderFromShippingLabel({ parsed, labelFile = null } = {}) {
    if (!parsed) return fail("LABEL_DATA_REQUIRED", "ไม่พบข้อมูลใบปะหน้าที่อ่านได้");
    if (!String(parsed.productName || "").trim()) {
      return fail("PRODUCT_NAME_REQUIRED", "อ่านใบปะหน้าได้บางส่วน แต่ไม่มีชื่อสินค้า กรุณาแก้ไข/กรอกข้อมูลก่อนนำเข้า", { parsed });
    }
    if (!Number.isInteger(Number(parsed.quantity)) || Number(parsed.quantity) < 1) {
      return fail("QTY_REQUIRED", "อ่านใบปะหน้าได้บางส่วน แต่ไม่มีจำนวนสินค้า กรุณาแก้ไข/กรอกข้อมูลก่อนนำเข้า", { parsed });
    }
    const missingSku = !String(parsed.sku || "").trim();
    const created = createManualOrder({
      awb: parsed.awb,
      platform: parsed.platform,
      buyer: parsed.customerName || "ไม่พบชื่อลูกค้า",
      orderNumber: parsed.orderNumber,
      carrier: parsed.carrier,
      items: parsed.quantity,
      itemLines: [{
        sku: parsed.sku,
        name: parsed.productName,
        qty: parsed.quantity,
        barcode: parsed.sku || parsed.awb
      }],
      labelFile,
      allowBlankSku: missingSku
    });
    if (!created.ok) return created;

    if (missingSku) {
      const warning = "ไม่มี SKU กรุณาแก้ไข/กรอกข้อมูล หรือไม่กรอกก็ได้";
      return {
        ...created,
        message: created.message ? `${created.message} · ${warning}` : warning
      };
    }

    return created;
  }

  function saveDraftLabelImport({ parsed = {}, labelFile = null, code = "", message = "" } = {}) {
    const cleanAwb = String(parsed.awb || "").trim();
    if (!cleanAwb) return fail("AWB_REQUIRED", "กรุณากรอกเลข AWB / Order ID");

    const platform = normalizePlatform(String(parsed.platform || parsed.platformLabel || "custom").trim().toLowerCase());
    const qty = Number(parsed.quantity || 0);
    const normalizedQty = Number.isInteger(qty) && qty > 0 ? qty : 1;
    const draft = {
      awb: cleanAwb,
      platform,
      buyer: String(parsed.customerName || "ไม่พบชื่อลูกค้า").trim(),
      items: normalizedQty,
      status: "draft",
      alreadyIn: true,
      orderNumber: String(parsed.orderNumber || "").trim(),
      carrier: String(parsed.carrier || "").trim(),
      importedAt: labelFile?.importedAt || new Date().toISOString(),
      labelFile,
      labelImport: true,
      draft: true,
      draftCode: String(code || "").trim(),
      draftMessage: String(message || "").trim(),
      itemLines: parsed.sku || parsed.productName || parsed.quantity ? 1 : 0,
      sku: String(parsed.sku || "").trim(),
      productName: String(parsed.productName || "").trim(),
      barcode: String(parsed.sku || parsed.awb || "").trim()
    };

    const index = draftLabelImports.findIndex((item) => item.awb === cleanAwb);
    if (index >= 0) draftLabelImports[index] = draft;
    else draftLabelImports.unshift(draft);
    return ok(toSyncOrder(draft));
  }

  function updateImportedOrder({ awb = "", platform = "", buyer = "", orderNumber = "", carrier = "", itemLines = [] } = {}) {
    const cleanAwb = String(awb).trim();
    const order = orders[cleanAwb];
    const draftIndex = draftLabelImports.findIndex((item) => item.awb === cleanAwb);
    const draft = draftIndex >= 0 ? draftLabelImports[draftIndex] : null;
    if (!cleanAwb || (!order && !draft)) return fail("ORDER_NOT_FOUND", "ไม่พบออเดอร์ที่ต้องการแก้ไข");

    const meta = pool.find((item) => item.awb === cleanAwb) || draft;
    const cleanPlatform = String(platform || draft?.platform || order?.platform || "").trim().toLowerCase();
    const cleanBuyer = String(buyer ?? draft?.buyer ?? order?.buyer ?? "").trim();
    const cleanOrderNumber = String(orderNumber ?? draft?.orderNumber ?? order?.orderNumber ?? "").trim();
    const cleanCarrier = String(carrier ?? draft?.carrier ?? order?.carrier ?? "").trim();
    const cleanedItemLines = normalizeItemLinesWithOptions(itemLines, cleanAwb, { allowBlankSku: true });

    if (!Object.hasOwn(PLATFORM_LABELS, cleanPlatform)) return fail("PLATFORM_NOT_SUPPORTED", "ไม่รองรับแพลตฟอร์มนี้");
    if (!cleanBuyer) return fail("BUYER_REQUIRED", "กรุณากรอกชื่อลูกค้า / ร้านค้า");
    if (!cleanOrderNumber) return fail("ORDER_NUMBER_REQUIRED", "AWB ต้องมีเลขออเดอร์");
    const identityFailure = validateOrderIdentity({
      orders,
      awb: cleanAwb,
      orderNumber: cleanOrderNumber,
      ignoreAwb: cleanAwb
    });
    if (identityFailure) return identityFailure;

    if (draft) {
      draft.platform = cleanPlatform;
      draft.buyer = cleanBuyer;
      draft.orderNumber = cleanOrderNumber;
      draft.carrier = cleanCarrier;
      draft.items = cleanedItemLines.length || draft.items || 1;
      draft.itemLines = cleanedItemLines.length || draft.itemLines || 0;
      draft.sku = cleanedItemLines[0]?.sku || "";
      draft.productName = cleanedItemLines[0]?.name || "";
      draft.barcode = cleanedItemLines[0]?.barcode || cleanAwb;
      draft.draftCode = "";
      draft.draftMessage = "";

      if (cleanedItemLines.length === 0) {
        return ok(toSyncOrder(draft), "บันทึกร่างใบปะหน้าแล้ว");
      }

      orders[cleanAwb] = {
        platform: PLATFORM_LABELS[cleanPlatform] ?? "ทั่วไป",
        buyer: cleanBuyer,
        orderNumber: cleanOrderNumber,
        carrier: cleanCarrier,
        labelFile: draft.labelFile || null,
        importedAt: draft.importedAt || new Date().toISOString(),
        items: cleanedItemLines
      };
      draftLabelImports.splice(draftIndex, 1);
    } else {
      order.platform = PLATFORM_LABELS[cleanPlatform] ?? "ทั่วไป";
      order.buyer = cleanBuyer;
      order.orderNumber = cleanOrderNumber;
      order.carrier = cleanCarrier;
      order.items = cleanedItemLines;
    }

    if (meta) {
      meta.platform = cleanPlatform;
      meta.buyer = cleanBuyer;
      meta.orderNumber = cleanOrderNumber;
      meta.carrier = cleanCarrier;
      meta.items = cleanedItemLines.length;
      meta.itemLines = cleanedItemLines.length;
      meta.sku = cleanedItemLines[0]?.sku || "";
      meta.productName = cleanedItemLines[0]?.name || "";
      meta.barcode = cleanedItemLines[0]?.barcode || "";
      meta.alreadyIn = true;
      if ("draft" in meta) {
        meta.draft = false;
        meta.status = "ready";
      }
    }

    return ok(toSyncOrder({
      ...(meta || { awb: cleanAwb, platform: cleanPlatform, status: "ready" }),
      alreadyIn: true
    }));
  }

  function deleteImportedOrder({ awb = "" } = {}) {
    const cleanAwb = String(awb).trim();
    const order = orders[cleanAwb];
    const draftIndex = draftLabelImports.findIndex((item) => item.awb === cleanAwb);
    if (!cleanAwb || (!order && draftIndex < 0)) return fail("ORDER_NOT_FOUND", "ไม่พบออเดอร์ที่ต้องการลบ");

    if (order) delete orders[cleanAwb];
    if (draftIndex >= 0) draftLabelImports.splice(draftIndex, 1);

    const poolIndex = pool.findIndex((item) => item.awb === cleanAwb);
    if (poolIndex >= 0) {
      const poolOrder = pool[poolIndex];
      if (poolOrder.manual || poolOrder.labelImport) {
        pool.splice(poolIndex, 1);
      } else {
        pool[poolIndex] = {
          ...poolOrder,
          alreadyIn: false,
          importedAt: "",
          orderNumber: poolOrder.orderNumber || "",
          carrier: poolOrder.carrier || ""
        };
      }
    }

    return ok({ awb: cleanAwb });
  }

  function listImportedAwbs() {
    return new Set(
      [...draftLabelImports, ...pool]
        .filter((item) => item.alreadyIn)
        .map((item) => String(item.awb || "").trim())
        .filter(Boolean)
    );
  }

  return {
    testConnection,
    saveConnection,
    sync,
    importOrders,
    createManualOrder,
    createOrderFromShippingLabel,
    saveDraftLabelImport,
    updateImportedOrder,
    deleteImportedOrder,
    listImportedAwbs
  };
}

function normalizePlatform(platform) {
  if (Object.hasOwn(PLATFORM_LABELS, platform)) return platform;
  const text = String(platform || "").toLowerCase();
  if (text.includes("shopee")) return "shopee";
  if (text.includes("lazada")) return "lazada";
  if (text.includes("tiktok")) return "tiktok";
  return "custom";
}

function buildItems(meta) {
  return Array.from({ length: meta.items }, (_, index) => {
    const template = ITEM_TEMPLATES[index % ITEM_TEMPLATES.length];
    return {
      sku: `${template.sku}-${meta.awb.slice(-3)}`,
      name: `${template.name} (${meta.awb.slice(-4)})`,
      qty: template.qty,
      barcode: String(Number(template.barcode) + index + meta.awb.length).padStart(13, "0")
    };
  });
}

function normalizeItemLines(lines, awb) {
  return normalizeItemLinesWithOptions(lines, awb, {});
}

function normalizeItemLinesWithOptions(lines, awb, { allowBlankSku = false } = {}) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((line) => {
      const sku = String(line?.sku || "").trim().toUpperCase();
      const name = String(line?.name || line?.productName || "").trim();
      const qty = Number(line?.qty || line?.quantity || 0);
      const barcode = String(line?.barcode || sku || awb).trim();
      if ((!allowBlankSku && !sku) || !name) return null;
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) return null;
      if (!barcode) return null;
      return {
        sku,
        name,
        qty,
        barcode
      };
    })
    .filter(Boolean);
}

function resolveOrderItems({ meta = null, awb = "", itemLines = [], count = 0, demoMode = false, allowBlankSku = false } = {}) {
  const normalized = normalizeItemLinesWithOptions(itemLines, awb || meta?.awb || "", { allowBlankSku });
  if (normalized.length > 0) return ok(normalized);

  if (demoMode) {
    const generated = buildDemoItems(meta || { awb, items: count });
    if (generated.length > 0) return ok(generated);
  }

  return fail("ITEM_DETAILS_REQUIRED", "ต้องมี SKU, ชื่อสินค้า และจำนวนสินค้า ครบทุกบรรทัดก่อนนำเข้า");
}

function buildDemoItems(meta) {
  const count = Number(meta?.items || 0);
  const awb = String(meta?.awb || "").trim();
  if (!Number.isInteger(count) || count < 1 || count > 50 || !awb) return [];
  return Array.from({ length: count }, (_, index) => ({
    sku: `DEMO-${awb}-${index + 1}`,
    name: `Demo Item ${index + 1} (${awb})`,
    qty: 1,
    barcode: `${awb}-${index + 1}`
  }));
}

function mockConnection(platform) {
  const responses = {
    shopee: { platform, ok: true, message: "เชื่อมต่อสำเร็จ: Shopee · ออเดอร์รอแพค 14 รายการ" },
    lazada: { platform, ok: true, message: "เชื่อมต่อสำเร็จ: Lazada · ออเดอร์รอแพค 7 รายการ" },
    tiktok: { platform, ok: false, message: "Access Token หมดอายุ: กรุณา Re-authorize TikTok Shop" },
    "3pl": { platform, ok: true, message: "เชื่อมต่อ WMS/3PL สำเร็จ · ออเดอร์ PENDING_PACK 22 รายการ" }
  };
  return responses[platform] ?? { platform, ok: false, message: "ไม่รองรับแพลตฟอร์มนี้" };
}

function ok(data, message = "") {
  return { ok: true, data, message };
}

function fail(code, message, data = null) {
  return { ok: false, code, message, data };
}
