import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@shared/types';

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  path: '/socket.io',
  transports: ['websocket', 'polling'],
});

const debugSocket =
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  window.localStorage.getItem('debug-socket') === '1';

if (debugSocket) {
  socket.onAny((event, ...args) => {
    if (event === 'pty:data' || event === 'agent:output') return;
    console.log(`[socket] ${event}`, ...args);
  });

  socket.on('connect', () => console.log('[socket] connected'));
  socket.on('disconnect', (reason) => console.log('[socket] disconnected:', reason));
}

export default socket;
