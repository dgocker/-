import { spawn, execSync } from 'child_process';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

console.log('🧹 Clearing server logs...');
try {
  execSync('truncate -s 0 /var/www/my-app/logs/server.log', { stdio: 'inherit' });
  console.log('✅ Server logs cleared.');
} catch (e) {
  console.warn('⚠️ Failed to clear server logs (might be local build or permission issue):', e.message);
}

console.log('🚀 Starting build process...');
const buildProcess = spawn('npx', ['vite', 'build'], { stdio: 'inherit', shell: true });

buildProcess.on('close', (code) => {
  if (code !== 0) {
    console.error(`❌ Build process exited with code ${code}`);
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.ADMIN_TELEGRAM_ID;

    if (botToken && chatId) {
      const message = encodeURIComponent(`❌ Build Failed!\n📍 URL: ${process.env.APP_URL || 'Local'}\n⏰ Time: ${new Date().toLocaleString()}`);
      const url = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${message}`;

      https.get(url, (res) => {
        console.log('✅ Admin notified about build failure via Telegram.');
        process.exit(code);
      }).on('error', (e) => {
        console.error('❌ Failed to notify admin:', e);
        process.exit(code);
      });
    } else {
      console.log('ℹ️ Admin notification skipped (TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_ID missing)');
      process.exit(code);
    }
  } else {
    console.log('✅ Build successful!');
    process.exit(0);
  }
});
