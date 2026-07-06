import assert from "node:assert/strict";
import test from "node:test";
import { createImportService } from "../src/domain/importService.mjs";

function itemLine({ sku = "CAB-WALL-2D-60X32X24", name = "ตู้แขวนผนัง 2 ประตู 60x32x24 ซม.", qty = 1, barcode = sku } = {}) {
  return { sku, name, qty, barcode };
}

test("sync filters mock platform orders and import makes AWB packable", () => {
  const orders = {};
  const service = createImportService({
    orders,
    syncOrders: [
      {
        awb: "SPX-NEW-1",
        platform: "shopee",
        orderNumber: "SPX-ORDER-1",
        items: 2,
        itemLines: [
          itemLine({ sku: "CAB-WALL-2D-60X32X24", name: "ตู้แขวนผนัง 2 ประตู 60x32x24 ซม.", qty: 1 }),
          itemLine({ sku: "FIT-HANDLE-WHITE-96MM", name: "มือจับตู้สีขาว 96mm", qty: 1 })
        ],
        sku: "CAB-WALL-2D-60X32X24",
        productName: "ตู้แขวนผนัง 2 ประตู 60x32x24 ซม.",
        barcode: "CAB-WALL-2D-60X32X24",
        buyer: "A",
        status: "ready",
        alreadyIn: false
      },
      {
        awb: "LZD-NEW-1",
        platform: "lazada",
        items: 1,
        itemLines: [itemLine({ sku: "FIT-HANDLE-WHITE-96MM", name: "มือจับตู้สีขาว 96mm", qty: 1 })],
        sku: "FIT-HANDLE-WHITE-96MM",
        productName: "มือจับตู้สีขาว 96mm",
        barcode: "FIT-HANDLE-WHITE-96MM",
        buyer: "B",
        status: "pending",
        alreadyIn: false
      }
    ]
  });

  const synced = service.sync({ platform: "shopee", status: "ready" });
  assert.equal(synced.ok, true);
  assert.equal(synced.data.orders.length, 1);
  assert.equal(synced.data.orders[0].awb, "SPX-NEW-1");

  const imported = service.importOrders({ awbs: ["SPX-NEW-1"] });
  assert.equal(imported.ok, true);
  assert.equal(imported.data.importedCount, 1);
  assert.equal(orders["SPX-NEW-1"].platform, "Shopee");
  assert.equal(orders["SPX-NEW-1"].items.length, 2);

  const afterImport = service.sync({ platform: "shopee", status: "ready" });
  assert.equal(afterImport.data.orders[0].alreadyIn, true);
});

test("sync import allows same order number on different AWB and links new AWB to the existing order number", () => {
  const orders = {
    "SPX-OLD-1": {
      platform: "Shopee",
      buyer: "ลูกค้าเดิม",
      orderNumber: "SO-2001",
      carrier: "Shopee Express",
      importedAt: "2026-06-29T10:00:00.000Z",
      items: [{ sku: "CAB-WALL-2D-60X32X24", name: "ตู้แขวนผนัง 2 ประตู", qty: 1, barcode: "CAB-WALL-2D-60X32X24" }]
    }
  };

  const service = createImportService({
    orders,
    syncOrders: [{
      awb: "SPX-NEW-2001",
      platform: "shopee",
      items: 1,
      itemLines: [itemLine({ sku: "CAB-WALL-3D-96X46X30", name: "ตู้แขวนผนัง 3 ประตู", qty: 1 })],
      sku: "CAB-WALL-3D-96X46X30",
      productName: "ตู้แขวนผนัง 3 ประตู",
      barcode: "CAB-WALL-3D-96X46X30",
      buyer: "ลูกค้าใหม่",
      orderNumber: "SO-2001",
      status: "ready",
      alreadyIn: false
    }]
  });

  const imported = service.importOrders({ awbs: ["SPX-NEW-2001"] });
  assert.equal(imported.ok, true);
  assert.equal(imported.data.importedCount, 1);
  assert.equal(imported.data.skipped.length, 0);
  assert.equal(orders["SPX-NEW-2001"].orderNumber, "SO-2001");
});

