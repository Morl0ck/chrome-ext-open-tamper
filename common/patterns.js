const ESCAPE_REGEX = /[.+?^${}()|[\]\\]/g;

function escapeForRegex(input) {
  return input.replace(ESCAPE_REGEX, "\\$&");
}

export function compileMatchPattern(pattern) {
  if (pattern === "<all_urls>") {
    return /^(https?|wss?|file|ftp|chrome-extension):\/\/.+/;
  }

  const match = pattern.match(/^(\*|https?|wss?|file|ftp|chrome-extension):\/\/([^/]*)(\/.*)$/);
  if (!match) {
    return null;
  }

  let [, scheme, host, path] = match;

  const schemeRegex = scheme === "*" ? "https?" : escapeForRegex(scheme);

  let hostRegex;
  if (scheme === "file") {
    hostRegex = "";
    path = match[3] || "/";
  } else if (!host || host === "*") {
    hostRegex = "[^/]+";
  } else {
    hostRegex = host
      .split("*")
      .map(escapeForRegex)
      .join("[^/]*");
  }

  const pathRegex = path
    .split("*")
    .map(escapeForRegex)
    .join(".*");

  const fullPattern = scheme === "file"
    ? `^(?:${schemeRegex}):\/\/${pathRegex}$`
    : `^(?:${schemeRegex}):\/\/${hostRegex}${pathRegex}$`;

  try {
    return new RegExp(fullPattern);
  } catch (error) {
    console.warn("[OpenTamper] Failed to compile match pattern", pattern, error);
    return null;
  }
}

const compiledPatternsCache = new Map();

export function clearPatternCache() {
  compiledPatternsCache.clear();
}

export function patternToRegex(pattern) {
  if (compiledPatternsCache.has(pattern)) {
    return compiledPatternsCache.get(pattern);
  }
  const compiled = compileMatchPattern(pattern);
  if (compiled) {
    compiledPatternsCache.set(pattern, compiled);
  }
  return compiled;
}

export function matchesUrl(script, url) {
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
