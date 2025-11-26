import {
  STORAGE_KEY,
  loadScriptsFromStorage,
  persistScripts,
} from "../common/storage.js";
import {
  buildScriptFromCode,
  buildScriptWithLocalRequire,
} from "../common/metadata.js";

const addScriptForm = document.getElementById("add-script-form");
const urlInput = document.getElementById("script-url");
const scriptsContainer = document.getElementById("scripts");
const emptyState = document.getElementById("empty-state");
const rowTemplate = document.getElementById("script-row");
const warningBlock = document.getElementById("userscripts-warning");
const importFileButton = document.getElementById("import-from-file");
const importAsRequireButton = document.getElementById("import-as-require");
const fileInput = document.getElementById("script-file");

const supportsUserScripts = Boolean(
  chrome.userScripts && typeof chrome.userScripts.register === "function"
);

if (warningBlock) {
  warningBlock.hidden = supportsUserScripts;
}

let pendingReplaceId = null;
let pendingReplaceButton = null;
const ImportModes = {
  SCRIPT: "script",
  REQUIRE: "require",
};
let fileImportMode = ImportModes.SCRIPT;
let activeImportButton = null;

if (importFileButton && fileInput) {
  importFileButton.addEventListener("click", () => {
    fileImportMode = ImportModes.SCRIPT;
    activeImportButton = importFileButton;
    pendingReplaceId = null;
    pendingReplaceButton = null;
    fileInput.value = "";
    fileInput.click();
  });

  if (importAsRequireButton) {
    importAsRequireButton.addEventListener("click", () => {
      fileImportMode = ImportModes.REQUIRE;
      activeImportButton = importAsRequireButton;
      pendingReplaceId = null;
      pendingReplaceButton = null;
      fileInput.value = "";
      fileInput.click();
    });
  }

  fileInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      if (pendingReplaceButton) {
        pendingReplaceButton.disabled = false;
      }
      if (activeImportButton) {
        activeImportButton.disabled = false;
      }
      if (importFileButton) {
        importFileButton.disabled = false;
      }
      if (importAsRequireButton) {
        importAsRequireButton.disabled = false;
      }
      pendingReplaceId = null;
      pendingReplaceButton = null;
      activeImportButton = null;
      fileImportMode = ImportModes.SCRIPT;
      fileInput.value = "";
      return;
    }

    const buttonToReset = pendingReplaceButton;
    const triggerButton =
      !pendingReplaceId && activeImportButton ? activeImportButton : null;
    if (triggerButton) {
      triggerButton.disabled = true;
    }

    try {
      const code = await readFileAsText(file);
      const relativePath =
        file.webkitRelativePath && file.webkitRelativePath.length > 0
          ? file.webkitRelativePath
          : file.name;
      const normalizedPath = relativePath.replace(/\\/g, "/");
      const sourceUrl = `file:///${encodeURI(normalizedPath)}`;

      const newScript =
        fileImportMode === ImportModes.REQUIRE
          ? await buildScriptWithLocalRequire({
              code,
              sourceUrl,
              existingId: pendingReplaceId,
              fileName: file.name,
            })
          : await buildScriptFromCode({
              code,
              sourceUrl,
              existingId: pendingReplaceId,
              sourceType: "local",
              fileName: file.name,
            });

      upsertImportedScript(newScript);

      await persistScripts(scripts);
      renderScripts();
    } catch (error) {
      console.error(error);
      const message = error?.message || String(error);
      alert(`Unable to import script: ${message}`);
    } finally {
      if (buttonToReset) {
        buttonToReset.disabled = false;
      }
      if (triggerButton) {
        triggerButton.disabled = false;
      }
      if (importFileButton) {
        importFileButton.disabled = false;
      }
      if (importAsRequireButton) {
        importAsRequireButton.disabled = false;
      }
      pendingReplaceId = null;
      pendingReplaceButton = null;
      activeImportButton = null;
      fileImportMode = ImportModes.SCRIPT;
      fileInput.value = "";
    }
  });
}

let scripts = [];

