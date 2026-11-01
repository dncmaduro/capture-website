interface MessageResponse {
  ok: boolean;
  error?: string;
  count?: number;
  filename?: string;
  downloadId?: number;
  code?: string;
  token?: string;
}

interface StartCaptureMessage {
  type: "start-capture";
  token: string;
}

interface SessionInvalidatedMessage {
  type: "session-invalidated";
  reason: string;
}

interface ContentMessage {
  type: "capture-visible" | "finish-capture" | "abort-capture" | "restart-capture";
  token: string;
  reason?: string;
}

interface ContentRuntimeState {
  captureIsRunning: boolean;
  sessionInvalidated: boolean;
  invalidationReason: string;
  stopRequested: boolean;
  interruptWaiters: Set<() => void>;
}

interface CaptureOverlay {
  setCapturing(count: number): void;
  setWaiting(count: number): void;
  setStopping(count: number): void;
  setPaused(reason: string, onRestart: () => void, onStop: () => void): void;
  setVisualHidden(hidden: boolean): void;
  remove(): void;
}

interface RecoveryDecision {
  action: "restart" | "stop";
  token?: string;
}

(() => {
  const MAX_SCREENSHOTS = 200;
  const MIN_CAPTURE_INTERVAL_MS = 550;
  const MIN_SETTLE_DELAY_MS = 650;
  const DOM_STABLE_DELAY_MS = 400;
  const MAX_VIEWPORT_WAIT_MS = 4500;
  const IMAGE_NEAR_VIEWPORT_PX = 160;
  const SCROLL_WAIT_TIMEOUT_MS = 1500;
  const scrollKeys = new Set([
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " ",
    "Spacebar",
  ]);

  const globalScope = globalThis as typeof globalThis & {
    __viewportCaptureContentState__?: ContentRuntimeState;
    __viewportCaptureContentInstalled__?: boolean;
  };
  const state = (globalScope.__viewportCaptureContentState__ ??= {
    captureIsRunning: false,
    sessionInvalidated: false,
    invalidationReason: "",
    stopRequested: false,
    interruptWaiters: new Set<() => void>(),
  });

  if (!globalScope.__viewportCaptureContentInstalled__) {
    globalScope.__viewportCaptureContentInstalled__ = true;
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!message || typeof message !== "object" || !("type" in message)) {
        return undefined;
      }

      const type = (message as { type?: string }).type;
      if (type === "session-invalidated") {
        markSessionInvalidated((message as SessionInvalidatedMessage).reason);
        return undefined;
      }

      if (type !== "start-capture") {
        return undefined;
      }

      if (state.captureIsRunning) {
        sendResponse({ ok: false, error: "A capture is already running on this page." });
        return undefined;
      }

      const startMessage = message as StartCaptureMessage;
      state.captureIsRunning = true;
      state.sessionInvalidated = false;
      state.invalidationReason = "";
      state.stopRequested = false;
      sendResponse({ ok: true });
      void runCapture(startMessage.token).finally(() => {
        state.captureIsRunning = false;
      });
      return undefined;
    });
  }

  async function runCapture(initialToken: string): Promise<void> {
    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;
    const scrollBehavior = rememberScrollBehavior();
    const overlay = createCaptureOverlay();
    let currentToken = initialToken;
    let finalized = false;

    try {
      setScrollBehavior("auto");

      while (true) {
        let screenshotCount: number;
        try {
          screenshotCount = await capturePass(currentToken, overlay);
        } catch (error) {
          if (!isSessionInvalidatedError(error)) {
            throw error;
          }
          markSessionInvalidated(error instanceof Error ? error.message : "The capture was paused.");
          const recovery = await waitForRecoveryDecision(currentToken, overlay);
          if (recovery.action === "stop" || !recovery.token) {
            await abortSession(currentToken);
            return;
          }
          currentToken = recovery.token;
          continue;
        }

        if (state.sessionInvalidated) {
          const recovery = await waitForRecoveryDecision(currentToken, overlay);
          if (recovery.action === "stop" || !recovery.token) {
            await abortSession(currentToken);
            return;
          }
          currentToken = recovery.token;
          continue;
        }

        await restoreScrollPosition(originalScrollX, originalScrollY);
        if (screenshotCount === 0) {
          await abortSession(currentToken);
          return;
        }

        const finishResponse = await sendToBackground({
          type: "finish-capture",
          token: currentToken,
        });
        if (isInvalidatedResponse(finishResponse)) {
          markSessionInvalidated(finishResponse.error ?? "The capture was paused.");
          const recovery = await waitForRecoveryDecision(currentToken, overlay);
          if (recovery.action === "stop" || !recovery.token) {
            await abortSession(currentToken);
            return;
          }
          currentToken = recovery.token;
          continue;
        }
        if (!finishResponse.ok) {
          throw new Error(finishResponse.error ?? "ZIP creation failed.");
        }

        finalized = true;
        return;
      }
    } catch (error) {
      await restoreScrollPosition(originalScrollX, originalScrollY);
      if (!finalized) {
        await abortSession(currentToken);
      }
      console.error("Viewport Capture failed.", error);
    } finally {
      restoreScrollBehavior(scrollBehavior);
      overlay.remove();
      state.sessionInvalidated = false;
      state.invalidationReason = "";
      state.stopRequested = false;
      interruptWaiters();
    }
  }

  async function capturePass(token: string, overlay: CaptureOverlay): Promise<number> {
    let screenshotCount = 0;
    let previousScrollY = -1;
    let lastCaptureAt = 0;

    if (!(await scrollToAndPrepare(0, overlay, screenshotCount))) {
      return 0;
    }

    while (screenshotCount < MAX_SCREENSHOTS) {
      throwIfSessionInvalidated();
      if (state.stopRequested) {
        overlay.setStopping(screenshotCount);
        break;
      }

      const currentScrollY = Math.max(0, Math.round(window.scrollY));
      if (currentScrollY === previousScrollY) {
        break;
      }
      previousScrollY = currentScrollY;

      const elapsedSinceLastCapture = performance.now() - lastCaptureAt;
      if (lastCaptureAt > 0 && elapsedSinceLastCapture < MIN_CAPTURE_INTERVAL_MS) {
        await waitInterruptible(MIN_CAPTURE_INTERVAL_MS - elapsedSinceLastCapture);
      }
      throwIfSessionInvalidated();
      if (state.stopRequested) {
        overlay.setStopping(screenshotCount);
        break;
      }

      const screenshotResponse = await captureViewport(token, overlay, screenshotCount);
      if (isInvalidatedResponse(screenshotResponse)) {
        throw new SessionInvalidatedError(
          screenshotResponse.error ?? "The capture tab is no longer active.",
        );
      }
      if (!screenshotResponse.ok) {
        throw new Error(screenshotResponse.error ?? "Screenshot capture failed.");
      }

      lastCaptureAt = performance.now();
      screenshotCount += 1;
      overlay.setCapturing(screenshotCount);

      if (state.stopRequested) {
        overlay.setStopping(screenshotCount);
        break;
      }

      const { maxScrollY, viewportHeight } = getPageState();
      if (currentScrollY >= maxScrollY) {
        break;
      }

      const overlapPx = Math.min(
        180,
        Math.max(100, Math.round(viewportHeight * 0.12)),
      );
      const scrollStep = Math.max(1, viewportHeight - overlapPx);
      const nextScrollY = Math.min(currentScrollY + scrollStep, maxScrollY);
      if (nextScrollY <= currentScrollY) {
        break;
      }

      if (!(await scrollToAndPrepare(nextScrollY, overlay, screenshotCount))) {
        break;
      }
    }

    return screenshotCount;
  }

  async function scrollToAndPrepare(
    targetY: number,
    overlay: CaptureOverlay,
    screenshotCount: number,
  ): Promise<boolean> {
    throwIfSessionInvalidated();
    if (state.stopRequested) {
      overlay.setStopping(screenshotCount);
      return false;
    }

    window.scrollTo(0, Math.max(0, Math.round(targetY)));
    const expectedY = Math.min(
      Math.max(0, Math.round(targetY)),
      getPageState().maxScrollY,
    );
    const startedAt = performance.now();
    while (Math.abs(window.scrollY - expectedY) > 1) {
      throwIfSessionInvalidated();
      if (state.stopRequested) {
        overlay.setStopping(screenshotCount);
        return false;
      }
      if (performance.now() - startedAt >= SCROLL_WAIT_TIMEOUT_MS) {
        break;
      }
      await nextFrame();
    }

    return waitForViewportReady(overlay, screenshotCount);
  }

  async function waitForViewportReady(
    overlay: CaptureOverlay,
    screenshotCount: number,
  ): Promise<boolean> {
    overlay.setWaiting(screenshotCount);
    const deadline = performance.now() + MAX_VIEWPORT_WAIT_MS;

    await nextFrame();
    await nextFrame();
    throwIfSessionInvalidated();
    if (state.stopRequested) {
      overlay.setStopping(screenshotCount);
      return false;
    }

    await waitInterruptible(MIN_SETTLE_DELAY_MS);
    if (!awaitReadyToContinue(screenshotCount, overlay)) {
      return false;
    }

    await waitForVisibleImages(deadline);
    if (!awaitReadyToContinue(screenshotCount, overlay)) {
      return false;
    }

    await waitForDomStability(deadline);
    if (!awaitReadyToContinue(screenshotCount, overlay)) {
      return false;
    }

    return true;
  }

  function awaitReadyToContinue(
    screenshotCount: number,
    overlay: CaptureOverlay,
  ): boolean {
    throwIfSessionInvalidated();
    if (state.stopRequested) {
      overlay.setStopping(screenshotCount);
      return false;
    }
    return true;
  }

  async function waitForVisibleImages(deadline: number): Promise<void> {
    while (performance.now() < deadline) {
      throwIfSessionInvalidated();
      if (state.stopRequested) {
        return;
      }

      const pendingImages = findVisibleImages().filter((image) => !image.complete);
      if (pendingImages.length === 0) {
        return;
      }

      const remaining = Math.max(50, Math.min(800, deadline - performance.now()));
      await Promise.all(pendingImages.map((image) => waitForImage(image, remaining)));
      await waitInterruptible(80);
    }
  }

  function findVisibleImages(): HTMLImageElement[] {
    const viewportTop = -IMAGE_NEAR_VIEWPORT_PX;
    const viewportBottom = window.innerHeight + IMAGE_NEAR_VIEWPORT_PX;
    return Array.from(document.images).filter((image) => {
      const rect = image.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= viewportTop &&
        rect.top <= viewportBottom
      );
    });
  }

  async function waitForImage(image: HTMLImageElement, timeoutMs: number): Promise<void> {
    if (image.complete) {
      if (image.naturalWidth > 0 && typeof image.decode === "function") {
        await image.decode().catch(() => undefined);
      }
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId = 0;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        image.removeEventListener("load", finish);
        image.removeEventListener("error", finish);
        resolve();
      };
      timeoutId = window.setTimeout(finish, timeoutMs);
      image.addEventListener("load", finish, { once: true });
      image.addEventListener("error", finish, { once: true });
      if (typeof image.decode === "function") {
        void image.decode().then(finish).catch(() => undefined);
      }
    });
  }

  async function waitForDomStability(deadline: number): Promise<void> {
    const root = document.documentElement;
    let lastMutationAt = performance.now();
    const observer = new MutationObserver(() => {
      lastMutationAt = performance.now();
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    try {
      while (
        performance.now() < deadline &&
        performance.now() - lastMutationAt < DOM_STABLE_DELAY_MS
      ) {
        throwIfSessionInvalidated();
        if (state.stopRequested) {
          return;
        }
        await waitInterruptible(60);
      }
    } finally {
      observer.disconnect();
    }
  }

  async function captureViewport(
    token: string,
    overlay: CaptureOverlay,
    screenshotCount: number,
  ): Promise<MessageResponse> {
    overlay.setCapturing(screenshotCount);
    overlay.setVisualHidden(true);
    try {
      await nextFrame();
      await nextFrame();
      throwIfSessionInvalidated();
      return await sendToBackground({ type: "capture-visible", token });
    } finally {
      overlay.setVisualHidden(false);
    }
  }

  async function waitForRecoveryDecision(
    token: string,
    overlay: CaptureOverlay,
  ): Promise<RecoveryDecision> {
    return new Promise<RecoveryDecision>((resolve) => {
      let settled = false;
      let restarting = false;

      const onStop = async (): Promise<void> => {
        if (settled) {
          return;
        }
        settled = true;
        state.stopRequested = true;
        interruptWaiters();
        await abortSession(token);
        resolve({ action: "stop" });
      };

      const onRestart = async (): Promise<void> => {
        if (settled || restarting) {
          return;
        }
        restarting = true;
        try {
          const response = await sendToBackground({
            type: "restart-capture",
            token,
          });
          if (!response.ok || !response.token) {
            throw new Error(response.error ?? "Unable to restart capture right now.");
          }
          settled = true;
          state.sessionInvalidated = false;
          state.invalidationReason = "";
          state.stopRequested = false;
          resolve({ action: "restart", token: response.token });
        } catch (error) {
          restarting = false;
          const reason = error instanceof Error
            ? error.message
            : "Unable to restart capture right now.";
          overlay.setPaused(reason, onRestart, onStop);
        }
      };

      overlay.setPaused(
        state.invalidationReason || "You left the capture tab while capture was in progress.",
        onRestart,
        onStop,
      );
    });
  }

  async function abortSession(token: string): Promise<void> {
    await sendToBackground({
      type: "abort-capture",
      token,
      reason: state.stopRequested ? "stopped by user" : "capture failed",
    }).catch(() => undefined);
  }

  function markSessionInvalidated(reason: string): void {
    state.sessionInvalidated = true;
    state.invalidationReason = reason;
    interruptWaiters();
  }

  function throwIfSessionInvalidated(): void {
    if (state.sessionInvalidated) {
      throw new SessionInvalidatedError(
        state.invalidationReason || "The capture session was invalidated.",
      );
    }
  }

  function isSessionInvalidatedError(error: unknown): boolean {
    return error instanceof SessionInvalidatedError || isInvalidatedResponse(error);
  }

  function isInvalidatedResponse(response: unknown): boolean {
    return (
      typeof response === "object" &&
      response !== null &&
      "code" in response &&
      (response as { code?: string }).code === "SESSION_INVALIDATED"
    );
  }

  class SessionInvalidatedError extends Error {
    readonly code = "SESSION_INVALIDATED";
  }

  function interruptWaiters(): void {
    for (const waiter of state.interruptWaiters) {
      waiter();
    }
    state.interruptWaiters.clear();
  }

  function waitInterruptible(milliseconds: number): Promise<void> {
    if (state.sessionInvalidated || state.stopRequested) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeoutId = 0;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        state.interruptWaiters.delete(finish);
        resolve();
      };
      timeoutId = window.setTimeout(finish, milliseconds);
      state.interruptWaiters.add(finish);
    });
  }

  async function sendToBackground(message: ContentMessage): Promise<MessageResponse> {
    const response = (await chrome.runtime.sendMessage(message)) as MessageResponse | undefined;
    if (!response) {
      throw new Error("The extension background worker did not respond.");
    }
    return response;
  }

  function getPageState(): { maxScrollY: number; viewportHeight: number } {
    const viewportHeight = Math.max(1, window.innerHeight);
    const documentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
    );
    return {
      maxScrollY: Math.max(0, documentHeight - viewportHeight),
      viewportHeight,
    };
  }

  function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function restoreScrollPosition(x: number, y: number): Promise<void> {
    window.scrollTo(x, y);
    await nextFrame();
  }

  interface ScrollBehaviorSnapshot {
    htmlValue: string;
    htmlPriority: string;
    bodyValue: string;
    bodyPriority: string;
  }

  function rememberScrollBehavior(): ScrollBehaviorSnapshot {
    const htmlStyle = document.documentElement.style;
    const bodyStyle = document.body?.style;
    return {
      htmlValue: htmlStyle.getPropertyValue("scroll-behavior"),
      htmlPriority: htmlStyle.getPropertyPriority("scroll-behavior"),
      bodyValue: bodyStyle?.getPropertyValue("scroll-behavior") ?? "",
      bodyPriority: bodyStyle?.getPropertyPriority("scroll-behavior") ?? "",
    };
  }

  function setScrollBehavior(value: string): void {
    document.documentElement.style.setProperty("scroll-behavior", value, "important");
    document.body?.style.setProperty("scroll-behavior", value, "important");
  }

  function restoreScrollBehavior(snapshot: ScrollBehaviorSnapshot): void {
    restoreStyleProperty(
      document.documentElement.style,
      "scroll-behavior",
      snapshot.htmlValue,
      snapshot.htmlPriority,
    );
    if (document.body) {
      restoreStyleProperty(
        document.body.style,
        "scroll-behavior",
        snapshot.bodyValue,
        snapshot.bodyPriority,
      );
    }
  }

  function restoreStyleProperty(
    style: CSSStyleDeclaration,
    property: string,
    value: string,
    priority: string,
  ): void {
    style.removeProperty(property);
    if (value) {
      style.setProperty(property, value, priority);
    }
  }

  function createCaptureOverlay(): CaptureOverlay {
    const host = document.createElement("div");
    host.setAttribute("data-viewport-capture-overlay", "true");
    host.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "pointer-events:none",
      "display:block",
    ].join(";");

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483647 !important;
        display: block !important;
        pointer-events: none !important;
      }
      #shield {
        position: fixed;
        inset: 0;
        z-index: 0;
        background: transparent;
        pointer-events: auto;
        cursor: wait;
      }
      #bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 10px;
        box-sizing: border-box;
        min-height: 42px;
        padding: 8px 12px;
        background: #202124;
        color: #fff;
        font: 13px/1.35 Arial, sans-serif;
        pointer-events: auto;
        box-shadow: 0 1px 4px rgba(0, 0, 0, .3);
      }
      #message { flex: 1 1 auto; white-space: pre-line; }
      #count { color: #d7d7d7; white-space: nowrap; }
      button {
        border: 1px solid #9aa0a6;
        border-radius: 3px;
        padding: 4px 10px;
        background: #fff;
        color: #202124;
        font: inherit;
        cursor: pointer;
      }
      button[hidden] { display: none; }
      button:disabled { opacity: .55; cursor: default; }
    `;

    const shield = document.createElement("div");
    shield.id = "shield";
    const bar = document.createElement("div");
    bar.id = "bar";
    const message = document.createElement("span");
    message.id = "message";
    const count = document.createElement("span");
    count.id = "count";
    const restartButton = document.createElement("button");
    restartButton.textContent = "Start over";
    const stopButton = document.createElement("button");
    stopButton.textContent = "Stop";
    restartButton.hidden = true;
    bar.append(message, count, restartButton, stopButton);
    shadow.append(style, shield, bar);
    document.documentElement.appendChild(host);

    const blockPointer = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const shieldEvents = [
      "click",
      "dblclick",
      "dragstart",
      "mousedown",
      "mousemove",
      "mouseup",
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
      "touchstart",
      "touchmove",
      "touchend",
      "wheel",
      "contextmenu",
      "selectstart",
    ];
    for (const eventName of shieldEvents) {
      shield.addEventListener(eventName, blockPointer, { capture: true, passive: false });
    }

    const blockScrollKey = (event: KeyboardEvent): void => {
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        scrollKeys.has(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", blockScrollKey, true);
    document.addEventListener("selectstart", blockPointer, true);

    const setVisualVisible = (visible: boolean): void => {
      bar.style.visibility = visible ? "visible" : "hidden";
      bar.style.opacity = visible ? "1" : "0";
      bar.style.pointerEvents = visible ? "auto" : "none";
    };
    const setCount = (value: number): void => {
      count.textContent = value > 0 ? ` · ${value} images` : "";
    };
    const setButtonState = (
      isPaused: boolean,
      onRestart?: () => void,
      onStop?: () => void,
    ): void => {
      restartButton.hidden = !isPaused;
      stopButton.hidden = false;
      restartButton.disabled = !isPaused;
      stopButton.disabled = false;
      restartButton.onclick = onRestart
        ? (event) => {
            event.stopPropagation();
            onRestart();
          }
        : null;
      stopButton.onclick = onStop
        ? (event) => {
            event.stopPropagation();
            onStop();
          }
        : null;
    };

    return {
      setCapturing(value) {
        setVisualVisible(true);
        message.textContent = "Capturing page…";
        setCount(value);
        setButtonState(false, undefined, () => {
          state.stopRequested = true;
          stopButton.disabled = true;
          message.textContent = "Finishing the current screenshot…";
          interruptWaiters();
        });
      },
      setWaiting(value) {
        setVisualVisible(true);
        message.textContent = "Waiting for content…";
        setCount(value);
        setButtonState(false, undefined, () => {
          state.stopRequested = true;
          stopButton.disabled = true;
          message.textContent = "Finishing the current screenshot…";
          interruptWaiters();
        });
      },
      setStopping(value) {
        setVisualVisible(true);
        message.textContent = "Stopping…";
        setCount(value);
        stopButton.disabled = true;
        restartButton.hidden = true;
      },
      setPaused(reason, onRestart, onStop) {
        setVisualVisible(true);
        message.textContent = reason === "The page URL changed during capture."
          ? "Capture stopped\n\nThe page changed while capture was in progress.\nPlease start a new capture."
          : "Capture paused\n\nYou left this tab while capture was in progress.\n\nTo avoid missing or incorrectly ordered screenshots, the page must be captured again from the beginning.";
        setCount(0);
        setButtonState(true, onRestart, onStop);
      },
      setVisualHidden(hidden) {
        setVisualVisible(!hidden);
      },
      remove() {
        for (const eventName of shieldEvents) {
          shield.removeEventListener(eventName, blockPointer, { capture: true });
        }
        document.removeEventListener("keydown", blockScrollKey, true);
        document.removeEventListener("selectstart", blockPointer, true);
        host.remove();
      },
    };
  }
})();
