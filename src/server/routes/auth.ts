import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { authenticateToken, AuthRequest } from '../authMiddleware.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Password hashing utility
const hashPassword = async (password: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(salt + ':' + derivedKey.toString('hex'));
    });
  });
};

const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(':');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(key === derivedKey.toString('hex'));
    });
  });
};

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
  try {
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
  } catch (error) {
    console.error('Error in /telegram-webapp:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function sendWelcomeMessage(telegramId: number) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: telegramId,
        text: '👋 Добро пожаловать! Теперь я в вашем списке чатов.\n\nОткрыть приложение: https://t.me/Vid_dm_qwe_bot/Call'
      }),
    });
    const data = await response.json();
    if (!data.ok) {
      console.error('Failed to send welcome message:', data.description);
    }
  } catch (error) {
    console.error('Error sending welcome message:', error);
  }
}

async function handleUserLogin(authData: any, inviteCode: string, res: any) {
  const { id: telegram_id, first_name, last_name, username, photo_url } = authData;

  if (!telegram_id) {
    return res.status(400).json({ error: 'Invalid user data: missing telegram_id' });
  }

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
      
      // Send welcome message so bot appears in chat list
      sendWelcomeMessage(telegram_id);
    } else {
      // Need an invite code
      if (!inviteCode) {
        return res.status(403).json({ error: 'Требуется код приглашения для новых пользователей' });
      }

      const isFriendInvite = inviteCode.startsWith('friend-');
      if (isFriendInvite) {
        return res.status(403).json({ error: 'Для регистрации требуется инвайт-код от администратора. Код друга не подходит для регистрации.' });
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
        
      // Send welcome message so bot appears in chat list
      sendWelcomeMessage(telegram_id);
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

router.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) {
      return res.status(400).json({ error: 'Login and password are required' });
    }

    const user = await db.prepare('SELECT * FROM users WHERE login = ?').get(login) as any;
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid login or password' });
    }

    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid login or password' });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (error) {
    console.error('Error in /login:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { login, password, first_name, inviteCode } = req.body;
    if (!login || !password || !first_name) {
      return res.status(400).json({ error: 'Login, password, and first name are required' });
    }

    // Check if user exists
    const existingUser = await db.prepare('SELECT * FROM users WHERE login = ?').get(login);
    if (existingUser) {
      return res.status(400).json({ error: 'Login already taken' });
    }

    /* 
    // Invites commented out as per user request
    if (!inviteCode) {
      return res.status(403).json({ error: 'Invite code required' });
    }
    const invite = await db.prepare('SELECT * FROM app_invites WHERE code = ? AND used_by IS NULL').get(inviteCode) as any;
    if (!invite) {
      return res.status(403).json({ error: 'Invalid or used invite code' });
    }
    */

    const passwordHash = await hashPassword(password);
    const stmt = db.prepare(`
      INSERT INTO users (login, password_hash, first_name, role)
      VALUES (?, ?, ?, 'user')
    `);
    const info = await stmt.run(login, passwordHash, first_name);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as any;

    /*
    // Mark invite as used
    if (invite) {
      await db.prepare('UPDATE app_invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(user.id, invite.id);
    }
    */

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (error) {
    console.error('Error in /register:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/telegram', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Error in /telegram:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', authenticateToken, (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

router.get('/turn', authenticateToken, (req: AuthRequest, res) => {
  res.json({
    stunUrl: process.env.STUN_URL || null,
    turnUrl: process.env.TURN_URL || null,
    turnUsername: process.env.TURN_USERNAME || null,
    turnCredential: process.env.TURN_CREDENTIAL || null,
  });
});

export default router;
