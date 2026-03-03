import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

export interface AuthRequest extends Request {
  user?: any;
}

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, async (err: any, user: any) => {
    if (err) return res.sendStatus(403);
    
    try {
      // Fetch full user from db
      const dbUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as any;
      if (!dbUser) return res.sendStatus(403);

      req.user = dbUser;
      next();
    } catch (e) {
      console.error('Auth middleware error:', e);
      res.sendStatus(500);
    }
  });
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.sendStatus(403);
  }
}
