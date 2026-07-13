import assert from "node:assert/strict";
import test from "node:test";

import { establishAuthenticatedConfig } from "../public/assets/configLifecycle.js";
import { createAuthenticatedRuntimeCleanup } from "../public/assets/authRuntimeCleanup.js";

function createFixture({ recorderState = "recording" } = {}) {
  const state = {
    publicConfig: { app: { name: "Public only" } },
    authToken: "high-privilege-token",
    currentUser: { email: "owner@example.test", permissions: ["users:manage"] },
    config: { auth: { roles: ["owner"] }, reports: { private: true } },
    users: [{ email: "owner@example.test" }],
    auditLogs: [{ action: "user_update" }],
    activityLogs: [{ action: "view_reports" }],
    editingUserEmail: "staff@example.test",
    editingImportedAwb: "AWB-EDIT",
    session: { id: "SESSION-1" },
    record: { id: "RECORD-1" },
    records: [{ id: "RECORD-1" }],
    syncedOrders: [{ awb: "AWB-1" }],
    labels: [{ id: "LABEL-1" }],
    labelSummary: { total: 1, filtered: 1 },
    labelSearchQuery: "customer name",
    selectedOrderIds: new Set(["AWB-1"]),
    activeLabelPreviewId: "LABEL-1",
    pendingLabelAutoPrint: true,
    diagnostics: { private: true }
  };
  const storage = { removed: [], removeItem(key) { this.removed.push(key); } };
  const recorder = { state: recorderState, stopCalls: 0, stop() { this.stopCalls += 1; this.state = "inactive"; } };
  const tracks = [{ stopCalls: 0, stop() { this.stopCalls += 1; } }, { stopCalls: 0, stop() { this.stopCalls += 1; } }];
  const settingsTrack = { stopCalls: 0, stop() { this.stopCalls += 1; } };
  const mediaStream = { getTracks: () => tracks };
  const settingsCameraStream = { getTracks: () => [settingsTrack] };
  const dom = {
    privilegedCollection: "<section>owner-only audit</section>",
    editingValue: "staff@example.test",
    selectedValue: "AWB-1",
    webcamSource: "active-stream"
  };
  const clearedIntervals = [];
  let resetResources = null;
  const runtime = createAuthenticatedRuntimeCleanup({
    state,
    storage,
    getMediaResources: () => ({ mediaRecorder: recorder, streams: [mediaStream, settingsCameraStream], recTimerId: 91 }),
    resetMediaResources: (resources) => { resetResources = resources; },
    clearIntervalFn: (timer) => clearedIntervals.push(timer),
    resetRecordingDiagnostics: () => ({ cameraStarted: false, recorderStarted: false }),
    clearPermissionSensitiveDom: () => {
      dom.privilegedCollection = "";
      dom.editingValue = "";
      dom.selectedValue = "";
      dom.webcamSource = null;
    }
  });
  return { state, storage, recorder, tracks, settingsTrack, dom, clearedIntervals, runtime, get resetResources() { return resetResources; } };
}

test("AUTH_REQUIRED triggers the central cleanup routine", () => {
  const fixture = createFixture();

  assert.equal(fixture.runtime.cleanupForAuthenticationFailure({ code: "AUTH_REQUIRED" }), true);
  assert.equal(fixture.state.authToken, "");
  assert.equal(fixture.state.currentUser, null);
  assert.equal(fixture.state.config, null);
  assert.deepEqual(fixture.storage.removed, ["smartrecord.authToken"]);
});

test("SESSION_EXPIRED safely stops the recorder, every stream track, timer, and camera state", () => {
  const fixture = createFixture();

  assert.equal(fixture.runtime.cleanupForAuthenticationFailure({ code: "SESSION_EXPIRED" }), true);
  assert.equal(fixture.recorder.stopCalls, 1);
  assert.deepEqual(fixture.tracks.map((track) => track.stopCalls), [1, 1]);
  assert.equal(fixture.settingsTrack.stopCalls, 1);
  assert.deepEqual(fixture.clearedIntervals, [91]);
  assert.deepEqual(fixture.resetResources, {
    mediaRecorder: null,
    mediaStream: null,
    settingsCameraStream: null,
    recordedChunks: [],
    recordingDiagnostics: { cameraStarted: false, recorderStarted: false },
    recTimerId: null,
    recSeconds: 0
  });
});

test("authenticated-config failure uses the central cleanup routine", async () => {
  const fixture = createFixture();
  const result = await establishAuthenticatedConfig({
    token: fixture.state.authToken,
    loadConfig: async () => ({ ok: false, code: "CONFIG_UNAVAILABLE" }),
    logout: async () => {},
    persistToken: () => assert.fail("a failed config load must not persist a token"),
    clearPersistedToken: () => {},
    applyConfig: () => assert.fail("a failed config load must not apply config"),
    clearSession: fixture.runtime.cleanup
  });

  assert.equal(result.code, "CONFIG_UNAVAILABLE");
  assert.equal(fixture.state.config, null);
  assert.equal(fixture.state.session, null);
  assert.equal(fixture.recorder.stopCalls, 1);
});

test("explicit cleanup clears privileged collections, editing state, selections, and DOM before a lower-privilege identity is accepted", () => {
  const fixture = createFixture();

  fixture.runtime.cleanup();
  fixture.state.authToken = "packer-token";
  fixture.state.currentUser = { email: "packer@example.test", permissions: ["pack:use"] };
  fixture.state.config = { station: { defaultStationId: "PACK-01" } };

  assert.deepEqual(fixture.state.users, []);
  assert.deepEqual(fixture.state.auditLogs, []);
  assert.deepEqual(fixture.state.activityLogs, []);
  assert.deepEqual(fixture.state.records, []);
  assert.deepEqual(fixture.state.syncedOrders, []);
  assert.deepEqual(fixture.state.labels, []);
  assert.equal(fixture.state.editingUserEmail, "");
  assert.equal(fixture.state.editingImportedAwb, "");
  assert.equal(fixture.state.selectedOrderIds.size, 0);
  assert.equal(fixture.state.activeLabelPreviewId, "");
  assert.equal(fixture.state.diagnostics, null);
  assert.deepEqual(fixture.dom, {
    privilegedCollection: "",
    editingValue: "",
    selectedValue: "",
    webcamSource: null
  });
  assert.deepEqual(fixture.state.publicConfig, { app: { name: "Public only" } });
});

test("cleanup is idempotent when no authenticated state exists or the recorder is inactive", () => {
  const fixture = createFixture({ recorderState: "inactive" });

  assert.doesNotThrow(() => fixture.runtime.cleanup());
  assert.doesNotThrow(() => fixture.runtime.cleanup());
  assert.equal(fixture.recorder.stopCalls, 0);
  assert.equal(fixture.runtime.getGeneration(), 2);
});
