import assert from "node:assert/strict";
import test from "node:test";
import { createLabelService } from "../src/domain/labelService.mjs";

const sampleConfig = {
  labelPrint: {
    enabledPlatforms: ["shopee", "tiktok", "lazada"],
    acceptedImageTypes: ["image/jpeg", "image/png"],
    maxImageSizeMb: 5
  }
};

const tinyPngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("saveLabel stores a valid manual label and listLabels returns it newest-first", () => {
  const service = createLabelService({ config: sampleConfig, idFactory: () => "test-id-1" });

  const result = service.saveLabel({
    platform: "shopee",
    date: "2026-06-24",
    imageDataUrl: tinyPngDataUrl,
    fileName: "label.png"
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.platform, "shopee");
  assert.equal(result.data.id, "LBL-TESTID1");
  assert.equal(result.data.fileName, "label.png");

  const list = service.listLabels();
  assert.equal(list.data.labels.length, 1);
  assert.equal(list.data.labels[0].id, result.data.id);
});

test("saveLabel rejects a platform outside the configured enabledPlatforms list", () => {
  const service = createLabelService({ config: sampleConfig });

  const result = service.saveLabel({
    platform: "3pl",
    date: "2026-06-24",
    imageDataUrl: tinyPngDataUrl
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PLATFORM_NOT_SUPPORTED");
});

test("saveLabel rejects missing date and missing image with distinct codes", () => {
  const service = createLabelService({ config: sampleConfig });

  const missingDate = service.saveLabel({ platform: "shopee", imageDataUrl: tinyPngDataUrl });
  assert.equal(missingDate.ok, false);
  assert.equal(missingDate.code, "LABEL_DATE_REQUIRED");

  const missingImage = service.saveLabel({ platform: "shopee", date: "2026-06-24" });
  assert.equal(missingImage.ok, false);
  assert.equal(missingImage.code, "LABEL_IMAGE_REQUIRED");
});

test("saveLabel rejects an image larger than the configured max size", () => {
  const service = createLabelService({
    config: { labelPrint: { ...sampleConfig.labelPrint, maxImageSizeMb: 0.00001 } }
  });

  const result = service.saveLabel({
    platform: "shopee",
    date: "2026-06-24",
    imageDataUrl: tinyPngDataUrl
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "LABEL_IMAGE_TOO_LARGE");
});

test("saveLabel rejects an unsupported image mime type", () => {
  const service = createLabelService({ config: sampleConfig });

  const result = service.saveLabel({
    platform: "shopee",
    date: "2026-06-24",
    imageDataUrl: "data:image/bmp;base64,Zm9v"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "LABEL_IMAGE_TYPE_NOT_SUPPORTED");
});

test("registerImportedLabel stores Connect / Import label metadata for printing", () => {
  const service = createLabelService({ config: sampleConfig, idFactory: () => "import-id-1" });

  const result = service.registerImportedLabel({
    parsed: {
      platform: "shopee",
      awb: "TH01288T6C4J4A",
      orderNumber: "2606047GU07A12",
      customerName: "ธนงศักดิ์ บุญโสม",
      carrier: "Flash Express"
    },
    labelFile: {
      fileName: "shipping-label.png",
      relativePath: "local-nas/labels/2026-06/source.png",
      pageImageRelativePath: "local-nas/labels/2026-06/page-1.png",
      importedAt: "2026-06-24T08:00:00.000Z",
      contentType: "image/png",
      bytes: 1200
    },
    order: { awb: "TH01288T6C4J4A", platform: "shopee" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.id, "LBL-IMPORTID1");
  assert.equal(result.data.source, "connect-import");
  assert.equal(result.data.awb, "TH01288T6C4J4A");
  assert.equal(result.data.orderNumber, "2606047GU07A12");
  assert.equal(result.data.relativePath, "local-nas/labels/2026-06/page-1.png");
  assert.equal(result.data.originalRelativePath, "local-nas/labels/2026-06/source.png");
  assert.equal(result.data.date, "2026-06-24");

  const found = service.getLabel(result.data.id);
  assert.equal(found.ok, true);
  assert.equal(found.data.carrier, "Flash Express");
});

test("listLabels hides skipped imported labels so duplicate uploads never appear in print page", () => {
  const service = createLabelService({ config: sampleConfig, idFactory: () => "import-id-skip" });

  service.registerImportedLabel({
    parsed: {
      platform: "shopee",
      awb: "TH23018SMKA02G",
      orderNumber: "260529NR16YYRH",
      customerName: "ไรจันทร์ / 6",
      carrier: "Flash Express"
    },
    labelFile: {
      fileName: "shipping-label-page-1.png",
      relativePath: "local-nas/labels/2026-06/source.pdf",
      pageImageRelativePath: "local-nas/labels/2026-06/page-1.png",
      importedAt: "2026-06-30T07:38:49.000Z",
      contentType: "image/png",
      bytes: 1200
    },
    status: "skipped"
  });

  const list = service.listLabels();
  assert.equal(list.ok, true);
  assert.equal(list.data.total, 0);
  assert.equal(list.data.filtered, 0);
  assert.equal(list.data.labels.length, 0);
});

test("listLabels keeps imported printable labels for the same AWB available to API dedupe layer", () => {
  const service = createLabelService({ config: sampleConfig, idFactory: () => "import-id-dupe" });

  service.registerImportedLabel({
    parsed: {
      platform: "shopee",
      awb: "TH23018SMKA02G",
      orderNumber: "260529NR16YYRH",
      customerName: "ไรจันทร์ / 6",
      carrier: "Flash Express"
    },
    labelFile: {
      fileName: "shipping-label-page-1.png",
      relativePath: "local-nas/labels/2026-06/source-a.pdf",
      pageImageRelativePath: "local-nas/labels/2026-06/page-a-1.png",
      importedAt: "2026-06-30T07:38:49.000Z",
      contentType: "image/png",
      bytes: 1200
    },
    status: "imported"
  });

  service.registerImportedLabel({
    parsed: {
      platform: "shopee",
      awb: "TH23018SMKA02G",
      orderNumber: "260529NR16YYRH",
      customerName: "ไรจันทร์ / 6",
      carrier: "Flash Express"
    },
    labelFile: {
      fileName: "shipping-label-page-2.png",
      relativePath: "local-nas/labels/2026-06/source-b.pdf",
      pageImageRelativePath: "local-nas/labels/2026-06/page-b-1.png",
      importedAt: "2026-06-30T07:40:49.000Z",
      contentType: "image/png",
      bytes: 1300
    },
    status: "imported"
  });

  const list = service.listLabels();
  assert.equal(list.ok, true);
  assert.equal(list.data.total, 1);
  assert.equal(list.data.filtered, 1);
  assert.equal(list.data.labels.length, 1);
  assert.equal(list.data.labels[0].fileName, "shipping-label-page-2.png");
});

test("listLabels keeps printable labels from skipped imports that still have a valid AWB", () => {
  const service = createLabelService({ config: sampleConfig, idFactory: () => "import-id-ready" });

  service.registerImportedLabel({
    parsed: {
      platform: "shopee",
      awb: "TH54018SMKA07J",
      orderNumber: "260529N4JQKDM5",
      customerName: "นพาวรณ์ คำจันทร์ Q 3 0",
      carrier: "Flash Express"
    },
    labelFile: {
      fileName: "shipping-label-page-1.png",
      relativePath: "local-nas/labels/2026-07/source.pdf",
      pageImageRelativePath: "local-nas/labels/2026-07/page-1.png",
      importedAt: "2026-07-01T06:40:00.000Z",
      contentType: "image/png",
      bytes: 1500
    },
    status: "ready"
  });

  const list = service.listLabels();
  assert.equal(list.ok, true);
  assert.equal(list.data.total, 1);
  assert.equal(list.data.filtered, 1);
  assert.equal(list.data.labels[0].awb, "TH54018SMKA07J");
  assert.equal(list.data.labels[0].status, "ready");
});

test("deleteLabelsForAwb removes imported labels tied to a deleted AWB", () => {
  const service = createLabelService({ config: sampleConfig, idFactory: () => "import-id-2" });

  service.registerImportedLabel({
    parsed: {
      platform: "shopee",
      awb: "TH23018SMKA16G",
      orderNumber: "260529NR16YYRH",
      customerName: "ไรจันทร์ / 6",
      carrier: "Flash Express"
    },
    labelFile: {
      fileName: "shipping-label-page-1.png",
      relativePath: "local-nas/labels/2026-06/source.pdf",
      pageImageRelativePath: "local-nas/labels/2026-06/page-1.png",
      importedAt: "2026-06-29T11:00:00.000Z",
      contentType: "image/png",
      bytes: 1200
    }
  });
  service.registerImportedLabel({
    parsed: {
      platform: "shopee",
      awb: "TH23018SMKA16G",
      orderNumber: "260529NR16YYRH",
      customerName: "ไรจันทร์ / 6",
      carrier: "Flash Express"
    },
    labelFile: {
      fileName: "shipping-label-page-2.png",
      relativePath: "local-nas/labels/2026-06/source.pdf",
      pageImageRelativePath: "local-nas/labels/2026-06/page-2.png",
      importedAt: "2026-06-29T11:00:00.000Z",
      contentType: "image/png",
      bytes: 1300
    }
  });

  const removed = service.deleteLabelsForAwb({ awb: "TH23018SMKA16G" });
  assert.equal(removed.ok, true);
  assert.equal(removed.data.deletedCount, 1);
  assert.equal(service.listLabels().data.labels.length, 0);
});

test("updateLabelsForAwb syncs printable label metadata after Connect / Import edits", () => {
  const service = createLabelService({ config: sampleConfig, idFactory: () => "import-id-3" });

  const created = service.registerImportedLabel({
    parsed: {
      platform: "lazada",
      awb: "LEXDO0185476846",
      orderNumber: "1101259465611295",
      customerName: "บริษัท เชาท์เกท เอ็นจิเนียริ่ง จำกัด Phli, 10540",
      carrier: "LEX"
    },
    labelFile: {
      fileName: "shipping-label.png",
      relativePath: "local-nas/labels/2026-06/source.pdf",
      pageImageRelativePath: "local-nas/labels/2026-06/page-1.png",
      importedAt: "2026-06-29T15:00:00.000Z",
      contentType: "image/png",
      bytes: 1400
    }
  });

  const updated = service.updateLabelsForAwb({
    awb: "LEXDO0185476846",
    updates: {
      platform: "lazada",
      orderNumber: "1101259465611295",
      customerName: "บริษัท เชาท์เกท เอ็นจิเนียริ่ง จำกัด",
      carrier: "LEX"
    }
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.data.updatedCount, 1);

  const found = service.getLabel(created.data.id);
  assert.equal(found.ok, true);
  assert.equal(found.data.customerName, "บริษัท เชาท์เกท เอ็นจิเนียริ่ง จำกัด");
  assert.equal(found.data.orderNumber, "1101259465611295");
  assert.equal(found.data.carrier, "LEX");
});


test("createLabelService restores labels from initialLabels for runtime persistence", () => {
  const original = createLabelService({ config: sampleConfig, idFactory: () => "persist-id-1" });

  const saved = original.saveLabel({
    platform: "shopee",
    date: "2026-07-09",
    imageDataUrl: tinyPngDataUrl,
    fileName: "persisted-label.png"
  });

  assert.equal(saved.ok, true);

  const snapshot = original.listAllLabels();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].id, saved.data.id);

  const restored = createLabelService({ config: sampleConfig, initialLabels: snapshot });

  const found = restored.getLabel(saved.data.id);
  assert.equal(found.ok, true);
  assert.equal(found.data.fileName, "persisted-label.png");

  const listed = restored.listLabels();
  assert.equal(listed.ok, true);
  assert.equal(listed.data.labels.length, 1);
  assert.equal(listed.data.labels[0].id, saved.data.id);
});
