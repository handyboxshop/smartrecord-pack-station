export const ACTIVE_VIEW_STORAGE_KEY = "smartrecord.activeView";

export function readSavedActiveView(storage = localStorage) {
  try {
    return String(storage.getItem(ACTIVE_VIEW_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

export function saveActiveView(view, storage = localStorage) {
  if (!view) return;
  try {
    storage.setItem(ACTIVE_VIEW_STORAGE_KEY, view);
  } catch {
    // Browser storage is optional; navigation remains functional without it.
  }
}

export function clearSavedActiveView(storage = localStorage) {
  try {
    storage.removeItem(ACTIVE_VIEW_STORAGE_KEY);
  } catch {
    // Browser storage is optional; logout must still complete.
  }
}

export function resolveRestoredView({ savedView, allowedViews, fallbackView }) {
  const allowed = new Set(Array.isArray(allowedViews) ? allowedViews : []);
  return allowed.has(savedView) ? savedView : fallbackView;
}
