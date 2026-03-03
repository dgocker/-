import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

router.post('/invites', async (req: AuthRequest, res) => {
  try {
    const code = uuidv4();
    const stmt = db.prepare('INSERT INTO app_invites (code, created_by) VALUES (?, ?)');
    const info = await stmt.run(code, req.user.id);
    const invite = await db.prepare('SELECT * FROM app_invites WHERE id = ?').get(info.lastInsertRowid) as any;
    res.json({ invite });
  } catch (error) {
    console.error('Error in /admin/invites:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/invites', async (req: AuthRequest, res) => {
  try {
    const invites = await db.prepare(`
      SELECT a.*, u.username as used_by_username 
      FROM app_invites a 
      LEFT JOIN users u ON a.used_by = u.id
      ORDER BY a.created_at DESC
    `).all();
    res.json({ invites });
  } catch (error) {
    console.error('Error in /admin/invites:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
