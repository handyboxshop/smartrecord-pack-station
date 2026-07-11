import path from "node:path";

export function resolveStorageRoot({ rootDir, storageTarget, customPath }) {
  const customPathValue = String(customPath ?? "").trim();
  if (requiresCustomNasMountPath(storageTarget) && !customPathValue) {
    return {
      ok: false,
      code: "CUSTOM_STORAGE_PATH_REQUIRED",
      message: "NAS กำหนดเองต้องกรอก mounted path จริงก่อนใช้งาน"
    };
  }

  const rawPath = customPathValue || storageTarget.localPath;
  if (/^https?:\/\//i.test(rawPath)) {
    const urlResult = validateExternalUrl(rawPath);
    if (!urlResult.ok) return urlResult;
    if (storageTarget.provider !== "cloud-sync") {
      return {
        ok: false,
        code: "INVALID_CUSTOM_STORAGE_URL",
        message: "URL เว็บภายนอกใช้ได้เฉพาะ Storage Target แบบ Cloud Sync"
      };
    }
    return resolveProjectStorage({
      rootDir,
      rawPath: storageTarget.localPath,
      externalUrl: rawPath,
      destinationType: "website-url",
      provider: storageTarget.provider
    });
  }

  const nasPathValidation = validateNasWritablePath(rawPath, storageTarget, Boolean(customPathValue));
  if (!nasPathValidation.ok) return nasPathValidation;

  return resolveProjectStorage({ rootDir, rawPath, destinationType: "file-path", provider: storageTarget.provider });
}

export async function verifyStorageDestination({ fs, rootDir, storageTarget, customPath, logError }) {
  const resolved = resolveStorageRoot({ rootDir, storageTarget, customPath });
  if (!resolved.ok) return safeStorageError(resolved.code, resolved.message);
  if (resolved.data.mountedRequired) {
    return safeStorageError(
      "STORAGE_MOUNT_UNAVAILABLE",
      "ปลายทาง NAS ยังต้องตั้งค่าหรือ mount บน SmartRecord server ก่อนตรวจสอบได้"
    );
  }

  try {
    await fs.mkdir(resolved.data.storageRoot, { recursive: true });
    const probePath = path.join(resolved.data.storageRoot, `.smartrecord-storage-test-${Date.now()}.tmp`);
    await fs.writeFile(probePath, "smartrecord-storage-ok", "utf8");
    await fs.unlink(probePath);
    return {
      ok: true,
      data: {
        status: "available",
        targetLabel: storageTarget.label,
        writable: true,
        message: "SmartRecord server ตรวจสอบปลายทางจัดเก็บและเขียนไฟล์ทดสอบได้"
      }
    };
  } catch (error) {
    if (typeof logError === "function") {
      logError(`[storage] verification failed for target=${storageTarget?.id || "unknown"}`, error);
    }
    if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) {
      return safeStorageError("STORAGE_NOT_WRITABLE", "ปลายทางจัดเก็บไม่อนุญาตให้ SmartRecord server เขียนไฟล์");
    }
    if (["ENOENT", "ENOTDIR", "ENODEV", "ESTALE"].includes(error?.code)) {
      return safeStorageError("STORAGE_DESTINATION_UNAVAILABLE", "ปลายทางจัดเก็บไม่พร้อมใช้งานบน SmartRecord server");
    }
    return safeStorageError("STORAGE_VERIFICATION_FAILED", "ตรวจสอบปลายทางจัดเก็บไม่สำเร็จ กรุณาลองใหม่หรือตรวจการตั้งค่าบน server");
  }
}

function safeStorageError(code, message) {
  return { ok: false, code, message };
}

function validateExternalUrl(rawPath) {
  try {
    const url = new URL(rawPath);
    if (!["http:", "https:"].includes(url.protocol)) {
      return {
        ok: false,
        code: "INVALID_CUSTOM_STORAGE_URL",
        message: "Website URL ต้องขึ้นต้นด้วย http:// หรือ https://"
      };
    }
    if (url.username || url.password) {
      return {
        ok: false,
        code: "CUSTOM_STORAGE_URL_HAS_SECRET",
        message: "Website URL ห้ามใส่ username/password หรือ secret ไว้ใน URL"
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      code: "INVALID_CUSTOM_STORAGE_URL",
      message: "Website URL ไม่ถูกต้อง"
    };
  }
}

function resolveProjectStorage({ rootDir, rawPath, externalUrl = "", destinationType = "file-path", provider = "" }) {
  if (rawPath.includes("..")) {
    return {
      ok: false,
      code: "INVALID_CUSTOM_STORAGE_PATH",
      message: "Custom Path ห้ามใช้ .. เพื่อย้อนออกนอกโฟลเดอร์จัดเก็บ"
    };
  }

  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(rootDir, rawPath);
  const projectRoot = path.resolve(rootDir);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    return {
      ok: false,
      code: "CUSTOM_STORAGE_PATH_TOO_BROAD",
      message: "Custom Path ห้ามชี้ไปที่ root ของเครื่องโดยตรง"
    };
  }

  return {
    ok: true,
    data: {
      storageRoot: resolved,
      externalUrl,
      destinationType,
      isInsideProject: resolved.startsWith(projectRoot),
      targetMode: classifyStorageMode({ provider, storageTargetPath: rawPath, resolvedPath: resolved, projectRoot, externalUrl }),
      mountedRequired: isMountedPathRequired({ provider, storageTargetPath: rawPath, resolvedPath: resolved, projectRoot, externalUrl }),
      simulated: isMountedPathRequired({ provider, storageTargetPath: rawPath, resolvedPath: resolved, projectRoot, externalUrl })
    }
  };
}

