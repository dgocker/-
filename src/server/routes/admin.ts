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

router.get('/users', async (req: AuthRequest, res) => {
  try {
    const users = await db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
    res.json({ users });
  } catch (error) {
    console.error('Error in /admin/users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/users/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.params.id;
    
    // Prevent deleting self
    if (parseInt(userId) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    // Delete related data first (foreign key constraints)
    await db.prepare('DELETE FROM friends WHERE user_id_1 = ? OR user_id_2 = ?').run(userId, userId);
    await db.prepare('DELETE FROM friend_links WHERE created_by = ?').run(userId);
    await db.prepare('DELETE FROM app_invites WHERE created_by = ? OR used_by = ?').run(userId, userId);
    
    // Delete user
    await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error in DELETE /admin/users/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
