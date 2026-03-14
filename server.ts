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
import { setupSocket } from './src/server/socket.js';
import authRoutes from './src/server/routes/auth.js';
import adminRoutes from './src/server/routes/admin.js';
import friendRoutes from './src/server/routes/friends.js';

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
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Set<WebSocket>>();

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    
    if (url.pathname.startsWith('/secure-relay')) {
      const token = url.searchParams.get('token');
      if (token === SECRET_TOKEN) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    }
    // If it's not /secure-relay, we do nothing and let socket.io handle its own upgrades
  });

  wss.on('connection', (ws, request) => {
    const urlParams = new URLSearchParams(request.url?.split('?')[1] || '');
    const roomId = urlParams.get('room');

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

    ws.on('message', (message, isBinary) => {
      const roomClients = rooms.get(roomId);
      if (roomClients) {
        roomClients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            try {
              client.send(message, { binary: isBinary });
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
