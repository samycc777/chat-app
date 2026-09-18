import { io, Socket } from 'socket.io-client';
import { API_URL } from './api';

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  if (socket?.connected) return socket;

  socket = io(API_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
  });

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
