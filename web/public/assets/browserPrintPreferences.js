const STORAGE_KEY = "smartrecord.browserPrintPreferences";
const PAPER_SIZES = new Set(["a4", "100x150"]);

export function loadBrowserPrintPreferences(storage = localStorage) {
  try {
    return normalizeBrowserPrintPreferences(JSON.parse(storage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return normalizeBrowserPrintPreferences({});
  }
}

export function saveBrowserPrintPreferences(preferences, storage = localStorage) {
  const normalized = normalizeBrowserPrintPreferences(preferences);
  storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function normalizeBrowserPrintPreferences(preferences = {}) {
  return { paperSize: PAPER_SIZES.has(preferences.paperSize) ? preferences.paperSize : "a4" };
}