function upsertImportedScript(newScript) {
  if (!newScript) {
    return;
  }

  if (pendingReplaceId) {
    const indexById = scripts.findIndex(
      (script) => script.id === pendingReplaceId
    );
    if (indexById >= 0) {
      const enabled = scripts[indexById].enabled;
      scripts[indexById] = { ...newScript, enabled };
      return;
    }
  }

  if (newScript.url) {
    const indexByUrl = scripts.findIndex(
      (script) => script.url && script.url === newScript.url
    );
    if (indexByUrl >= 0) {
      const existing = scripts[indexByUrl];
      const enabled = existing.enabled;
      scripts[indexByUrl] = { ...existing, ...newScript, enabled };
      return;
    }
  }

  scripts.push(newScript);
}

async function loadScripts() {
  scripts = await loadScriptsFromStorage();
}

function renderScripts() {
  scriptsContainer.innerHTML = "";
  if (scripts.length === 0) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  for (const script of scripts) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    const nameEl = node.querySelector(".script__name");
    const descriptionEl = node.querySelector(".script__description");
    const tagsEl = node.querySelector(".script__tags");
    const metaEl = node.querySelector(".script__meta");
    const matchesEl = node.querySelector(".script__matches");
    const framesEl = node.querySelector(".script__frames");
    const requiresEl = node.querySelector(".script__requires");
    const toggleEl = node.querySelector(".script__toggle");
    const removeBtn = node.querySelector(".remove");
    const refreshBtn = node.querySelector(".refresh");

    nameEl.textContent = script.name;

    if (descriptionEl) {
      const description = (script.description || "").trim();
      if (description) {
        descriptionEl.textContent = description;
        descriptionEl.hidden = false;
      } else {
        descriptionEl.textContent = "";
        descriptionEl.hidden = true;
      }
    }

    const updated = script.lastUpdated
      ? new Date(script.lastUpdated).toLocaleString()
      : "n/a";
    const sourceLabel =
      script.sourceType === "local"
        ? `Local file: ${script.fileName || script.url || "(unknown)"}`
        : script.url || "n/a";
    const versionLabel = script.version || "n/a";
    const modeLabel =
      script.importMode === ImportModes.REQUIRE
        ? "Local @require import"
        : script.sourceType === "local"
        ? "Local script"
        : "Remote script";
    const runAtLabel = script.runAt?.replace(/_/g, "-") || "document-idle";
    const framesLabel = script.allFrames
      ? "all frames"
      : script.noframes
      ? "top frame only"
      : "top frame";
    const requires = Array.isArray(script.requires) ? script.requires : [];

    if (tagsEl) {
      tagsEl.innerHTML = "";
      const modeTag = (modeLabel || "").trim();
      if (modeTag) {
        const badge = document.createElement("span");
        badge.className = "script__tag";
        badge.textContent = modeTag;
        tagsEl.appendChild(badge);
      }
      tagsEl.hidden = tagsEl.childElementCount === 0;
    }

    if (metaEl) {
      const metaItems = [
        { label: "Source", value: sourceLabel },
        { label: "Mode", value: modeLabel },
        { label: "Version", value: versionLabel },
        { label: "Updated", value: updated },
      ];
      if (script.fileName && script.sourceType === "local") {
        metaItems.push({ label: "File", value: script.fileName });
      }

      metaEl.innerHTML = "";
      for (const item of metaItems) {
        if (!item.value) {
          continue;
        }
        const row = document.createElement("div");
        const labelEl = document.createElement("strong");
        labelEl.textContent = `${item.label}: `;
        const valueEl = document.createElement("span");
        valueEl.textContent = item.value;
        row.append(labelEl, valueEl);
        metaEl.appendChild(row);
      }
    }

    if (matchesEl) {
      const renderListSection = (heading, entries) => {
        if (!entries || entries.length === 0) {
          return null;
        }
        const section = document.createElement("div");
        const headingEl = document.createElement("strong");
        headingEl.textContent = heading;
        section.appendChild(headingEl);
        const list = document.createElement("ul");
        for (const entry of entries) {
          const li = document.createElement("li");
          li.textContent = entry;
          list.appendChild(li);
        }
        section.appendChild(list);
        return section;
      };

      matchesEl.innerHTML = "";
      const matchSection = renderListSection("Matches", script.matches);
      if (matchSection) {
        matchesEl.appendChild(matchSection);
      }
      const excludeSection = renderListSection("Excludes", script.excludes);
      if (excludeSection) {
        matchesEl.appendChild(excludeSection);
      }
      matchesEl.hidden = matchesEl.childElementCount === 0;
    }

    if (framesEl) {
      framesEl.innerHTML = "";
      const executionHeading = document.createElement("strong");
      executionHeading.textContent = "Execution";
      framesEl.appendChild(executionHeading);

      const executionList = document.createElement("ul");
      const runAtItem = document.createElement("li");
      runAtItem.textContent = `Run at: ${runAtLabel}`;
      executionList.appendChild(runAtItem);

      const frameTargetItem = document.createElement("li");
      frameTargetItem.textContent = `Frames: ${framesLabel}`;
      executionList.appendChild(frameTargetItem);

      if (script.matchAboutBlank) {
        const aboutItem = document.createElement("li");
        aboutItem.textContent = "Matches about:blank";
        executionList.appendChild(aboutItem);
      }

      const enabledItem = document.createElement("li");
      enabledItem.textContent = script.enabled ? "Enabled" : "Disabled";
      executionList.appendChild(enabledItem);

      framesEl.appendChild(executionList);
    }

    if (requiresEl) {
      requiresEl.innerHTML = "";
      if (requires.length > 0) {
        const requiresHeading = document.createElement("strong");
        requiresHeading.textContent = "Dependencies";
        requiresEl.appendChild(requiresHeading);

        const requiresList = document.createElement("ul");
        requires.forEach((item, index) => {
          const li = document.createElement("li");
          li.textContent = item && item.url ? item.url : `Inline resource ${
            index + 1
          }`;
          requiresList.appendChild(li);
        });
        requiresEl.appendChild(requiresList);
        requiresEl.hidden = false;
      } else {
        requiresEl.hidden = true;
      }
    }

    toggleEl.checked = script.enabled;
    refreshBtn.textContent =
      script.sourceType === "local" ? "Reimport" : "Refresh";

    toggleEl.addEventListener("change", async () => {
      script.enabled = toggleEl.checked;
      await persistScripts(scripts);
    });

    removeBtn.addEventListener("click", async () => {
      const shouldRemove = confirm(`Remove ${script.name}?`);
      if (!shouldRemove) {
        return;
      }
      scripts = scripts.filter((item) => item.id !== script.id);
      await persistScripts(scripts);
      renderScripts();
    });

    refreshBtn.addEventListener("click", async () => {
      if (script.sourceType === "local") {
        pendingReplaceId = script.id;
        pendingReplaceButton = refreshBtn;
        fileImportMode =
          script.importMode === "require"
            ? ImportModes.REQUIRE
            : ImportModes.SCRIPT;
        activeImportButton = null;
        fileInput.value = "";
        refreshBtn.disabled = true;
        fileInput?.click();
        return;
      }

      refreshBtn.disabled = true;
      try {
        const updatedScript = await fetchAndBuildScript(script.url, script.id);
        const wasEnabled = script.enabled;
        Object.assign(script, updatedScript);
        script.enabled = wasEnabled;
        await persistScripts(scripts);
        renderScripts();
      } catch (error) {
        console.error(error);
        alert(`Unable to refresh script: ${error.message}`);
      } finally {
        refreshBtn.disabled = false;
      }
    });

    scriptsContainer.appendChild(node);
  }
}

