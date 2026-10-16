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

// Takes someone out of a call's sound and video on LiveKit's side. They have often left already
// (the app hangs up by itself), which LiveKit answers with "not found"; anything else is logged,
// because it means someone the server let go may still be in the call.
export async function removeFromLiveKit(roomName: string, identity: string, why: string) {
  const service = roomService();
  if (!service) return;
  try {
    await service.removeParticipant(roomName, identity);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return;
    console.error(`Could not remove ${identity} from ${roomName} (${why}):`, error);
  }
}

// Ends a call on LiveKit's side for everyone in it at once, sound, video and shared screens alike,
// for a room whose people should no longer be there (its key changed, or it was deleted).
export async function endLiveKitRoom(roomName: string, why: string) {
  const service = roomService();
  if (!service) return;
  try {
    await service.deleteRoom(roomName);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return;
    console.error(`Could not end ${roomName} (${why}):`, error);
  }
}
