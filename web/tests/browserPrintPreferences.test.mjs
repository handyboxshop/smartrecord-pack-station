import assert from "node:assert/strict";
import test from "node:test";
import { loadBrowserPrintPreferences, saveBrowserPrintPreferences } from "../public/assets/browserPrintPreferences.js";

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

test("browser print paper preference persists only in the provided workstation storage", () => {
  const workstationA = createStorage();
  const workstationB = createStorage();

  assert.deepEqual(saveBrowserPrintPreferences({ paperSize: "100x150" }, workstationA), { paperSize: "100x150" });
  assert.deepEqual(loadBrowserPrintPreferences(workstationA), { paperSize: "100x150" });
  assert.deepEqual(loadBrowserPrintPreferences(workstationB), { paperSize: "a4" });
});

test("browser print preferences reject unsupported paper sizes", () => {
  const storage = createStorage();
  saveBrowserPrintPreferences({ paperSize: "printer-online" }, storage);
  assert.deepEqual(loadBrowserPrintPreferences(storage), { paperSize: "a4" });
});