test("connection test supports success and error mock cases", () => {
  const service = createImportService({ orders: {}, syncOrders: [] });

  const shopee = service.testConnection({ platform: "shopee" });
  assert.equal(shopee.ok, true);
  assert.equal(shopee.data.ok, true);

  const tiktok = service.testConnection({ platform: "tiktok" });
  assert.equal(tiktok.ok, true);
  assert.equal(tiktok.data.ok, false);
  assert.match(tiktok.data.message, /Token/);
});

test("manual order form creates an order in ORDER_DB", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });

  const created = service.createManualOrder({
    awb: "FORM-ORDER-1",
    platform: "shopee",
    buyer: "ร้าน ABC",
    orderNumber: "FORM-SO-1",
    itemLines: [
      itemLine({ sku: "CAB-WALL-2D-60X32X24", name: "ตู้แขวนผนัง 2 ประตู", qty: 1 }),
      itemLine({ sku: "FIT-HANDLE-WHITE-96MM", name: "มือจับตู้สีขาว 96 มม.", qty: 1 }),
      itemLine({ sku: "FIT-SLIDE-300MM", name: "รางลิ้นชัก 300 มม.", qty: 1 })
    ]
  });

  assert.equal(created.ok, true);
  assert.equal(created.data.awb, "FORM-ORDER-1");
  assert.equal(created.data.platform, "Shopee");
  assert.equal(orders["FORM-ORDER-1"].buyer, "ร้าน ABC");
  assert.equal(orders["FORM-ORDER-1"].items.length, 3);

  const duplicate = service.createManualOrder({
    awb: "FORM-ORDER-1",
    platform: "shopee",
    buyer: "ร้าน ABC",
    orderNumber: "FORM-SO-1",
    itemLines: [itemLine()]
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "ORDER_DUPLICATE_LABEL");
});

test("manual order allows duplicate order number on different AWB and reports multi-AWB linkage", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });

  const first = service.createManualOrder({
    awb: "FORM-ORDER-10",
    platform: "shopee",
    buyer: "ร้าน ABC",
    orderNumber: "SO-1001",
    itemLines: [itemLine()]
  });
  assert.equal(first.ok, true);

  const linked = service.createManualOrder({
    awb: "FORM-ORDER-11",
    platform: "shopee",
    buyer: "ร้าน XYZ",
    orderNumber: "SO-1001",
    itemLines: [itemLine({ sku: "CAB-WALL-3D-96X46X30", name: "ตู้แขวนผนัง 3 ประตู", qty: 1 })]
  });

  assert.equal(linked.ok, true);
  assert.equal(linked.data.allowMultiAwb, true);
  assert.deepEqual(linked.data.linkedAwbs, ["FORM-ORDER-10"]);
  assert.match(linked.message, /เพิ่มพัสดุใหม่ FORM-ORDER-11 ให้กับออเดอร์เดิม SO-1001/);
});

test("manual order form validates required fields and item count", () => {
  const service = createImportService({ orders: {}, syncOrders: [] });

  assert.equal(service.createManualOrder({ platform: "shopee", buyer: "ร้าน ABC", items: 1 }).code, "AWB_REQUIRED");
  assert.equal(service.createManualOrder({ awb: "FORM-3", platform: "shopee", buyer: "ร้าน ABC", orderNumber: "", items: 1 }).code, "ORDER_NUMBER_REQUIRED");
  assert.equal(service.createManualOrder({ awb: "FORM-2", platform: "unknown", buyer: "ร้าน ABC", items: 1 }).code, "PLATFORM_NOT_SUPPORTED");
  assert.equal(service.createManualOrder({ awb: "FORM-2", platform: "shopee", buyer: "", items: 1 }).code, "BUYER_REQUIRED");
  assert.equal(service.createManualOrder({ awb: "FORM-2", platform: "shopee", buyer: "ร้าน ABC", orderNumber: "", items: 0 }).code, "ORDER_NUMBER_REQUIRED");
});

