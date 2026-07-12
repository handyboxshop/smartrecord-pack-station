import assert from "node:assert/strict";
import test from "node:test";

import { settleAuthenticatedCameraRequest } from "../public/assets/cameraLifecycle.js";
import { createAuthenticatedRuntimeCleanup } from "../public/assets/authRuntimeCleanup.js";

test("a rejected camera request after authenticated cleanup cannot restore state or create a timer", async () => {
  const state = { authToken: "active-token" };
  const runtime = createAuthenticatedRuntimeCleanup({
    state,
    storage: { removeItem() {} },
    getMediaResources: () => ({}),
    resetMediaResources: () => {},
    clearPermissionSensitiveDom: () => {}
  });
  const requestGeneration = runtime.getGeneration();
  const requestToken = state.authToken;
  let rejectCameraRequest;
  const pendingCamera = new Promise((_, reject) => { rejectCameraRequest = reject; });
  let cameraStateUpdates = 0;
  let timerStarts = 0;

  const request = settleAuthenticatedCameraRequest({
    openCameraStream: () => pendingCamera,
    isCurrent: () => runtime.isCurrent(requestGeneration, requestToken),
    onStream: () => { cameraStateUpdates += 1; },
    onError: () => { cameraStateUpdates += 1; },
    startTimer: () => { timerStarts += 1; }
  });

  runtime.cleanup();
  rejectCameraRequest(new Error("camera permission denied"));

  assert.equal(await request, false);
  assert.equal(cameraStateUpdates, 0);
  assert.equal(timerStarts, 0);
});

test("a resolved camera request after authenticated cleanup stops its stream without starting media or a timer", async () => {
  let current = true;
  const track = { stopped: false, stop() { this.stopped = true; } };
  let streamAccepted = 0;
  let timerStarts = 0;

  const request = settleAuthenticatedCameraRequest({
    openCameraStream: async () => ({ getTracks: () => [track] }),
    isCurrent: () => current,
    onStream: () => { streamAccepted += 1; },
    onError: () => assert.fail("a resolved request must not enter the error path"),
    startTimer: () => { timerStarts += 1; }
  });
  current = false;

  assert.equal(await request, false);
  assert.equal(track.stopped, true);
  assert.equal(streamAccepted, 0);
  assert.equal(timerStarts, 0);
});
