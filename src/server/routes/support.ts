import express from 'express';
import { authenticateToken, AuthRequest } from '../authMiddleware.js';
import https from 'https';
import { Buffer } from 'buffer';

const router = express.Router();

router.post('/logs', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const { logs } = req.body;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.ADMIN_TELEGRAM_ID;

    if (!botToken || !adminId) {
      console.error('❌ Support: Telegram configuration missing');
      return res.status(500).json({ error: 'Telegram configuration missing' });
    }

    if (!logs) {
      return res.status(400).json({ error: 'No logs provided' });
    }

    const boundary = '----------' + Math.random().toString(36).substring(2);
    const filename = `logs_${req.user?.username || req.user?.id || 'unknown'}_${Date.now()}.txt`;
    
    // Use Buffer to ensure correct byte length with UTF-8
    const chunks: Buffer[] = [];
    
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="chat_id"\r\n\r\n`));
    chunks.push(Buffer.from(`${adminId}\r\n`));
    
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="document"; filename="${filename}"\r\n`));
    chunks.push(Buffer.from(`Content-Type: text/plain; charset=utf-8\r\n\r\n`));
    chunks.push(Buffer.from(logs));
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(chunks);

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/sendDocument`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) {
            console.log('✅ Support: Logs sent to Telegram');
            res.json({ success: true });
          } else {
            console.error('❌ Support: Telegram error:', result.description);
            res.status(500).json({ error: result.description });
          }
        } catch (e) {
          console.error('❌ Support: Failed to parse Telegram response:', data);
          res.status(500).json({ error: 'Failed to parse Telegram response' });
        }
      });
    });

    request.on('error', (e) => {
      console.error('❌ Support: Telegram request error:', e);
      res.status(500).json({ error: 'Failed to connect to Telegram' });
    });

    request.write(body);
    request.end();

  } catch (error) {
    console.error('❌ Support: Internal error in /logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