test("manual order rejects missing sku product name or quantity outside demo mode", () => {
  const service = createImportService({ orders: {}, syncOrders: [] });

  assert.equal(service.createManualOrder({
    awb: "FORM-10",
    platform: "shopee",
    buyer: "ร้าน ABC",
    orderNumber: "FORM-SO-10",
    itemLines: [{ sku: "", name: "ตู้แขวนผนัง 2 ประตู", qty: 1, barcode: "FORM-10-1" }]
  }).code, "ITEM_DETAILS_REQUIRED");

  assert.equal(service.createManualOrder({
    awb: "FORM-11",
    platform: "shopee",
    buyer: "ร้าน ABC",
    orderNumber: "FORM-SO-11",
    itemLines: [{ sku: "CAB-WALL-2D-60X32X24", name: "", qty: 1, barcode: "FORM-11-1" }]
  }).code, "ITEM_DETAILS_REQUIRED");

  assert.equal(service.createManualOrder({
    awb: "FORM-12",
    platform: "shopee",
    buyer: "ร้าน ABC",
    orderNumber: "FORM-SO-12",
    itemLines: [{ sku: "CAB-WALL-2D-60X32X24", name: "ตู้แขวนผนัง 2 ประตู", qty: 0, barcode: "FORM-12-1" }]
  }).code, "ITEM_DETAILS_REQUIRED");
});

test("demo mode still allows fallback item generation for count-only manual orders", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [], demoMode: true });

  const created = service.createManualOrder({
    awb: "DEMO-ORDER-1",
    platform: "shopee",
    buyer: "ร้าน Demo",
    orderNumber: "DEMO-SO-1",
    items: 2
  });

  assert.equal(created.ok, true);
  assert.equal(orders["DEMO-ORDER-1"].items.length, 2);
  assert.deepEqual(orders["DEMO-ORDER-1"].items[0], {
    sku: "DEMO-DEMO-ORDER-1-1",
    name: "Demo Item 1 (DEMO-ORDER-1)",
    qty: 1,
    barcode: "DEMO-ORDER-1-1"
  });
});

test("shipping label import creates order with parsed item and label attachment", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });
  const created = service.createOrderFromShippingLabel({
    parsed: {
      platform: "tiktok",
      orderNumber: "584452252146042306",
      awb: "798548223255",
      customerName: "ช่างกอล์ฟ",
      productName: "ตู้ไซด์กันน้ำ",
      sku: "3CWWV-3",
      quantity: 1,
      carrier: "J&T Express"
    },
    labelFile: { fileName: "label.png", relativePath: "local-nas/labels/label.png" }
  });

  assert.equal(created.ok, true);
  assert.equal(created.data.awb, "798548223255");
  assert.equal(created.data.platform, "TikTok Shop");
  assert.equal(orders["798548223255"].orderNumber, "584452252146042306");
  assert.equal(orders["798548223255"].carrier, "J&T Express");
  assert.match(orders["798548223255"].importedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(orders["798548223255"].items[0], {
    sku: "3CWWV-3",
    name: "ตู้ไซด์กันน้ำ",
    qty: 1,
    barcode: "3CWWV-3"
  });
  assert.equal(orders["798548223255"].labelFile.fileName, "label.png");
});

test("shipping label import rejects AWB without order number", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });
  const created = service.createOrderFromShippingLabel({
    parsed: {
      platform: "tiktok",
      orderNumber: "",
      awb: "798548223255",
      customerName: "ช่างกอล์ฟ",
      productName: "ตู้ไซด์กันน้ำ",
      sku: "3CWWV-3",
      quantity: 1,
      carrier: "J&T Express"
    }
  });

  assert.equal(created.ok, false);
  assert.equal(created.code, "ORDER_NUMBER_REQUIRED");
  assert.equal(orders["798548223255"], undefined);
});

test("sync order list exposes imported date for manual label imports", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });
  const created = service.createOrderFromShippingLabel({
    parsed: {
      platform: "shopee",
      orderNumber: "2606047GU07A12",
      awb: "TH01288T6C4J4A",
      customerName: "ธนงศักดิ์ บุญโสม",
      productName: "ตู้เหล็กมาตรฐาน ตู้ไซร์ ตู้คอนโทรล",
      sku: "2DMI_BDC-ดอกไม้",
      quantity: 1,
      carrier: "Flash Express"
    },
    labelFile: {
      fileName: "label.png",
      relativePath: "local-nas/labels/label.png",
      importedAt: "2026-06-24T08:22:44.000Z"
    }
  });

  assert.equal(created.ok, true);
  const synced = service.sync({ platform: "all", status: "ready" });
  const order = synced.data.orders.find((item) => item.awb === "TH01288T6C4J4A");
  assert.equal(order.importedAt, "2026-06-24T08:22:44.000Z");
});

