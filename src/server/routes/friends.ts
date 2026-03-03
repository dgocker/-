import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db.js';
import { authenticateToken, AuthRequest } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);

router.post('/links', async (req: AuthRequest, res) => {
  try {
    const code = uuidv4();
    const stmt = db.prepare('INSERT INTO friend_links (code, created_by) VALUES (?, ?)');
    const info = await stmt.run(code, req.user.id);
    const link = await db.prepare('SELECT * FROM friend_links WHERE id = ?').get(info.lastInsertRowid) as any;
    res.json({ link });
  } catch (error) {
    console.error('Error in /friends/links:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/add', async (req: AuthRequest, res) => {
  try {
    const { code } = req.body;
    const link = await db.prepare('SELECT * FROM friend_links WHERE code = ?').get(code) as any;
    
    if (!link) {
      return res.status(404).json({ error: 'Invalid friend link' });
    }

    if (link.created_by === req.user.id) {
      return res.status(400).json({ error: 'You cannot add yourself' });
    }

    // Check if already friends
    const existing = await db.prepare(`
      SELECT * FROM friends 
      WHERE (user_id_1 = ? AND user_id_2 = ?) OR (user_id_1 = ? AND user_id_2 = ?)
    `).get(req.user.id, link.created_by, link.created_by, req.user.id);

    if (existing) {
      return res.status(400).json({ error: 'Already friends' });
    }

    // Add friend
    await db.prepare('INSERT INTO friends (user_id_1, user_id_2) VALUES (?, ?)').run(req.user.id, link.created_by);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error in /friends/add:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', async (req: AuthRequest, res) => {
  try {
    const friends = await db.prepare(`
      SELECT u.id, u.first_name, u.last_name, u.username, u.photo_url
      FROM friends f
      JOIN users u ON (f.user_id_1 = u.id AND f.user_id_2 = ?) OR (f.user_id_2 = u.id AND f.user_id_1 = ?)
    `).all(req.user.id, req.user.id);
    
    res.json({ friends });
  } catch (error) {
    console.error('Error in /friends:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const friendId = req.params.id;
    await db.prepare(`
      DELETE FROM friends 
      WHERE (user_id_1 = ? AND user_id_2 = ?) OR (user_id_1 = ? AND user_id_2 = ?)
    `).run(req.user.id, friendId, friendId, req.user.id);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error in DELETE /friends/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
