import { io, Socket } from 'socket.io-client';
import { API_URL } from './api';

let socket: Socket | null = null;

// One connection serves the whole page. socket.io reconnects it on its own after a network drop,
// so a disconnected socket is reused rather than replaced, keeping every listener attached.
export function connectSocket(token: string): Socket {
  if (socket) return socket;

  const opts = {
    auth: { token },
    transports: ['websocket', 'polling'],
    // Some school networks block WebSockets; fall back to HTTP polling instead of never connecting.
    tryAllTransports: true,
  };

  socket = API_URL ? io(API_URL, opts) : io(opts);

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