test("shipping label duplicate is decided by order number and AWB", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });
  const parsed = {
    platform: "shopee",
    orderNumber: "260529N4JQKDMS",
    awb: "TH54018SMKA07J",
    customerName: "ธนงศักดิ์ บุญโสม",
    productName: "ตู้ไซด์กันน้ำ",
    sku: "2BDEZONAIQRDNS",
    quantity: 2,
    carrier: "Flash Express"
  };

  const created = service.createOrderFromShippingLabel({ parsed });
  assert.equal(created.ok, true);

  const duplicate = service.createOrderFromShippingLabel({ parsed });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "ORDER_DUPLICATE_LABEL");
  assert.match(duplicate.message, /เลขออเดอร์ 260529N4JQKDMS \+ AWB TH54018SMKA07J/);

  const conflict = service.createOrderFromShippingLabel({
    parsed: {
      ...parsed,
      orderNumber: "DIFFERENT-ORDER"
    }
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "ORDER_AWB_CONFLICT");
  assert.match(conflict.message, /เลขออเดอร์ไม่ตรง/);
});

test("shipping label import allows missing sku but still rejects missing product name or qty", () => {
  const service = createImportService({ orders: {}, syncOrders: [] });

  const missingSku = service.createOrderFromShippingLabel({
    parsed: {
      platform: "tiktok",
      orderNumber: "584452252146042306",
      awb: "798548223255",
      customerName: "ช่างกอล์ฟ",
      productName: "ตู้ไซด์กันน้ำ",
      sku: "",
      quantity: 1,
      carrier: "J&T Express"
    }
  });
  assert.equal(missingSku.ok, true);
  assert.match(missingSku.message, /ไม่มี SKU/);
  assert.equal(missingSku.data.awb, "798548223255");

  assert.equal(service.createOrderFromShippingLabel({
    parsed: {
      platform: "tiktok",
      orderNumber: "584452252146042306",
      awb: "798548223255",
      customerName: "ช่างกอล์ฟ",
      productName: "",
      sku: "3CWWV-3",
      quantity: 1,
      carrier: "J&T Express"
    }
  }).code, "PRODUCT_NAME_REQUIRED");

  assert.equal(service.createOrderFromShippingLabel({
    parsed: {
      platform: "tiktok",
      orderNumber: "584452252146042306",
      awb: "798548223255",
      customerName: "ช่างกอล์ฟ",
      productName: "ตู้ไซด์กันน้ำ",
      sku: "3CWWV-3",
      quantity: 0,
      carrier: "J&T Express"
    }
  }).code, "QTY_REQUIRED");
});

test("draft label import can be edited later and promoted into ORDER_DB when item details are completed", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });

  const savedDraft = service.saveDraftLabelImport({
    parsed: {
      platform: "shopee",
      orderNumber: "2606047GU07A12",
      awb: "TH01288T6C4J4A",
      customerName: "ธนงศักดิ์ บุญโสม",
      productName: "",
      sku: "",
      quantity: 1,
      carrier: "Flash Express"
    },
    labelFile: {
      fileName: "label-page-1.png",
      relativePath: "local-nas/labels/2026-07/source.pdf",
      pageImageRelativePath: "local-nas/labels/2026-07/page-1.png",
      importedAt: "2026-07-01T10:00:00.000Z"
    },
    code: "PRODUCT_NAME_REQUIRED",
    message: "อ่านใบปะหน้าได้บางส่วน แต่ไม่มีชื่อสินค้า"
  });

  assert.equal(savedDraft.ok, true);

  const before = service.sync({ platform: "all", status: "all" });
  const draftRow = before.data.orders.find((item) => item.awb === "TH01288T6C4J4A");
  assert.equal(Boolean(draftRow), true);
  assert.equal(draftRow.draft, true);

  const updated = service.updateImportedOrder({
    awb: "TH01288T6C4J4A",
    platform: "shopee",
    orderNumber: "2606047GU07A12",
    buyer: "ธนงศักดิ์ บุญโสม",
    carrier: "Flash Express",
    itemLines: [{
      sku: "WLL-MOUNTING-CABINET",
      name: "ตู้เหล็กมาตรฐาน ตู้ไซร์ ตู้คอนโทรล",
      qty: 1,
      barcode: "WLL-MOUNTING-CABINET"
    }]
  });

  assert.equal(updated.ok, true);
  assert.equal(orders["TH01288T6C4J4A"].orderNumber, "2606047GU07A12");
  assert.equal(orders["TH01288T6C4J4A"].items[0].sku, "WLL-MOUNTING-CABINET");

  const after = service.sync({ platform: "all", status: "all" });
  const promoted = after.data.orders.find((item) => item.awb === "TH01288T6C4J4A");
  assert.equal(Boolean(promoted), false);
});

