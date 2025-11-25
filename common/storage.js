export const STORAGE_KEY = "openTamperScripts";

export function sanitizeScripts(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry) => ({
    ...entry,
    matches: Array.isArray(entry.matches) ? entry.matches : [],
    excludes: Array.isArray(entry.excludes) ? entry.excludes : [],
    enabled: entry.enabled !== false,
    runAt: entry.runAt || "document_idle",
    noframes: Boolean(entry.noframes),
    allFrames: Boolean(entry.allFrames),
    matchAboutBlank: Boolean(entry.matchAboutBlank),
    requires: Array.isArray(entry.requires) ? entry.requires : [],
    sourceType: entry.sourceType || "remote",
    fileName: entry.fileName || null,
  }));
}

export async function loadScriptsFromStorage() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return sanitizeScripts(stored[STORAGE_KEY]);
}

export async function persistScripts(scripts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: scripts });
}

export default {
  STORAGE_KEY,
  sanitizeScripts,
  loadScriptsFromStorage,
  persistScripts,
};
