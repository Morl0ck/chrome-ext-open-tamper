export function isGitHubUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "github.com" ||
      host === "www.github.com" ||
      host.endsWith(".github.com") ||
      host === "raw.githubusercontent.com" ||
      host.endsWith(".githubusercontent.com")
    );
  } catch (_) {
    return false;
  }
}
