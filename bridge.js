/**
 * Bridge content script running in ISOLATED world.
 * Relays GM API calls from userscripts (MAIN world) to the background service worker.
 */

const XHR_CHANNEL = "openTamper:gmXhr";
const SLACK_CHANNEL = "openTamper:gmSlackUserId";

function relayToBackground(channel, event) {
  const { id, type, scriptId } = event.data;

  if (type !== "request") return;

  const payload = { type: channel, id, scriptId };

  if (channel === XHR_CHANNEL) {
    payload.details = event.data.details;
  } else if (channel === SLACK_CHANNEL) {
    payload.org = event.data.org;
  }

  (async () => {
    try {
      const response = await chrome.runtime.sendMessage(payload);

      if (response === undefined) {
        window.postMessage(
          { channel, id, type: "error", error: "No response from service worker" },
          "*"
        );
        return;
      }

      window.postMessage({ channel, id, type: "response", response }, "*");
    } catch (error) {
      window.postMessage(
        { channel, id, type: "error", error: error.message || String(error) },
        "*"
      );
    }
  })();
}

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data) return;

  const { channel } = event.data;
  if (channel === XHR_CHANNEL || channel === SLACK_CHANNEL) {
    relayToBackground(channel, event);
  }
});

window.postMessage({ channel: XHR_CHANNEL, type: "bridge-ready" }, "*");
window.postMessage({ channel: SLACK_CHANNEL, type: "bridge-ready" }, "*");
