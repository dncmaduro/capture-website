import { createZip, type ZipEntry } from "./zip/create-zip.js";
import type {
  MessageResponse,
  OffscreenAbortMessage,
  OffscreenAppendMessage,
  OffscreenFinishMessage,
  OffscreenReleaseMessage,
  OffscreenStartMessage,
} from "./capture/types.js";

interface OffscreenSession {
  hostname: string;
  images: Uint8Array[];
}

const sessions = new Map<string, OffscreenSession>();
const objectUrls = new Map<string, string>();

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || !("type" in message)) {
    return undefined;
  }

  const type = (message as { type?: string }).type;
  if (type === "offscreen-start") {
    void handleStart(message as OffscreenStartMessage, sendResponse);
    return true;
  }
  if (type === "offscreen-append") {
    void handleAppend(message as OffscreenAppendMessage, sendResponse);
    return true;
  }
  if (type === "offscreen-finish") {
    void handleFinish(message as OffscreenFinishMessage, sendResponse);
    return true;
  }
  if (type === "offscreen-release") {
    handleRelease(message as OffscreenReleaseMessage, sendResponse);
    return true;
  }
  if (type === "offscreen-abort") {
    void handleAbort(message as OffscreenAbortMessage, sendResponse);
    return true;
  }

  return undefined;
});

function handleStart(
  message: OffscreenStartMessage,
  sendResponse: (response: MessageResponse) => void,
): void {
  sessions.set(message.token, { hostname: message.hostname, images: [] });
  sendResponse({ ok: true });
}

function handleAppend(
  message: OffscreenAppendMessage,
  sendResponse: (response: MessageResponse) => void,
): void {
  try {
    const session = sessions.get(message.token);
    if (!session) {
      throw new Error("The offscreen capture session is missing.");
    }
    session.images.push(dataUrlToBytes(message.dataUrl));
    sendResponse({ ok: true, count: session.images.length });
  } catch (error) {
    sendResponse(errorResponse(error));
  }
}

async function handleFinish(
  message: OffscreenFinishMessage,
  sendResponse: (response: MessageResponse) => void,
): Promise<void> {
  const session = sessions.get(message.token);
  if (!session) {
    sendResponse({ ok: false, error: "The offscreen capture session is missing." });
    return;
  }

  try {
    if (session.images.length === 0) {
      throw new Error("No screenshots were captured.");
    }

    const padding = Math.max(3, String(session.images.length).length);
    const entries: ZipEntry[] = session.images.map((data, index) => ({
      name: String(index + 1).padStart(padding, "0") + ".png",
      data,
    }));
    const zipBytes = createZip(entries);
    const zipBuffer = new ArrayBuffer(zipBytes.byteLength);
    new Uint8Array(zipBuffer).set(zipBytes);
    const blob = new Blob([zipBuffer], { type: "application/zip" });
    const objectUrl = URL.createObjectURL(blob);
    const filename = `${session.hostname}-capture.zip`;
    objectUrls.set(message.token, objectUrl);
    window.setTimeout(() => releaseObjectUrl(message.token), 5 * 60_000);
    sendResponse({
      ok: true,
      count: session.images.length,
      filename,
      blobUrl: objectUrl,
    });
  } catch (error) {
    sendResponse(errorResponse(error));
  } finally {
    sessions.delete(message.token);
  }
}

function handleRelease(
  message: OffscreenReleaseMessage,
  sendResponse: (response: MessageResponse) => void,
): void {
  // Let chrome.downloads finish opening the Blob URL before revoking it.
  window.setTimeout(() => releaseObjectUrl(message.token), 30_000);
  sendResponse({ ok: true });
}

function handleAbort(
  message: OffscreenAbortMessage,
  sendResponse: (response: MessageResponse) => void,
): void {
  sessions.delete(message.token);
  releaseObjectUrl(message.token);
  sendResponse({ ok: true });
}

function releaseObjectUrl(token: string): void {
  const objectUrl = objectUrls.get(token);
  if (!objectUrl) {
    return;
  }
  URL.revokeObjectURL(objectUrl);
  objectUrls.delete(token);
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) {
    throw new Error("Only PNG data URLs can be added to the ZIP.");
  }

  const binary = atob(dataUrl.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function errorResponse(error: unknown): MessageResponse {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
