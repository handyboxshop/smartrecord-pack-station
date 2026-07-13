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

  function createManualOrder({ awb = "", platform = "custom", buyer = "", items = 1, orderNumber = "", carrier = "", itemLines = [], labelFile = null, allowBlankSku = false, reviewRequired = false } = {}) {
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
      importedAt: labelFile?.importedAt || new Date().toISOString(),
      ...(reviewRequired ? { reviewRequired: true } : {})
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
      items: itemsResult.data,
      ...(reviewRequired ? { reviewRequired: true } : {})
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
      linkedAwbs,
      ...(reviewRequired ? { reviewRequired: true } : {})
    }, successMessage);
  }

  function createOrderFromShippingLabel({ parsed, labelFile = null } = {}) {
    if (!parsed) return fail("LABEL_DATA_REQUIRED", "ไม่พบข้อมูลใบปะหน้าที่อ่านได้");
    const awb = String(parsed.awb || "").trim();
    if (!awb) return fail("AWB_REQUIRED", "กรุณากรอกเลข AWB / Order ID");

    const platform = normalizePlatform(parsed.platform || parsed.platformLabel || "custom");
    const buyer = String(parsed.customerName || "").trim() || "Unverified customer";
    const orderNumber = String(parsed.orderNumber || "").trim() || `AWB-${awb}`;
    const identityFailure = validateOrderIdentity({ orders, awb, orderNumber });
    if (identityFailure) {
      if (identityFailure.code === "ORDER_DUPLICATE_LABEL") {
        const existing = orders[awb];
        return ok({
          awb,
          platform: existing?.platform || PLATFORM_LABELS[platform] || "ทั่วไป",
          buyer: existing?.buyer || buyer,
          orderNumber,
          carrier: existing?.carrier || String(parsed.carrier || "").trim(),
          itemLines: Array.isArray(existing?.items) ? existing.items.length : 0,
          importedAt: existing?.importedAt || existing?.labelFile?.importedAt || "",
          reviewRequired: Boolean(existing?.reviewRequired),
          orderState: "already_exists"
        }, "ออเดอร์มีอยู่แล้ว");
      }
      return {
        ...identityFailure,
        data: {
          ...(identityFailure.data || {}),
          orderState: "conflict"
        }
      };
    }

    const sku = String(parsed.sku || "").trim();
    const productName = String(parsed.productName || "").trim() || "Unverified item from shipping label";
    const parsedQuantity = Number(parsed.quantity);
    const hasValidOcrQuantity = Number.isInteger(parsedQuantity) && parsedQuantity > 0;
    const quantity = hasValidOcrQuantity
      ? parsedQuantity
      : 1;
    const reviewRequired = !String(parsed.platform || parsed.platformLabel || "").trim()
      || !hasValidOcrQuantity
      || requiresOrderReview({
        platform,
        buyer,
        orderNumber,
        itemLines: [{ sku, name: productName, qty: quantity, barcode: sku || awb }],
        submittedItemLines: [{ sku, name: productName, qty: quantity, barcode: sku || awb }]
      });
    const created = createManualOrder({
      awb,
      platform,
      buyer,
      orderNumber,
      carrier: parsed.carrier,
      items: quantity,
      itemLines: [{
        sku,
        name: productName,
        qty: quantity,
        barcode: sku || awb
      }],
      labelFile,
      allowBlankSku: !sku,
      reviewRequired
    });
    if (!created.ok) return created;

    const createdWithState = {
      ...created,
      data: {
        ...created.data,
        orderState: "created"
      }
    };

    if (reviewRequired) {
      const warning = "นำเข้าด้วยข้อมูลสำรอง กรุณาตรวจสอบข้อมูลออเดอร์ภายหลัง";
      return {
        ...createdWithState,
        message: created.message ? `${created.message} · ${warning}` : warning
      };
    }

    return createdWithState;
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
    const reviewRequired = requiresOrderReview({
      platform: cleanPlatform,
      buyer: cleanBuyer,
      orderNumber: cleanOrderNumber,
      itemLines: cleanedItemLines,
      submittedItemLines: itemLines
    });

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
      applyReviewRequired(draft, reviewRequired);

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
        items: cleanedItemLines,
        ...(reviewRequired ? { reviewRequired: true } : {})
      };
      draftLabelImports.splice(draftIndex, 1);
    } else {
      order.platform = PLATFORM_LABELS[cleanPlatform] ?? "ทั่วไป";
      order.buyer = cleanBuyer;
      order.orderNumber = cleanOrderNumber;
      order.carrier = cleanCarrier;
      order.items = cleanedItemLines;
      applyReviewRequired(order, reviewRequired);
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
      applyReviewRequired(meta, reviewRequired);
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

function requiresOrderReview({ platform = "", buyer = "", orderNumber = "", itemLines = [], submittedItemLines = [] } = {}) {
  const cleanPlatform = String(platform || "").trim().toLowerCase();
  const cleanBuyer = String(buyer || "").trim();
  const cleanOrderNumber = String(orderNumber || "").trim();
  if (!Object.hasOwn(PLATFORM_LABELS, cleanPlatform)) return true;
  if (cleanBuyer === "Unverified customer") return true;
  if (/^AWB-/i.test(cleanOrderNumber)) return true;
  if (!Array.isArray(itemLines) || itemLines.length === 0) return true;

  return itemLines.some((item, index) => {
    const sku = String(item?.sku || "").trim();
    const name = String(item?.name || item?.productName || "").trim();
    const qty = Number(item?.qty || item?.quantity || 0);
    const submittedBarcode = String(submittedItemLines?.[index]?.barcode || "").trim();
    return name === "Unverified item from shipping label"
      || !Number.isInteger(qty)
      || qty < 1
      || (!sku && !submittedBarcode);
  });
}

function applyReviewRequired(record, reviewRequired) {
  if (!record) return;
  if (reviewRequired) record.reviewRequired = true;
  else delete record.reviewRequired;
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
