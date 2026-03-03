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

function verifyTelegramWebApp(initData: string, botToken: string) {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  
  const dataCheckString = Array.from(urlParams.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
    
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  
  return calculatedHash === hash;
}

router.post('/telegram-webapp', async (req, res) => {
  const { initData, inviteCode } = req.body;

  if (!TELEGRAM_BOT_TOKEN) {
    // Dev bypass
    if (process.env.NODE_ENV !== 'production') {
      // Mock user for dev
      const user = { id: 12345, first_name: 'Dev', last_name: 'User', username: 'devuser', photo_url: '' };
      return await handleUserLogin(user, inviteCode, res);
    }
    return res.status(500).json({ error: 'Bot token not configured' });
  }

  const isValid = verifyTelegramWebApp(initData, TELEGRAM_BOT_TOKEN);
  
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid Telegram WebApp authentication' });
  }

  const urlParams = new URLSearchParams(initData);
  const userData = JSON.parse(urlParams.get('user') || '{}');
  
  await handleUserLogin(userData, inviteCode, res);
});

async function handleUserLogin(authData: any, inviteCode: string, res: any) {
  const { id: telegram_id, first_name, last_name, username, photo_url } = authData;

  // Check if user exists
  let user = await db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id) as any;

  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
  const expectedRole = (adminTelegramId && telegram_id.toString() === adminTelegramId) ? 'admin' : 'user';

  if (!user) {
    // If not exists, they need an invite code unless they are the admin
    if (expectedRole === 'admin') {
      // Admin bypasses invite code
      const stmt = db.prepare(`
        INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, role)
        VALUES (?, ?, ?, ?, ?, 'admin')
      `);
      const info = await stmt.run(telegram_id, first_name, last_name, username, photo_url);
      user = await db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as any;
    } else {
      // Need an invite code
      if (!inviteCode) {
        return res.status(403).json({ error: 'Требуется код приглашения для новых пользователей' });
      }

      const invite = await db.prepare('SELECT * FROM app_invites WHERE code = ? AND used_by IS NULL').get(inviteCode) as any;
      if (!invite) {
        return res.status(403).json({ error: 'Недействительный или уже использованный код приглашения' });
      }

      // Create user
      const stmt = db.prepare(`
        INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, role)
        VALUES (?, ?, ?, ?, ?, 'user')
      `);
      const info = await stmt.run(telegram_id, first_name, last_name, username, photo_url);
      user = await db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as any;

      // Mark invite as used
      await db.prepare('UPDATE app_invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(user.id, invite.id);
    }
  } else {
    // Update role if it changed (e.g., admin was set in env later)
    if (user.role !== expectedRole && expectedRole === 'admin') {
      await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(expectedRole, user.id);
      user.role = expectedRole;
    }
  }

  // Generate JWT
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  
  res.json({ token, user });
}

router.post('/telegram', async (req, res) => {
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

  await handleUserLogin(authData, inviteCode, res);
});

router.get('/me', authenticateToken, (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

export default router;
