import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { v4 as uuidv4 } from "uuid";

async function startServer() {
  const app = express();
  const PORT = 3000;
  const server = http.createServer(app);

  // WebSocket Signaling Server
  const wss = new WebSocketServer({ server });

  interface Client extends WebSocket {
    id: string;
    roomId?: string;
  }

  const rooms = new Map<string, Set<Client>>();

  wss.on("connection", (ws: Client) => {
    ws.id = uuidv4();
    console.log(`Client connected: ${ws.id}`);

    ws.on("message", (message: string) => {
      try {
        const data = JSON.parse(message);
        const { type, payload } = data;

        switch (type) {
          case "join-room": {
            const { roomId } = payload;
            ws.roomId = roomId;
            
            if (!rooms.has(roomId)) {
              rooms.set(roomId, new Set());
            }
            const room = rooms.get(roomId)!;
            
            // Notify others in the room
            room.forEach((client) => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: "user-joined",
                  payload: { userId: ws.id }
                }));
              }
            });

            room.add(ws);
            console.log(`Client ${ws.id} joined room ${roomId}`);
            break;
          }

          case "offer":
          case "answer":
          case "ice-candidate": {
            const { targetUserId } = payload;
            const roomId = ws.roomId;
            if (!roomId || !rooms.has(roomId)) return;

            const room = rooms.get(roomId)!;
            room.forEach((client) => {
              if (client.id === targetUserId && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: type,
                  payload: { ...payload, userId: ws.id }
                }));
              }
            });
            break;
          }
        }
      } catch (error) {
        console.error("Error handling message:", error);
      }
    });

    ws.on("close", () => {
      if (ws.roomId && rooms.has(ws.roomId)) {
        const room = rooms.get(ws.roomId)!;
        room.delete(ws);
        
        // Notify others
        room.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "user-left",
              payload: { userId: ws.id }
            }));
          }
        });

        if (room.size === 0) {
          rooms.delete(ws.roomId);
        }
      }
      console.log(`Client disconnected: ${ws.id}`);
    });
  });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve static files (if built)
    // For this environment, we mostly rely on dev mode, but good practice:
    const path = await import("path");
    app.use(express.static(path.resolve(__dirname, "dist")));
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
