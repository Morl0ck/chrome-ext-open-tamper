const STORAGE_KEY = "openTamperScripts";

const addScriptForm = document.getElementById("add-script-form");
const urlInput = document.getElementById("script-url");
const scriptsContainer = document.getElementById("scripts");
const emptyState = document.getElementById("empty-state");
const rowTemplate = document.getElementById("script-row");
const warningBlock = document.getElementById("userscripts-warning");
const importFileButton = document.getElementById("import-from-file");
const fileInput = document.getElementById("script-file");

const supportsUserScripts = Boolean(chrome.userScripts && typeof chrome.userScripts.register === "function");

if (warningBlock) {
  warningBlock.hidden = supportsUserScripts;
}

let pendingReplaceId = null;
let pendingReplaceButton = null;

if (importFileButton && fileInput) {
  importFileButton.addEventListener("click", () => {
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
      pendingReplaceId = null;
      pendingReplaceButton = null;
      return;
    }

    const buttonToReset = pendingReplaceButton;
    if (!pendingReplaceId) {
      importFileButton.disabled = true;
    }

    try {
      const code = await readFileAsText(file);
      const relativePath = (file.webkitRelativePath && file.webkitRelativePath.length > 0)
        ? file.webkitRelativePath
        : file.name;
      const normalizedPath = relativePath.replace(/\\/g, "/");
      const sourceUrl = `file:///${encodeURI(normalizedPath)}`;

      const newScript = await buildScriptFromCode({
        code,
        sourceUrl,
        existingId: pendingReplaceId,
        sourceType: "local",
        fileName: file.name
      });

      if (pendingReplaceId) {
        const index = scripts.findIndex((script) => script.id === pendingReplaceId);
        if (index >= 0) {
          const enabled = scripts[index].enabled;
          scripts[index] = { ...newScript, enabled };
        } else {
          scripts.push(newScript);
        }
      } else {
        scripts.push(newScript);
      }

      await persistScripts();
      renderScripts();
    } catch (error) {
      console.error(error);
      alert(`Unable to import script: ${error.message}`);
    } finally {
      if (buttonToReset) {
        buttonToReset.disabled = false;
      }
      importFileButton.disabled = false;
      pendingReplaceId = null;
      pendingReplaceButton = null;
      fileInput.value = "";
    }
  });
}

let scripts = [];

async function loadScripts() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  scripts = raw.map((entry) => ({
    ...entry,
    matches: Array.isArray(entry.matches) ? entry.matches : [],
    excludes: Array.isArray(entry.excludes) ? entry.excludes : [],
    runAt: entry.runAt || "document_idle",
    noframes: Boolean(entry.noframes),
    allFrames: Boolean(entry.allFrames),
    matchAboutBlank: Boolean(entry.matchAboutBlank),
    requires: Array.isArray(entry.requires) ? entry.requires : [],
    sourceType: entry.sourceType || "remote",
    fileName: entry.fileName || null
  }));
}

async function persistScripts() {
  await chrome.storage.local.set({ [STORAGE_KEY]: scripts });
}

function parseMetadata(code) {
  const meta = {};
  const match = code.match(/==UserScript==([\s\S]*?)==\/UserScript==/);
  if (!match) {
    return meta;
  }

  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim().replace(/^\/\/\s?/, "").replace(/^\*\s?/, "");
    if (!trimmed.startsWith("@")) {
      continue;
    }
    const [tag, ...rest] = trimmed.split(/\s+/);
    const key = tag.slice(1).toLowerCase();
    const value = rest.join(" ").trim();
    if (!value) {
      continue;
    }
    if (!meta[key]) {
      meta[key] = [];
    }
    meta[key].push(value);
  }
  return meta;
}

function deriveMatches(meta) {
  if (Array.isArray(meta.match) && meta.match.length > 0) {
    return meta.match;
  }
  if (Array.isArray(meta.include) && meta.include.length > 0) {
    return meta.include;
  }
  return ["<all_urls>"];
}

function deriveExcludes(meta) {
  if (Array.isArray(meta.exclude) && meta.exclude.length > 0) {
    return meta.exclude;
  }
  return [];
}

function deriveRunAt(meta) {
  const value = Array.isArray(meta["run-at"]) ? meta["run-at"][0] : null;
  if (!value) {
    return "document_idle";
  }
  const normalized = value.toLowerCase();
  if (normalized.includes("document-start")) {
    return "document_start";
  }
  if (normalized.includes("document-end") || normalized.includes("document-ready")) {
    return "document_end";
  }
  if (normalized.includes("document-idle")) {
    return "document_idle";
  }
  return "document_idle";
}

function deriveNoFrames(meta) {
  return Array.isArray(meta.noframes) && meta.noframes.length > 0;
}

function deriveAllFrames(meta) {
  if (!Array.isArray(meta["all-frames"])) {
    return false;
  }
  return meta["all-frames"].some((entry) => entry.toLowerCase() === "true");
}

function deriveMatchAboutBlank(meta) {
  const values = meta["match-about-blank"] || meta.matchaboutblank;
  if (!Array.isArray(values)) {
    return false;
  }
  return values.some((entry) => entry.toLowerCase() === "true");
}

