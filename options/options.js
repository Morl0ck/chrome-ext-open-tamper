import {
  STORAGE_KEY,
  SETTINGS_KEY,
  loadScriptsFromStorage,
  persistScripts,
  loadSettings,
  persistSettings,
} from "../common/storage.js";
import {
  buildScriptFromCode,
  buildScriptWithLocalRequire,
} from "../common/metadata.js";
import { isGitHubUrl } from "../common/urls.js";

const addScriptForm = document.getElementById("add-script-form");
const urlInput = document.getElementById("script-url");
const scriptsContainer = document.getElementById("scripts");
const emptyState = document.getElementById("empty-state");
const rowTemplate = document.getElementById("script-row");
const warningBlock = document.getElementById("userscripts-warning");
const importFileButton = document.getElementById("import-from-file");
const importAsRequireButton = document.getElementById("import-as-require");
const fileInput = document.getElementById("script-file");
const repoImportSection = document.getElementById("repo-import");
const repoImportSummary = document.getElementById("repo-import-summary");
const repoImportList = document.getElementById("repo-import-list");
const repoImportEmpty = document.getElementById("repo-import-empty");
const repoImportRowTemplate = document.getElementById("repo-import-row");
const fetchButton = addScriptForm?.querySelector('button[type="submit"]');
const defaultFetchButtonLabel = fetchButton?.textContent?.trim() || "Fetch & Save";

// Settings elements
const badgeTextColorInput = document.getElementById("badge-text-color");
const badgeTextColorHex = document.getElementById("badge-text-color-hex");
const badgeBgColorInput = document.getElementById("badge-bg-color");
const badgeBgColorHex = document.getElementById("badge-bg-color-hex");
const badgePreview = document.getElementById("badge-preview");

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
let repoSearchContext = null;
let repoSearchResults = [];

function isGitHubRawUserscriptUrl(value) {
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (
      host === "raw.githubusercontent.com" ||
      host === "gist.githubusercontent.com" ||
      host.endsWith(".githubusercontent.com")
    ) {
      return path.endsWith(".user.js");
    }
    if (host === "github.com" || host === "www.github.com") {
      return path.includes("/raw/") && path.endsWith(".user.js");
    }
    return false;
  } catch (error) {
    return false;
  }
}

function isLikelyFilePath(value) {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^file:\/\//i.test(trimmed)) {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("\\\\")) {
    return true;
  }
  if (
    trimmed.startsWith("../") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("~/")
  ) {
    return true;
  }
  if (!trimmed.includes("://") && trimmed.startsWith("/")) {
    return !trimmed.startsWith("//");
  }
  return false;
}

// Sync action buttons with the current input type (repo/raw/file).
function updateInputContextState() {
  if (!urlInput) {
    return;
  }

  const value = urlInput.value.trim();
  const hasValue = value.length > 0;
  const isRepoValue = hasValue && Boolean(parseGitHubRepoUrl(value));
  const isRawValue = hasValue && isGitHubRawUserscriptUrl(value);
  const isFileValue = hasValue && isLikelyFilePath(value);
  const disableLocalImports = isRepoValue || isRawValue;
  const nextFetchLabel = isRepoValue ? "Fetch" : defaultFetchButtonLabel;

  if (importFileButton) {
    importFileButton.disabled = disableLocalImports;
  }
  if (importAsRequireButton) {
    importAsRequireButton.disabled = disableLocalImports;
  }

  if (fetchButton) {
    if (fetchButton.textContent !== nextFetchLabel) {
      fetchButton.textContent = nextFetchLabel;
    }
    if (isFileValue) {
      fetchButton.disabled = true;
    } else if (!addScriptForm.classList.contains("loading")) {
      fetchButton.disabled = false;
    }
  }
}

function resolveLocalFileSpec(rawValue) {
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      const fileName = url.pathname
        ? decodeURIComponent(url.pathname.split("/").pop() || "")
        : null;
      return {
        fileUrl: url.toString(),
        fileName: fileName || null,
      };
    } catch (error) {
      console.error("Invalid file URL", error);
      return null;
    }
  }

  const unquoted = trimmed.replace(/^['"]|['"]$/g, "");
  if (!unquoted) {
    return null;
  }

  let normalizedPath = unquoted.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalizedPath)) {
    normalizedPath = `/${normalizedPath}`;
  } else if (!normalizedPath.startsWith("/")) {
    normalizedPath = `/${normalizedPath}`;
  }

  try {
    const url = new URL("file://");
    url.pathname = normalizedPath;
    const fileName = url.pathname
      ? decodeURIComponent(url.pathname.split("/").pop() || "")
      : null;
    return {
      fileUrl: url.toString(),
      fileName: fileName || null,
    };
  } catch (error) {
    console.error("Unable to normalize local file path", error);
    return null;
  }
}

