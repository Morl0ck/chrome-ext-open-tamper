// ==UserScript==
// @name         Crunchyroll Skip Intro (Userscript)
// @namespace    https://github.com/Morl0ck
// @version      1.1
// @description  Automatically skips the intro on Crunchyroll videos (enabled by default).
// @author       Morl0ck
// @match        https://*.crunchyroll.com/*
// @run-at       document-idle
// @all-frames   true
// @grant        none
// ==/UserScript==

const clickSkipButton = () => {
  const skipButton = document.body.querySelector(
    '[data-testid="skipButton"] > div'
  );
  if (skipButton) {
    skipButton.click();
    return true;
  }
  return false;
};

const startAutoSkip = () => {
  // Avoid multiple intervals
  if (window.__cr_skip_interval) return;
  window.__cr_skip_interval = setInterval(clickSkipButton, 1000);
};

const stopAutoSkip = () => {
  if (window.__cr_skip_interval) {
    clearInterval(window.__cr_skip_interval);
    delete window.__cr_skip_interval;
  }
};

// Find video element, optionally wait for it
const ensureVideoAndSetup = () => {
  let video = document.querySelector("video");
  if (video) {
    setupMediaSession(video);
    return;
  }

  // If no video yet, observe DOM for added video element
  const obs = new MutationObserver((mutations, observer) => {
    const v = document.querySelector("video");
    if (v) {
      observer.disconnect();
      setupMediaSession(v);
    }
  });
  obs.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
};

const setupMediaSession = (videoElement) => {
  if (!("mediaSession" in navigator)) return;

  try {
    navigator.mediaSession.setActionHandler("play", () => {
      if (videoElement.paused) videoElement.play();
    });

    navigator.mediaSession.setActionHandler("pause", () => {
      if (!videoElement.paused) videoElement.pause();
    });

    navigator.mediaSession.setActionHandler("nexttrack", () => {
      if (!clickSkipButton()) videoElement.currentTime += 10;
    });

    navigator.mediaSession.setActionHandler("previoustrack", () => {
      videoElement.currentTime = Math.max(0, videoElement.currentTime - 10);
    });
  } catch (e) {
    // Some browsers may throw on setActionHandler when not allowed; ignore
  }
};

// Initialize
startAutoSkip();
ensureVideoAndSetup();

// Optional: expose simple toggle via console for quick testing (no persistence)
window.crSkip = {
  enable() {
    startAutoSkip();
  },
  disable() {
    stopAutoSkip();
  },
  status() {
    return !!window.__cr_skip_interval;
  },
};
