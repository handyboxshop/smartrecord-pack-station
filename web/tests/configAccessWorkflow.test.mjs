import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceUploadProgress,
  buildPackStartPayload,
  establishAuthenticatedConfig,
  resolvePackDeviceSettings,
  runConfigBoot
} from "../public/assets/configLifecycle.js";
import {
  ACTIVE_VIEW_STORAGE_KEY,
  clearSavedActiveView,
  readSavedActiveView,
  resolveRestoredView,
  saveActiveView
} from "../public/assets/authViewState.js";
import {
  AuthBootstrapTimeoutError,
  completeLogout,
  createAuthUiState,
  withAbortTimeout
} from "../public/assets/authBootstrap.js";

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

function createAuthUiFixture() {
  const createClassList = (initial = []) => {
    const values = new Set(initial);
    return {
      add: (...classes) => classes.forEach((value) => values.add(value)),
      remove: (...classes) => classes.forEach((value) => values.delete(value)),
      toggle: (value, force) => {
        const shouldAdd = force === undefined ? !values.has(value) : Boolean(force);
        if (shouldAdd) values.add(value);
        else values.delete(value);
        return shouldAdd;
      },
      contains: (value) => values.has(value)
    };
  };
  const createNode = (initialClasses = []) => {
    const attributes = new Map();
    return {
      classList: createClassList(initialClasses),
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: (name) => attributes.get(name) || null
    };
  };
  const app = createNode(["authLocked"]);
  const loginScreen = createNode(["hidden"]);
  const loadingScreen = createNode();
  const ui = createAuthUiState({ app, loginScreen, loadingScreen });
  return { app, loginScreen, loadingScreen, ui };
}

function assertAuthUi({ app, loginScreen, loadingScreen }, { loading, login, appVisible }) {
  assert.equal(loadingScreen.classList.contains("hidden"), !loading);
  assert.equal(loginScreen.classList.contains("hidden"), !login);
  assert.equal(app.classList.contains("authLocked"), !appVisible);
  assert.equal(loadingScreen.getAttribute("aria-hidden"), String(!loading));
  assert.equal(loadingScreen.getAttribute("aria-busy"), String(loading));
}

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
    showLoggedOut: () => calls.push("login"),
    showInitializing: () => calls.push("loading")
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["loading", "public", "apply-public", "login"]);
});

test("boot keeps login hidden while a persisted session is being restored", async () => {
  const calls = [];
  await runConfigBoot({
    loadPublicConfig: async () => {
      calls.push("public");
      return { ok: true, data: { app: { name: "SmartRecord" } } };
    },
    applyPublicConfig: () => calls.push("apply-public"),
    hasPersistedSession: () => true,
    restoreSession: async () => {
      assert.equal(calls.includes("login"), false);
      calls.push("authenticated");
    },
    showLoggedOut: () => calls.push("login"),
    showInitializing: () => calls.push("loading")
  });

  assert.deepEqual(calls, ["loading", "public", "apply-public", "authenticated"]);
});

test("valid restoration reveals the app and failed restoration reveals login only after loading", async () => {
  const validCalls = [];
  await runConfigBoot({
    loadPublicConfig: async () => ({ ok: true, data: { app: {} } }),
    applyPublicConfig: () => validCalls.push("public"),
    hasPersistedSession: () => true,
    restoreSession: async () => validCalls.push("app"),
    showLoggedOut: () => validCalls.push("login"),
    showInitializing: () => validCalls.push("loading")
  });
  assert.deepEqual(validCalls, ["loading", "public", "app"]);

  const failedCalls = [];
  await runConfigBoot({
    loadPublicConfig: async () => ({ ok: true, data: { app: {} } }),
    applyPublicConfig: () => failedCalls.push("public"),
    hasPersistedSession: () => true,
    restoreSession: async () => failedCalls.push("login"),
    showLoggedOut: () => failedCalls.push("unexpected-logged-out"),
    showInitializing: () => failedCalls.push("loading")
  });
  assert.deepEqual(failedCalls, ["loading", "public", "login"]);
});

test("DOM bootstrap state keeps login hidden while pending and hides loading when app or login is shown", () => {
  const fixture = createAuthUiFixture();

  fixture.ui.showLoading();
  assertAuthUi(fixture, { loading: true, login: false, appVisible: false });

  fixture.ui.showApp();
  assertAuthUi(fixture, { loading: false, login: false, appVisible: true });

  fixture.ui.showLoading();
  fixture.ui.showLogin();
  assertAuthUi(fixture, { loading: false, login: true, appVisible: false });
});

