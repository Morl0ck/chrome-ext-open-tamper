import { compileMatchPattern } from "./common/patterns.js";
import {
  STORAGE_KEY,
  loadScriptsFromStorage,
  persistScripts,
  propagateLocalScriptsToSync,
  applySyncScriptsToLocal,
  restoreScriptsFromSyncIfNeeded,
} from "./common/storage.js";
import { buildScriptFromCode } from "./common/metadata.js";
const EVENT_PREFIX = "openTamper:run:";
const RUNNER_PREFIX = "__openTamperRunner_";
const AUTO_UPDATE_ALARM = "openTamper:autoUpdate";
const AUTO_UPDATE_INTERVAL_MINUTES = 5;
const AUTO_UPDATE_INTERVAL_MS = AUTO_UPDATE_INTERVAL_MINUTES * 60 * 1000;

const compiledPatternsCache = new Map();
const supportsUserScripts = Boolean(
  chrome.userScripts && typeof chrome.userScripts.register === "function"
);
let warnedUserScriptsMissing = false;
const manualInjectionScriptIds = new Set();
const manualRunStages = new Set();
let navigationListenersActive = false;

function isFileSchemeUrl(url) {
  if (typeof url !== "string") {
    return false;
  }
  if (url.startsWith("file://")) {
    return true;
  }
  try {
    return new URL(url).protocol === "file:";
  } catch (_) {
    return false;
  }
}

async function isFileSchemeAccessEnabled() {
  if (!chrome?.extension?.isAllowedFileSchemeAccess) {
    return false;
  }
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => {
        resolve(Boolean(allowed));
      });
    } catch (error) {
      console.warn(
        "[OpenTamper] Unable to determine file scheme access permission",
        error
      );
      resolve(false);
    }
  });
}

async function fetchRequireContent(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

function isGitHubUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "github.com" ||
      host === "www.github.com" ||
      host.endsWith(".github.com") ||
      host === "raw.githubusercontent.com" ||
      host.endsWith(".githubusercontent.com")
    );
  } catch (error) {
    return false;
  }
}

