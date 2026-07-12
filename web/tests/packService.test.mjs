import assert from "node:assert/strict";
import test from "node:test";
import { createPackService } from "../src/domain/packService.mjs";

const baseConfig = {
  station: { defaultStationId: "STATION-07" },
  employees: { defaultEmployeeId: "EMP-0012" },
  packFlow: {
    closeBoxByRescanningAwb: true,
    allowForceCloseWithMissingItems: true,
    requireReasonForForceClose: true,
    requireLabelBeforePack: true
  },
  upload: {
    provider: "nas",
    nasHost: "192.0.2.40",
    defaultStorageTargetId: "local-machine",
    storageTargets: [
      {
        id: "main-nas",
        label: "NAS หลัก",
        provider: "nas",
        host: "192.0.2.40",
        localPath: "local-nas/videos",
        isDefault: false
      },
      {
        id: "local-machine",
        label: "เก็บที่เครื่องนี้",
        provider: "local",
        host: "localhost",
        localPath: "local-nas/this-machine",
        isDefault: true
      },
      {
        id: "local-backup",
        label: "สำรองในเครื่องนี้",
        provider: "local",
        host: "localhost",
        localPath: "local-nas/local-backup",
        isDefault: false
      },
      {
        id: "local-cloud-sync",
        label: "Cloud Sync",
        provider: "cloud-sync",
        host: "cloud sync folder",
        localPath: "local-nas/cloud-sync",
        isDefault: false
      }
    ],
    simulationSteps: [
      { pct: 15, label: "หยุดบันทึกวิดีโอ" },
      { pct: 100, label: "ผูกไฟล์กับออเดอร์" }
    ]
  },
  shareLinks: {
    publicBaseUrl: "https://share.example.local"
  },
  reports: {
    seedHistoricalRecords: false
  }
};

const orders = {
  "SPX-1": {
    platform: "Shopee",
    buyer: "Buyer",
    labelFile: {
      fileName: "SPX-1-label.png",
      relativePath: "local-nas/labels/2026-06/SPX-1-label.png",
      importedAt: "2026-06-22T08:00:00.000Z",
      contentType: "image/png"
    },
    items: [
      { sku: "A", name: "Item A", qty: 2, barcode: "111" },
      { sku: "B", name: "Item B", qty: 1, barcode: "222" }
    ]
  },
  "SPX-2": {
    platform: "Shopee",
    buyer: "Second Buyer",
    labelFile: {
      fileName: "SPX-2-label.png",
      relativePath: "local-nas/labels/2026-06/SPX-2-label.png",
      importedAt: "2026-06-22T08:00:00.000Z",
      contentType: "image/png"
    },
    items: [
      { sku: "C", name: "Item C", qty: 1, barcode: "333" }
    ]
  }
};

test("server starts a pack session only for a known AWB", () => {
  const service = createService();

  const missing = service.startPackSession({ awb: "UNKNOWN" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "ORDER_NOT_FOUND");

  const result = service.startPackSession({ awb: "SPX-1" });
  assert.equal(result.ok, true);
  assert.equal(result.data.awb, "SPX-1");
  assert.equal(result.data.labelFile.fileName, "SPX-1-label.png");
  assert.equal(result.data.summary.totalLineCount, 2);
  assert.equal(result.data.storageTargetId, "local-machine");
});

test("start requires AWB only and permits a new AWB when no record exists", () => {
  const service = createService();

  const missing = service.startPackSession({ awb: "   " });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "AWB_REQUIRED");
  assert.equal(missing.message, "กรุณาสแกนเลข AWB");

  const started = service.startPackSession({ awb: " SPX-1 " });
  assert.equal(started.ok, true);
  assert.equal(started.data.awb, "SPX-1");
});

