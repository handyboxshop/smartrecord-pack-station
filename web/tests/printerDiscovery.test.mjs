import assert from "node:assert/strict";
import test from "node:test";
import { parseLpstatPrinters } from "../src/domain/printerDiscovery.mjs";

test("parse lpstat printer list into system printer options", () => {
  const printers = parseLpstatPrinters(`
printer TSC_TE244 is idle.  enabled since Tue Jun 23 08:00:00 2026
printer Zebra_ZPL_Compatible disabled since Tue Jun 23 08:01:00 2026 -
`);

  assert.deepEqual(printers, [
    {
      id: "system:TSC_TE244",
      label: "TSC TE244",
      systemName: "TSC_TE244",
      source: "system"
    },
    {
      id: "system:Zebra_ZPL_Compatible",
      label: "Zebra ZPL Compatible",
      systemName: "Zebra_ZPL_Compatible",
      source: "system"
    }
  ]);
});
