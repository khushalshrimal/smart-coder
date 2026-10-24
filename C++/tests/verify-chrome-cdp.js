// Simple test script to verify Chrome launch and CDP connectivity
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_PATH = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.resolve(__dirname, '..', '.tmp_chrome_profile');

if (!fs.existsSync(USER_DATA_DIR)) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

console.log('Testing Chrome launch with extension:', EXT_PATH);

const chromeProc = spawn(CHROME_PATH, [
  `--remote-debugging-port=9222`,
  `--user-data-dir=${USER_DATA_DIR}`,
  `--load-extension=${EXT_PATH}`,
  `--disable-extensions-except=${EXT_PATH}`,
  `--no-first-run`,
  `--no-default-browser-check`,
  'about:blank'
], { detached: false });

chromeProc.on('error', (err) => {
  console.error('Failed to spawn Chrome:', err);
  process.exit(1);
});

// Wait 2 seconds and query http://127.0.0.1:9222/json/version
setTimeout(() => {
  const req = http.get('http://127.0.0.1:9222/json/version', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('CDP Version Response:', data);
      chromeProc.kill('SIGKILL');
      process.exit(0);
    });
  });
  req.on('error', (err) => {
    console.error('HTTP error connecting to CDP:', err);
    chromeProc.kill('SIGKILL');
    process.exit(1);
  });
}, 2500);
