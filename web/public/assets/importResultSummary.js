export function normalizeOrderNumber(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

export function buildImportResultSummary(data = {}) {
  const imported = Array.isArray(data.imported) ? data.imported : [];
  const importedLabelCount = imported.length || Number(data.importedCount || (data.order ? 1 : 0));
  const skippedCount = Number(data.skippedCount || 0);
  const successfulRows = imported.length ? imported : (data.order ? [{ order: data.order, parsed: data.parsed }] : []);
  const uniqueOrderNumbers = new Set(
    successfulRows
      .map((item) => normalizeOrderNumber(
        item?.order?.orderNumber ?? item?.parsed?.orderNumber ?? item?.orderNumber
      ))
      .filter(Boolean)
  );

  if (importedLabelCount > 0) {
    return {
      importedLabelCount,
      uniqueOrderCount: uniqueOrderNumbers.size,
      skippedCount,
      tone: "success",
      message: `นำเข้าใบปะหน้าสำเร็จ ${importedLabelCount} รายการ · ${uniqueOrderNumbers.size} คำสั่งซื้อ`
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
