const PLATFORM_LABELS = {
  shopee: "Shopee",
  lazada: "Lazada",
  tiktok: "TikTok Shop"
};

export function parseShippingLabelText(input = "") {
  const batch = parseShippingLabelTexts(input);
  if (!batch.ok) return batch;
  return ok(batch.data.labels[0]);
}

export function parseShippingLabelTexts(input = "") {
  const text = normalizeOcrText(input);
  if (!text) return fail("LABEL_TEXT_REQUIRED", "ไม่พบข้อความจาก OCR");

  const platform = detectPlatform(text);
  if (!platform) {
    const awb = extractRecoverableAwb(text);
    return fail(
      "LABEL_PLATFORM_UNKNOWN",
      "แยกแพลตฟอร์มจากใบปะหน้าไม่ได้",
      awb ? incompleteLabel({ awb, rawText: text }) : null
    );
  }

  if (platform === "tiktok") {
    const labels = parseTiktokBatch(text);
    if (labels.length > 1) return ok({ labels });
  }

  const parser = {
    shopee: parseShopee,
    lazada: parseLazada,
    tiktok: parseTiktok
  }[platform];
  const parsed = parser(text);
  const quantity = normalizeQuantity(parsed.quantity);
  const fields = {
    platform,
    platformLabel: PLATFORM_LABELS[platform],
    orderNumber: cleanCode(parsed.orderNumber),
    awb: cleanCode(parsed.awb),
    customerName: cleanText(parsed.customerName),
    sku: cleanCode(parsed.sku),
    productName: cleanProductName(parsed.productName),
    quantity,
    carrier: cleanText(parsed.carrier),
    rawText: text
  };

  if (!fields.awb) return fail("LABEL_AWB_NOT_FOUND", "อ่านเลขพัสดุ AWB จากใบปะหน้าไม่ได้", fields);
  if (!fields.orderNumber) return fail("LABEL_ORDER_NOT_FOUND", "อ่านเลขออเดอร์จากใบปะหน้าไม่ได้", fields);
  if (!fields.customerName) fields.customerName = "";
  if (!fields.sku) fields.sku = "";
  return ok({ labels: [fields] });
}

export function detectPlatform(input = "") {
  const text = normalizeOcrText(input);
  if (hasStrongTiktokMarker(text) || countTiktokSecondarySignals(text) >= 2) return "tiktok";
  if (/\bLEX\b|LAZADA\s+Order\s+Number|lazada/i.test(text)) return "lazada";
  if (/shopee(?:\s+order\s+no\.?)?/i.test(text)) return "shopee";
  return "";
}

function parseShopee(text) {
  return {
    awb: matchFirst(text, [/\b(TH[A-Z0-9]{8,})\b/i]),
    orderNumber: matchFirst(text, [/Shopee\s+Order\s+No\.?\s*([A-Z0-9-]+)/i]),
    customerName: matchFirst(text, [/ผู้รับ\s*\([^)]*\)\s*([^\n]+)/i, /TO\)\s*([^\n]+)/i]),
    sku: "",
    productName: extractShopeeProductName(text),
    quantity: matchFirst(text, [/จ[ํำ]า?นวนรวม\s*(\d+)/i, /Qty\s+Total:?\s*(\d+)/i, /จ[ํำ]า?นวน\s*\n?\s*(\d+)/i]),
    carrier: /flash|express/i.test(text) ? "Flash Express" : ""
  };
}

function parseLazada(text) {
  return {
    awb: matchFirst(text, [/\b(LEXD?[A-Z0-9]{8,})\b/i]),
    orderNumber: matchFirst(text, [/LAZADA\s+Order\s+Number:?\s*([0-9]{10,})/i, /Order\s+No\.?:?\s*([0-9]{10,})/i]),
    customerName: matchFirst(text, [/Customer\s+NAME:?\s*([^\n]+)/i, /Receiver:?\s*([^\n]+)/i]),
    sku: extractLazadaSku(text),
    productName: extractLazadaProductName(text),
    quantity: matchFirst(text, [
      /Name\s+Qty\s+SKU[\s\S]*?\n\s*.+?\s+(\d+)\s+[A-Z0-9-]{4,}(?:\s+\d[\d.,]*)?/i,
      /Qty\s+SKU[\s\S]*?\n\s*(\d+)\s+[A-Z0-9-]{4,}/i,
      /\bQty\b[\s\S]*?\n\s*(\d+)\s+[A-Z0-9-]{4,}/i
    ]),
    carrier: "LEX"
  };
}