test("a persisted pass record blocks a new session for the same normalized AWB", () => {
  const service = createService({ records: [persistedRecord({ awb: " SPX-1 ", status: "pass" })] });

  const result = service.startPackSession({ awb: "SPX-1" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "AWB_ALREADY_PACKED");
  assert.equal(result.message, "AWB นี้แพ็กไปแล้ว ไม่สามารถแพ็กซ้ำได้");
});

test("a persisted warn record blocks a new session for the same AWB", () => {
  const service = createService({ records: [persistedRecord({ awb: "SPX-1", status: "warn" })] });

  const result = service.startPackSession({ awb: "SPX-1" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "AWB_ALREADY_PACKED");
  assert.equal(result.message, "AWB นี้แพ็กไปแล้ว ไม่สามารถแพ็กซ้ำได้");
});

test("a second active session for the same AWB is blocked while a different AWB may start", () => {
  const service = createService();
  const first = service.startPackSession({ awb: "SPX-1" });

  const duplicate = service.startPackSession({ awb: "SPX-1" });
  const different = service.startPackSession({ awb: "SPX-2" });

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "AWB_PACK_IN_PROGRESS");
  assert.equal(duplicate.message, "AWB นี้กำลังอยู่ระหว่างการแพ็ก");
  assert.equal(different.ok, true);
  assert.equal(different.data.awb, "SPX-2");
});

test("pack session requires a shipping label before scanning AWB when configured", () => {
  const service = createPackService({
    config: structuredClone(baseConfig),
    orders: {
      "NO-LABEL-1": {
        platform: "Shopee",
        buyer: "Buyer",
        items: [{ sku: "A", name: "Item A", qty: 1, barcode: "111" }]
      }
    }
  });

  const result = service.startPackSession({ awb: "NO-LABEL-1" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "LABEL_REQUIRED_BEFORE_PACK");
});

test("pack session uses the selected platform before scanning", () => {
  const service = createService();

  const result = service.startPackSession({ awb: "SPX-1", platform: "Tiktok" });

  assert.equal(result.ok, true);
  assert.equal(result.data.platform, "Tiktok");
});

test("pack session normalizes imported TikTok platform labels", () => {
  const serviceOptions = {
    config: structuredClone(baseConfig),
    orders: {
      "TT-OCR-1": {
        platform: "TikTok Shop",
        buyer: "Buyer",
        labelFile: {
          fileName: "TT-OCR-1-label.png",
          relativePath: "local-nas/labels/2026-06/TT-OCR-1-label.png"
        },
        items: [
          { sku: "SKU-TT", name: "TikTok Item", qty: 1, barcode: "SKU-TT" }
        ]
      }
    },
    idFactory: () => "id-tiktok",
    now: () => new Date(Date.UTC(2026, 5, 22, 8, 0, 0))
  };

  const fromOrder = createPackService(serviceOptions).startPackSession({ awb: "TT-OCR-1" });
  const fromClient = createPackService({
    ...serviceOptions,
    config: structuredClone(baseConfig),
    orders: structuredClone(serviceOptions.orders)
  }).startPackSession({ awb: "TT-OCR-1", platform: "tiktok" });

  assert.equal(fromOrder.ok, true);
  assert.equal(fromOrder.data.platform, "Tiktok");
  assert.equal(fromClient.ok, true);
  assert.equal(fromClient.data.platform, "Tiktok");
});

test("pack session can select a storage target for the final record", () => {
  const service = createService();
  const session = service.startPackSession({ awb: "SPX-1", storageTargetId: "local-backup" }).data;
  service.scanCode({ sessionId: session.id, code: "111" });
  service.scanCode({ sessionId: session.id, code: "111" });
  service.scanCode({ sessionId: session.id, code: "222" });

  const result = service.closePackSession({ sessionId: session.id });

  assert.equal(result.ok, true);
  assert.equal(result.data.record.storage.targetId, "local-backup");
  assert.equal(result.data.record.storage.label, "สำรองในเครื่องนี้");
});

test("pack session supports local cloud sync storage target", () => {
  const service = createService();
  const session = service.startPackSession({ awb: "SPX-1", storageTargetId: "local-cloud-sync" }).data;
  service.scanCode({ sessionId: session.id, code: "111" });
  service.scanCode({ sessionId: session.id, code: "111" });
  service.scanCode({ sessionId: session.id, code: "222" });

  const result = service.closePackSession({ sessionId: session.id });

  assert.equal(result.ok, true);
  assert.equal(result.data.record.storage.targetId, "local-cloud-sync");
  assert.equal(result.data.record.storage.provider, "cloud-sync");
});

test("product scanning accepts product barcode or SKU and rejects over-scan", () => {
  const service = createService();
  const session = service.startPackSession({ awb: "SPX-1" }).data;

  assert.equal(service.scanCode({ sessionId: session.id, code: "111" }).ok, true);
  const second = service.scanCode({ sessionId: session.id, code: "A" });
  assert.equal(second.ok, true);
  assert.equal(second.data.items[0].scannedQty, 2);

  const overScan = service.scanCode({ sessionId: session.id, code: "111" });
  assert.equal(overScan.ok, false);
  assert.equal(overScan.code, "ITEM_ALREADY_COMPLETE");
});

test("rescanning AWB with zero scanned items is blocked immediately", () => {
  const service = createService();
  const session = service.startPackSession({ awb: "SPX-1" }).data;

  const result = service.scanCode({ sessionId: session.id, code: "SPX-1" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "AWB_RESCAN_BLOCKED");
  assert.equal(result.data.session.status, "packing");
  assert.equal(result.data.session.summary.scannedQty, 0);
  assert.equal(result.data.missingItems.length, 2);
  assert.equal(service.listRecords().length, 0);
});

test("rescanning AWB after partial scanning is blocked and force cannot close missing items", () => {
  const service = createService();
  const session = service.startPackSession({ awb: "SPX-1" }).data;
  service.scanCode({ sessionId: session.id, code: "111" });

  const awbRescan = service.scanCode({ sessionId: session.id, code: "SPX-1" });
  assert.equal(awbRescan.ok, false);
  assert.equal(awbRescan.code, "AWB_RESCAN_BLOCKED");
  assert.equal(awbRescan.data.session.summary.scannedQty, 1);

  const forcedClose = service.closePackSession({
    sessionId: session.id,
    force: true,
    reason: "สินค้าขาด"
  });
  assert.equal(forcedClose.ok, false);
  assert.equal(forcedClose.code, "MISSING_ITEMS");
  assert.equal(forcedClose.data.status, "packing");
  assert.equal(forcedClose.data.summary.scannedQty, 1);
  assert.equal(service.listRecords().length, 0);
});

test("AWB can act as item barcode first, then rescanning the same AWB requests close", () => {
  const service = createPackService({
    config: structuredClone(baseConfig),
    orders: {
      "TH77108VWHND9B": {
        platform: "Shopee",
        buyer: "Buyer",
        labelFile: {
          fileName: "TH77108VWHND9B-label.png",
          relativePath: "local-nas/labels/2026-06/TH77108VWHND9B-label.png"
        },
        items: [
          {
            sku: "",
            name: "สินค้าจากใบปะหน้า",
            qty: 1,
            barcode: "TH77108VWHND9B"
          }
        ]
      }
    }
  });

  const session = service.startPackSession({ awb: "TH77108VWHND9B" }).data;

  const firstScan = service.scanCode({ sessionId: session.id, code: "TH77108VWHND9B" });
  assert.equal(firstScan.ok, true);
  assert.equal(firstScan.data.items[0].scannedQty, 1);
  assert.equal(firstScan.data.summary.scannedLineCount, 1);

  const secondScan = service.scanCode({ sessionId: session.id, code: "TH77108VWHND9B" });
  assert.equal(secondScan.ok, true);
  assert.equal(secondScan.data.closeRequested, true);
  assert.equal(secondScan.data.session.summary.scannedLineCount, 1);
});

test("complete session creates a pass record after all items are scanned", () => {
  const service = createService();
  const session = service.startPackSession({ awb: "SPX-1" }).data;
  service.scanCode({ sessionId: session.id, code: "111" });
  service.scanCode({ sessionId: session.id, code: "111" });
  service.scanCode({ sessionId: session.id, code: "222" });

  const result = service.closePackSession({ sessionId: session.id });
  assert.equal(result.ok, true);
  assert.equal(result.data.record.status, "pass");
  assert.equal(result.data.record.itemSummary, "2/2 รายการ");
  assert.equal(result.data.record.shareLink, null);
  assert.equal(service.listRecords().length, 1);
});

test("rescanning AWB after all item quantities are complete follows the normal close flow", () => {
  const service = createService();
  const session = service.startPackSession({ awb: "SPX-1" }).data;
  service.scanCode({ sessionId: session.id, code: "111" });
  service.scanCode({ sessionId: session.id, code: "111" });
  service.scanCode({ sessionId: session.id, code: "222" });

  const closeRequested = service.scanCode({ sessionId: session.id, code: "SPX-1" });
  assert.equal(closeRequested.ok, true);
  assert.equal(closeRequested.data.closeRequested, true);
  assert.equal(closeRequested.data.session.status, "packing");

  const result = service.closePackSession({ sessionId: session.id });
  assert.equal(result.ok, true);
  assert.equal(result.data.record.status, "pass");
});

test("video metadata can be attached to a completed record", () => {
  const service = createService();
  const session = service.startPackSession({ awb: "SPX-1" }).data;
  service.scanCode({ sessionId: session.id, code: "111" });
  service.scanCode({ sessionId: session.id, code: "111" });
  service.scanCode({ sessionId: session.id, code: "222" });
  const closed = service.closePackSession({ sessionId: session.id });

  const attached = service.attachVideoToRecord({
    recordId: closed.data.record.id,
    video: {
      fileName: "SPX-1.webm",
      sizeMb: 1.25,
      shareLink: "http://localhost:4173/api/video/stream/id-4"
    }
  });

  assert.equal(attached.ok, true);
  assert.equal(service.listRecords()[0].video.fileName, "SPX-1.webm");
  assert.equal(service.listRecords()[0].shareLink, "http://localhost:4173/api/video/stream/id-4");
});


test("pack service uses initial records and skips seed history", () => {
  const existingRecord = {
    id: "rec-loaded",
    awb: "SPX-LOADED",
    platform: "Shopee",
    employeeId: "EMP-LOADED",
    stationId: "STATION-07",
    startedAt: "2026-06-22T08:00:00.000Z",
    endedAt: "2026-06-22T08:01:00.000Z",
    durationSeconds: 60,
    status: "pass",
    itemSummary: "1/1 รายการ",
    sizeMb: 5.5,
    storage: {
      targetId: "local-machine",
      label: "เก็บที่เครื่องนี้",
      provider: "local",
      host: "localhost"
    },
    shareLink: null,
    forceCloseReason: null
  };

  const config = structuredClone(baseConfig);
  config.reports = { seedHistoricalRecords: true, seedHistoricalCount: 3 };

  const service = createPackService({
    config,
    orders: structuredClone(orders),
    records: [existingRecord],
    idFactory: () => "id-unused",
    now: () => new Date(Date.UTC(2026, 5, 22, 8, 0, 0))
  });

  const records = service.listRecords();

  assert.equal(records.length, 1);
  assert.equal(records[0].id, "rec-loaded");
  assert.equal(records.some((record) => String(record.id).startsWith("seed_")), false);
});

test("pack service with null records falls back to seed history when configured", () => {
  const config = structuredClone(baseConfig);
  config.reports = { seedHistoricalRecords: true, seedHistoricalCount: 3 };

  const service = createPackService({
    config,
    orders: structuredClone(orders),
    records: null,
    now: () => new Date(Date.UTC(2026, 5, 22, 8, 0, 0))
  });

  const records = service.listRecords();

  assert.equal(records.length, 3);
  assert.equal(records[0].id, "seed_0");
});

test("pack service with null records and seed disabled starts empty", () => {
  const config = structuredClone(baseConfig);
  config.reports = { seedHistoricalRecords: false };

  const service = createPackService({
    config,
    orders: structuredClone(orders),
    records: null
  });

  assert.deepEqual(service.listRecords(), []);
});


function persistedRecord({ awb, status }) {
  return {
    id: `record-${status}`,
    awb,
    status,
    storage: {}
  };
}

function createService({ records = null } = {}) {
  let id = 0;
  let tick = 0;
  return createPackService({
    config: structuredClone(baseConfig),
    orders: structuredClone(orders),
    records: records === null ? null : structuredClone(records),
    idFactory: () => `id-${++id}`,
    now: () => new Date(Date.UTC(2026, 5, 22, 8, 0, tick++))
  });
}
