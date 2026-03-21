import './src/utils/logger.js';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import jwt from 'jsonwebtoken';
import https from 'https';
import { db, initDb } from './src/server/db.js';
import { setupSocket, activeCalls } from './src/server/socket.js';
import authRoutes from './src/server/routes/auth.js';
import adminRoutes from './src/server/routes/admin.js';
import friendRoutes from './src/server/routes/friends.js';
import supportRoutes from './src/server/routes/support.js';

dotenv.config();

const PORT = 3000;
const SECRET_TOKEN = process.env.RELAY_TOKEN || 'super-secret-anti-dpi-token-2026';

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  
  // Initialize DB
  await initDb();

  // Setup Socket.io
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });
  setupSocket(io);

  // Setup Secure WebSocket Relay (Anti-DPI)
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const rooms = new Map<string, Set<WebSocket>>();

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    
    if (url.pathname.startsWith('/secure-relay')) {
      const token = url.searchParams.get('token');
      const roomId = url.searchParams.get('room');
      
      const roomConf = roomId ? activeCalls.get(roomId) : undefined;
      
      if (roomConf && roomConf.token === token) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        console.warn(`Unauthorized relay connection attempt for room: ${roomId}`);
        socket.destroy();
      }
    }
    // If it's not /secure-relay, we do nothing and let socket.io handle its own upgrades
  });

  wss.on('connection', (ws, request) => {
    const urlParams = new URLSearchParams(request.url?.split('?')[1] || '');
    const roomId = urlParams.get('room');
    const senderId = Math.random().toString(36).substring(7);
    (ws as any).id = senderId;

    // Optimize socket buffers for media streaming (Secure Relay)
    const rawSocket = (ws as any)._socket;
    if (rawSocket && typeof rawSocket.setSendBufferSize === 'function') {
      try {
        // FIX: Bufferbloat prevention. 64KB instead of 2MB so TCP backpressure kicks in early
        rawSocket.setSendBufferSize(64 * 1024);
        rawSocket.setReceiveBufferSize(64 * 1024);
      } catch (e) {
        console.warn('⚠️ Failed to tune socket buffers:', (e as Error).message);
      }
    }

    if (!roomId) {
      ws.close();
      return;
    }

    // Heartbeat setup
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId)!.add(ws);

    const isLoopback = urlParams.get('loopback') === 'true';

    ws.on('message', (message, isBinary) => {
      // FIX: Server-Side RTT (Iteration 9)
      // If message is a string and contains "type":"ping", respond immediately.
      // This prevents remote client lag from affecting local bitrate.
      if (!isBinary) {
        try {
          const text = message.toString();
          if (text.includes('"type":"ping"')) {
            const msg = JSON.parse(text);
            ws.send(JSON.stringify({ type: 'pong', ts: msg.ts, sid: msg.sid }));
            return; // DO NOT relay ping to other clients!
          }
        } catch (e) {
          // Fall through to relay logic for non-json or error cases
        }
      }

      const roomClients = rooms.get(roomId);
      if (roomClients) {
        let relayedMessage = message;

        if (isBinary) {
          const senderIdBuffer = Buffer.from((ws as any).id || 'unknown');
          const senderIdLength = Buffer.alloc(1);
          senderIdLength.writeUInt8(senderIdBuffer.length);
          const dataBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message as any);
          relayedMessage = Buffer.concat([senderIdLength, senderIdBuffer, dataBuffer]);
        }

        roomClients.forEach((client) => {
          if ((client !== ws || isLoopback) && client.readyState === WebSocket.OPEN) {
            // FIX: Server-side Backpressure for slow receivers (Download < Upload).
            // If the receiver's download link is too slow, their buffer will grow indefinitely.
            // Drop binary (media) packets to keep the queue small and prevent 35,000ms RTT explosions.
            // Increased to 512KB for Iteration 6 to prevent I-frame truncation.
            if (isBinary && client.bufferedAmount > 524288) {
              return; // Drop packet
            }
            try {
              client.send(relayedMessage, { binary: isBinary });
            } catch (e) {
              console.error('Relay send error:', e);
              client.terminate();
            }
          }
        });
      }
    });

    ws.on('error', (err) => {
      console.error('Relay WebSocket error:', err);
    });

    ws.on('close', () => {
      const roomClients = rooms.get(roomId);
      if (roomClients) {
        roomClients.delete(ws);
        if (roomClients.size === 0) {
          rooms.delete(roomId);
        }
      }
    });
  });

  // Interval to check for dead connections
  const interval = setInterval(() => {
    wss.clients.forEach((ws: any) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  app.use(cors());
  app.use(express.json());

  // API Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/friends', friendRoutes);
  app.use('/api/support', supportRoutes);

  // Client Log Receptor
  app.post('/api/logs', (req, res) => {
    const { level, message, timestamp } = req.body;
    const prefix = `[CLIENT] [${timestamp || new Date().toISOString()}] [${(level || 'info').toUpperCase()}]`;
    
    if (level === 'error') {
      console.error(`${prefix} ${message}`);
    } else if (level === 'warn') {
      console.warn(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
    
    res.sendStatus(200);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  }

  // Global Error Handler (must be last)
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('🔥 Server Error:', err);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      message: process.env.NODE_ENV === 'development' ? err.message : undefined 
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Notify Admin via Telegram (standard for "bots" and free)
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.ADMIN_TELEGRAM_ID;
    
    if (botToken && chatId) {
      const message = encodeURIComponent(`🚀 Secure Relay Server Started!\n📍 URL: ${process.env.APP_URL || 'Local'}\n⏰ Time: ${new Date().toLocaleString()}`);
      const url = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${message}`;
      
      https.get(url, (res) => {
        if (res.statusCode === 200) {
          console.log('✅ Admin notified via Telegram');
        } else {
          console.error('❌ Failed to notify admin via Telegram');
        }
      }).on('error', (e) => {
        console.error('❌ Telegram notification error:', e);
      });
    } else {
      console.log('ℹ️ Admin notification skipped (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing)');
    }
  });
}

startServer();
