import { isGitHubUrl } from "./urls.js";

export function parseMetadata(code) {
  const meta = {};
  const match = code.match(/==UserScript==([\s\S]*?)==\/UserScript==/);
  if (!match) {
    return meta;
  }

  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line
      .trim()
      .replace(/^\/\/\s?/, "")
      .replace(/^\*\s?/, "");
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

export function deriveMatches(meta) {
  if (Array.isArray(meta.match) && meta.match.length > 0) {
    return meta.match;
  }
  if (Array.isArray(meta.include) && meta.include.length > 0) {
    return meta.include;
  }
  return ["<all_urls>"];
}

export function deriveExcludes(meta) {
  if (Array.isArray(meta.exclude) && meta.exclude.length > 0) {
    return meta.exclude;
  }
  return [];
}

export function deriveRunAt(meta) {
  const value = Array.isArray(meta["run-at"]) ? meta["run-at"][0] : null;
  if (!value) {
    return "document_idle";
  }
  const normalized = value.toLowerCase();
  if (normalized.includes("document-start")) {
    return "document_start";
  }
  if (
    normalized.includes("document-end") ||
    normalized.includes("document-ready")
  ) {
    return "document_end";
  }
  if (normalized.includes("document-idle")) {
    return "document_idle";
  }
  return "document_idle";
}

export function deriveNoFrames(meta) {
  return Array.isArray(meta.noframes) && meta.noframes.length > 0;
}

export function deriveAllFrames(meta) {
  if (!Array.isArray(meta["all-frames"])) {
    return false;
  }
  return meta["all-frames"].some((entry) => entry.toLowerCase() === "true");
}

export function deriveMatchAboutBlank(meta) {
  const values = meta["match-about-blank"] || meta.matchaboutblank;
  if (!Array.isArray(values)) {
    return false;
  }
  return values.some((entry) => entry.toLowerCase() === "true");
}

export function deriveGrants(meta) {
  if (!Array.isArray(meta.grant)) {
    return [];
  }
  return meta.grant
    .map((g) => (typeof g === "string" ? g.trim() : ""))
    .filter(Boolean);
}

export function deriveName(meta, url) {
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

export function deriveDescription(meta) {
  if (!Array.isArray(meta.description) || meta.description.length === 0) {
    return "";
  }
  const value = meta.description[0];
  return typeof value === "string" ? value : String(value);
}

export function deriveVersion(meta) {
  if (!Array.isArray(meta.version) || meta.version.length === 0) {
    return null;
  }
  const value = meta.version[0];
  return typeof value === "string" ? value : String(value);
}

const COMMENTED_METADATA_BLOCK_REGEX = /\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==/i;

export async function resolveRequires(meta, baseUrl) {
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
      throw new Error(
        `Failed to load @require ${resolvedUrl}: ${error.message || error}`
      );
    }
  }

  return resolved;
}

export async function buildScriptFromCode({
  code,
  sourceUrl,
  existingId,
  sourceType,
  fileName,
}) {
  const meta = parseMetadata(code);
  const requires = await resolveRequires(meta, sourceUrl);
  return createScriptRecord({
    meta,
    code,
    requires,
    existingId,
    sourceUrl,
    sourceType,
    fileName,
    importMode: "script",
  });
}

export async function buildScriptWithLocalRequire({
  code,
  sourceUrl,
  existingId,
  fileName,
}) {
  const { metadataLines, closingIndex } = extractMetadataLinesOrThrow(code);

  const requireLine = `// @require ${sourceUrl}`;
  const normalizedRequireLine = requireLine.toLowerCase();
  const hasRequire = metadataLines.some(
    (line) => line.trim().toLowerCase() === normalizedRequireLine
  );
  if (!hasRequire) {
    metadataLines.splice(closingIndex, 0, requireLine);
  }

  const metadataOnly = metadataLines.join("\n");
  const normalizedMetadata = metadataOnly.endsWith("\n")
    ? metadataOnly
    : `${metadataOnly}\n`;
  const parsedMeta = parseMetadata(normalizedMetadata);

  const allRequires = Array.isArray(parsedMeta.require)
    ? [...parsedMeta.require]
    : [];
  const lowerSourceUrl = sourceUrl.toLowerCase();
  const remoteRequireUrls = allRequires.filter(
    (entry) => (entry || "").toLowerCase() !== lowerSourceUrl
  );
  const metaForResolution = {
    ...parsedMeta,
    require: remoteRequireUrls,
  };
  const remoteRequires = await resolveRequires(metaForResolution, sourceUrl);
  const requires = Array.isArray(remoteRequires) ? [...remoteRequires] : [];
  if (
    !requires.some(
      (item) => item && (item.url || "").toLowerCase() === lowerSourceUrl
    )
  ) {
    requires.push({ url: sourceUrl, code });
  }

  return createScriptRecord({
    meta: parsedMeta,
    code: normalizedMetadata,
    requires,
    existingId,
    sourceUrl,
    sourceType: "local",
    fileName,
    importMode: "require",
  });
}

function createScriptRecord({
  meta,
  code,
  requires,
  existingId,
  sourceUrl,
  sourceType,
  fileName,
  importMode,
}) {
  const derivedRequires = Array.isArray(requires) ? requires : [];
  const resolvedSourceUrl = sourceUrl || null;
  const resolvedFileName = fileName || null;
  const fallbackLabel = resolvedSourceUrl || resolvedFileName || "local-file";
  const resolvedSourceType = sourceType || "remote";
  const autoUpdateEligible =
    resolvedSourceType === "remote" && isGitHubUrl(resolvedSourceUrl);

  return {
    id: existingId || crypto.randomUUID(),
    name: deriveName(meta, fallbackLabel),
    description: deriveDescription(meta),
    url: resolvedSourceUrl,
    code,
    matches: deriveMatches(meta),
    excludes: deriveExcludes(meta),
    enabled: true,
    lastUpdated: Date.now(),
    runAt: deriveRunAt(meta),
    noframes: deriveNoFrames(meta),
    allFrames: deriveAllFrames(meta),
    matchAboutBlank: deriveMatchAboutBlank(meta),
    requires: derivedRequires,
    sourceType: resolvedSourceType,
    fileName: resolvedFileName,
    version: deriveVersion(meta),
    importMode: importMode || "script",
    autoUpdateEnabled: autoUpdateEligible,
    autoUpdateLastChecked: 0,
    grants: deriveGrants(meta),
  };
}

function extractMetadataLinesOrThrow(code) {
  const metadataMatch = code.match(COMMENTED_METADATA_BLOCK_REGEX);
  if (!metadataMatch) {
    throw new Error(
      "The selected file does not contain a userscript metadata block."
    );
  }

  const metadataLines = metadataMatch[0].split(/\r?\n/);
  const closingIndex = metadataLines.findIndex((line) =>
    /\/\/\s*==\/UserScript==/i.test(line)
  );
  if (closingIndex === -1) {
    throw new Error("The userscript metadata block is malformed.");
  }

  return { metadataLines, closingIndex };
}
