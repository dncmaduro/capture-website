import {
  CaptureSessionCoordinator,
  SessionInvalidatedError,
} from "./capture/capture-session.js";
import {
  CAPTURE_MENU_ID,
  type AbortCaptureMessage,
  type CaptureVisibleMessage,
  type FinishCaptureMessage,
  type MessageResponse,
  type RestartCaptureMessage,
  type StartCaptureMessage,
} from "./capture/types.js";
import { ensureOffscreenDocument } from "./capture/offscreen-client.js";

const coordinator = new CaptureSessionCoordinator();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({
      id: CAPTURE_MENU_ID,
      title: "Capture",
      contexts: ["page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CAPTURE_MENU_ID || !tab || typeof tab.id !== "number") {
    return;
  }

  void startCapture(tab);
});

async function startCapture(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.id !== "number") {
    return;
  }

  let sessionToken: string | undefined;
  try {
    const session = await coordinator.begin(tab);
    sessionToken = session.token;

    await ensureOffscreenDocument();
    await coordinator.startOffscreen(session);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    const response = (await chrome.tabs.sendMessage(tab.id, {
      type: "start-capture",
      token: session.token,
    } satisfies StartCaptureMessage)) as MessageResponse | undefined;

    if (!response?.ok) {
      throw new Error(response?.error ?? "The page capture script did not start.");
    }
  } catch (error) {
    if (sessionToken) {
      await coordinator.abort(tab.id, sessionToken, "capture start failed");
    }
    console.error("Viewport Capture could not start.", error);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number" || !message || typeof message !== "object") {
    return undefined;
  }

  const typedMessage = message as {
    type?: string;
    token?: string;
    reason?: string;
  };
  if (!typedMessage.token) {
    return undefined;
  }

  if (typedMessage.type === "capture-visible") {
    void handleCaptureVisible(
      tabId,
      typedMessage as CaptureVisibleMessage,
      sendResponse,
    );
    return true;
  }

  if (typedMessage.type === "finish-capture") {
    void handleFinish(tabId, typedMessage as FinishCaptureMessage, sendResponse);
    return true;
  }

  if (typedMessage.type === "abort-capture") {
    void handleAbort(tabId, typedMessage as AbortCaptureMessage, sendResponse);
    return true;
  }

  if (typedMessage.type === "restart-capture") {
    void handleRestart(tabId, typedMessage as RestartCaptureMessage, sendResponse);
    return true;
  }

  return undefined;
});

async function handleCaptureVisible(
  tabId: number,
  message: CaptureVisibleMessage,
  sendResponse: (response: MessageResponse) => void,
): Promise<void> {
  try {
    sendResponse(await coordinator.captureVisible(tabId, message.token));
  } catch (error) {
    if (error instanceof SessionInvalidatedError) {
      await coordinator.invalidate(tabId, error.message);
      sendResponse({ ok: false, code: error.code, error: error.message });
      return;
    }
    const response = errorResponse(error);
    sendResponse(response);
    await coordinator.abort(tabId, message.token, response.error);
  }
}

async function handleFinish(
  tabId: number,
  message: FinishCaptureMessage,
  sendResponse: (response: MessageResponse) => void,
): Promise<void> {
  try {
    sendResponse(await coordinator.finish(tabId, message.token));
  } catch (error) {
    if (error instanceof SessionInvalidatedError) {
      await coordinator.invalidate(tabId, error.message);
      sendResponse({ ok: false, code: error.code, error: error.message });
      return;
    }
    sendResponse(errorResponse(error));
    await coordinator.abort(tabId, message.token, "finish failed");
  }
}

async function handleAbort(
  tabId: number,
  message: AbortCaptureMessage,
  sendResponse: (response: MessageResponse) => void,
): Promise<void> {
  await coordinator.abort(tabId, message.token, message.reason);
  sendResponse({ ok: true });
}

async function handleRestart(
  tabId: number,
  message: RestartCaptureMessage,
  sendResponse: (response: MessageResponse) => void,
): Promise<void> {
  try {
    const session = await coordinator.restart(tabId, message.token);
    sendResponse({ ok: true, token: session.token });
  } catch (error) {
    sendResponse(errorResponse(error));
  }
}

function errorResponse(error: unknown): MessageResponse {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void coordinator.abortTab(tabId, "tab closed");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
    void coordinator.abortTab(tabId, "navigation started");
  }
});

chrome.tabs.onActivated.addListener(() => {
  void inspectCaptureVisibility();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    void coordinator.invalidateAll("The capture window is no longer focused.");
    return;
  }
  void inspectCaptureVisibility();
});

async function inspectCaptureVisibility(): Promise<void> {
  for (const tabId of await coordinator.getActiveTabIds()) {
    try {
      const visibility = await coordinator.inspectSessionVisibility(tabId);
      if (!visibility) {
        continue;
      }
      if (!visibility.visible) {
        await coordinator.invalidate(
          tabId,
          visibility.reason ?? "The capture tab is no longer active.",
        );
      } else {
        await coordinator.notifyInvalidated(tabId);
      }
    } catch (error) {
      console.error("Viewport Capture visibility check failed.", error);
    }
  }
}
