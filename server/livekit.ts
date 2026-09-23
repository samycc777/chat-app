import { RoomServiceClient } from 'livekit-server-sdk';

// Read on every use so that credentials can be added to a running deployment's environment.
export function liveKitConfig() {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  return url && apiKey && apiSecret ? { url, apiKey, apiSecret } : null;
}

export function roomService(): RoomServiceClient | null {
  const config = liveKitConfig();
  return config ? new RoomServiceClient(config.url, config.apiKey, config.apiSecret) : null;
}