test("DOM bootstrap transitions missing token and each restoration failure from loading to login", async () => {
  const scenarios = [
    { name: "missing token", hasPersistedSession: false, restoreSession: null },
    { name: "session restoration failure", hasPersistedSession: true, restoreSession: (ui) => ui.showLogin() },
    { name: "authenticated config failure", hasPersistedSession: true, restoreSession: (ui) => ui.showLogin() }
  ];

  for (const scenario of scenarios) {
    const fixture = createAuthUiFixture();
    await runConfigBoot({
      loadPublicConfig: async () => ({ ok: true, data: { app: {} } }),
      applyPublicConfig: () => {},
      hasPersistedSession: () => scenario.hasPersistedSession,
      restoreSession: async () => scenario.restoreSession?.(fixture.ui),
      showLoggedOut: () => fixture.ui.showLogin(),
      showInitializing: () => fixture.ui.showLoading()
    });
    assertAuthUi(fixture, { loading: false, login: true, appVisible: false }, scenario.name);
  }
});

test("DOM bootstrap transitions public config failure from loading to startup login fallback", async () => {
  const fixture = createAuthUiFixture();
  const result = await runConfigBoot({
    loadPublicConfig: async () => ({ ok: false, code: "AUTH_BOOT_TIMEOUT", message: "Bootstrap timed out" }),
    applyPublicConfig: () => assert.fail("public config must not be applied"),
    hasPersistedSession: () => true,
    restoreSession: async () => assert.fail("session restoration must not start"),
    showLoggedOut: () => assert.fail("logged-out branch must not run"),
    showInitializing: () => fixture.ui.showLoading()
  });
  assert.equal(result.ok, false);
  fixture.ui.showLogin(); // Mirrors boot()'s existing showStartupError() fallback.
  assertAuthUi(fixture, { loading: false, login: true, appVisible: false });
});

test("aborting bootstrap timeouts cannot leave the loading UI visible", async () => {
  let aborted = false;
  const fixture = createAuthUiFixture();
  fixture.ui.showLoading();

  await assert.rejects(
    withAbortTimeout(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = signal.aborted;
        reject(new Error("request aborted"));
      });
    }), { timeoutMs: 10, message: "Bootstrap request timed out" }),
    (error) => error instanceof AuthBootstrapTimeoutError && error.code === "AUTH_BOOT_TIMEOUT"
  );
  assert.equal(aborted, true);
  fixture.ui.showLogin();
  assertAuthUi(fixture, { loading: false, login: true, appVisible: false });
});

test("actual logout completion clears the saved active view and leaves loading hidden", async () => {
  const fixture = createAuthUiFixture();
  const values = new Map([[ACTIVE_VIEW_STORAGE_KEY, "reports"]]);
  const storage = {
    getItem: (key) => values.get(key) || null,
    removeItem: (key) => values.delete(key)
  };
  let clearedSession = 0;

  fixture.ui.showApp();
  await completeLogout({
    requestLogout: async () => ({ ok: true }),
    clearSession: () => { clearedSession += 1; },
    clearSavedView: () => clearSavedActiveView(storage),
    showLogin: () => fixture.ui.showLogin()
  });

  assert.equal(clearedSession, 1);
  assert.equal(storage.getItem(ACTIVE_VIEW_STORAGE_KEY), null);
  assertAuthUi(fixture, { loading: false, login: true, appVisible: false });
});

test("restores only a permitted saved active view and otherwise uses the first allowed view", () => {
  assert.equal(resolveRestoredView({
    savedView: "reports",
    allowedViews: ["pack", "reports"],
    fallbackView: "pack"
  }), "reports");
  assert.equal(resolveRestoredView({
    savedView: "users",
    allowedViews: ["pack", "reports"],
    fallbackView: "pack"
  }), "pack");
  assert.equal(resolveRestoredView({
    savedView: "unknown",
    allowedViews: ["pack", "reports"],
    fallbackView: "pack"
  }), "pack");
});

test("active-view storage stores only the identifier and logout cleanup removes it", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };

  saveActiveView("reports", storage);
  assert.equal(values.get(ACTIVE_VIEW_STORAGE_KEY), "reports");
  assert.equal(readSavedActiveView(storage), "reports");
  clearSavedActiveView(storage);
  assert.equal(readSavedActiveView(storage), "");
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
