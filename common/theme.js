const m = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(isDark) {
  try {
    document.documentElement.setAttribute(
      "data-theme",
      isDark ? "dark" : "light"
    );
  } catch (e) {
    // ignore
  }
}

applyTheme(m.matches);
if (typeof m.addEventListener === "function") {
  m.addEventListener("change", (e) => applyTheme(e.matches));
} else if (typeof m.addListener === "function") {
  m.addListener((e) => applyTheme(e.matches));
}

export {};
