import type {
  MessageResponse,
  OffscreenMessage,
} from "./types.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingDocument: Promise<void> | undefined;

export async function ensureOffscreenDocument(): Promise<void> {
  if (!("offscreen" in chrome)) {
    throw new Error("This Chrome version does not support offscreen documents.");
  }

  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingDocument) {
    creatingDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["BLOBS"],
      justification: "Create a temporary ZIP Blob URL for captured PNG files.",
    });
  }

  try {
    await creatingDocument;
  } finally {
    creatingDocument = undefined;
  }
}

export async function sendToOffscreen(
  message: OffscreenMessage,
): Promise<MessageResponse> {
  const response = await chrome.runtime.sendMessage(message);

  if (!response || response.ok !== true) {
    throw new Error(response?.error ?? "The offscreen document did not respond.");
  }

  return response as MessageResponse;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const runtime = chrome.runtime as typeof chrome.runtime & {
    getContexts?: (
      filter: chrome.runtime.ContextFilter,
    ) => Promise<chrome.runtime.ExtensionContext[]>;
  };

  if (typeof runtime.getContexts === "function") {
    const contexts = await runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
    });
    return contexts.length > 0;
  }

  const serviceWorkerScope = globalThis as typeof globalThis & {
    clients?: {
      matchAll(options?: { includeUncontrolled?: boolean }): Promise<Array<{ url: string }>>;
    };
  };
  if (!serviceWorkerScope.clients) {
    return false;
  }

  const clients = await serviceWorkerScope.clients.matchAll({ includeUncontrolled: true });
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  return clients.some((client) => client.url === offscreenUrl);
}
