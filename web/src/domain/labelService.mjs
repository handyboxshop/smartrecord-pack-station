import crypto from "node:crypto";

const DATA_URL_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

export function createLabelService({ config, idFactory, initialLabels = [] } = {}) {
  if (!config?.labelPrint) throw new Error("labelPrint config is required");

  const labels = Array.isArray(initialLabels) ? [...initialLabels] : [];
  const nextId = idFactory ?? (() => crypto.randomUUID());
  const enabledPlatforms = config.labelPrint.enabledPlatforms || [];
  const acceptedImageTypes = config.labelPrint.acceptedImageTypes || [];
  const maxBytes = (config.labelPrint.maxImageSizeMb || 5) * 1024 * 1024;

  function saveLabel({ platform, date, imageDataUrl, fileName } = {}) {
    if (!enabledPlatforms.includes(platform)) {
      return fail("PLATFORM_NOT_SUPPORTED", `รองรับเฉพาะแพลตฟอร์ม: ${enabledPlatforms.join(", ")}`);
    }
    if (!date || Number.isNaN(new Date(date).getTime())) {
      return fail("LABEL_DATE_REQUIRED", "กรุณาเลือกวัน/เดือน/ปีที่นำเข้าออเดอร์");
    }

    const match = DATA_URL_PATTERN.exec(String(imageDataUrl ?? ""));
    if (!match) {
      return fail("LABEL_IMAGE_REQUIRED", "กรุณาอัปโหลดรูปใบปะหน้า");
    }
    const [, mimeType, base64] = match;
    if (acceptedImageTypes.length && !acceptedImageTypes.includes(mimeType)) {
      return fail("LABEL_IMAGE_TYPE_NOT_SUPPORTED", `รองรับไฟล์รูปภาพ: ${acceptedImageTypes.join(", ")}`);
    }
    const approxBytes = Math.ceil((base64.length * 3) / 4);
    if (approxBytes > maxBytes) {
      return fail("LABEL_IMAGE_TOO_LARGE", `ไฟล์รูปใหญ่เกิน ${config.labelPrint.maxImageSizeMb} MB`);
    }

    const label = {
      id: `LBL-${String(nextId()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toUpperCase()}`,
      platform,
      date,
      fileName: String(fileName ?? "label.jpg").trim().slice(0, 120) || "label.jpg",
      imageDataUrl,
      sizeBytes: approxBytes,
      createdAt: new Date().toISOString()
    };
    labels.unshift(label);
    return ok(label, "บันทึกใบปะหน้าแล้ว");
  }

  function listLabels({ date = "", platform = "" } = {}) {
    const normalizedDate = String(date || "").trim();
    const normalizedPlatform = String(platform || "").trim().toLowerCase();
    const filtered = labels.filter((label) => {
      if (String(label.status || "").trim().toLowerCase() === "skipped") return false;
      const sameDate = !normalizedDate || String(label.date || "").trim() === normalizedDate;
      const samePlatform = !normalizedPlatform || String(label.platform || "").trim().toLowerCase() === normalizedPlatform;
      return sameDate && samePlatform;
    });
    const printableTotal = labels.filter((label) => String(label.status || "").trim().toLowerCase() !== "skipped").length;
    return ok({
      labels: [...filtered],
      total: printableTotal,
      filtered: filtered.length
    });
  }

  function registerImportedLabel({ parsed = {}, labelFile = {}, order = null, status = "imported" } = {}) {
    const importedAt = labelFile.importedAt || new Date().toISOString();
    const cleanAwb = String(parsed.awb || order?.awb || "").trim();
    if (cleanAwb) {
      for (let index = labels.length - 1; index >= 0; index -= 1) {
        const current = labels[index];
        if (current?.source !== "connect-import") continue;
        if (String(current?.awb || "").trim() !== cleanAwb) continue;
        labels.splice(index, 1);
      }
    }
    const label = {
      id: `LBL-${String(nextId()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toUpperCase()}`,
      source: "connect-import",
      status,
      platform: parsed.platform || order?.platform || "custom",
      date: importedAt.slice(0, 10),
      fileName: String(labelFile.fileName || "shipping-label").trim().slice(0, 120) || "shipping-label",
      relativePath: labelFile.pageImageRelativePath || labelFile.relativePath || "",
      originalRelativePath: labelFile.relativePath || "",
      contentType: labelFile.contentType || "",
      awb: cleanAwb,
      orderNumber: parsed.orderNumber || order?.orderNumber || "",
      customerName: parsed.customerName || order?.buyer || "",
      carrier: parsed.carrier || order?.carrier || "",
      page: labelFile.page || 1,
      labelIndex: labelFile.labelIndex || 1,
      sizeBytes: labelFile.bytes || 0,
      createdAt: importedAt
    };
    labels.unshift(label);
    return ok(label, "บันทึกใบปะหน้าจาก Connect / Import แล้ว");
  }

  function getLabel(id) {
    const label = labels.find((item) => item.id === id);
    if (!label) return fail("LABEL_NOT_FOUND", "ไม่พบใบปะหน้านี้");
    return ok(label);
  }

  function deleteLabelsForAwb({ awb = "" } = {}) {
    const cleanAwb = String(awb || "").trim();
    if (!cleanAwb) return fail("AWB_REQUIRED", "กรุณาระบุ AWB ที่ต้องการลบใบปะหน้า");
    const before = labels.length;
    for (let index = labels.length - 1; index >= 0; index -= 1) {
      if (String(labels[index]?.awb || "").trim() === cleanAwb) {
        labels.splice(index, 1);
      }
    }
    return ok({ awb: cleanAwb, deletedCount: before - labels.length });
  }

  function updateLabelsForAwb({ awb = "", updates = {} } = {}) {
    const cleanAwb = String(awb || "").trim();
    if (!cleanAwb) return fail("AWB_REQUIRED", "กรุณาระบุ AWB ที่ต้องการอัปเดตใบปะหน้า");

    const touched = [];
    for (const label of labels) {
      if (String(label?.awb || "").trim() !== cleanAwb) continue;
      if (updates.platform != null) label.platform = String(updates.platform || "").trim() || label.platform;
      if (updates.orderNumber != null) label.orderNumber = String(updates.orderNumber || "").trim();
      if (updates.customerName != null) label.customerName = String(updates.customerName || "").trim();
      if (updates.carrier != null) label.carrier = String(updates.carrier || "").trim();
      if (updates.awb != null) label.awb = String(updates.awb || "").trim() || label.awb;
      touched.push(label.id);
    }

    return ok({ awb: cleanAwb, updatedCount: touched.length, labelIds: touched });
  }

  function listAllLabels() {
    return [...labels];
  }

  return { saveLabel, registerImportedLabel, listLabels, listAllLabels, getLabel, deleteLabelsForAwb, updateLabelsForAwb };
}

function ok(data, message = "") {
  return { ok: true, data, message };
}

function fail(code, message, data = null) {
  return { ok: false, code, message, data };
}