export function describeStorageTarget({ rootDir, storageTarget, customPath = "" }) {
  const customPathValue = String(customPath ?? "").trim();
  if (requiresCustomNasMountPath(storageTarget) && !customPathValue) {
    return {
      provider: storageTarget.provider,
      targetMode: "nas-custom-required",
      mountedRequired: true,
      simulated: true,
      customPathRequired: true
    };
  }

  const rawPath = customPathValue || storageTarget.localPath;
  const resolvedLocalPath = resolveAbsolutePath(rootDir, rawPath);
  const externalUrl = /^https?:\/\//i.test(rawPath) ? rawPath : "";
  const targetMode = classifyStorageMode({
    provider: storageTarget.provider,
    storageTargetPath: externalUrl ? storageTarget.localPath : rawPath,
    resolvedPath: externalUrl ? resolveAbsolutePath(rootDir, storageTarget.localPath) : resolvedLocalPath,
    projectRoot: path.resolve(rootDir),
    externalUrl
  });
  const mountedRequired = isMountedPathRequired({
    provider: storageTarget.provider,
    storageTargetPath: externalUrl ? storageTarget.localPath : rawPath,
    resolvedPath: externalUrl ? resolveAbsolutePath(rootDir, storageTarget.localPath) : resolvedLocalPath,
    projectRoot: path.resolve(rootDir),
    externalUrl
  });
  return {
    provider: storageTarget.provider,
    targetMode,
    mountedRequired,
    simulated: mountedRequired,
    customPathRequired: requiresCustomNasMountPath(storageTarget)
  };
}

function resolveAbsolutePath(rootDir, rawPath = "") {
  return path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(rootDir, rawPath);
}

function requiresCustomNasMountPath(storageTarget) {
  return storageTarget?.provider === "nas" && storageTarget?.id === "custom-nas";
}

function validateNasWritablePath(rawPath, storageTarget, isCustomOverride) {
  if (storageTarget?.provider !== "nas") return { ok: true };
  if (looksLikeIpAddressPath(rawPath)) {
    return {
      ok: false,
      code: "INVALID_CUSTOM_STORAGE_PATH",
      message: "ห้ามกรอกเป็น IP address อย่างเดียว ต้องใช้ mounted path จริง"
    };
  }
  if (requiresCustomNasMountPath(storageTarget) || isCustomOverride) {
    if (!path.isAbsolute(rawPath)) {
      return {
        ok: false,
        code: "CUSTOM_STORAGE_PATH_MUST_BE_ABSOLUTE",
        message: "NAS ต้องใช้ absolute path หรือ mounted path จริงเท่านั้น"
      };
    }
  }
  return { ok: true };
}

function looksLikeIpAddressPath(rawPath = "") {
  return /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/i.test(String(rawPath).trim());
}

function classifyStorageMode({ provider = "", storageTargetPath = "", resolvedPath = "", projectRoot = "", externalUrl = "" }) {
  if (externalUrl) return "external-cloud-sync";
  if (provider === "local") return "local-machine";
  if (provider === "cloud-sync") return "cloud-sync-fallback";
  if (provider === "nas") {
    return isMountedPathRequired({ provider, storageTargetPath, resolvedPath, projectRoot, externalUrl })
      ? "nas-simulated"
      : "nas-mounted";
  }
  return provider || "unknown";
}

function isMountedPathRequired({ provider = "", storageTargetPath = "", resolvedPath = "", projectRoot = "", externalUrl = "" }) {
  if (externalUrl || provider !== "nas") return false;
  const raw = String(storageTargetPath || "").trim();
  if (!path.isAbsolute(raw)) return true;
  return Boolean(projectRoot) && String(resolvedPath || "").startsWith(projectRoot);
}
