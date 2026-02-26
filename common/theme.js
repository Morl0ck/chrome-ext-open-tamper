const darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(isDark) {
  try {
    document.documentElement.setAttribute(
      "data-theme",
      isDark ? "dark" : "light"
    );
  } catch (_) {
    // ignore
  }
}

applyTheme(darkModeQuery.matches);
if (typeof darkModeQuery.addEventListener === "function") {
  darkModeQuery.addEventListener("change", (e) => applyTheme(e.matches));
} else if (typeof darkModeQuery.addListener === "function") {
  darkModeQuery.addListener((e) => applyTheme(e.matches));
}
