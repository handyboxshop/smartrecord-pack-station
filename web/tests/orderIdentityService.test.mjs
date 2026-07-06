import assert from "node:assert/strict";
import test from "node:test";
import { DUPLICATE_ORDER_CODES, findAwbByOrderNumber, findAwbsByOrderNumber, validateOrderIdentity } from "../src/domain/orderIdentityService.mjs";

test("duplicate order code list includes all supported duplicate/conflict states", () => {
  assert.deepEqual(DUPLICATE_ORDER_CODES, [
    "ORDER_ALREADY_EXISTS",
    "ORDER_DUPLICATE_LABEL",
    "ORDER_AWB_CONFLICT"
  ]);
});

test("validateOrderIdentity requires order number whenever AWB exists", () => {
  const result = validateOrderIdentity({
    orders: {},
    awb: "LEXDO0185476846",
    orderNumber: ""
  });

  assert.equal(result?.ok, false);
  assert.equal(result?.code, "ORDER_NUMBER_REQUIRED");
  assert.match(result?.message || "", /LEXDO0185476846/);
});

test("validateOrderIdentity rejects duplicate label when AWB and order number both match", () => {
  const result = validateOrderIdentity({
    orders: {
      LEXDO0185476846: { orderNumber: "1101259465611295" }
    },
    awb: "LEXDO0185476846",
    orderNumber: "1101259465611295"
  });

  assert.equal(result?.ok, false);
  assert.equal(result?.code, "ORDER_DUPLICATE_LABEL");
});

test("validateOrderIdentity rejects AWB conflict when AWB exists with another order number", () => {
  const result = validateOrderIdentity({
    orders: {
      LEXDO0185476846: { orderNumber: "1101259465611295" }
    },
    awb: "LEXDO0185476846",
    orderNumber: "DIFFERENT-ORDER"
  });

  assert.equal(result?.ok, false);
  assert.equal(result?.code, "ORDER_AWB_CONFLICT");
});

test("validateOrderIdentity allows same order number on another AWB", () => {
  const result = validateOrderIdentity({
    orders: {
      LEXDO0185476846: { orderNumber: "1101259465611295" }
    },
    awb: "LEXDO0185476999",
    orderNumber: "1101259465611295"
  });

  assert.equal(result, null);
});

test("validateOrderIdentity allows updating the same AWB when ignoreAwb matches", () => {
  const result = validateOrderIdentity({
    orders: {
      LEXDO0185476846: { orderNumber: "1101259465611295" }
    },
    awb: "LEXDO0185476846",
    orderNumber: "1101259465611295",
    ignoreAwb: "LEXDO0185476846"
  });

  assert.equal(result, null);
});

test("findAwbByOrderNumber returns empty string when order number is not found", () => {
  const awb = findAwbByOrderNumber({
    orders: {
      LEXDO0185476846: { orderNumber: "1101259465611295" }
    },
    orderNumber: "NOT-FOUND"
  });

  assert.equal(awb, "");
});

test("findAwbsByOrderNumber returns every AWB linked to the same order number", () => {
  const awbs = findAwbsByOrderNumber({
    orders: {
      LEXDO0185476846: { orderNumber: "1101259465611295" },
      LEXDO0185476999: { orderNumber: "1101259465611295" },
      TH23018SMKA02G: { orderNumber: "260529NR16YYRH" }
    },
    orderNumber: "1101259465611295"
  });

  assert.deepEqual(awbs, ["LEXDO0185476846", "LEXDO0185476999"]);
});
