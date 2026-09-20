import { api } from './api';

const pendingCandidates = new WeakMap<RTCPeerConnection, RTCIceCandidateInit[]>();

export async function createPeerConnection(): Promise<RTCPeerConnection> {
  return new RTCPeerConnection(await api.getIceConfiguration());
}

export async function addRemoteIceCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInit) {
  if (!pc.remoteDescription) {
    const queue = pendingCandidates.get(pc) || [];
    if (queue.length < 128) queue.push(candidate);
    pendingCandidates.set(pc, queue);
    return;
  }
  await pc.addIceCandidate(new RTCIceCandidate(candidate));
}

export async function setRemoteDescription(pc: RTCPeerConnection, description: RTCSessionDescriptionInit) {
  await pc.setRemoteDescription(new RTCSessionDescription(description));
  for (const candidate of pendingCandidates.get(pc) || []) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
  pendingCandidates.delete(pc);
}
