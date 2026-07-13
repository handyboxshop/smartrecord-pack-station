export function resolvePackDeviceSettings(config, saved = {}) {
  const targets = Array.isArray(config?.upload?.storageTargets) ? config.upload.storageTargets : [];
  const allowedTargetIds = new Set(targets.map((target) => target.id).filter(Boolean));
  const configuredDefault = config?.upload?.defaultStorageTargetId;
  const defaultStorageTargetId = allowedTargetIds.has(configuredDefault)
    ? configuredDefault
    : targets.find((target) => target.isDefault)?.id || targets[0]?.id || "";
  const savedStorageTargetId = String(saved.storageTargetId || "");

  return {
    storageTargetId: allowedTargetIds.has(savedStorageTargetId) ? savedStorageTargetId : defaultStorageTargetId,
    customStoragePath: "",
    cameraDeviceId: saved.cameraDeviceId || "",
    scannerMode: saved.scannerMode || ""
  };
}

export function buildPackStartPayload({ awb, config, currentUser, deviceSettings }) {
  return {
    awb,
    employeeId: config?.employees?.defaultEmployeeId || currentUser?.employeeId || "",
    stationId: config?.station?.defaultStationId || "",
    storageTargetId: deviceSettings?.storageTargetId || ""
  };
}

export async function runConfigBoot({
  loadPublicConfig,
  applyPublicConfig,
  hasPersistedSession,
  restoreSession,
  showLoggedOut,
  showInitializing = () => {}
}) {
  showInitializing();
  const result = await loadPublicConfig();
  if (!result?.ok || !result.data) return result;

  applyPublicConfig(result.data);
  if (hasPersistedSession()) await restoreSession();
  else showLoggedOut();
  return result;
}

export async function advanceUploadProgress(steps, { wait, onStep }) {
  for (const step of Array.isArray(steps) ? steps : []) {
    await wait();
    onStep(step);
  }
}

export async function establishAuthenticatedConfig({
  token,
  loadConfig,
  logout,
  persistToken,
  clearPersistedToken,
  applyConfig,
  clearSession
}) {
  const result = await loadConfig(token);
  if (!result?.ok || !result.data) {
    try {
      await logout(token);
    } catch {
      // Best effort: client state is always cleared even if the server is unreachable.
    }
    clearPersistedToken();
    clearSession();
    return result || { ok: false, message: "Unable to load authenticated configuration" };
  }

  applyConfig(result.data);
  persistToken(token);
  return result;
}
