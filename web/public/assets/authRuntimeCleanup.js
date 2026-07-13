export function createAuthenticatedRuntimeCleanup({
  state,
  storage,
  getMediaResources,
  resetMediaResources,
  clearPermissionSensitiveDom,
  clearIntervalFn = clearInterval,
  resetRecordingDiagnostics = () => ({})
}) {
  let generation = 0;

  function cleanup() {
    generation += 1;
    storage?.removeItem?.("smartrecord.authToken");

    Object.assign(state, {
      authToken: "",
      currentUser: null,
      config: null,
      users: [],
      auditLogs: [],
      activityLogs: [],
      editingUserEmail: "",
      editingImportedAwb: "",
      session: null,
      record: null,
      records: [],
      syncedOrders: [],
      labels: [],
      labelSummary: { total: 0, filtered: 0 },
      labelSearchQuery: "",
      selectedOrderIds: new Set(),
      activeLabelPreviewId: "",
      pendingLabelAutoPrint: false,
      diagnostics: null
    });

    const resources = getMediaResources?.() || {};
    safelyStopRecorder(resources.mediaRecorder);
    for (const stream of resources.streams || []) safelyStopStream(stream);
    if (resources.recTimerId !== null && resources.recTimerId !== undefined) {
      clearIntervalFn(resources.recTimerId);
    }
    resetMediaResources?.({
      mediaRecorder: null,
      mediaStream: null,
      settingsCameraStream: null,
      recordedChunks: [],
      recordingDiagnostics: resetRecordingDiagnostics(),
      recTimerId: null,
      recSeconds: 0
    });
    clearPermissionSensitiveDom?.();
    return generation;
  }

  return {
    cleanup,
    getGeneration: () => generation,
    isCurrent: (requestGeneration, token) => generation === requestGeneration && state.authToken === token,
    cleanupForAuthenticationFailure: (result) => {
      if (!result || !["AUTH_REQUIRED", "SESSION_EXPIRED"].includes(result.code)) return false;
      cleanup();
      return true;
    }
  };
}

function safelyStopRecorder(recorder) {
  if (!recorder || recorder.state === "inactive") return;
  try {
    recorder.stop();
  } catch {
    // Cleanup must not fail when a browser has already stopped the recorder.
  }
}

function safelyStopStream(stream) {
  try {
    stream?.getTracks?.().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Continue stopping the remaining tracks.
      }
    });
  } catch {
    // A stale browser stream must not prevent authenticated cleanup.
  }
}
