chrome.runtime.onInstalled.addListener(() => {
  console.log("Audio Splitter & Mixer Pro installed.");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ ok: true, source: "background" });
    return true;
  }

  if (message?.type === "ENSURE_OFFSCREEN") {
    (async () => {
      try {
        if (!chrome.offscreen?.createDocument) {
          sendResponse({ ok: false, error: "offscreen API unavailable" });
          return;
        }

        const offscreenUrl = chrome.runtime.getURL("offscreen/offscreen.html");
        const existingContexts = await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [offscreenUrl]
        });

        if (existingContexts.length > 0) {
          sendResponse({ ok: true, created: false });
          return;
        }

        await chrome.offscreen.createDocument({
          url: offscreenUrl,
          reasons: ["AUDIO_PLAYBACK"],
          justification: "Chunked audio download handling"
        });
        sendResponse({ ok: true, created: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  if (message?.type === "EMERGENCY_UNMUTE_SWEEP") {
    (async () => {
      try {
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs || []) {
          if (!tab.id) continue;

          if (tab.mutedInfo?.muted && tab.mutedInfo?.reason === "extension" &&
              tab.mutedInfo?.extensionId === chrome.runtime.id) {
            chrome.tabs.update(tab.id, { muted: false }, () => { void chrome.runtime.lastError; });
          }

          chrome.tabs.sendMessage(tab.id, { type: "UNMUTE_ORIGINAL_MEDIA" }, () => {
            void chrome.runtime.lastError;
          });
        }
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  // Download a file via the background service worker.
  if (message?.type === "DOWNLOAD_URL") {
    const { url, filename } = message;
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      void chrome.runtime.lastError;
      sendResponse({ ok: true, downloadId: downloadId ?? null });
    });
    return true; // keep channel open for async sendResponse
  }

  return false;
});
