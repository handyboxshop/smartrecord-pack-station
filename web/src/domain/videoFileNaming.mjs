export function buildVideoFileLocation({ awb, status, savedAt = new Date() } = {}) {
  const date = savedAt instanceof Date ? savedAt : new Date(savedAt);
  if (Number.isNaN(date.getTime())) {
    return fail("INVALID_SAVED_AT", "วันที่บันทึกวิดีโอไม่ถูกต้อง");
  }

  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const safeAwb = sanitizeFilePart(awb);
  const safeStatus = sanitizeFilePart(String(status || "unknown").toUpperCase());

  if (!safeAwb) return fail("AWB_REQUIRED", "ต้องมีเลขพัสดุสำหรับตั้งชื่อไฟล์วิดีโอ");

  const folderName = `${yyyy}-${mm}`;
  const fileName = `${yyyy}${mm}${dd}_${safeAwb}_${safeStatus}.webm`;
  return ok({ folderName, fileName });
}

function sanitizeFilePart(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function ok(data) {
  return { ok: true, data };
}

function fail(code, message) {
  return { ok: false, code, message };
}