function deriveName(meta, url) {
  const metaName = Array.isArray(meta.name) ? meta.name[0] : null;
  if (metaName) {
    return metaName;
  }
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/");
    const last = segments[segments.length - 1];
    return last || url;
  } catch (_) {
    return url;
  }
}

async function resolveRequires(meta, baseUrl) {
  const requires = Array.isArray(meta.require) ? meta.require : [];
  if (requires.length === 0) {
    return [];
  }

  const resolved = [];
  const seen = new Set();

  for (const entry of requires) {
    const raw = (entry || "").trim();
    if (!raw) {
      continue;
    }

    let resolvedUrl = raw;
    try {
      resolvedUrl = new URL(raw, baseUrl || undefined).toString();
    } catch (_) {
      // leave as provided if it cannot be resolved relative to base
    }

    if (seen.has(resolvedUrl)) {
      continue;
    }
    seen.add(resolvedUrl);

    try {
      const response = await fetch(resolvedUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const code = await response.text();
      resolved.push({ url: resolvedUrl, code });
    } catch (error) {
      throw new Error(`Failed to load @require ${resolvedUrl}: ${error.message || error}`);
    }
  }

  return resolved;
}

async function buildScriptFromCode({ code, sourceUrl, existingId, sourceType, fileName }) {
  const meta = parseMetadata(code);
  const matches = deriveMatches(meta);
  const name = deriveName(meta, sourceUrl || fileName || "local-file");
  const description = Array.isArray(meta.description) ? meta.description[0] : "";
  const runAt = deriveRunAt(meta);
  const noframes = deriveNoFrames(meta);
  const allFrames = deriveAllFrames(meta);
  const matchAboutBlank = deriveMatchAboutBlank(meta);
  const requires = await resolveRequires(meta, sourceUrl);

  return {
    id: existingId || crypto.randomUUID(),
    name,
    description,
    url: sourceUrl,
    code,
    matches,
    excludes: deriveExcludes(meta),
    enabled: true,
    lastUpdated: Date.now(),
    runAt,
    noframes,
    allFrames,
    matchAboutBlank,
    requires,
    sourceType: sourceType || "remote",
    fileName: fileName || null
  };
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
    const metaEl = node.querySelector(".script__meta");
    const matchesEl = node.querySelector(".script__matches");
    const toggleEl = node.querySelector(".script__toggle");
    const removeBtn = node.querySelector(".remove");
    const refreshBtn = node.querySelector(".refresh");

    nameEl.textContent = script.name;
    const updated = script.lastUpdated ? new Date(script.lastUpdated).toLocaleString() : "n/a";
    const sourceLabel = script.sourceType === "local"
      ? `Local file: ${script.fileName || script.url || "(unknown)"}`
      : script.url;
    const requiresDetail = script.requires && script.requires.length > 0
      ? `\nRequires: ${script.requires.map((item) => item.url || "(unknown)").join(", ")}`
      : "";
    metaEl.textContent = `Source: ${sourceLabel}\nUpdated: ${updated}${requiresDetail}`;
    const matchesLine = `Matches: ${script.matches.join(", ")}`;
    const excludesLine = script.excludes && script.excludes.length > 0
      ? ` | Excludes: ${script.excludes.join(", ")}`
      : "";
    const runAtLabel = script.runAt?.replace(/_/g, "-") || "document-idle";
    const framesLabel = script.allFrames
      ? "all frames"
      : script.noframes
        ? "top frame only"
        : "top frame";
    const framesSuffix = framesLabel ? ` | Frames: ${framesLabel}` : "";
    const aboutBlankSuffix = script.matchAboutBlank ? " | about:blank" : "";
    const requiresSuffix = script.requires && script.requires.length > 0 ? ` | Requires: ${script.requires.length}` : "";
    matchesEl.textContent = `${matchesLine}${excludesLine} | Run at: ${runAtLabel}${framesSuffix}${aboutBlankSuffix}${requiresSuffix}`;
    toggleEl.checked = script.enabled;
    refreshBtn.textContent = script.sourceType === "local" ? "Reimport" : "Refresh";

    toggleEl.addEventListener("change", async () => {
      script.enabled = toggleEl.checked;
      await persistScripts();
    });

    removeBtn.addEventListener("click", async () => {
      const shouldRemove = confirm(`Remove ${script.name}?`);
      if (!shouldRemove) {
        return;
      }
      scripts = scripts.filter((item) => item.id !== script.id);
      await persistScripts();
      renderScripts();
    });

    refreshBtn.addEventListener("click", async () => {
      if (script.sourceType === "local") {
        pendingReplaceId = script.id;
        pendingReplaceButton = refreshBtn;
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
        await persistScripts();
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
    sourceType: "remote"
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error || new Error("Unable to read file"));
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
    const existingIndex = scripts.findIndex((script) => script.url === newScript.url);
    if (existingIndex >= 0) {
      scripts[existingIndex] = {
        ...scripts[existingIndex],
        ...newScript,
        enabled: scripts[existingIndex].enabled
      };
    } else {
      scripts.push(newScript);
    }
    await persistScripts();
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