test("draft label import can be deleted before becoming a real ORDER_DB record", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });

  service.saveDraftLabelImport({
    parsed: {
      platform: "shopee",
      orderNumber: "2606047GU07A12",
      awb: "TH01288T6C4J4A",
      customerName: "ธนงศักดิ์ บุญโสม",
      productName: "",
      sku: "",
      quantity: 1,
      carrier: "Flash Express"
    },
    code: "PRODUCT_NAME_REQUIRED",
    message: "อ่านใบปะหน้าได้บางส่วน แต่ไม่มีชื่อสินค้า"
  });

  const removed = service.deleteImportedOrder({ awb: "TH01288T6C4J4A" });
  assert.equal(removed.ok, true);
  assert.equal(orders["TH01288T6C4J4A"], undefined);
  assert.equal(service.sync({ platform: "all", status: "all" }).data.orders.length, 0);
});

test("shipping label import allows same order number on different AWB", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });

  const first = service.createOrderFromShippingLabel({
    parsed: {
      platform: "lazada",
      orderNumber: "1101259465611295",
      awb: "LEXDO0185476846",
      customerName: "บริษัท A",
      productName: "ตู้แขวนผนัง 2 ประตู",
      sku: "CAB-WALL-2D-60X32X24",
      quantity: 1,
      carrier: "LEX"
    }
  });
  assert.equal(first.ok, true);

  const linked = service.createOrderFromShippingLabel({
    parsed: {
      platform: "lazada",
      orderNumber: "1101259465611295",
      awb: "LEXDO0185476999",
      customerName: "บริษัท B",
      productName: "ตู้แขวนผนัง 3 ประตู",
      sku: "CAB-WALL-3D-96X46X30",
      quantity: 1,
      carrier: "LEX"
    }
  });

  assert.equal(linked.ok, true);
  assert.equal(linked.data.allowMultiAwb, true);
  assert.deepEqual(linked.data.linkedAwbs, ["LEXDO0185476846"]);
  assert.match(linked.message, /เพิ่มพัสดุใหม่ LEXDO0185476999 ให้กับออเดอร์เดิม 1101259465611295/);
  assert.equal(orders["LEXDO0185476999"].orderNumber, "1101259465611295");
});

test("imported manual label order can be updated after import", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });

  const created = service.createOrderFromShippingLabel({
    parsed: {
      platform: "shopee",
      orderNumber: "2606047GU07A12",
      awb: "TH23018SMKA02G",
      customerName: "ไรจันทร์ / 6",
      productName: "ตู้ไซด์กันน้ำเดิม",
      sku: "SKU-OLD",
      quantity: 1,
      carrier: "Flash Express"
    }
  });
  assert.equal(created.ok, true);

  const updated = service.updateImportedOrder({
    awb: "TH23018SMKA02G",
    platform: "lazada",
    orderNumber: "1101259465611295",
    buyer: "บริษัท เชาท์เกท เอ็นจิเนียริ่ง จำกัด",
    carrier: "LEX TH",
    itemLines: [{
      sku: "3CWDO-C2G",
      name: "ตู้ไซด์กันน้ำมีหลังคา",
      qty: 2,
      barcode: "LEXD00185476846"
    }]
  });

  assert.equal(updated.ok, true);
  assert.equal(orders["TH23018SMKA02G"].platform, "Lazada");
  assert.equal(orders["TH23018SMKA02G"].buyer, "บริษัท เชาท์เกท เอ็นจิเนียริ่ง จำกัด");
  assert.equal(orders["TH23018SMKA02G"].orderNumber, "1101259465611295");
  assert.equal(orders["TH23018SMKA02G"].carrier, "LEX TH");
  assert.deepEqual(orders["TH23018SMKA02G"].items[0], {
    sku: "3CWDO-C2G",
    name: "ตู้ไซด์กันน้ำมีหลังคา",
    qty: 2,
    barcode: "LEXD00185476846"
  });

  const synced = service.sync({ platform: "all", status: "ready" });
  const order = synced.data.orders.find((item) => item.awb === "TH23018SMKA02G");
  assert.equal(order.platformLabel, "Lazada");
  assert.equal(order.orderNumber, "1101259465611295");
  assert.equal(order.buyer, "บริษัท เชาท์เกท เอ็นจิเนียริ่ง จำกัด");
  assert.equal(order.sku, "3CWDO-C2G");
  assert.equal(order.productName, "ตู้ไซด์กันน้ำมีหลังคา");
  assert.equal(order.barcode, "LEXD00185476846");
  assert.equal(order.itemLines, 1);
});

