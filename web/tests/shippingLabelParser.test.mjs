import assert from "node:assert/strict";
import test from "node:test";
import { detectPlatform, parseShippingLabelText, parseShippingLabelTexts } from "../src/domain/shippingLabelParser.mjs";

test("parses Shopee label OCR text with missing SKU left blank", () => {
  const result = parseShippingLabelText(`
    Shopee FLASH SPEED
    TH01288T6C4J4A
    ผู้รับ (TO) ธนศักดิ์ บุญโสม
    Shopee Order No. 2606047GU07A12
    # ชื่อสินค้า ตัวเลือกสินค้า จำนวน
    ตู้เหล็กมาตรฐาน ตู้ไซร์ ตู้คอนโทรล 1
    จำนวนรวม 1
  `);

  assert.equal(result.ok, true);
  assert.equal(result.data.platform, "shopee");
  assert.equal(result.data.awb, "TH01288T6C4J4A");
  assert.equal(result.data.orderNumber, "2606047GU07A12");
  assert.equal(result.data.customerName, "ธนศักดิ์ บุญโสม");
  assert.equal(result.data.sku, "");
  assert.equal(result.data.productName, "ตู้เหล็กมาตรฐาน ตู้ไซร์ ตู้คอนโทรล");
  assert.equal(result.data.quantity, 1);
  assert.equal(result.data.carrier, "Flash Express");
});

test("normalizes common Shopee OCR noise from Thai labels", () => {
  const result = parseShippingLabelText(`
    (EXPRESS
    Shopee THO1288T6C4J4A
    ผู้ส่ง (FROM) TJC ELECTRIC
    ผู้รับ (60) ธนงศักดิ์ บุญโสม ว 24
    Shopee Order No. 2606047GU07A12 ไม่ต้องเก็บเงิน
    # ชื่อสินค้า ตัวเลือกสินค้า จํานวน
    1 1 (300%450%170มม.) 1
  `);

  assert.equal(result.ok, true);
  assert.equal(result.data.awb, "TH01288T6C4J4A");
  assert.equal(result.data.orderNumber, "2606047GU07A12");
  assert.equal(result.data.customerName, "ธนงศักดิ์ บุญโสม ว 24");
});

test("parses Lazada LEX label OCR text", () => {
  const result = parseShippingLabelText(`
    LEX DOF H-CJM-A1 LEX
    LEXDO0185476846
    Receiver: บริษัท เซททัก เอ็นจิเนียริ่ง จำกัด
    LAZADA Order Number: 1101259465611295
    Name Qty SKU Unit Price
    ตู้ไซด์กันน้ำ 1 3CWDO-C2G-03 2849.00
    Total: 3,019.00Baht
  `);

  assert.equal(result.ok, true);
  assert.equal(result.data.platform, "lazada");
  assert.equal(result.data.awb, "LEXDO0185476846");
  assert.equal(result.data.orderNumber, "1101259465611295");
  assert.equal(result.data.customerName, "บริษัท เซททัก เอ็นจิเนียริ่ง จำกัด");
  assert.equal(result.data.sku, "3CWDO-C2G-03");
  assert.equal(result.data.productName, "ตู้ไซด์กันน้ำ");
  assert.equal(result.data.quantity, 1);
  assert.equal(result.data.carrier, "LEX");
});

test("parses TikTok Shop J&T label OCR text", () => {
  const result = parseShippingLabelText(`
    TikTok Shop J&T EXPRESS
    798548223255
    ถึง ช่างกอล์ฟ
    Order ID: 584452252146042306
    Product Name SKU Seller SKU Qty
    ตู้ไซด์กันน้ำ 3 3CWWV-3 1
    Qty Total: 1
  `);

  assert.equal(result.ok, true);
  assert.equal(result.data.platform, "tiktok");
  assert.equal(result.data.awb, "798548223255");
  assert.equal(result.data.orderNumber, "584452252146042306");
  assert.equal(result.data.customerName, "ช่างกอล์ฟ");
  assert.equal(result.data.sku, "3CWWV-3");
  assert.equal(result.data.productName, "ตู้ไซด์กันน้ำ");
  assert.equal(result.data.quantity, 1);
  assert.equal(result.data.carrier, "J&T Express");
});

