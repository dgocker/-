import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { db } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

// Map of userId -> Set of socketIds
const onlineUsers = new Map<number, Set<string>>();

export function setupSocket(io: Server) {
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));

    jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
      if (err) return next(new Error('Authentication error'));
      socket.data.user = decoded;
      next();
    });
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.user.id;
    let friends: any[] = [];
    
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId)!.add(socket.id);

    socket.on('disconnect', () => {
      const userSockets = onlineUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(userId);
          // Notify friends
          const friendsToNotify = socket.data.friends || [];
          friendsToNotify.forEach((friend: any) => {
            const friendSockets = onlineUsers.get(friend.id);
            if (friendSockets) {
              friendSockets.forEach(socketId => {
                io.to(socketId).emit('friend_offline', { userId });
              });
            }
          });
        }
      }
    });

    // WebRTC Signaling
    socket.on('call_user', (data) => {
      const { userToCall, from, name } = data;
      const targetSockets = onlineUsers.get(userToCall);
      if (targetSockets) {
        targetSockets.forEach(socketId => {
          io.to(socketId).emit('call_incoming', { from, name });
        });
      }
    });

    socket.on('answer_call', (data) => {
      const { to } = data;
      const targetSockets = onlineUsers.get(to);
      if (targetSockets) {
        targetSockets.forEach(socketId => {
          io.to(socketId).emit('call_accepted', { from: userId });
        });
      }
    });

    socket.on('webrtc_offer', (data) => {
      const { to, offer } = data;
      const targetSockets = onlineUsers.get(to);
      if (targetSockets) {
        targetSockets.forEach(socketId => {
          io.to(socketId).emit('webrtc_offer', { offer, from: userId });
        });
      }
    });

    socket.on('webrtc_answer', (data) => {
      const { to, answer } = data;
      const targetSockets = onlineUsers.get(to);
      if (targetSockets) {
        targetSockets.forEach(socketId => {
          io.to(socketId).emit('webrtc_answer', { answer, from: userId });
        });
      }
    });

    socket.on('webrtc_ice_candidate', (data) => {
      const { to, candidate } = data;
      const targetSockets = onlineUsers.get(to);
      if (targetSockets) {
        targetSockets.forEach(socketId => {
          io.to(socketId).emit('webrtc_ice_candidate', { candidate, from: userId });
        });
      }
    });

    socket.on('end_call', (data) => {
      const { to } = data;
      const targetSockets = onlineUsers.get(to);
      if (targetSockets) {
        targetSockets.forEach(socketId => {
          io.to(socketId).emit('call_ended');
        });
      }
    });

    socket.on('set_call_emojis', (data) => {
      const { to, emojis } = data;
      const targetSockets = onlineUsers.get(to);
      if (targetSockets) {
        targetSockets.forEach(socketId => {
          io.to(socketId).emit('call_emojis', { emojis });
        });
      }
    });

    try {
      await updateSocketFriends(socket, userId);
    } catch (err) {
      console.error('Error fetching friends for socket:', err);
    }

    socket.on('refresh_friends', async () => {
      try {
        await updateSocketFriends(socket, userId);
      } catch (err) {
        console.error('Error refreshing friends:', err);
      }
    });
  });
}

async function updateSocketFriends(socket: Socket, userId: number) {
  // Notify friends that this user is online
  const friends = await db.prepare(`
    SELECT u.id 
    FROM friends f
    JOIN users u ON (f.user_id_1 = u.id AND f.user_id_2 = ?) OR (f.user_id_2 = u.id AND f.user_id_1 = ?)
  `).all(userId, userId);

  // Store friends list on socket for disconnect handler
  socket.data.friends = friends;

  // Update online status for friends
  // We need to use io (socket.server) to emit to specific socket IDs
  const io = socket.server;
  
  friends.forEach((friend: any) => {
    // Check if friend is online
    // We need to access the onlineUsers map which is in the closure of setupSocket
    // But we are outside. We can pass onlineUsers or make it global in module scope (it is).
    // onlineUsers is defined in module scope.
    const friendSockets = onlineUsers.get(friend.id);
    if (friendSockets) {
      friendSockets.forEach(socketId => {
        io.to(socketId).emit('friend_online', { userId });
      });
    }
  });

  // Send current online friends to the connected user
  const onlineFriends = friends.filter((f: any) => onlineUsers.has(f.id)).map((f: any) => f.id);
  socket.emit('online_friends', onlineFriends);
}
