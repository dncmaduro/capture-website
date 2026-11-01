export const CAPTURE_MENU_ID = "viewport-capture";

export const MAX_SCREENSHOTS = 200;

export interface CaptureSessionInfo {
  token: string;
  tabId: number;
  windowId: number;
  hostname: string;
  captureStartUrl?: string;
}

export interface StartCaptureMessage {
  type: "start-capture";
  token: string;
}

export interface CaptureVisibleMessage {
  type: "capture-visible";
  token: string;
}

export interface FinishCaptureMessage {
  type: "finish-capture";
  token: string;
}

export interface AbortCaptureMessage {
  type: "abort-capture";
  token: string;
  reason?: string;
}

export interface RestartCaptureMessage {
  type: "restart-capture";
  token: string;
}

export interface SessionInvalidatedMessage {
  type: "session-invalidated";
  reason: string;
}

export interface OffscreenStartMessage {
  type: "offscreen-start";
  token: string;
  hostname: string;
}

export interface OffscreenAppendMessage {
  type: "offscreen-append";
  token: string;
  dataUrl: string;
}

export interface OffscreenFinishMessage {
  type: "offscreen-finish";
  token: string;
}

export interface OffscreenReleaseMessage {
  type: "offscreen-release";
  token: string;
}

export interface OffscreenAbortMessage {
  type: "offscreen-abort";
  token: string;
}

export type ContentMessage =
  | CaptureVisibleMessage
  | FinishCaptureMessage
  | AbortCaptureMessage
  | RestartCaptureMessage;

export type OffscreenMessage =
  | OffscreenStartMessage
  | OffscreenAppendMessage
  | OffscreenFinishMessage
  | OffscreenReleaseMessage
  | OffscreenAbortMessage;

export interface MessageResponse {
  ok: boolean;
  error?: string;
  count?: number;
  filename?: string;
  downloadId?: number;
  blobUrl?: string;
  code?: string;
  token?: string;
}
