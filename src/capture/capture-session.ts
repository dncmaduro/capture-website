import {
  MAX_SCREENSHOTS,
  type CaptureSessionInfo,
  type MessageResponse,
} from "./types.js";
import {
  sendToOffscreen,
} from "./offscreen-client.js";

interface ActiveSession extends CaptureSessionInfo {
  screenshotCount: number;
  invalidated: boolean;
  invalidationReason?: string;
}

const SESSION_STORAGE_PREFIX = "viewport-capture.session.";

export class SessionInvalidatedError extends Error {
  readonly code = "SESSION_INVALIDATED";

  constructor(message: string) {
    super(message);
    this.name = "SessionInvalidatedError";
  }
}

function createToken(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function getHostname(url: string | undefined): string {
  try {
    const hostname = new URL(url ?? "").hostname;
    return (
      hostname
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "page"
    );
  } catch {
    return "page";
  }
}

async function getVisibleCaptureTab(session: ActiveSession): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(session.tabId);
  } catch {
    throw new SessionInvalidatedError("The capture tab is no longer available.");
  }

  let focusedWindow: chrome.windows.Window;
  try {
    focusedWindow = await chrome.windows.getLastFocused();
  } catch {
    throw new SessionInvalidatedError("The capture window could not be verified.");
  }

  if (
    !tab.active ||
    tab.windowId !== session.windowId ||
    focusedWindow.id !== session.windowId
  ) {
    throw new SessionInvalidatedError(
      "You left the capture tab while capture was in progress.",
    );
  }

  if (
    session.captureStartUrl &&
    tab.url &&
    session.captureStartUrl !== tab.url
  ) {
    throw new SessionInvalidatedError("The page URL changed during capture.");
  }

  return tab;
}

export class CaptureSessionCoordinator {
  private readonly sessions = new Map<number, ActiveSession>();

