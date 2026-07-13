export function normalizeOrderNumber(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

export function buildImportResultSummary(data = {}) {
  const imported = Array.isArray(data.imported) ? data.imported : [];
  const successfulRows = imported.length
    ? imported
    : (data.order ? [{ order: data.order, parsed: data.parsed }] : []);
  const importedLabelCount = successfulRows.length;
  const skippedCount = Number(data.skippedCount || 0);
  const uniqueOrderNumbers = new Set(
    successfulRows
      .map((item) => normalizeOrderNumber(
        item?.order?.orderNumber ?? item?.parsed?.orderNumber ?? item?.orderNumber
      ))
      .filter(Boolean)
  );
  const orderCreated = successfulRows.filter((item) => item?.orderState === "created").length;
  const orderAlreadyExists = successfulRows.filter((item) => item?.orderState === "already_exists").length;
  const labelCreated = successfulRows.filter((item) => item?.labelState === "created").length;
  const labelAlreadyExists = successfulRows.filter((item) => item?.labelState === "already_exists").length;
  const labelFailed = successfulRows.filter((item) => item?.labelState === "failed").length;
  const hasExplicitStates = orderCreated + orderAlreadyExists + labelCreated + labelAlreadyExists + labelFailed > 0;

  if (importedLabelCount > 0) {
    if (hasExplicitStates) {
      const outcomes = [
        orderCreated ? `สร้างออเดอร์ ${orderCreated}` : "",
        orderAlreadyExists ? `ออเดอร์มีอยู่แล้ว ${orderAlreadyExists}` : "",
        labelCreated ? `เพิ่มใบปะหน้าสำหรับพิมพ์แล้ว ${labelCreated}` : "",
        labelAlreadyExists ? `ใบปะหน้าสำหรับพิมพ์มีอยู่แล้ว ${labelAlreadyExists}` : "",
        labelFailed ? `ใบปะหน้าสำหรับพิมพ์ผิดพลาด ${labelFailed}` : ""
      ].filter(Boolean);
      return {
        importedLabelCount,
        uniqueOrderCount: uniqueOrderNumbers.size,
        skippedCount,
        tone: labelFailed ? "warning" : "success",
        message: `${outcomes.join(" · ")}${skippedCount ? ` · ขัดแย้ง/ข้าม ${skippedCount} รายการ` : ""}`
      };
    }
    const message = `นำเข้าใบปะหน้าสำเร็จ ${importedLabelCount} รายการ · ${uniqueOrderNumbers.size} คำสั่งซื้อ`;
    return {
      importedLabelCount,
      uniqueOrderCount: uniqueOrderNumbers.size,
      skippedCount,
      tone: "success",
      message: skippedCount ? `${message} · ซ้ำ/ข้าม ${skippedCount} รายการ` : message
    };
  }

  return {
    importedLabelCount: 0,
    uniqueOrderCount: 0,
    skippedCount,
    tone: skippedCount ? "warning" : "",
    message: `ไม่มีออเดอร์ใหม่ · ซ้ำ/ข้าม ${skippedCount} รายการ`
  };
}