async function importLocalRequireFromPath({
  rawPath,
  existingId = null,
  triggerButton = null,
  clearInput = true,
} = {}) {
  const spec = resolveLocalFileSpec(rawPath);
  if (!spec) {
    alert("Enter a valid local file path or file:// URL before importing.");
    return false;
  }

  const { fileUrl, fileName } = spec;

  if (triggerButton) {
    triggerButton.disabled = true;
  }

  try {
    const code = await fetchScriptSource(fileUrl);
    const newScript = await buildScriptWithLocalRequire({
      code,
      sourceUrl: fileUrl,
      existingId,
      fileName,
    });

    upsertImportedScript(newScript);
    await persistScripts(scripts);
    renderScripts();
    if (clearInput) {
      urlInput.value = "";
      clearRepoResults();
      updateInputContextState();
    }
    return true;
  } catch (error) {
    console.error(error);
    const message = error?.message || String(error);
    alert(`Unable to import script: ${message}`);
    return false;
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
    }
  }
}

if (importFileButton && fileInput) {
  importFileButton.addEventListener("click", () => {
    fileImportMode = ImportModes.SCRIPT;
    activeImportButton = importFileButton;
    pendingReplaceId = null;
    pendingReplaceButton = null;
    fileInput.value = "";
    fileInput.click();
  });

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
      const inferredSourceUrl = normalizedPath
        ? `file:///${encodeURI(normalizedPath)}`
        : null;

      const newScript = await buildScriptFromCode({
        code,
        sourceUrl: inferredSourceUrl,
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

if (importAsRequireButton) {
  importAsRequireButton.addEventListener("click", async () => {
    const rawPath = urlInput.value.trim();
    if (!rawPath) {
      alert("Enter the full path or file:// URL before importing as @require.");
      return;
    }

    pendingReplaceId = null;
    pendingReplaceButton = null;
    activeImportButton = null;

    await importLocalRequireFromPath({
      rawPath,
      triggerButton: importAsRequireButton,
      clearInput: true,
    });
  });
}

if (urlInput) {
  const handleUrlChange = () => updateInputContextState();
  urlInput.addEventListener("input", handleUrlChange);
  urlInput.addEventListener("change", handleUrlChange);
  updateInputContextState();
}

let scripts = [];

function ensureRepoSectionVisibility() {
  if (!repoImportSection) {
    return;
  }
  repoImportSection.hidden = !repoSearchContext;
}

function clearRepoResults() {
  repoSearchContext = null;
  repoSearchResults = [];
  ensureRepoSectionVisibility();
  if (repoImportSummary) {
    repoImportSummary.textContent = "";
  }
  if (repoImportList) {
    repoImportList.innerHTML = "";
  }
  if (repoImportEmpty) {
    repoImportEmpty.hidden = true;
  }
}

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
      const autoUpdateEnabled = scripts[indexById].autoUpdateEnabled === true;
      const autoUpdateLastChecked =
        scripts[indexById].autoUpdateLastChecked || 0;
      scripts[indexById] = {
        ...newScript,
        enabled,
        autoUpdateEnabled,
        autoUpdateLastChecked,
      };
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
      const autoUpdateEnabled = existing.autoUpdateEnabled === true;
      const autoUpdateLastChecked = existing.autoUpdateLastChecked || 0;
      scripts[indexByUrl] = {
        ...existing,
        ...newScript,
        enabled,
        autoUpdateEnabled,
        autoUpdateLastChecked,
      };
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
    const autoUpdateContainer = node.querySelector(".script__autoupdate");
    const autoUpdateToggle = node.querySelector(".script__autoupdate-toggle");

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

    const supportsAutoUpdate =
      script.sourceType === "remote" && isGitHubUrl(script.url);
    if (autoUpdateContainer && autoUpdateToggle) {
      if (!supportsAutoUpdate) {
        autoUpdateContainer.remove();
        script.autoUpdateEnabled = false;
      } else {
        autoUpdateContainer.hidden = false;
        autoUpdateToggle.disabled = false;
        autoUpdateToggle.checked = script.autoUpdateEnabled === true;
        autoUpdateToggle.addEventListener("change", async () => {
          script.autoUpdateEnabled = autoUpdateToggle.checked;
          if (script.autoUpdateEnabled) {
            script.autoUpdateLastChecked = 0;
          }
          await persistScripts(scripts);
        });
      }
    }

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
        if (script.importMode === ImportModes.REQUIRE) {
          const sourceReference = script.url || "";
          if (!sourceReference) {
            alert("Original file reference is missing. Reimport from the Add Script section.");
            return;
          }

          await importLocalRequireFromPath({
            rawPath: sourceReference,
            existingId: script.id,
            triggerButton: refreshBtn,
            clearInput: false,
          });
          return;
        }

        pendingReplaceId = script.id;
        pendingReplaceButton = refreshBtn;
        fileImportMode = ImportModes.SCRIPT;
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
        const previousAutoUpdateEnabled = script.autoUpdateEnabled === true;
        const previousAutoUpdateLastChecked = script.autoUpdateLastChecked || 0;
        Object.assign(script, updatedScript);
        script.enabled = wasEnabled;
        script.autoUpdateEnabled = previousAutoUpdateEnabled;
        script.autoUpdateLastChecked = previousAutoUpdateLastChecked;
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

function renderRepoScripts() {
  if (!repoImportSection || !repoImportSummary || !repoImportList) {
    return;
  }

  ensureRepoSectionVisibility();

  if (!repoSearchContext) {
    return;
  }

  const { owner, repo, ref, path } = repoSearchContext;
  const locationLabel = path ? `${path}` : "repo root";
  const count = repoSearchResults.length;
  const summaryPrefix = `${owner}/${repo}@${ref}`;
  const summarySuffix = count === 1 ? "1 userscript found" : `${count} userscripts found`;
  repoImportSummary.textContent = `${summaryPrefix} (${locationLabel}) - ${summarySuffix}`;

  repoImportList.innerHTML = "";

  if (!repoImportEmpty) {
    return;
  }

  if (count === 0) {
    repoImportEmpty.hidden = false;
    return;
  }

  repoImportEmpty.hidden = true;

  for (const script of repoSearchResults) {
    if (!repoImportRowTemplate?.content?.firstElementChild) {
      continue;
    }
    const node = repoImportRowTemplate.content.firstElementChild.cloneNode(true);
    const nameEl = node.querySelector(".repo-script__name");
    const pathEl = node.querySelector(".repo-script__path");
    const importBtn = node.querySelector(".repo-script__import");

    if (nameEl) {
      nameEl.textContent = script.name;
    }
    if (pathEl) {
      pathEl.textContent = script.path;
    }
    if (importBtn) {
      importBtn.addEventListener("click", async () => {
        importBtn.disabled = true;
        const previousLabel = importBtn.textContent;
        importBtn.textContent = "Importing...";
        try {
          const imported = await fetchAndBuildScript(script.rawUrl);
          upsertImportedScript(imported);
          await persistScripts(scripts);
          renderScripts();
        } catch (error) {
          console.error(error);
          const message = error?.message || String(error);
          alert(`Unable to import ${script.name}: ${message}`);
        } finally {
          importBtn.textContent = previousLabel;
          importBtn.disabled = false;
        }
      });
    }

    repoImportList.appendChild(node);
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

function parseGitHubRepoUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (!owner || !repo) {
    return null;
  }

  if (segments.length >= 4 && segments[2] === "tree") {
    const ref = segments[3];
    const path = segments.slice(4).join("/");
    return { owner, repo, ref, path };
  }

  return { owner, repo, ref: null, path: "" };
}

async function fetchGitHubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message = errorBody?.message || `GitHub request failed with status ${response.status}`;
    throw new Error(message);
  }
  return await response.json();
}

function encodePath(path) {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function fetchRepoUserscripts(repoSpec) {
  const { owner, repo } = repoSpec;
  let ref = repoSpec.ref;
  let basePath = repoSpec.path || "";

  if (!ref) {
    const meta = await fetchGitHubJson(`https://api.github.com/repos/${owner}/${repo}`);
    ref = meta?.default_branch || "main";
  }

  const encodedRefForApi = encodeURIComponent(ref);
  const encodedRefForRaw = encodePath(ref);
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodedRefForApi}?recursive=1`;
  const treePayload = await fetchGitHubJson(treeUrl);

  if (!Array.isArray(treePayload?.tree)) {
    throw new Error("Invalid tree response from GitHub");
  }

  basePath = basePath.trim().replace(/^\/+|\/+$/g, "");
  const normalizedBase = basePath ? basePath.replace(/\\/g, "/") : "";

  const results = [];
  for (const item of treePayload.tree) {
    if (item?.type !== "blob" || typeof item.path !== "string") {
      continue;
    }
    if (!item.path.endsWith(".user.js")) {
      continue;
    }
    if (normalizedBase && !item.path.startsWith(`${normalizedBase}/`) && item.path !== normalizedBase) {
      continue;
    }

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodedRefForRaw}/${encodePath(item.path)}`;
    const fileName = item.path.split("/").pop() || item.path;
    results.push({
      name: fileName,
      path: item.path,
      rawUrl,
    });
  }

  repoSearchContext = { owner, repo, ref, path: normalizedBase };
  repoSearchResults = results.sort((a, b) => a.path.localeCompare(b.path));
  renderRepoScripts();
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
    const repoSpec = parseGitHubRepoUrl(url);
    if (repoSpec) {
      await fetchRepoUserscripts(repoSpec);
      return;
    }

    clearRepoResults();

    const newScript = await fetchAndBuildScript(url);
    const existingIndex = scripts.findIndex(
      (script) => script.url === newScript.url
    );
    if (existingIndex >= 0) {
      const existing = scripts[existingIndex];
      const autoUpdateEnabled = existing.autoUpdateEnabled === true;
      const autoUpdateLastChecked = existing.autoUpdateLastChecked || 0;
      scripts[existingIndex] = {
        ...existing,
        ...newScript,
        enabled: existing.enabled,
        autoUpdateEnabled,
        autoUpdateLastChecked,
      };
    } else {
      scripts.push(newScript);
    }
    await persistScripts(scripts);
    urlInput.value = "";
    updateInputContextState();
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
  if (areaName !== "local") {
    return;
  }
  if (changes[STORAGE_KEY]) {
    await loadScripts();
    renderScripts();
  }
  if (changes[SETTINGS_KEY]) {
    await loadAndApplySettings();
  }
});

