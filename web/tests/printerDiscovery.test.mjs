import assert from "node:assert/strict";
import test from "node:test";
import { discoverNasCupsPrinters, parseLpstatPrinters } from "../src/domain/printerDiscovery.mjs";

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

test("missing lpstat reports NAS/CUPS discovery as unsupported without exposing host details", async () => {
  const result = await discoverNasCupsPrinters({
    execFileFn: async () => {
      const error = new Error("spawn lpstat ENOENT /usr/bin/lpstat");
      error.code = "ENOENT";
      throw error;
    }
  });

  assert.deepEqual(result, {
    ok: false,
    code: "NAS_CUPS_UNSUPPORTED",
    message: "Server นี้ยังไม่ได้ตั้งค่า NAS / CUPS printer discovery"
  });
});

test("NAS/CUPS discovery failure has a sanitized browser-safe message", async () => {
  const result = await discoverNasCupsPrinters({
    execFileFn: async () => {
      throw new Error("permission denied at /private/nas/cups.conf");
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "NAS_CUPS_DISCOVERY_FAILED");
  assert.equal(result.message, "ไม่สามารถค้นหาเครื่องพิมพ์บน NAS / CUPS ได้");
  assert.doesNotMatch(result.message, /private|cups\.conf|permission denied/i);
});
