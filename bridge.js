/**
 * Bridge content script running in ISOLATED world.
 * Relays GM_xmlhttpRequest calls from userscripts (MAIN world) to the background service worker.
 */

const CHANNEL = "openTamper:gmXhr";

// Listen for messages from the page (MAIN world)
window.addEventListener("message", async (event) => {
  if (event.source !== window) {
    return;
  }
  if (!event.data || event.data.channel !== CHANNEL) {
    return;
  }

  const { id, type, details, scriptId } = event.data;

  if (type === "request") {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "openTamper:gmXhr",
        id,
        scriptId,
        details,
      });

      window.postMessage(
        {
          channel: CHANNEL,
          id,
          type: "response",
          response,
        },
        "*"
      );
    } catch (error) {
      window.postMessage(
        {
          channel: CHANNEL,
          id,
          type: "error",
          error: error.message || String(error),
        },
        "*"
      );
    }
  }
});

// Signal that the bridge is ready
window.postMessage({ channel: CHANNEL, type: "bridge-ready" }, "*");