function parseTiktok(text) {
  const orderNumber = matchFirst(text, [/Order\s+ID:?\s*([0-9]{12,})/i]);
  const awb = extractTiktokAwb(text, orderNumber);
  return {
    awb,
    orderNumber,
    customerName: matchFirst(text, [/ถึง\s*([^\n(:]+)/i, /สง\s+([^\n:]+)/i]),
    sku: matchFirst(text, [/\b((?=[0-9A-Z]*[A-Z])[0-9A-Z]{2,}-[0-9A-Z-]{1,})\b/i]),
    productName: extractTiktokProductName(text),
    quantity: matchFirst(text, [/Qty\s+Total:?\s*(\d+)/i, /Seller\s+SKU\s+Qty[\s\S]*?\b(\d+)\s*$/im]),
    carrier: /J&T|express|veress/i.test(text) ? "J&T Express" : ""
  };
}

function parseTiktokBatch(text) {
  const orderNumbers = uniqueMatches(text, /Order\s+ID:?\s*([0-9]{12,})/gi).map(cleanCode);
  if (orderNumbers.length <= 1) return [];
  const awbs = uniqueMatches(text, /\b(JTTH[A-Z0-9-]{8,}|[0-9]{11,13})\b/gi)
    .map(cleanCode)
    .filter((code) => !orderNumbers.includes(code));
  const skus = uniqueMatches(text, /\b((?=[0-9A-Z]*[A-Z])[0-9A-Z]{2,}-[0-9A-Z-]{1,})\b/gi).map(cleanCode);
  const productNames = extractTiktokBatchProductNames(text, skus);
  const qtys = uniqueMatches(text, /Qty\s+Total:?\s*(\d+)/gi).map((value) => normalizeQuantity(value));
  const carrier = /J&T|express|veress/i.test(text) ? "J&T Express" : "";

  return orderNumbers.map((orderNumber, index) => ({
    platform: "tiktok",
    platformLabel: PLATFORM_LABELS.tiktok,
    orderNumber,
    awb: awbs[index] || "",
    customerName: "",
    sku: skus[index] || "",
    productName: productNames[index] || "",
    quantity: qtys[index] || 1,
    carrier,
    rawText: text
  })).filter((label) => label.awb && label.orderNumber);
}

function normalizeOcrText(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractRecoverableAwb(text) {
  const direct = cleanCode(matchFirst(text, [
    /\b(TH[A-Z0-9]{8,})\b/i,
    /\b(LEXD?[A-Z0-9]{8,})\b/i,
    /\b(JTTH[A-Z0-9-]{8,})\b/i,
    /(?:AWB|Tracking(?:\s+(?:No|Number))?|Waybill)\s*[:#]?\s*([A-Z0-9-]{8,})\b/i
  ]));
  if (direct) return direct;

  const orderNumbers = new Set(uniqueMatches(text, /Order\s+ID:?\s*([0-9]{12,})/gi));
  return cleanCode(uniqueMatches(text, /\b([0-9]{11,13})\b/g)
    .find((code) => !orderNumbers.has(code)) || "");
}

function extractTiktokAwb(text, orderNumber) {
  const codes = uniqueMatches(text, /\b(JTTH[A-Z0-9-]{8,}|[0-9]{11,13})\b/gi).map(cleanCode);
  return codes.find((code) => code !== cleanCode(orderNumber)) || "";
}

function hasStrongTiktokMarker(text) {
  const compact = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return /t[i1l]k+t[o0]k+sh[o0][pob0]/.test(compact);
}

function countTiktokSecondarySignals(text) {
  const signals = [
    /\bJTTH[A-Z0-9-]{8,}\b/i,
    /Order\s+I[D0]\s*:?\s*[0-9]{12,}/i,
    /\bJ\s*[&+]\s*T\b|\bJT\s*Express\b/i,
    /Product\s+Name\s+SKU\s+Seller\s+SKU\s+Qty|Qty\s+Total|Shipping\s+Date|Estimated\s+Date|In\s+transit\s+by/i
  ];
  return signals.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function incompleteLabel({ awb = "", rawText = "" } = {}) {
  return {
    platform: "",
    platformLabel: "",
    orderNumber: "",
    awb,
    customerName: "",
    sku: "",
    productName: "",
    quantity: 0,
    carrier: "",
    rawText
  };
}

function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return "";
}

function uniqueMatches(text, pattern) {
  const seen = new Set();
  const values = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[1];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function extractShopeeProductName(text) {
  const section = matchFirst(text, [
    /(?:#\s*)?ชื่อสินค้า\s+ตัวเลือกสินค้า\s+จ[ํำ]า?นวน\s*\n\s*([\s\S]+?)(?:\n\s*(?:ฉนตอ|Shopee\s+Order|Total|จ[ํำ]า?นวนรวม)\b|$)/i,
    /Product\s+Name[\s\S]*?\n\s*([^\n]+)/i
  ]);
  return stripProductNoise(section);
}

function extractLazadaProductName(text) {
  const fromTable = matchFirst(text, [
    /\|\s*(.+?)\s+\|,\s+\[?\s*[S3]CWDO-C2G-/i,
    /Name\s+Qty\s+SKU[\s\S]*?\n\s*(.+?)\s+\d+\s+[A-Z0-9-]{4,}/i,
    /Product\s+Name[\s\S]*?\n\s*(.+?)\s+\d+\s+[A-Z0-9-]{4,}/i
  ]);
  return stripProductNoise(fromTable);
}

function extractLazadaSku(text) {
  const fragmented = /\[?\s*([S3]CWDO-C2G-)\s*\|[\s\S]{0,120}?\n\|?\s*ELECTRIC\s+(\d{2})/i.exec(text);
  if (fragmented) return `${fragmented[1]}${fragmented[2]}`;
  const direct = matchFirst(text, [
    /\b([S3]CWDO-C2G-\s*\|?\s*\d{2})\b/i,
    /\b(\d[A-Z0-9]{2,}-[A-Z0-9-]{2,})\b/i,
    /Qty\s+SKU[\s\S]*?\d+\s+([A-Z0-9-]{4,})/i
  ]);
  return direct;
}

function extractTiktokProductName(text) {
  const fromTable = matchFirst(text, [
    /Product\s+Name\s+SKU\s+Seller\s+SKU\s+Qty\s*\n\s*([\s\S]+?)\s+\d+\s+(?=[0-9A-Z]*[A-Z])[0-9A-Z]{2,}-[0-9A-Z-]{1,}\s+\d+/i
  ]);
  return stripProductNoise(fromTable);
}

function extractTiktokBatchProductNames(text, skus = []) {
  if (skus.length === 0) return [];
  const section = matchFirst(text, [
    /Product\s+Name\s+SKU\s+Seller\s+SKU\s+Qty\s+Product\s+Name\s+SKU\s+Seller\s+SKU\s+Qty\s*([\s\S]+?)Qty\s+Total/i,
    /Product\s+Name\s+SKU\s+Seller\s+SKU\s+Qty\s*([\s\S]+?)Qty\s+Total/i
  ]);
  if (!section) return [];

  const names = [];
  let cursor = 0;
  for (const sku of skus) {
    const skuIndex = section.indexOf(sku, cursor);
    if (skuIndex < 0) {
      names.push("");
      continue;
    }
    const beforeSku = section.slice(cursor, skuIndex).replace(/\s+\d+\s*$/, "");
    names.push(stripProductNoise(beforeSku));
    const afterSku = section.slice(skuIndex + sku.length);
    const qtyMatch = /^\s+\d+/.exec(afterSku);
    cursor = skuIndex + sku.length + (qtyMatch?.[0].length || 0);
  }
  return names;
}

function stripProductNoise(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/จ[ํำ]า?นวนรวม|Qty\s+Total|Total:/i.test(line))
    .filter((line) => !/^(?:ฉนตอ|Shopee\s+Order\b|LAZADA\s+Order\s+Number\b|Order\s+ID\b)/i.test(line))
    .filter((line) => !/^\d+\s*[.,|]*\s*\d*\s*\([^)]*\)\s*\d*$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/[|[\],]+/g, " ")
    .replace(/^#\s*/, "")
    .replace(/^\d+\s+/, "")
    .replace(/\s+\d+\s*$/, "")
    .trim();
}

function cleanCode(value) {
  const code = String(value || "").trim().replace(/\s+/g, "").toUpperCase();
  if (/^THO[0-9A-Z]{8,}$/.test(code)) return `TH0${code.slice(3)}`;
  if (/^SCW[A-Z0-9-]+$/.test(code)) return `3${code.slice(1)}`;
  if (/^([S3]CWDO-C2G-)\|?(\d{2})$/.test(code)) return code.replace(/^S/i, "3").replace("|", "");
  return code;
}

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function cleanProductName(value) {
  return cleanText(value).slice(0, 240);
}

function normalizeQuantity(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const qty = Number(raw.replace(/[^0-9]/g, ""));
  return Number.isInteger(qty) && qty > 0 ? qty : 0;
}

function ok(data) {
  return { ok: true, data };
}

function fail(code, message, data = null) {
  return { ok: false, code, message, data };
}
