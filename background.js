import { compileMatchPattern } from "./common/patterns.js";
import {
  STORAGE_KEY,
  loadScriptsFromStorage,
  propagateLocalScriptsToSync,
  applySyncScriptsToLocal,
  restoreScriptsFromSyncIfNeeded,
} from "./common/storage.js";
const EVENT_PREFIX = "openTamper:run:";
const RUNNER_PREFIX = "__openTamperRunner_";

const compiledPatternsCache = new Map();
const supportsUserScripts = Boolean(
  chrome.userScripts && typeof chrome.userScripts.register === "function"
);
let warnedUserScriptsMissing = false;

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

async function syncUserScripts() {
  compiledPatternsCache.clear();

  if (!supportsUserScripts) {
    if (!warnedUserScriptsMissing) {
      console.warn(
        "chrome.userScripts API is unavailable; scripts will not auto-run automatically."
      );
      warnedUserScriptsMissing = true;
    }
    return;
  }

  let scripts = [];
  try {
    scripts = await loadScriptsFromStorage();
  } catch (error) {
    console.warn("Unable to read stored scripts", error);
    scripts = [];
  }

  try {
    await chrome.userScripts.unregister();
  } catch (error) {
    if (error?.message && !error.message.includes("No such script")) {
      console.warn("Failed to unregister user scripts", error);
    }
  }

  const registrations = scripts
    .filter(
      (script) =>
        script &&
        script.enabled !== false &&
        Array.isArray(script.matches) &&
        script.matches.length > 0
    )
    .map((script) => {
      const code = wrapScriptCode(script);
      const registration = {
        id: script.id,
        matches: script.matches,
        excludeMatches: Array.isArray(script.excludes) ? script.excludes : [],
        js: [{ code }],
        runAt: script.runAt || "document_idle",
        world: "MAIN",
      };
      if (script.matchAboutBlank) {
        registration.matchAboutBlank = true;
      }
      if (script.noframes === true) {
        registration.allFrames = false;
      } else if (script.allFrames === true) {
        registration.allFrames = true;
      }
      return registration;
    });

  if (registrations.length === 0) {
    return;
  }

  try {
    await chrome.userScripts.register(registrations);
  } catch (error) {
    console.warn("Failed to register user scripts", error);
  }
}

async function injectScriptIntoTab(tabId, script, { frameId, allFrames } = {}) {
  const payload = wrapScriptCode(script);

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
    console.warn("Failed to inject script", script.id, error);
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

async function runScriptsForTab(tabId, url, { scriptId, force, frameId } = {}) {
  if (!url || url.startsWith("chrome://") || url.startsWith("edge://")) {
    return [];
  }

  const scripts = await loadScriptsFromStorage();

  let targets = [];
  if (scriptId) {
    const target = scripts.find((item) => item.id === scriptId);
    if (!target) {
      throw new Error("Script not found");
    }
    if (target.enabled === false) {
      throw new Error("Script is disabled");
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
      return matchesUrl(script, url);
    });
  }

  const ran = [];
  for (const script of targets) {
    const targetFrames = {
      frameId,
      // fall back to allFrames when we do not have a specific frame
      allFrames: typeof frameId !== "number" && script.allFrames === true,
    };

    if (force) {
      const injected = await injectScriptIntoTab(tabId, script, targetFrames);
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

// if (chrome.webNavigation && chrome.webNavigation.onCompleted) {
//   chrome.webNavigation.onCompleted.addListener((details) => {
//     try {
//       if (!details || !details.tabId || !details.url) return;
//       runScriptsForTab(details.tabId, details.url, {
//         frameId: details.frameId,
//         force: !supportsUserScripts,
//       }).catch((e) => console.warn("Frame injection failed", e));
//     } catch (e) {
//       console.warn("webNavigation onCompleted handler error", e);
//     }
//   });
// }

// if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
//   chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
//     try {
//       if (!details || !details.tabId || !details.url) return;
//       runScriptsForTab(details.tabId, details.url, {
//         frameId: details.frameId,
//         force: !supportsUserScripts,
//       }).catch((e) => console.warn("History-state injection failed", e));
//     } catch (e) {
//       console.warn("webNavigation onHistoryStateUpdated handler error", e);
//     }
//   });
// }

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
  })().catch((error) => {
    console.warn("[OpenTamper] onInstalled initialization failed", error);
  });
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    (async () => {
      await restoreScriptsFromSyncIfNeeded();
      await syncUserScripts();
    })().catch((error) => {
      console.warn("[OpenTamper] onStartup initialization failed", error);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "openTamper:runScriptsForTab") {
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

restoreScriptsFromSyncIfNeeded()
  .catch((error) => {
    console.warn("[OpenTamper] initial restore from sync storage failed", error);
  })
  .finally(() => {
    syncUserScripts().catch((error) => {
      console.warn("Initial user script sync failed", error);
    });
  });
