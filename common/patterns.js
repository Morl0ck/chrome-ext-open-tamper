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
    console.warn("Failed to compile match pattern", pattern, error);
    return null;
  }
}
