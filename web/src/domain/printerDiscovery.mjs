import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function discoverNasCupsPrinters({ execFileFn = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileFn("lpstat", ["-p"], { timeout: 3000 });
    const printers = parseLpstatPrinters(stdout);
    return {
      ok: true,
      data: { printers },
      message: printers.length ? `พบเครื่องพิมพ์ NAS / CUPS ${printers.length} เครื่อง` : "ไม่พบเครื่องพิมพ์ที่ตั้งค่าไว้บน NAS / CUPS"
    };
  } catch (error) {
    if (error?.code === "ENOENT") return {
      ok: false,
      code: "NAS_CUPS_UNSUPPORTED",
      message: "Server นี้ยังไม่ได้ตั้งค่า NAS / CUPS printer discovery"
    };
    return {
      ok: false,
      code: "NAS_CUPS_DISCOVERY_FAILED",
      message: "ไม่สามารถค้นหาเครื่องพิมพ์บน NAS / CUPS ได้"
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