test("detects TikTok platform from noisy OCR text captured from real label image", () => {
  const result = parseShippingLabelText(`
    720
    Vv
    OTikTok Shoo J&Tivencs EZ
    798548223255
    3 สง ช่างกอล์ฟ :
    Shipping Date: 11-06-2026
    Order ID: 584452252146042306 Estimated Date:
    In transit by: 11/06/2026 23:59
    Product Name SKU Seller SKU Qty
    ตู้ไซด์กันน้้าไม่มีหลังคา gunan ตัไซต์ 3 3CWW-3 1
    Qty Total: 1
    ย TikTok Sh op Order ID: 584452252146042306
  `);

  assert.equal(result.ok, true);
  assert.equal(result.data.platform, "tiktok");
  assert.equal(result.data.awb, "798548223255");
  assert.equal(result.data.orderNumber, "584452252146042306");
  assert.equal(result.data.customerName, "ช่างกอล์ฟ");
  assert.equal(result.data.sku, "3CWW-3");
  assert.equal(result.data.quantity, 1);
  assert.equal(result.data.carrier, "J&T Express");
});

test("parses multiple TikTok labels from one OCR page", () => {
  const result = parseShippingLabelTexts(`
    TikTok Shop AST veress EZ TikTok Shop AST ines EZ
    798786566023 798892416184
    Order ID: 584505631971771834 Estimated Date:
    Order ID: 584506147567208403 Estimated Date:
    Product Name SKU Seller SKU Qty Product Name SKU Seller SKU Qty
    ตู้เหล็กมาตรฐาน 4 3CWG-4 1 ดู้เหล็กมาตรฐาน 1 3CWG-1 1
    Qty Total: 1 Qty Total: 1
    Order ID: 584505631971771834 Order ID: 584506147567208403
  `);

  assert.equal(result.ok, true);
  assert.equal(result.data.labels.length, 2);
  assert.equal(result.data.labels[0].awb, "798786566023");
  assert.equal(result.data.labels[0].orderNumber, "584505631971771834");
  assert.equal(result.data.labels[0].sku, "3CWG-4");
  assert.equal(result.data.labels[0].productName, "ตู้เหล็กมาตรฐาน");
  assert.equal(result.data.labels[1].awb, "798892416184");
  assert.equal(result.data.labels[1].orderNumber, "584506147567208403");
  assert.equal(result.data.labels[1].sku, "3CWG-1");
  assert.equal(result.data.labels[1].productName, "ดู้เหล็กมาตรฐาน");
});

test("detects unknown label text as unsupported", () => {
  assert.equal(detectPlatform("random warehouse text"), "");
  const result = parseShippingLabelText("random warehouse text");
  assert.equal(result.ok, false);
  assert.equal(result.code, "LABEL_PLATFORM_UNKNOWN");
});

test("returns recoverable partial data when AWB is found but order number is missing", () => {
  const result = parseShippingLabelTexts(`
    LEX DOF H-CJM-A1 LEX
    LEXDO0185476846
    Receiver: บริษัท เซาท์เกท เอ็นจิเนียริ่ง จำกัด
    Name Qty SKU Unit Price
    ตู้ไซด์กันน้ำ 1 3CWDO-C2G-03 2849.00
    Total: 3,019.00Baht
  `);

  assert.equal(result.ok, false);
  assert.equal(result.code, "LABEL_ORDER_NOT_FOUND");
  assert.equal(result.data.awb, "LEXDO0185476846");
  assert.equal(result.data.orderNumber, "");
  assert.equal(result.data.platform, "lazada");
  assert.equal(result.data.sku, "3CWDO-C2G-03");
});

test("returns quantity 0 when OCR cannot find a valid quantity", () => {
  const result = parseShippingLabelText(`
    Shopee FLASH SPEED
    TH01288T6C4J4A
    ผู้รับ (TO) ธนศักดิ์ บุญโสม
    Shopee Order No. 2606047GU07A12
    # ชื่อสินค้า ตัวเลือกสินค้า จำนวน
    ตู้เหล็กมาตรฐาน ตู้ไซร์ ตู้คอนโทรล
  `);

  assert.equal(result.ok, true);
  assert.equal(result.data.quantity, 0);
});