async function fetchScriptSource(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

// Reload @require resources right before execution so local file updates are honored.
async function prepareScriptForExecution(script) {
  if (!script || typeof script !== "object") {
    return script;
  }

  const requires = Array.isArray(script.requires) ? script.requires : [];
  if (requires.length === 0) {
    return script;
  }

  const resolvedRequires = [];
  let fileAccessChecked = false;
  let fileAccessAllowed = false;

  for (const entry of requires) {
    const normalized =
      entry && typeof entry === "object"
        ? { ...entry }
        : { url: typeof entry === "string" ? entry : "" };
    const url = typeof normalized.url === "string" ? normalized.url : "";
    const hasCode = typeof normalized.code === "string" && normalized.code.length > 0;

    if (!url) {
      resolvedRequires.push(normalized);
      continue;
    }

    const isFile = isFileSchemeUrl(url);
    const shouldRefresh = isFile || !hasCode;

    if (!shouldRefresh) {
      resolvedRequires.push(normalized);
      continue;
    }

    if (isFile) {
      if (!fileAccessChecked) {
        fileAccessChecked = true;
        fileAccessAllowed = await isFileSchemeAccessEnabled();
      }

      if (!fileAccessAllowed) {
        console.warn(
          `[OpenTamper] Local file access denied for ${url}. Enable "Allow access to file URLs" for Open Tamper.`
        );
        resolvedRequires.push(normalized);
        continue;
      }
    }

    try {
      const code = await fetchRequireContent(url);
      normalized.code = code;
    } catch (error) {
      console.error(`[OpenTamper] Failed to load @require ${url}`, error);
    }

    resolvedRequires.push(normalized);
  }

  return { ...script, requires: resolvedRequires };
}

function scriptHasLocalRequire(script) {
  if (!script || !Array.isArray(script.requires)) {
    return false;
  }
  return script.requires.some((entry) => {
    if (!entry) {
      return false;
    }
    if (typeof entry === "string") {
      return isFileSchemeUrl(entry);
    }
    if (typeof entry === "object") {
      return isFileSchemeUrl(entry.url);
    }
    return false;
  });
}

function shouldRegisterScript(script) {
  if (!script || script.importMode === "require") {
    return false;
  }
  return !scriptHasLocalRequire(script);
}

function normalizeRunAt(value) {
  if (!value) {
    return "document_idle";
  }
  const normalized = String(value).toLowerCase().replace(/-/g, "_");
  if (normalized.includes("document_start")) {
    return "document_start";
  }
  if (normalized.includes("document_end")) {
    return "document_end";
  }
  if (normalized.includes("document_idle")) {
    return "document_idle";
  }
  return "document_idle";
}

function updateManualInjectionScripts(scripts) {
  manualInjectionScriptIds.clear();
  manualRunStages.clear();
  for (const entry of scripts) {
    if (entry && entry.id) {
      manualInjectionScriptIds.add(entry.id);
      manualRunStages.add(normalizeRunAt(entry.runAt));
    }
  }
  updateNavigationListenerState();
}

function enableNavigationListeners() {
  if (navigationListenersActive || !chrome.webNavigation) {
    return;
  }
  const { document_start, document_end, document_idle, history } = navigationHandlers;
  if (chrome.webNavigation.onCommitted) {
    chrome.webNavigation.onCommitted.addListener(document_start);
  }
  if (chrome.webNavigation.onDOMContentLoaded) {
    chrome.webNavigation.onDOMContentLoaded.addListener(document_end);
  }
  if (chrome.webNavigation.onCompleted) {
    chrome.webNavigation.onCompleted.addListener(document_idle);
  }
  if (chrome.webNavigation.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener(history);
  }
  navigationListenersActive = true;
}

function disableNavigationListeners() {
  if (!navigationListenersActive || !chrome.webNavigation) {
    return;
  }
  const { document_start, document_end, document_idle, history } = navigationHandlers;
  if (chrome.webNavigation.onCommitted) {
    chrome.webNavigation.onCommitted.removeListener(document_start);
  }
  if (chrome.webNavigation.onDOMContentLoaded) {
    chrome.webNavigation.onDOMContentLoaded.removeListener(document_end);
  }
  if (chrome.webNavigation.onCompleted) {
    chrome.webNavigation.onCompleted.removeListener(document_idle);
  }
  if (chrome.webNavigation.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.removeListener(history);
  }
  navigationListenersActive = false;
}

function updateNavigationListenerState() {
  const needsListeners = manualInjectionScriptIds.size > 0 || !supportsUserScripts;
  if (needsListeners) {
    enableNavigationListeners();
  } else {
    disableNavigationListeners();
  }
}

function handleNavigationEvent(stage, details, { force } = {}) {
  try {
    if (!details || typeof details.tabId !== "number" || !details.url) {
      return;
    }
    if (stage && manualRunStages.size > 0 && !manualRunStages.has(stage)) {
      return;
    }
    const runOptions = {
      frameId: typeof details.frameId === "number" ? details.frameId : undefined,
      stage,
    };
    if (typeof force === "boolean") {
      runOptions.force = force;
    }
    void runScriptsForTab(details.tabId, details.url, runOptions).catch((error) => {
      console.warn("[OpenTamper] navigation injection failed", error);
    });
  } catch (error) {
    console.warn("[OpenTamper] navigation handler failed", error);
  }
}

const navigationHandlers = {
  document_start: (details) => handleNavigationEvent("document_start", details),
  document_end: (details) => handleNavigationEvent("document_end", details),
  document_idle: (details) => handleNavigationEvent("document_idle", details),
  history: (details) => {
    handleNavigationEvent("document_start", details);
    handleNavigationEvent("document_end", details);
    handleNavigationEvent("document_idle", details);
  },
};

function patternToRegex(pattern) {
  if (compiledPatternsCache.has(pattern)) {
    return compiledPatternsCache.get(pattern);
  }

  const compiled = compileMatchPattern(pattern);
  if (compiled) {
    compiledPatternsCache.set(pattern, compiled);
  }
  return compiled;
}

function matchesUrl(script, url) {
  if (!Array.isArray(script.matches) || script.matches.length === 0) {
    return false;
  }

  const includes = script.matches.some((pattern) => {
    const regex = patternToRegex(pattern);
    return regex ? regex.test(url) : false;
  });

  if (!includes) {
    return false;
  }

  if (Array.isArray(script.excludes) && script.excludes.length > 0) {
    const isExcluded = script.excludes.some((pattern) => {
      const regex = patternToRegex(pattern);
      return regex ? regex.test(url) : false;
    });
    if (isExcluded) {
      return false;
    }
  }

  return true;
}

function wrapScriptCode(script) {
  const eventName = `${EVENT_PREFIX}${script.id}`;
  const runnerKey = `${RUNNER_PREFIX}${script.id}`;
  const requireFlagKey = `__openTamperRequiresExecuted_${script.id}`;
  const sourceLabel = script.url || `open-tamper/${script.id}.user.js`;
  const indentedSource = (script.code || "")
    .split(/\r?\n/)
    .map((line) => `      ${line}`)
    .join("\n");
  const requiresSource = Array.isArray(script.requires)
    ? script.requires
        .filter((item) => item && item.code)
        .map((item) => `// @require ${item.url || ""}\n${item.code}`)
        .join("\n")
    : "";
  const indentedRequires = requiresSource
    ? requiresSource
        .split(/\r?\n/)
        .map((line) => `        ${line}`)
        .join("\n") + "\n"
    : "";
  const requireBlock = indentedRequires
    ? `      if (!globalThis[REQUIRE_FLAG]) {\n${indentedRequires}        globalThis[REQUIRE_FLAG] = true;\n      }\n`
    : "";

  // Check if script has GM_xmlhttpRequest grant
  const grants = Array.isArray(script.grants) ? script.grants : [];
  const hasXhrGrant =
    grants.includes("GM_xmlhttpRequest") ||
    grants.includes("GM.xmlHttpRequest");

  // GM_xmlhttpRequest implementation injected when granted
  const gmXhrCode = hasXhrGrant
    ? `
  const ensureGMXmlHttpRequest = () => {
    if (typeof globalThis.GM_xmlhttpRequest === "function") {
      return;
    }

    const XHR_CHANNEL = "openTamper:gmXhr";
    const SCRIPT_ID = ${JSON.stringify(script.id)};
    const pendingRequests = new Map();
    let requestIdCounter = 0;

    // Listen for responses from the bridge content script
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (!event.data || event.data.channel !== XHR_CHANNEL) return;

      const { id, type, response, error } = event.data;
      const handlers = pendingRequests.get(id);
      if (!handlers) return;

      if (type === "response") {
        if (response.error) {
          if (response.isTimeout && handlers.ontimeout) {
            handlers.ontimeout({
              error: response.errorMessage,
              status: 0,
              statusText: "Timeout",
            });
          } else if (handlers.onerror) {
            handlers.onerror({
              error: response.errorMessage,
              status: 0,
              statusText: "Error",
            });
          }
        } else {
          // Build the response object similar to Tampermonkey
          let finalResponse = response.response;

          // Handle arraybuffer reconstruction
          if (response.responseType === "arraybuffer" && Array.isArray(response.response)) {
            finalResponse = new Uint8Array(response.response).buffer;
          }
          // Handle blob reconstruction
          else if (response.responseType === "blob" && response.response && response.response.data) {
            const binary = atob(response.response.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            finalResponse = new Blob([bytes], { type: response.response.type || "application/octet-stream" });
          }

          const responseObj = {
            readyState: response.readyState || 4,
            status: response.status,
            statusText: response.statusText,
            responseHeaders: response.responseHeaders,
            responseText: response.responseText,
            response: finalResponse,
            finalUrl: response.finalUrl,
          };

          // Call onreadystatechange if provided
          if (handlers.onreadystatechange) {
            handlers.onreadystatechange(responseObj);
          }

          // Call onload for successful responses
          if (handlers.onload) {
            handlers.onload(responseObj);
          }
        }
        pendingRequests.delete(id);
      } else if (type === "error") {
        if (handlers.onerror) {
          handlers.onerror({
            error: error,
            status: 0,
            statusText: "Error",
          });
        }
        pendingRequests.delete(id);
      }
    });

    const gmXhr = (details) => {
      if (!details || typeof details.url !== "string") {
        throw new Error("GM_xmlhttpRequest requires a URL");
      }

      const requestId = SCRIPT_ID + "_" + (++requestIdCounter);
      const handlers = {
        onload: typeof details.onload === "function" ? details.onload : null,
        onerror: typeof details.onerror === "function" ? details.onerror : null,
        ontimeout: typeof details.ontimeout === "function" ? details.ontimeout : null,
        onreadystatechange: typeof details.onreadystatechange === "function" ? details.onreadystatechange : null,
        onprogress: typeof details.onprogress === "function" ? details.onprogress : null,
      };
      pendingRequests.set(requestId, handlers);

      // Post message to bridge content script
      window.postMessage({
        channel: XHR_CHANNEL,
        id: requestId,
        type: "request",
        scriptId: SCRIPT_ID,
        details: {
          method: details.method || "GET",
          url: details.url,
          headers: details.headers || {},
          data: details.data,
          timeout: details.timeout || 0,
          responseType: details.responseType || "text",
          anonymous: details.anonymous === true,
          redirect: details.redirect,
        },
      }, "*");

      // Return abort handle
      return {
        abort: () => {
          const h = pendingRequests.get(requestId);
          if (h) {
            pendingRequests.delete(requestId);
            if (h.onerror) {
              h.onerror({ error: "Aborted", status: 0, statusText: "Aborted" });
            }
          }
        },
      };
    };

    Object.defineProperty(globalThis, "GM_xmlhttpRequest", {
      value: gmXhr,
      configurable: true,
      writable: true,
    });

    // Also provide GM.xmlHttpRequest for newer API style
    if (typeof globalThis.GM === "undefined") {
      Object.defineProperty(globalThis, "GM", {
        value: {},
        configurable: true,
        writable: true,
      });
    }
    if (typeof globalThis.GM.xmlHttpRequest !== "function") {
      globalThis.GM.xmlHttpRequest = gmXhr;
    }
  };
`
    : "";

  const ensureXhrCall = hasXhrGrant ? "      ensureGMXmlHttpRequest();\n" : "";

  return `(() => {
  const EVENT_NAME = ${JSON.stringify(eventName)};
  const RUNNER_KEY = ${JSON.stringify(runnerKey)};
  const REQUIRE_FLAG = ${JSON.stringify(requireFlagKey)};
  const previous = globalThis[RUNNER_KEY];
  if (typeof previous === "function" && typeof globalThis.removeEventListener === "function") {
    globalThis.removeEventListener(EVENT_NAME, previous);
  }

  const ensureAddStyle = () => {
    if (typeof globalThis.GM_addStyle === "function") {
      return;
    }
    const helper = (css) => {
      if (!css) {
        return null;
      }
      const style = document.createElement("style");
      style.type = "text/css";
      style.dataset.openTamperStyle = ${JSON.stringify(script.id)};
      style.textContent = String(css);
      const attach = () => {
        const parent = document.head || document.documentElement || document.body;
        if (parent && typeof parent.appendChild === "function") {
          parent.appendChild(style);
          return true;
        }
        return false;
      };
      if (!attach() && typeof document.addEventListener === "function") {
        document.addEventListener("DOMContentLoaded", attach, { once: true });
      }
      return style;
    };

    Object.defineProperty(globalThis, "GM_addStyle", {
      value: helper,
      configurable: true,
      writable: true
    });
  };
${gmXhrCode}
  const executeScript = () => {
    try {
${requireBlock}${indentedSource}
    } catch (error) {
      console.error("[OpenTamper] script execution failed", error);
    }
  };

  const run = () => {
    try {
      ensureAddStyle();
${ensureXhrCall}
      const runAt = ${JSON.stringify(script.runAt || "document_idle")};
      
      if (runAt === 'document_start') {
        // Run immediately for document-start
        executeScript();
      } else if (runAt === 'document_end' || runAt === 'document-end') {
        // Wait for DOMContentLoaded
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', executeScript, { once: true });
        } else {
          executeScript();
        }
      } else {
        // document_idle/document-idle: wait for full load
        if (document.readyState === 'complete') {
          executeScript();
        } else {
          window.addEventListener('load', executeScript, { once: true });
        }
      }
    } catch (error) {
      console.error("[OpenTamper] script execution failed", error);
    }
  };

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener(EVENT_NAME, run, { passive: true });
    Object.defineProperty(globalThis, RUNNER_KEY, {
      value: run,
      configurable: true,
      writable: true
    });
  }

  run();
})();
//# sourceURL=${sourceLabel}`;
}

async function ensureAutoUpdateAlarm() {
  if (!chrome?.alarms?.create) {
    return;
  }
  try {
    const existing = await chrome.alarms.get(AUTO_UPDATE_ALARM);
    if (
      !existing ||
      typeof existing.periodInMinutes !== "number" ||
      existing.periodInMinutes !== AUTO_UPDATE_INTERVAL_MINUTES
    ) {
      if (existing) {
        await chrome.alarms.clear(AUTO_UPDATE_ALARM);
      }
      chrome.alarms.create(AUTO_UPDATE_ALARM, {
        periodInMinutes: AUTO_UPDATE_INTERVAL_MINUTES,
      });
    }
  } catch (error) {
    console.warn("[OpenTamper] failed to configure auto-update alarm", error);
    try {
      await chrome.alarms.clear(AUTO_UPDATE_ALARM);
    } catch (_) {
      // ignore
    }
    try {
      chrome.alarms.create(AUTO_UPDATE_ALARM, {
        periodInMinutes: AUTO_UPDATE_INTERVAL_MINUTES,
      });
    } catch (_) {
      // ignore
    }
  }
}

async function autoUpdateScripts() {
  let scripts = [];
  try {
    scripts = await loadScriptsFromStorage();
  } catch (error) {
    console.warn("[OpenTamper] failed to load scripts for auto-update", error);
    return;
  }

  if (!Array.isArray(scripts) || scripts.length === 0) {
    return;
  }

  const now = Date.now();
  let needsPersist = false;

  for (const script of scripts) {
    if (!script || script.autoUpdateEnabled !== true) {
      continue;
    }
    if (script.sourceType !== "remote") {
      continue;
    }
    if (!isGitHubUrl(script.url)) {
      continue;
    }

    const lastChecked =
      typeof script.autoUpdateLastChecked === "number"
        ? script.autoUpdateLastChecked
        : 0;
    if (now - lastChecked < AUTO_UPDATE_INTERVAL_MS) {
      continue;
    }

    script.autoUpdateLastChecked = now;
    needsPersist = true;

    let latestSource;
    try {
      latestSource = await fetchScriptSource(script.url);
    } catch (error) {
      console.warn(
        `[OpenTamper] auto-update fetch failed for ${script.url}`,
        error
      );
      continue;
    }

    if (typeof latestSource !== "string") {
      continue;
    }

    if (latestSource === script.code) {
      continue;
    }

    try {
      const rebuilt = await buildScriptFromCode({
        code: latestSource,
        sourceUrl: script.url,
        existingId: script.id,
        sourceType: script.sourceType,
        fileName: script.fileName,
      });
      const enabled = script.enabled !== false;
      const autoUpdateEnabled = script.autoUpdateEnabled === true;
      Object.assign(script, rebuilt);
      script.enabled = enabled;
      script.autoUpdateEnabled = autoUpdateEnabled;
      script.autoUpdateLastChecked = now;
      needsPersist = true;
    } catch (error) {
      console.warn(
        `[OpenTamper] auto-update rebuild failed for ${script.url}`,
        error
      );
    }
  }

  if (needsPersist) {
    try {
      await persistScripts(scripts);
    } catch (error) {
      console.warn("[OpenTamper] failed to persist auto-updated scripts", error);
    }
  }
}

async function syncUserScripts() {
  compiledPatternsCache.clear();

  let scripts = [];
  try {
    scripts = await loadScriptsFromStorage();
  } catch (error) {
    console.warn("Unable to read stored scripts", error);
    scripts = [];
  }

  const manualScripts = [];
  const registrableScripts = [];

  for (const script of scripts) {
    if (
      !script ||
      script.enabled === false ||
      !Array.isArray(script.matches) ||
      script.matches.length === 0
    ) {
      continue;
    }

    if (shouldRegisterScript(script)) {
      registrableScripts.push(script);
    } else {
      manualScripts.push(script);
    }
  }

  const manualCandidates = supportsUserScripts
    ? manualScripts
    : [...registrableScripts, ...manualScripts];
  updateManualInjectionScripts(manualCandidates);

  if (!supportsUserScripts) {
    if (!warnedUserScriptsMissing) {
      console.warn(
        "chrome.userScripts API is unavailable; scripts will not auto-run automatically."
      );
      warnedUserScriptsMissing = true;
    }
    return;
  }

  try {
    await chrome.userScripts.unregister();
  } catch (error) {
    if (error?.message && !error.message.includes("No such script")) {
      console.warn("Failed to unregister user scripts", error);
    }
  }

  const registrations = [];
  for (const script of registrableScripts) {
    try {
      const prepared = await prepareScriptForExecution(script);
      const code = wrapScriptCode(prepared);
      const registration = {
        id: prepared.id,
        matches: prepared.matches,
        excludeMatches: Array.isArray(prepared.excludes) ? prepared.excludes : [],
        js: [{ code }],
        runAt: prepared.runAt || "document_idle",
        world: "MAIN",
      };
      if (prepared.matchAboutBlank) {
        registration.matchAboutBlank = true;
      }
      if (prepared.noframes === true) {
        registration.allFrames = false;
      } else if (prepared.allFrames === true) {
        registration.allFrames = true;
      }
      registrations.push(registration);
    } catch (error) {
      console.warn("[OpenTamper] Failed to prepare script for registration", error);
    }
  }

  if (registrations.length === 0) {
    return;
  }

  try {
    await chrome.userScripts.register(registrations);
  } catch (error) {
    console.warn("Failed to register user scripts", error);
  }
}

async function injectScriptIntoTab(tabId, script, { frameId, allFrames, stage } = {}) {
  const prepared = await prepareScriptForExecution(script);
  const payload = wrapScriptCode(prepared);

  const target =
    typeof frameId === "number"
      ? { tabId, frameIds: [frameId] }
      : allFrames
      ? { tabId, allFrames: true }
      : { tabId };

  try {
    await chrome.scripting.executeScript({
      target,
      world: "MAIN",
      injectImmediately: stage === "document_start",
      func: (code) => {
        try {
          (0, eval)(code);
        } catch (error) {
          console.error("[OpenTamper] injection failed", error);
        }
      },
      args: [payload],
    });
    return true;
  } catch (error) {
    const id = prepared?.id || script?.id;
    console.warn("Failed to inject script", id, error);
    return false;
  }
}

async function dispatchRunEvent(tabId, scriptId, { frameId, allFrames } = {}) {
  const eventName = `${EVENT_PREFIX}${scriptId}`;

  const target =
    typeof frameId === "number"
      ? { tabId, frameIds: [frameId] }
      : allFrames
      ? { tabId, allFrames: true }
      : { tabId };

  try {
    await chrome.scripting.executeScript({
      target,
      world: "MAIN",
      func: (name) => {
        try {
          let event;
          if (typeof CustomEvent === "function") {
            event = new CustomEvent(name);
          } else {
            event = document.createEvent("Event");
            event.initEvent(name, false, false);
          }
          window.dispatchEvent(event);
        } catch (error) {
          console.error("[OpenTamper] dispatch failed", error);
        }
      },
      args: [eventName],
    });
    return true;
  } catch (error) {
    console.warn("Failed to dispatch run event", scriptId, error);
    return false;
  }
}

async function runScriptsForTab(tabId, url, { scriptId, force, frameId, stage } = {}) {
  if (!url || url.startsWith("chrome://") || url.startsWith("edge://")) {
    return [];
  }

  const scripts = await loadScriptsFromStorage();
  const normalizedStage = stage ? normalizeRunAt(stage) : null;

  let targets = [];
  if (scriptId) {
    const target = scripts.find((item) => item.id === scriptId);
    if (!target) {
      throw new Error("Script not found");
    }
    if (target.enabled === false) {
      throw new Error("Script is disabled");
    }
    if (normalizedStage && normalizeRunAt(target.runAt) !== normalizedStage) {
      return [];
    }
    if (!matchesUrl(target, url) && !force) {
      throw new Error("Script does not match this URL");
    }
    targets = [target];
  } else {
    targets = scripts.filter((script) => {
      if (script.enabled === false) {
        return false;
      }
      if (normalizedStage && normalizeRunAt(script.runAt) !== normalizedStage) {
        return false;
      }
      return matchesUrl(script, url);
    });
  }

  if (targets.length === 0) {
    return [];
  }

  const ran = [];
  for (const script of targets) {
    const targetFrames = {
      frameId,
      // fall back to allFrames when we do not have a specific frame
      allFrames: typeof frameId !== "number" && script.allFrames === true,
    };

    const needsManualInjection = manualInjectionScriptIds.has(script.id) || !supportsUserScripts;
    const shouldForceInjection = Boolean(force) || needsManualInjection;

    if (shouldForceInjection) {
      const injectionTarget = normalizedStage
        ? { ...targetFrames, stage: normalizedStage }
        : targetFrames;
      const injected = await injectScriptIntoTab(tabId, script, injectionTarget);
      if (injected) {
        ran.push(script.id);
        continue;
      }
    }

    const ok = await dispatchRunEvent(tabId, script.id, targetFrames);
    if (ok) {
      ran.push(script.id);
    }
  }
  return ran;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) {
    propagateLocalScriptsToSync(changes[STORAGE_KEY].newValue).catch((error) => {
      console.warn("[OpenTamper] syncing scripts to sync storage failed", error);
    });
    syncUserScripts().catch((error) => {
      console.warn("[OpenTamper] user script sync failed", error);
    });
    return;
  }

  if (areaName === "sync" && changes[STORAGE_KEY]) {
    applySyncScriptsToLocal(changes[STORAGE_KEY].newValue).catch((error) => {
      console.warn("[OpenTamper] failed to propagate sync storage changes", error);
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    await restoreScriptsFromSyncIfNeeded();
    await syncUserScripts();
    await ensureAutoUpdateAlarm();
  })().catch((error) => {
    console.warn("[OpenTamper] onInstalled initialization failed", error);
  });
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    (async () => {
      await restoreScriptsFromSyncIfNeeded();
      await syncUserScripts();
      await ensureAutoUpdateAlarm();
    })().catch((error) => {
      console.warn("[OpenTamper] onStartup initialization failed", error);
    });
  });
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== AUTO_UPDATE_ALARM) {
      return;
    }
    autoUpdateScripts().catch((error) => {
      console.warn("[OpenTamper] auto-update cycle failed", error);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return;
  }

  // Handle GM_xmlhttpRequest from bridge content script
  if (message.type === "openTamper:gmXhr") {
    handleGmXmlHttpRequest(message, sender, sendResponse);
    return true;
  }

  if (message.type !== "openTamper:runScriptsForTab") {
    return;
  }

  const { tabId, url, scriptId, force } = message;
  if (typeof tabId !== "number") {
    sendResponse?.({ ok: false, error: "Invalid tab id" });
    return;
  }

  (async () => {
    try {
      const targetUrl = url ?? (await chrome.tabs.get(tabId)).url;
      if (!targetUrl) {
        throw new Error("Tab has no URL");
      }

      const executedIds = await runScriptsForTab(tabId, targetUrl, {
        scriptId,
        force,
      });
      sendResponse?.({ ok: true, ran: executedIds });
    } catch (error) {
      console.warn("User-triggered execution failed", error);
      sendResponse?.({ ok: false, error: error.message });
    }
  })();

  return true;
});

