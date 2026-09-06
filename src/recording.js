// Small, browser-only helpers for the AR recording state machine.
// Keeping codec selection and file handling here makes the XR/render loop
// responsible only for producing frames.

export const RECORDING_FPS = 30;
export const MAX_RECORDING_MS = 60_000;

// MP4 is the user-facing format. Keep the codec list conservative because
// Android devices can expose different H.264 profiles to MediaRecorder.
export const RECORDING_MIME_TYPES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1",
  "video/mp4",
];

export function supportedRecordingMimeTypes(MediaRecorderCtor = globalThis.MediaRecorder) {
  if (typeof MediaRecorderCtor !== "function") return [];
  if (typeof MediaRecorderCtor.isTypeSupported !== "function") {
    return ["video/mp4"];
  }
  return RECORDING_MIME_TYPES.filter((type) => {
    try {
      return MediaRecorderCtor.isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

// MediaRecorder implementations occasionally report a codec as supported but
// reject it in the constructor. Try each advertised MP4 format before giving
// up; silently falling back to WebM would produce the wrong file type.
export function createMediaRecorder(
  stream,
  MediaRecorderCtor = globalThis.MediaRecorder,
) {
  if (typeof MediaRecorderCtor !== "function") {
    throw new Error("MediaRecorder is unavailable");
  }

  const candidates = supportedRecordingMimeTypes(MediaRecorderCtor);
  let lastError = null;
  for (const mimeType of candidates) {
    try {
      const recorder = mimeType
        ? new MediaRecorderCtor(stream, { mimeType })
        : new MediaRecorderCtor(stream);
      return { recorder, mimeType: recorder.mimeType || mimeType || "video/mp4" };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("No MP4 MediaRecorder format is available");
}

export function formatRecordingDuration(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function recordingFileName(date = new Date()) {
  return [
    "microduck-ar",
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join("-") + ".mp4";
}

export function downloadRecording(
  chunks,
  { filename = recordingFileName(), mimeType = "video/mp4", documentRef = globalThis.document } = {},
) {
  const blob = new Blob(chunks, { type: mimeType });
  if (!blob.size || !documentRef?.body) return false;

  const url = URL.createObjectURL(blob);
  const link = documentRef.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