  async begin(tab: chrome.tabs.Tab): Promise<CaptureSessionInfo> {
    if (typeof tab.id !== "number") {
      throw new Error("The selected tab has no usable ID.");
    }
    if (typeof tab.windowId !== "number") {
      throw new Error("The selected tab has no usable window ID.");
    }
    if (this.sessions.has(tab.id)) {
      throw new Error("A capture is already running in this tab.");
    }

    if (await this.readStoredSession(tab.id)) {
      throw new Error("A capture is already running in this tab.");
    }

    const session: ActiveSession = {
      token: createToken(),
      tabId: tab.id,
      windowId: tab.windowId,
      hostname: getHostname(tab.url),
      captureStartUrl: tab.url,
      screenshotCount: 0,
      invalidated: false,
    };
    this.sessions.set(tab.id, session);
    try {
      await this.writeStoredSession(session);
    } catch (error) {
      this.sessions.delete(tab.id);
      throw new Error(
        `Could not persist the capture session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return session;
  }

  async startOffscreen(session: CaptureSessionInfo): Promise<void> {
    const active = await this.getSession(session.tabId, session.token);
    await sendToOffscreen({
      type: "offscreen-start",
      token: active.token,
      hostname: active.hostname,
    });
  }

  async captureVisible(tabId: number, token: string): Promise<MessageResponse> {
    const session = await this.getSession(tabId, token);
    if (session.screenshotCount >= MAX_SCREENSHOTS) {
      throw new Error(`The ${MAX_SCREENSHOTS}-screenshot safety limit was reached.`);
    }

    if (session.invalidated) {
      throw new SessionInvalidatedError(
        session.invalidationReason ?? "The capture session was invalidated.",
      );
    }

    await getVisibleCaptureTab(session);

    let dataUrl: string;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(session.windowId, {
        format: "png",
      });
    } catch (error) {
      throw new Error(
        `Could not capture the visible tab: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error("Chrome returned an unexpected screenshot format.");
    }

    await sendToOffscreen({
      type: "offscreen-append",
      token: session.token,
      dataUrl,
    });
    session.screenshotCount += 1;
    await this.writeStoredSession(session);

    return { ok: true, count: session.screenshotCount };
  }

  async finish(tabId: number, token: string): Promise<MessageResponse> {
    const session = await this.getSession(tabId, token);
    if (session.invalidated) {
      throw new SessionInvalidatedError(
        session.invalidationReason ?? "The capture session was invalidated.",
      );
    }
    await getVisibleCaptureTab(session);

    try {
      const response = await sendToOffscreen({
        type: "offscreen-finish",
        token: session.token,
      });
      if (!response.blobUrl || !response.filename) {
        throw new Error("The offscreen document did not return a ZIP Blob URL.");
      }

      try {
        const downloadId = await chrome.downloads.download({
          url: response.blobUrl,
          filename: response.filename,
          conflictAction: "uniquify",
          saveAs: false,
        });
        return {
          ...response,
          count: session.screenshotCount,
          downloadId,
        };
      } finally {
        await sendToOffscreen({
          type: "offscreen-release",
          token: session.token,
        }).catch((error) => {
          console.error("Viewport Capture Blob URL cleanup failed.", error);
        });
      }
    } finally {
      this.sessions.delete(tabId);
      await this.removeStoredSession(tabId).catch((error) => {
        console.error("Viewport Capture session cleanup failed.", error);
      });
    }
  }

  async abort(tabId: number, token: string, reason?: string): Promise<void> {
    const session = this.sessions.get(tabId) ?? (await this.readStoredSession(tabId));
    if (!session || session.token !== token) {
      return;
    }

    this.sessions.delete(tabId);
    await this.removeStoredSession(tabId).catch((error) => {
      console.error("Viewport Capture session cleanup failed.", error);
    });
    try {
      await sendToOffscreen({
        type: "offscreen-abort",
        token: session.token,
      });
    } catch (error) {
      console.error("Viewport Capture cleanup failed.", reason, error);
    }
  }

  async abortTab(tabId: number, reason: string): Promise<void> {
    const session = this.sessions.get(tabId) ?? (await this.readStoredSession(tabId));
    if (session) {
      await this.abort(tabId, session.token, reason);
    }
  }

  async restart(tabId: number, token: string): Promise<CaptureSessionInfo> {
    const previous = await this.getSession(tabId, token);
    if (!previous.invalidated) {
      throw new Error("This capture session has not been invalidated.");
    }

    await getVisibleCaptureTab({ ...previous, invalidated: false });
    await sendToOffscreen({
      type: "offscreen-abort",
      token: previous.token,
    });

    const replacement: ActiveSession = {
      ...previous,
      token: createToken(),
      screenshotCount: 0,
      invalidated: false,
      invalidationReason: undefined,
    };
    this.sessions.set(tabId, replacement);
    try {
      await this.writeStoredSession(replacement);
      await sendToOffscreen({
        type: "offscreen-start",
        token: replacement.token,
        hostname: replacement.hostname,
      });
    } catch (error) {
      this.sessions.delete(tabId);
      await this.removeStoredSession(tabId).catch(() => undefined);
      throw error;
    }

    return replacement;
  }

  async invalidate(tabId: number, reason: string): Promise<boolean> {
    const session = await this.getSessionByTab(tabId);
    if (!session) {
      return false;
    }

    session.invalidated = true;
    session.invalidationReason = reason;
    this.sessions.set(tabId, session);
    await this.writeStoredSession(session);
    await this.sendInvalidatedNotification(session, reason);
    return true;
  }

  async notifyInvalidated(tabId: number): Promise<void> {
    const session = await this.getSessionByTab(tabId);
    if (session?.invalidated) {
      await this.notifyInvalidatedSession(session);
    }
  }

  async inspectSessionVisibility(
    tabId: number,
  ): Promise<{ visible: boolean; reason?: string } | undefined> {
    const session = await this.getSessionByTab(tabId);
    if (!session) {
      return undefined;
    }
    if (session.invalidated) {
      return { visible: false, reason: session.invalidationReason };
    }

    try {
      await getVisibleCaptureTab(session);
      return { visible: true };
    } catch (error) {
      if (error instanceof SessionInvalidatedError) {
        return { visible: false, reason: error.message };
      }
      throw error;
    }
  }

  async getActiveTabIds(): Promise<number[]> {
    const keys = await chrome.storage.session.get(null);
    const tabIds = new Set<number>(this.sessions.keys());
    for (const key of Object.keys(keys)) {
      if (!key.startsWith(SESSION_STORAGE_PREFIX)) {
        continue;
      }
      const tabId = Number(key.slice(SESSION_STORAGE_PREFIX.length));
      if (Number.isInteger(tabId)) {
        tabIds.add(tabId);
      }
    }
    return [...tabIds];
  }

  async invalidateAll(reason: string): Promise<void> {
    for (const tabId of await this.getActiveTabIds()) {
      await this.invalidate(tabId, reason);
    }
  }

  private async getSession(tabId: number, token: string): Promise<ActiveSession> {
    const session = await this.getSessionByTab(tabId);
    if (!session || session.token !== token) {
      throw new Error("The capture session is no longer active.");
    }
    this.sessions.set(tabId, session);
    return session;
  }

  private async getSessionByTab(tabId: number): Promise<ActiveSession | undefined> {
    const session = this.sessions.get(tabId) ?? (await this.readStoredSession(tabId));
    if (session) {
      this.sessions.set(tabId, session);
    }
    return session;
  }

  private async sendInvalidatedNotification(
    session: ActiveSession,
    reason: string,
  ): Promise<void> {
    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: "session-invalidated",
        reason,
      });
    } catch {
      // The content script may already have been destroyed by navigation.
    }
  }

  private async notifyInvalidatedSession(session: ActiveSession): Promise<void> {
    await this.sendInvalidatedNotification(
      session,
      session.invalidationReason ?? "The capture tab is no longer active.",
    );
  }

  private async readStoredSession(tabId: number): Promise<ActiveSession | undefined> {
    const key = storageKey(tabId);
    const result = await chrome.storage.session.get(key);
    const session = result[key] as ActiveSession | undefined;
    if (
      !session ||
      session.tabId !== tabId ||
      typeof session.invalidated !== "boolean"
    ) {
      return undefined;
    }
    return session;
  }

  private async writeStoredSession(session: ActiveSession): Promise<void> {
    await chrome.storage.session.set({
      [storageKey(session.tabId)]: session,
    });
  }

  private async removeStoredSession(tabId: number): Promise<void> {
    await chrome.storage.session.remove(storageKey(tabId));
  }
}

function storageKey(tabId: number): string {
  return `${SESSION_STORAGE_PREFIX}${tabId}`;
}
