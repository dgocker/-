import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { authenticateToken, AuthRequest } from '../authMiddleware.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function verifyTelegramAuth(data: any, botToken: string) {
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const checkString = Object.keys(data)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('\n');
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return hmac === data.hash;
}

router.post('/telegram', (req, res) => {
  const { authData, inviteCode } = req.body;

  let isValid = false;
  if (TELEGRAM_BOT_TOKEN) {
    isValid = verifyTelegramAuth(authData, TELEGRAM_BOT_TOKEN);
  } else if (process.env.NODE_ENV !== 'production') {
    // Dev bypass if no token is provided
    isValid = true;
  }

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid Telegram authentication' });
  }

  const { id: telegram_id, first_name, last_name, username, photo_url } = authData;

  // Check if user exists
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id) as any;

  if (!user) {
    // If not exists, they need an invite code unless they are the first user
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    
    if (userCount.count === 0) {
      // First user becomes admin
      const stmt = db.prepare(`
        INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, role)
        VALUES (?, ?, ?, ?, ?, 'admin')
      `);
      const info = stmt.run(telegram_id, first_name, last_name, username, photo_url);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as any;
    } else {
      // Need an invite code
      if (!inviteCode) {
        return res.status(403).json({ error: 'Invite code required for new users' });
      }

      const invite = db.prepare('SELECT * FROM app_invites WHERE code = ? AND used_by IS NULL').get(inviteCode) as any;
      if (!invite) {
        return res.status(403).json({ error: 'Invalid or already used invite code' });
      }

      // Create user
      const stmt = db.prepare(`
        INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, role)
        VALUES (?, ?, ?, ?, ?, 'user')
      `);
      const info = stmt.run(telegram_id, first_name, last_name, username, photo_url);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as any;

      // Mark invite as used
      db.prepare('UPDATE app_invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(user.id, invite.id);
    }
  }

  // Generate JWT
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  
  res.json({ token, user });
});

router.get('/me', authenticateToken, (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

export default router;
