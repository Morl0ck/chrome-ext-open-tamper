import { compileMatchPattern } from "./common/patterns.js";

const STORAGE_KEY = "openTamperScripts";
const EVENT_PREFIX = "openTamper:run:";
const RUNNER_PREFIX = "__openTamperRunner_";

const compiledPatternsCache = new Map();
const supportsUserScripts = Boolean(chrome.userScripts && typeof chrome.userScripts.register === "function");
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

async function getStoredScripts() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const scripts = stored[STORAGE_KEY];
  return Array.isArray(scripts) ? scripts : [];
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

  const run = () => {
    try {
      ensureAddStyle();
${requireBlock}${indentedSource}
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
      console.warn("chrome.userScripts API is unavailable; scripts will not auto-run automatically.");
      warnedUserScriptsMissing = true;
    }
    return;
  }

  let scripts = [];
  try {
    scripts = await getStoredScripts();
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
    .filter((script) => script && script.enabled !== false && Array.isArray(script.matches) && script.matches.length > 0)
    .map((script) => {
      const code = wrapScriptCode(script);
      const registration = {
        id: script.id,
        matches: script.matches,
        excludeMatches: Array.isArray(script.excludes) ? script.excludes : [],
        js: [{ code }],
        runAt: script.runAt || "document_idle",
        world: "MAIN"
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

async function injectScriptIntoTab(tabId, script) {
  const payload = wrapScriptCode(script);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (code) => {
        try {
          (0, eval)(code);
        } catch (error) {
          console.error("[OpenTamper] injection failed", error);
        }
      },
      args: [payload]
    });
    return true;
  } catch (error) {
    console.warn("Failed to inject script", script.id, error);
    return false;
  }
}

async function dispatchRunEvent(tabId, scriptId) {
  const eventName = `${EVENT_PREFIX}${scriptId}`;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
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
      args: [eventName]
    });
    return true;
  } catch (error) {
    console.warn("Failed to dispatch run event", scriptId, error);
    return false;
  }
}

async function runScriptsForTab(tabId, url, { scriptId, force } = {}) {
  if (!url || url.startsWith("chrome://") || url.startsWith("edge://")) {
    return [];
  }

  const scripts = await getStoredScripts();

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
    if (force) {
      const injected = await injectScriptIntoTab(tabId, script);
      if (injected) {
        ran.push(script.id);
        continue;
      }
    }

    const ok = await dispatchRunEvent(tabId, script.id);
    if (ok) {
      ran.push(script.id);
    }
  }
  return ran;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) {
    return;
  }
  syncUserScripts();
});

chrome.runtime.onInstalled.addListener(() => {
  syncUserScripts();
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    syncUserScripts();
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

      const executedIds = await runScriptsForTab(tabId, targetUrl, { scriptId, force });
      sendResponse?.({ ok: true, ran: executedIds });
    } catch (error) {
      console.warn("User-triggered execution failed", error);
      sendResponse?.({ ok: false, error: error.message });
    }
  })();

  return true;
});

syncUserScripts().catch((error) => {
  console.warn("Initial user script sync failed", error);
});
