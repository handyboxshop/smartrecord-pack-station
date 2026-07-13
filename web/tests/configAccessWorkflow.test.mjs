import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceUploadProgress,
  buildPackStartPayload,
  establishAuthenticatedConfig,
  resolvePackDeviceSettings,
  runConfigBoot
} from "../public/assets/configLifecycle.js";

const packConfig = {
  station: { defaultStationId: "STATION-01" },
  employees: { defaultEmployeeId: "EMP-01" },
  upload: {
    defaultStorageTargetId: "safe-default",
    simulationSteps: [
      { pct: 40, label: "Preparing" },
      { pct: 100, label: "Complete" }
    ],
    storageTargets: [
      { id: "safe-default", label: "Default", provider: "local", isDefault: true },
      { id: "safe-secondary", label: "Secondary", provider: "local", isDefault: false }
    ]
  }
};

test("logged-out boot loads public config and never attempts authenticated restoration", async () => {
  const calls = [];
  const result = await runConfigBoot({
    loadPublicConfig: async () => {
      calls.push("public");
      return { ok: true, data: { app: { name: "SmartRecord" } } };
    },
    applyPublicConfig: () => calls.push("apply-public"),
    hasPersistedSession: () => false,
    restoreSession: async () => calls.push("authenticated"),
    showLoggedOut: () => calls.push("login")
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["public", "apply-public", "login"]);
});

test("boot restores authenticated config only after public config when a token exists", async () => {
  const calls = [];
  await runConfigBoot({
    loadPublicConfig: async () => {
      calls.push("public");
      return { ok: true, data: { app: { name: "SmartRecord" } } };
    },
    applyPublicConfig: () => calls.push("apply-public"),
    hasPersistedSession: () => true,
    restoreSession: async () => calls.push("authenticated"),
    showLoggedOut: () => calls.push("login")
  });

  assert.deepEqual(calls, ["public", "apply-public", "authenticated"]);
});

test("Packer preserves an allowed saved storage target and sends it when starting a session", () => {
  const settings = resolvePackDeviceSettings(packConfig, { storageTargetId: "safe-secondary" });
  const payload = buildPackStartPayload({
    awb: "AWB-SAFE",
    config: packConfig,
    currentUser: { employeeId: "EMP-USER" },
    deviceSettings: settings
  });

  assert.equal(settings.storageTargetId, "safe-secondary");
  assert.equal(settings.customStoragePath, "");
  assert.deepEqual(payload, {
    awb: "AWB-SAFE",
    employeeId: "EMP-01",
    stationId: "STATION-01",
    storageTargetId: "safe-secondary"
  });
});

test("Packer rejects an unknown saved target and falls back to the server-approved default", () => {
  const settings = resolvePackDeviceSettings(packConfig, {
    storageTargetId: "client-only-target",
    customStoragePath: "client-only-custom-path"
  });

  assert.equal(settings.storageTargetId, "safe-default");
  assert.equal(settings.customStoragePath, "");
});

test("upload progress advances through every server-provided step", async () => {
  const advanced = [];
  let waits = 0;
  await advanceUploadProgress(packConfig.upload.simulationSteps, {
    wait: async () => {
      waits += 1;
    },
    onStep: (step) => advanced.push(step.pct)
  });

  assert.equal(waits, 2);
  assert.deepEqual(advanced, [40, 100]);
});

test("authenticated config persists a new token only after config succeeds", async () => {
  const calls = [];
  let appliedConfig = null;
  await establishAuthenticatedConfig({
    token: "temporary-token",
    loadConfig: async () => {
      calls.push("load-config");
      return { ok: true, data: packConfig };
    },
    logout: async () => calls.push("logout"),
    persistToken: () => calls.push("persist-token"),
    clearPersistedToken: () => calls.push("clear-token"),
    applyConfig: (config) => {
      calls.push("apply-config");
      appliedConfig = config;
    },
    clearSession: () => calls.push("clear-session")
  });

  assert.equal(appliedConfig, packConfig);
  assert.deepEqual(calls, ["load-config", "apply-config", "persist-token"]);
});

test("config failure logs out the temporary server session and clears previous client config", async () => {
  const calls = [];
  let clientState = { token: "temporary-token", user: { id: "old-user" }, config: { reports: {} } };
  const result = await establishAuthenticatedConfig({
    token: "temporary-token",
    loadConfig: async () => ({ ok: false, code: "CONFIG_UNAVAILABLE" }),
    logout: async (token) => calls.push(["logout", token]),
    persistToken: () => calls.push(["persist"]),
    clearPersistedToken: () => calls.push(["clear-persisted"]),
    applyConfig: () => calls.push(["apply"]),
    clearSession: () => {
      calls.push(["clear-session"]);
      clientState = { token: "", user: null, config: null };
    }
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [
    ["logout", "temporary-token"],
    ["clear-persisted"],
    ["clear-session"]
  ]);
  assert.deepEqual(clientState, { token: "", user: null, config: null });
});

test("client session is cleared even when best-effort server logout fails", async () => {
  let cleared = false;
  await establishAuthenticatedConfig({
    token: "temporary-token",
    loadConfig: async () => ({ ok: false }),
    logout: async () => {
      throw new Error("network unavailable");
    },
    persistToken: () => {},
    clearPersistedToken: () => {},
    applyConfig: () => {},
    clearSession: () => {
      cleared = true;
    }
  });

  assert.equal(cleared, true);
});