// Settings functionality
function isValidHexColor(value) {
  return /^#[0-9A-Fa-f]{6}$/.test(value);
}

function updateBadgePreview(textColor, bgColor) {
  if (!badgePreview) {
    return;
  }
  badgePreview.style.color = textColor;
  badgePreview.style.backgroundColor = bgColor;
}

async function loadAndApplySettings() {
  const settings = await loadSettings();
  
  if (badgeTextColorInput) {
    badgeTextColorInput.value = settings.badgeTextColor;
  }
  if (badgeTextColorHex) {
    badgeTextColorHex.value = settings.badgeTextColor;
  }
  if (badgeBgColorInput) {
    badgeBgColorInput.value = settings.badgeBackgroundColor;
  }
  if (badgeBgColorHex) {
    badgeBgColorHex.value = settings.badgeBackgroundColor;
  }
  
  updateBadgePreview(settings.badgeTextColor, settings.badgeBackgroundColor);
}

async function saveColorSettings() {
  const textColor = badgeTextColorInput?.value || "#000000";
  const bgColor = badgeBgColorInput?.value || "#4CAF50";
  
  await persistSettings({
    badgeTextColor: textColor,
    badgeBackgroundColor: bgColor,
  });
  
  updateBadgePreview(textColor, bgColor);
}

