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
  const matches = deriveMatches(meta);
  const name = deriveName(meta, sourceUrl || fileName || "local-file");
  const description = Array.isArray(meta.description)
    ? meta.description[0]
    : "";
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
    fileName: fileName || null,
  };
}

export default {
  buildScriptFromCode,
};
