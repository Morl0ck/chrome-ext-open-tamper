export const STORAGE_KEY = "openTamperScripts";

function hasSyncStorage() {
  return Boolean(chrome?.storage?.sync && chrome.storage.sync.get);
}

let applyingSyncToLocal = false;

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
  const sanitized = sanitizeScripts(scripts);
  await chrome.storage.local.set({ [STORAGE_KEY]: sanitized });

  if (!hasSyncStorage()) {
    return;
  }

  try {
    await chrome.storage.sync.set({ [STORAGE_KEY]: sanitized });
  } catch (error) {
    console.warn("[OpenTamper] failed to mirror scripts to sync storage", error);
  }
}

export async function loadScriptsFromSyncStorage() {
  if (!hasSyncStorage()) {
    return [];
  }

  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    return sanitizeScripts(stored[STORAGE_KEY]);
  } catch (error) {
    console.warn("[OpenTamper] failed to read scripts from sync storage", error);
    return [];
  }
}

export async function propagateLocalScriptsToSync(value) {
  if (!hasSyncStorage() || applyingSyncToLocal) {
    return;
  }

  try {
    if (typeof value === "undefined") {
      await chrome.storage.sync.remove(STORAGE_KEY);
      return;
    }
    const sanitized = sanitizeScripts(value);
    await chrome.storage.sync.set({ [STORAGE_KEY]: sanitized });
  } catch (error) {
    console.warn("[OpenTamper] failed to propagate local scripts to sync storage", error);
  }
}

export async function applySyncScriptsToLocal(value) {
  if (!hasSyncStorage()) {
    return;
  }

  try {
    const sanitized = sanitizeScripts(value);
    const current = await loadScriptsFromStorage();

    const valueIsUndefined = typeof value === "undefined";
    const nothingToRemove = valueIsUndefined && current.length === 0;
    const alreadySynced =
      !valueIsUndefined && JSON.stringify(current) === JSON.stringify(sanitized);

    if (nothingToRemove || alreadySynced) {
      return;
    }

    applyingSyncToLocal = true;
    if (valueIsUndefined) {
      await chrome.storage.local.remove(STORAGE_KEY);
    } else {
      await chrome.storage.local.set({ [STORAGE_KEY]: sanitized });
    }
  } catch (error) {
    console.warn("[OpenTamper] failed to apply sync scripts to local storage", error);
  } finally {
    applyingSyncToLocal = false;
  }
}

export async function restoreScriptsFromSyncIfNeeded() {
  if (!hasSyncStorage()) {
    return false;
  }

  try {
    const localScripts = await loadScriptsFromStorage();
    if (localScripts.length > 0) {
      return false;
    }

    const syncedScripts = await loadScriptsFromSyncStorage();
    if (syncedScripts.length === 0) {
      return false;
    }

    applyingSyncToLocal = true;
    await chrome.storage.local.set({ [STORAGE_KEY]: syncedScripts });
    return true;
  } catch (error) {
    console.warn("[OpenTamper] failed to restore scripts from sync storage", error);
    return false;
  } finally {
    applyingSyncToLocal = false;
  }
}

export default {
  STORAGE_KEY,
  sanitizeScripts,
  loadScriptsFromStorage,
  persistScripts,
  loadScriptsFromSyncStorage,
  propagateLocalScriptsToSync,
  applySyncScriptsToLocal,
  restoreScriptsFromSyncIfNeeded,
};