test("imported order update allows assigning the same order number to another AWB", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });

  assert.equal(service.createManualOrder({
    awb: "AWB-1001",
    platform: "shopee",
    buyer: "ลูกค้า A",
    orderNumber: "ORDER-1001",
    itemLines: [itemLine()]
  }).ok, true);

  assert.equal(service.createManualOrder({
    awb: "AWB-1002",
    platform: "lazada",
    buyer: "ลูกค้า B",
    orderNumber: "ORDER-1002",
    itemLines: [itemLine({ sku: "FIT-HANDLE-WHITE-96MM", name: "มือจับตู้สีขาว 96 มม.", qty: 1 })]
  }).ok, true);

  const updated = service.updateImportedOrder({
    awb: "AWB-1002",
    platform: "lazada",
    orderNumber: "ORDER-1001",
    buyer: "ลูกค้า B",
    carrier: "LEX",
    itemLines: [{
      sku: "FIT-HANDLE-WHITE-96MM",
      name: "มือจับตู้สีขาว 96 มม.",
      qty: 1,
      barcode: "FIT-HANDLE-WHITE-96MM"
    }]
  });

  assert.equal(updated.ok, true);
  assert.equal(orders["AWB-1002"].orderNumber, "ORDER-1001");
});

test("imported order update rejects blank order number when AWB exists", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });

  assert.equal(service.createManualOrder({
    awb: "AWB-2001",
    platform: "shopee",
    buyer: "ลูกค้า A",
    orderNumber: "ORDER-2001",
    itemLines: [itemLine()]
  }).ok, true);

  const result = service.updateImportedOrder({
    awb: "AWB-2001",
    platform: "shopee",
    orderNumber: "",
    buyer: "ลูกค้า A",
    carrier: "Shopee Express",
    itemLines: [{
      sku: "CAB-WALL-2D-60X32X24",
      name: "ตู้แขวนผนัง 2 ประตู",
      qty: 1,
      barcode: "CAB-WALL-2D-60X32X24"
    }]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ORDER_NUMBER_REQUIRED");
  assert.equal(orders["AWB-2001"].orderNumber, "ORDER-2001");
});

test("imported manual label order can be deleted and disappears from sync list", () => {
  const orders = {};
  const service = createImportService({ orders, syncOrders: [] });

  const created = service.createOrderFromShippingLabel({
    parsed: {
      platform: "tiktok",
      orderNumber: "584506147567208403",
      awb: "798892416184",
      customerName: "ไม่พบชื่อลูกค้า",
      productName: "ตู้เหล็กมาตรฐาน",
      sku: "3CWG-1",
      quantity: 1,
      carrier: "J&T Express"
    }
  });
  assert.equal(created.ok, true);
  assert.ok(orders["798892416184"]);

  const removed = service.deleteImportedOrder({ awb: "798892416184" });
  assert.equal(removed.ok, true);
  assert.equal(orders["798892416184"], undefined);

  const synced = service.sync({ platform: "all", status: "ready" });
  const order = synced.data.orders.find((item) => item.awb === "798892416184");
  assert.equal(order, undefined);
  assert.equal(service.listImportedAwbs().has("798892416184"), false);
});