// Badge text color handlers
if (badgeTextColorInput && badgeTextColorHex) {
  badgeTextColorInput.addEventListener("input", async () => {
    const value = badgeTextColorInput.value;
    badgeTextColorHex.value = value;
    updateBadgePreview(value, badgeBgColorInput?.value || "#4CAF50");
    await saveColorSettings();
  });
  
  badgeTextColorHex.addEventListener("input", () => {
    let value = badgeTextColorHex.value;
    if (!value.startsWith("#")) {
      value = "#" + value;
    }
    if (isValidHexColor(value)) {
      badgeTextColorInput.value = value;
      updateBadgePreview(value, badgeBgColorInput?.value || "#4CAF50");
    }
  });
  
  badgeTextColorHex.addEventListener("change", async () => {
    let value = badgeTextColorHex.value;
    if (!value.startsWith("#")) {
      value = "#" + value;
    }
    if (isValidHexColor(value)) {
      badgeTextColorInput.value = value;
      badgeTextColorHex.value = value;
      await saveColorSettings();
    } else {
      // Reset to current color picker value
      badgeTextColorHex.value = badgeTextColorInput.value;
    }
  });
}

// Badge background color handlers
if (badgeBgColorInput && badgeBgColorHex) {
  badgeBgColorInput.addEventListener("input", async () => {
    const value = badgeBgColorInput.value;
    badgeBgColorHex.value = value;
    updateBadgePreview(badgeTextColorInput?.value || "#000000", value);
    await saveColorSettings();
  });
  
  badgeBgColorHex.addEventListener("input", () => {
    let value = badgeBgColorHex.value;
    if (!value.startsWith("#")) {
      value = "#" + value;
    }
    if (isValidHexColor(value)) {
      badgeBgColorInput.value = value;
      updateBadgePreview(badgeTextColorInput?.value || "#000000", value);
    }
  });
  
  badgeBgColorHex.addEventListener("change", async () => {
    let value = badgeBgColorHex.value;
    if (!value.startsWith("#")) {
      value = "#" + value;
    }
    if (isValidHexColor(value)) {
      badgeBgColorInput.value = value;
      badgeBgColorHex.value = value;
      await saveColorSettings();
    } else {
      // Reset to current color picker value
      badgeBgColorHex.value = badgeBgColorInput.value;
    }
  });
}

(async function init() {
  await loadScripts();
  renderScripts();
  await loadAndApplySettings();
})().catch((error) => {
  console.error("[OpenTamper] options initialization failed", error);
});
