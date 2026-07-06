export const DUPLICATE_ORDER_CODES = Object.freeze([
  "ORDER_ALREADY_EXISTS",
  "ORDER_DUPLICATE_LABEL",
  "ORDER_AWB_CONFLICT"
]);

export function validateOrderIdentity({ orders, awb, orderNumber, ignoreAwb = "" } = {}) {
  const cleanAwb = String(awb || "").trim();
  const cleanOrderNumber = String(orderNumber || "").trim();
  const ignoredAwb = String(ignoreAwb || "").trim();
  const existingOrder = cleanAwb ? orders?.[cleanAwb] : null;

  if (cleanAwb && !cleanOrderNumber) {
    return fail(
      "ORDER_NUMBER_REQUIRED",
      `AWB ${cleanAwb} ต้องมีเลขออเดอร์ orderNumber เสมอ`,
      { awb: cleanAwb, orderNumber: cleanOrderNumber }
    );
  }

  if (existingOrder && cleanAwb !== ignoredAwb) {
    return duplicateOrderFailure({ existingOrder, awb: cleanAwb, orderNumber: cleanOrderNumber });
  }

  return null;
}

export function findAwbByOrderNumber({ orders, orderNumber, ignoreAwb = "" } = {}) {
  const cleanOrderNumber = String(orderNumber || "").trim();
  const ignoredAwb = String(ignoreAwb || "").trim();
  if (!cleanOrderNumber || !orders) return "";

  return Object.entries(orders).find(([awb, order]) => {
    const existingAwb = String(awb || "").trim();
    if (!existingAwb || existingAwb === ignoredAwb) return false;
    return String(order?.orderNumber || "").trim() === cleanOrderNumber;
  })?.[0] || "";
}

export function findAwbsByOrderNumber({ orders, orderNumber, ignoreAwb = "" } = {}) {
  const cleanOrderNumber = String(orderNumber || "").trim();
  const ignoredAwb = String(ignoreAwb || "").trim();
  if (!cleanOrderNumber || !orders) return [];

  return Object.entries(orders)
    .filter(([awb, order]) => {
      const existingAwb = String(awb || "").trim();
      if (!existingAwb || existingAwb === ignoredAwb) return false;
      return String(order?.orderNumber || "").trim() === cleanOrderNumber;
    })
    .map(([awb]) => awb);
}

function duplicateOrderFailure({ existingOrder, awb, orderNumber }) {
  const existingOrderNumber = String(existingOrder?.orderNumber || "").trim();
  const hasBothOrderNumbers = Boolean(orderNumber && existingOrderNumber);

  if (hasBothOrderNumbers && existingOrderNumber === orderNumber) {
    return fail(
      "ORDER_DUPLICATE_LABEL",
      `เลขออเดอร์ ${orderNumber} + AWB ${awb} อยู่ใน ORDER_DB แล้ว ห้ามสแกน/นำเข้าซ้ำ`,
      { awb, orderNumber, existingOrderNumber }
    );
  }

  if (hasBothOrderNumbers && existingOrderNumber !== orderNumber) {
    return fail(
      "ORDER_AWB_CONFLICT",
      `AWB ${awb} อยู่ใน ORDER_DB แล้ว แต่เลขออเดอร์ไม่ตรง: เดิม ${existingOrderNumber} / ใหม่ ${orderNumber}`,
      { awb, orderNumber, existingOrderNumber }
    );
  }

  return fail("ORDER_ALREADY_EXISTS", `AWB ${awb} อยู่ใน ORDER_DB แล้ว ห้ามสแกน/นำเข้าซ้ำ`, {
    awb,
    orderNumber,
    existingOrderNumber
  });
}

function fail(code, message, data = null) {
  return { ok: false, code, message, data };
}