/**
 * Handle GM_xmlhttpRequest from userscripts via the bridge content script.
 * This runs in the service worker context which bypasses CORS/CSP restrictions.
 */
async function handleGmXmlHttpRequest(message, sender, sendResponse) {
  const { id, details } = message;

  if (!details || typeof details.url !== "string") {
    sendResponse?.({
      error: true,
      errorMessage: "Invalid request: missing URL",
    });
    return;
  }

  try {
    const method = (details.method || "GET").toUpperCase();
    const fetchOptions = {
      method,
      headers: {},
      credentials: details.anonymous ? "omit" : "include",
      redirect: details.redirect || "follow",
    };

    // Apply custom headers
    if (details.headers && typeof details.headers === "object") {
      for (const [key, value] of Object.entries(details.headers)) {
        fetchOptions.headers[key] = String(value);
      }
    }

    // Add request body for appropriate methods
    if (details.data != null && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      fetchOptions.body = details.data;
    }

    // Setup abort controller for timeout
    const controller = new AbortController();
    fetchOptions.signal = controller.signal;

    let timeoutId = null;
    if (details.timeout && details.timeout > 0) {
      timeoutId = setTimeout(() => controller.abort(), details.timeout);
    }

    const response = await fetch(details.url, fetchOptions);

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // Build response headers string
    const responseHeadersList = [];
    response.headers.forEach((value, key) => {
      responseHeadersList.push(`${key}: ${value}`);
    });
    const responseHeaders = responseHeadersList.join("\r\n");

    // Get response content based on responseType
    let responseText = "";
    let responseData = null;

    const responseType = details.responseType || "text";

    if (responseType === "arraybuffer") {
      const buffer = await response.arrayBuffer();
      // Serialize as array of bytes for message passing
      responseData = Array.from(new Uint8Array(buffer));
      responseText = "";
    } else if (responseType === "blob") {
      const blob = await response.blob();
      // For blob, we serialize as base64
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      responseData = {
        type: blob.type,
        data: btoa(binary),
      };
      responseText = "";
    } else if (responseType === "json") {
      responseText = await response.text();
      try {
        responseData = JSON.parse(responseText);
      } catch (_) {
        responseData = null;
      }
    } else {
      // Default to text
      responseText = await response.text();
      responseData = responseText;
    }

    sendResponse?.({
      readyState: 4,
      status: response.status,
      statusText: response.statusText,
      responseHeaders,
      responseText,
      response: responseData,
      finalUrl: response.url,
      responseType,
    });
  } catch (error) {
    const isTimeout = error.name === "AbortError";
    sendResponse?.({
      error: true,
      isTimeout,
      errorMessage: error.message || String(error),
    });
  }
}

restoreScriptsFromSyncIfNeeded()
  .catch((error) => {
    console.warn("[OpenTamper] initial restore from sync storage failed", error);
  })
  .finally(() => {
    syncUserScripts().catch((error) => {
      console.warn("Initial user script sync failed", error);
    });
  });

ensureAutoUpdateAlarm().catch((error) => {
  console.warn("[OpenTamper] failed to schedule auto-update alarm", error);
});

autoUpdateScripts().catch((error) => {
  console.warn("[OpenTamper] initial auto-update check failed", error);
});
