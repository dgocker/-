import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure logs directory exists relative to project root
const projectRoot = path.resolve(__dirname, '../../');
const logsDir = path.join(projectRoot, 'logs');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFile = path.join(logsDir, 'server.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function getTimestamp() {
  return new Date().toISOString();
}

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function formatArgs(args: any[]) {
  return args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch (e) {
        return '[Circular or BigInt Object]';
      }
    }
    return String(arg);
  }).join(' ');
}

console.log = (...args: any[]) => {
  const message = `[${getTimestamp()}] [INFO] ${formatArgs(args)}\n`;
  logStream.write(message);
  originalLog.apply(console, args);
};

console.error = (...args: any[]) => {
  const message = `[${getTimestamp()}] [ERROR] ${formatArgs(args)}\n`;
  logStream.write(message);
  originalError.apply(console, args);
};

console.warn = (...args: any[]) => {
  const message = `[${getTimestamp()}] [WARN] ${formatArgs(args)}\n`;
  logStream.write(message);
  originalWarn.apply(console, args);
};

console.info = (...args: any[]) => {
  const message = `[${getTimestamp()}] [INFO] ${formatArgs(args)}\n`;
  logStream.write(message);
  originalInfo.apply(console, args);
};

console.log('📝 Persistent logging initialized.');
