import assert from "node:assert/strict";
import test from "node:test";
import { buildImportResultSummary } from "../public/assets/importResultSummary.js";

function importedLabel(awb, orderNumber) {
  return {
    parsed: { awb, orderNumber },
    order: { awb, orderNumber }
  };
}

test("summarizes 4 successful labels belonging to 2 unique orders", () => {
  const result = buildImportResultSummary({
    imported: [
      importedLabel("AWB-001", "ORDER-001"),
      importedLabel("AWB-002", "ORDER-001"),
      importedLabel("AWB-003", "ORDER-002"),
      importedLabel("AWB-004", "ORDER-002")
    ],
    importedCount: 99,
    skippedCount: 0
  });

  assert.equal(result.importedLabelCount, 4);
  assert.equal(result.uniqueOrderCount, 2);
  assert.equal(result.message, "นำเข้าใบปะหน้าสำเร็จ 4 รายการ · 2 คำสั่งซื้อ");
});

test("summarizes 1 successful label belonging to 1 order", () => {
  const result = buildImportResultSummary({
    imported: [importedLabel("AWB-001", "ORDER-001")]
  });

  assert.equal(result.importedLabelCount, 1);
  assert.equal(result.uniqueOrderCount, 1);
  assert.equal(result.message, "นำเข้าใบปะหน้าสำเร็จ 1 รายการ · 1 คำสั่งซื้อ");
});

test("normalizes the same order number across multiple successful labels", () => {
  const result = buildImportResultSummary({
    imported: [
      importedLabel("AWB-001", " order-001 "),
      importedLabel("AWB-002", "ORDER-001"),
      importedLabel("AWB-003", "ORDER - 001")
    ]
  });

  assert.equal(result.importedLabelCount, 3);
  assert.equal(result.uniqueOrderCount, 1);
  assert.equal(result.message, "นำเข้าใบปะหน้าสำเร็จ 3 รายการ · 1 คำสั่งซื้อ");
});

test("does not show a success summary when no labels were imported", () => {
  const result = buildImportResultSummary({
    imported: [],
    importedCount: 0,
    skippedCount: 4
  });

  assert.equal(result.importedLabelCount, 0);
  assert.equal(result.uniqueOrderCount, 0);
  assert.equal(result.message, "ไม่มีออเดอร์ใหม่ · ซ้ำ/ข้าม 4 รายการ");
});

test("keeps duplicate and skipped information for a mixed import batch", () => {
  const result = buildImportResultSummary({
    imported: [
      importedLabel("AWB-001", "ORDER-001"),
      importedLabel("AWB-002", "ORDER-001"),
      importedLabel("AWB-003", "ORDER-002")
    ],
    skippedCount: 1
  });

  assert.equal(result.importedLabelCount, 3);
  assert.equal(result.uniqueOrderCount, 2);
  assert.equal(result.message, "นำเข้าใบปะหน้าสำเร็จ 3 รายการ · 2 คำสั่งซื้อ · ซ้ำ/ข้าม 1 รายการ");
});

test("does not treat importedCount as a success source when imported rows are missing", () => {
  const result = buildImportResultSummary({
    importedCount: 4,
    skippedCount: 4
  });

  assert.equal(result.importedLabelCount, 0);
  assert.equal(result.uniqueOrderCount, 0);
  assert.equal(result.message, "ไม่มีออเดอร์ใหม่ · ซ้ำ/ข้าม 4 รายการ");
});

test("counts only successful rows when errors are present", () => {
  const result = buildImportResultSummary({
    imported: [importedLabel("AWB-001", "ORDER-001")],
    errors: [{ page: 2, code: "LABEL_IMPORT_FAILED" }]
  });

  assert.equal(result.importedLabelCount, 1);
  assert.equal(result.uniqueOrderCount, 1);
  assert.equal(result.message, "นำเข้าใบปะหน้าสำเร็จ 1 รายการ · 1 คำสั่งซื้อ");
});

test("uses the legacy single-order fallback when imported rows are unavailable", () => {
  const result = buildImportResultSummary({
    order: { awb: "AWB-001", orderNumber: "ORDER-001" },
    parsed: { awb: "AWB-001", orderNumber: "ORDER-001" }
  });

  assert.equal(result.importedLabelCount, 1);
  assert.equal(result.uniqueOrderCount, 1);
  assert.equal(result.message, "นำเข้าใบปะหน้าสำเร็จ 1 รายการ · 1 คำสั่งซื้อ");
});
