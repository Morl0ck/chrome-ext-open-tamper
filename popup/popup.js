import { compileMatchPattern } from "../common/patterns.js";
import {
  STORAGE_KEY,
  loadScriptsFromStorage,
  persistScripts,
} from "../common/storage.js";

const runMatchingButton = document.getElementById("run-matching");
const scriptsContainer = document.getElementById("scripts");
const emptyState = document.getElementById("empty");
const openOptionsButton = document.getElementById("open-options");
const refreshViewButton = document.getElementById("refresh-view");
const rowTemplate = document.getElementById("script-item");
const warningSection = document.getElementById("popup-warning");

const patternCache = new Map();

let scripts = [];
let activeTab = null;
const supportsUserScripts = Boolean(
  chrome.userScripts && typeof chrome.userScripts.register === "function"
);

if (warningSection) {
  warningSection.style.display = supportsUserScripts ? "none" : "block";
}

function patternToRegex(pattern) {
  if (patternCache.has(pattern)) {
    return patternCache.get(pattern);
  }
  const compiled = compileMatchPattern(pattern);
  if (compiled) {
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

function matchesUrl(script, url) {
  if (!url || !Array.isArray(script.matches) || script.matches.length === 0) {
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

function getScriptsForCurrentTab() {
  if (!activeTab || !activeTab.url) {
    return [];
  }
  const url = activeTab.url;
  if (url.startsWith("chrome://") || url.startsWith("edge://")) {
    return [];
  }
  return scripts.filter((script) => matchesUrl(script, url));
}

// Load scripts into `scripts` from storage helper
async function loadFromStorage() {
  scripts = await loadScriptsFromStorage();
}

function renderScriptsList() {
  scriptsContainer.innerHTML = "";

  if (!activeTab || !activeTab.url) {
    emptyState.hidden = false;
    emptyState.textContent = "No active tab.";
    runMatchingButton.disabled = true;
    return;
  }

  if (
    activeTab.url.startsWith("chrome://") ||
    activeTab.url.startsWith("edge://")
  ) {
    emptyState.hidden = false;
    emptyState.textContent = "Scripts cannot run on this page.";
    runMatchingButton.disabled = true;
    return;
  }

  const matching = getScriptsForCurrentTab();

  if (matching.length === 0) {
    emptyState.hidden = false;
    emptyState.textContent = "No scripts match this page.";
    runMatchingButton.disabled = true;
    return;
  }

  emptyState.hidden = true;
  runMatchingButton.disabled = !matching.some((script) => script.enabled);

  for (const script of matching) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    const nameEl = node.querySelector(".script__name");
    const toggleEl = node.querySelector(".script__toggle");
    const runBtn = node.querySelector(".script__run");
    const article = node;

    nameEl.textContent = script.name || "Unnamed script";
    toggleEl.checked = Boolean(script.enabled);
    runBtn.disabled = !script.enabled;

    article.classList.toggle("script--disabled", !script.enabled);

    toggleEl.addEventListener("change", async () => {
      script.enabled = toggleEl.checked;
      await persistScripts(scripts);
      article.classList.toggle("script--disabled", !script.enabled);
      runBtn.disabled = !script.enabled;
      const hasEnabled = getScriptsForCurrentTab().some((item) => item.enabled);
      runMatchingButton.disabled = !hasEnabled;
    });

    runBtn.addEventListener("click", async () => {
      if (!activeTab || typeof activeTab.id !== "number") {
        return;
      }
      runBtn.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({
          type: "openTamper:runScriptsForTab",
          tabId: activeTab.id,
          url: activeTab.url,
          scriptId: script.id,
          force: true,
        });
        if (!response?.ok) {
          console.warn("Manual run failed", response?.error);
        }
      } catch (error) {
        console.warn("Manual script run threw", error);
      } finally {
        runBtn.disabled = !script.enabled;
      }
    });

    scriptsContainer.appendChild(node);
  }
}

async function refreshView() {
  patternCache.clear();
  await loadFromStorage();
  renderScriptsList();
}

async function initActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (tab) {
    activeTab = tab;
  } else {
    activeTab = null;
  }
}

runMatchingButton.addEventListener("click", async () => {
  if (!activeTab || typeof activeTab.id !== "number") {
    return;
  }
  runMatchingButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "openTamper:runScriptsForTab",
      tabId: activeTab.id,
      url: activeTab.url,
      force: true,
    });
    if (!response?.ok) {
      console.warn("Unable to run scripts", response?.error);
    }
  } catch (error) {
    console.warn("Unable to trigger scripts", error);
  } finally {
    runMatchingButton.disabled = false;
  }
});

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refreshViewButton.addEventListener("click", async () => {
  refreshViewButton.disabled = true;
  await initActiveTab();
  await refreshView();
  refreshViewButton.disabled = false;
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) {
    return;
  }
  await refreshView();
});

(async function init() {
  await initActiveTab();
  await refreshView();
})();