async function fetchScriptSource(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return await response.text();
}

async function fetchAndBuildScript(url, existingId) {
  const code = await fetchScriptSource(url);
  return await buildScriptFromCode({
    code,
    sourceUrl: url,
    existingId,
    sourceType: "remote",
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () =>
      reject(reader.error || new Error("Unable to read file"));
    reader.readAsText(file);
  });
}

addScriptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    return;
  }

  addScriptForm.classList.add("loading");
  const submitBtn = addScriptForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;

  try {
    const newScript = await fetchAndBuildScript(url);
    const existingIndex = scripts.findIndex(
      (script) => script.url === newScript.url
    );
    if (existingIndex >= 0) {
      scripts[existingIndex] = {
        ...scripts[existingIndex],
        ...newScript,
        enabled: scripts[existingIndex].enabled,
      };
    } else {
      scripts.push(newScript);
    }
    await persistScripts(scripts);
    urlInput.value = "";
    renderScripts();
  } catch (error) {
    console.error(error);
    alert(`Unable to add script: ${error.message}`);
  } finally {
    submitBtn.disabled = false;
    addScriptForm.classList.remove("loading");
  }
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) {
    return;
  }
  await loadScripts();
  renderScripts();
});

(async function init() {
  await loadScripts();
  renderScripts();
})();
