import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function discoverLocalPrinters({ execFileFn = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileFn("lpstat", ["-p"], { timeout: 3000 });
    const printers = parseLpstatPrinters(stdout);
    return {
      ok: true,
      data: { printers },
      message: printers.length ? `พบเครื่องพิมพ์ ${printers.length} เครื่อง` : "ไม่พบเครื่องพิมพ์ในเครื่องนี้"
    };
  } catch (error) {
    return {
      ok: false,
      code: "PRINTER_DISCOVERY_FAILED",
      message: `ค้นหาเครื่องพิมพ์ในเครื่องไม่สำเร็จ: ${error.message}`
    };
  }
}

export function parseLpstatPrinters(stdout = "") {
  return stdout
    .split(/\r?\n/)
    .map((line) => /^printer\s+(\S+)/i.exec(line.trim())?.[1])
    .filter(Boolean)
    .map((name) => ({
      id: `system:${name}`,
      label: name.replace(/_/g, " "),
      systemName: name,
      source: "system"
    }));
}
