import { WhatsappMessage } from "@/lib/whatsapp";

export type MediaKind = "image" | "video" | "audio" | "document" | "unknown";

const IMAGE_TYPES = new Set(["image", "photo", "sticker"]);
const VIDEO_TYPES = new Set(["video"]);
const AUDIO_TYPES = new Set(["audio", "voice", "ptt", "voice_note", "audio_message"]);
const DOCUMENT_TYPES = new Set(["document", "file", "doc"]);

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "3gp", "avi"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "ogg", "oga", "wav", "m4a", "opus", "aac"]);
const DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "csv",
  "txt",
  "zip",
  "rtf",
]);

function getExtension(url: string): string {
  try {
    const path = new URL(url).pathname;
    const segment = path.split("/").pop() ?? "";
    const dot = segment.lastIndexOf(".");
    return dot === -1 ? "" : segment.slice(dot + 1).toLowerCase();
  } catch {
    // Not a parseable absolute URL — fall back to a plain string split.
    const segment = url.split("?")[0].split("/").pop() ?? "";
    const dot = segment.lastIndexOf(".");
    return dot === -1 ? "" : segment.slice(dot + 1).toLowerCase();
  }
}

/** Returns null when the message carries no media at all. */
export function classifyMedia(message: Pick<WhatsappMessage, "media_url" | "message_type">): MediaKind | null {
  if (!message.media_url) return null;

  const type = (message.message_type ?? "").toLowerCase();
  if (IMAGE_TYPES.has(type)) return "image";
  if (VIDEO_TYPES.has(type)) return "video";
  if (AUDIO_TYPES.has(type)) return "audio";
  if (DOCUMENT_TYPES.has(type)) return "document";

  // message_type was missing/unrecognised — infer from the URL extension
  // rather than dropping straight to "unknown".
  const ext = getExtension(message.media_url);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";

  return "unknown";
}

export function isVoiceNote(message: Pick<WhatsappMessage, "message_type">): boolean {
  const type = (message.message_type ?? "").toLowerCase();
  return type === "ptt" || type === "voice" || type === "voice_note";
}

/** Short label for previews (conversation list, notifications) where there's no room for a full attachment card. */
export function mediaPreviewLabel(message: Pick<WhatsappMessage, "message_type">, kind: MediaKind): string {
  switch (kind) {
    case "image":
      return "📷 Image";
    case "video":
      return "🎥 Video";
    case "audio":
      return isVoiceNote(message) ? "🎤 Voice Note" : "🎧 Audio message";
    case "document":
      return "📄 Document";
    default:
      return "📎 Attachment";
  }
}

export function getFileName(url: string): string {
  try {
    const path = new URL(url).pathname;
    const segment = decodeURIComponent(path.split("/").pop() ?? "");
    return segment || "Attachment";
  } catch {
    const segment = decodeURIComponent(url.split("?")[0].split("/").pop() ?? "");
    return segment || "Attachment";
  }
}
