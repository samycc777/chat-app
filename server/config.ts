export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const configuredMaxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES);
export const MAX_UPLOAD_BYTES = Number.isSafeInteger(configuredMaxUploadBytes) && configuredMaxUploadBytes > 0
  ? configuredMaxUploadBytes
  : DEFAULT_MAX_UPLOAD_BYTES;
