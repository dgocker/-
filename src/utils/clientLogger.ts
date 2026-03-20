/**
 * Client-side logger that forwards all console output to the server.
 */

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

async function sendLogToServer(level: 'info' | 'warn' | 'error', ...args: any[]) {
  const message = formatArgs(args);
  const timestamp = new Date().toISOString();

  try {
    // We use beacon or fetch, fetch is more reliable for immediate feedback
    await fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message, timestamp }),
    });
  } catch (e) {
    // Do not log the logging error to avoid infinite loops
    originalError('Failed to send log to server:', e);
  }
}

console.log = (...args: any[]) => {
  sendLogToServer('info', ...args);
  originalLog.apply(console, args);
};

console.error = (...args: any[]) => {
  sendLogToServer('error', ...args);
  originalError.apply(console, args);
};

console.warn = (...args: any[]) => {
  sendLogToServer('warn', ...args);
  originalWarn.apply(console, args);
};

console.info = (...args: any[]) => {
  sendLogToServer('info', ...args);
  originalInfo.apply(console, args);
};

console.log('🚀 Client-to-Server log relay initialized.');
