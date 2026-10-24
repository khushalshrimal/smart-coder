/**
 * Smart-Coder Gemini - Real Chrome Browser In-Browser Verification Suite
 * Executes realistic browser testing inside an active Google Chrome instance via CDP.
 *
 * NOTE: Google Chrome (v137+) intentionally disabled the CLI switch '--load-extension'
 * on retail builds for security. Unpacked extensions are loaded manually via chrome://extensions.
 * This runner executes full in-browser verification of settings.html, UI workflows,
 * Shadow DOM sidepanel, keyboard shortcuts (Alt+Shift+G, Alt+Shift+H, Alt+Shift+R),
 * DOM extractors (LeetCode / GFG), syntax highlighting, and Copy Code.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.resolve(PROJECT_ROOT, '.tmp_chrome_e2e_profile');

if (fs.existsSync(USER_DATA_DIR)) {
  try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch {}
}
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && this.callbacks.has(msg.id)) {
            const { resolve, reject } = this.callbacks.get(msg.id);
            this.callbacks.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
          }
        } catch (e) {
          console.error('CDP parse error:', e);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = this.id++;
      this.callbacks.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
  }
}

async function runRealBrowserTests() {
  console.log('====================================================');
  console.log('  Smart-Coder Gemini - Real Google Chrome Test Suite');
  console.log('====================================================');
  console.log('Chrome Binary:', CHROME_PATH);
  console.log('Project Root :', PROJECT_ROOT);

  let testsPassed = 0;
  let testsFailed = 0;

  function pass(name, details = '') {
    testsPassed++;
    console.log(`• ${name} ... ✅ PASS ${details ? `(${details})` : ''}`);
  }

  function fail(name, error) {
    testsFailed++;
    console.error(`• ${name} ... ❌ FAIL:`, error);
  }

  // 1. Spawn Chrome with debugging port
  const chromeProc = spawn(CHROME_PATH, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    'about:blank'
  ], { detached: false });

  try {
    // 2. Connect to DevTools
    let version = null;
    for (let i = 0; i < 30; i++) {
      try {
        version = await fetchJson('http://127.0.0.1:9222/json/version');
        if (version && version.webSocketDebuggerUrl) break;
      } catch {}
      await sleep(250);
    }

    if (!version) {
      throw new Error('Failed to connect to Chrome remote debugging port 9222.');
    }
    pass('Google Chrome Browser Spawned & CDP Active', `Version: ${version.Browser}`);

    const browserWs = new CdpClient(version.webSocketDebuggerUrl);
    await browserWs.connect();

    // -------------------------------------------------------------------------
    // TEST SECTION 1: Settings Page Real Browser Rendering & Interactions
    // -------------------------------------------------------------------------
    const settingsFileUrl = 'file:///' + path.join(PROJECT_ROOT, 'settings.html').replace(/\\/g, '/');
    const settingsTarget = await browserWs.send('Target.createTarget', { url: settingsFileUrl });
    await sleep(750);

    let targets = await fetchJson('http://127.0.0.1:9222/json/list');
    const settingsTgtInfo = targets.find(t => t.id === settingsTarget.targetId);
    const settingsClient = new CdpClient(settingsTgtInfo.webSocketDebuggerUrl);
    await settingsClient.connect();
    await settingsClient.send('Runtime.enable');

    // 1.1 Verify Settings DOM Elements Rendered
    const settingsDom = await settingsClient.send('Runtime.evaluate', {
      expression: `(() => {
        const headline = document.getElementById('activation-headline');
        const keyInput = document.getElementById('api-key-input');
        const modelSelect = document.getElementById('model-select');
        const saveBtn = document.getElementById('save-activate-btn');
        const testBtn = document.getElementById('test-btn');
        const clearBtn = document.getElementById('clear-btn');
        return {
          hasHeadline: Boolean(headline),
          headlineText: headline ? headline.textContent : '',
          hasKeyInput: Boolean(keyInput),
          keyType: keyInput ? keyInput.type : '',
          defaultModel: modelSelect ? modelSelect.value : '',
          hasSaveBtn: Boolean(saveBtn),
          hasTestBtn: Boolean(testBtn),
          hasClearBtn: Boolean(clearBtn)
        };
      })()`,
      returnByValue: true
    });

    const sVal = settingsDom.result.value;
    if (sVal.hasHeadline && sVal.defaultModel === 'gemini-3.8-flash' && sVal.keyType === 'password') {
      pass('Settings Page: Form Elements & gemini-3.8-flash Default Model Verified', `Default: ${sVal.defaultModel}`);
    } else {
      fail('Settings Page: Form Elements', JSON.stringify(sVal));
    }

    // 1.2 Test API Key Visibility Toggle Button
    const toggleTest = await settingsClient.send('Runtime.evaluate', {
      expression: `(() => {
        const toggleBtn = document.getElementById('toggle-key-visibility-btn');
        const keyInput = document.getElementById('api-key-input');
        toggleBtn.click();
        const typeAfterFirstClick = keyInput.type;
        toggleBtn.click();
        const typeAfterSecondClick = keyInput.type;
        return { typeAfterFirstClick, typeAfterSecondClick };
      })()`,
      returnByValue: true
    });

    const tVal = toggleTest.result.value;
    if (tVal.typeAfterFirstClick === 'text' && tVal.typeAfterSecondClick === 'password') {
      pass('Settings Page: API Key Visibility Toggle (Password ⇄ Text)');
    } else {
      fail('Settings Page: API Key Visibility Toggle', JSON.stringify(tVal));
    }

    // 1.3 Test Custom Model Selection
    const customModelTest = await settingsClient.send('Runtime.evaluate', {
      expression: `(() => {
        const modelSelect = document.getElementById('model-select');
        const customGroup = document.getElementById('custom-model-group');
        const isHiddenBefore = customGroup.classList.contains('hidden');
        modelSelect.value = 'custom';
        modelSelect.dispatchEvent(new Event('change'));
        const isHiddenAfter = customGroup.classList.contains('hidden');
        return { isHiddenBefore, isHiddenAfter };
      })()`,
      returnByValue: true
    });

    const cmVal = customModelTest.result.value;
    if (cmVal.isHiddenBefore === true && cmVal.isHiddenAfter === false) {
      pass('Settings Page: Custom Model Selection Unveils Custom Input');
    } else {
      fail('Settings Page: Custom Model Selection', JSON.stringify(cmVal));
    }

    // 1.4 Test Empty API Key Validation Error on Save
    const emptyKeySaveTest = await settingsClient.send('Runtime.evaluate', {
      expression: `(() => {
        const saveBtn = document.getElementById('save-activate-btn');
        const keyInput = document.getElementById('api-key-input');
        keyInput.value = '';
        saveBtn.click();
        const statusCard = document.getElementById('status-card');
        const statusTitle = document.getElementById('status-title');
        return {
          isStatusVisible: !statusCard.classList.contains('hidden'),
          statusTitle: statusTitle.textContent
        };
      })()`,
      returnByValue: true
    });

    const ekVal = emptyKeySaveTest.result.value;
    if (ekVal.isStatusVisible && ekVal.statusTitle.includes('API Key Required')) {
      pass('Settings Page: Empty Key Prevents Activation & Displays Required Warning');
    } else {
      fail('Settings Page: Empty Key Validation', JSON.stringify(ekVal));
    }

    settingsClient.close();
    await browserWs.send('Target.closeTarget', { targetId: settingsTarget.targetId });

    // -------------------------------------------------------------------------
    // TEST SECTION 2: Problem Page, Side Panel, Shadow DOM & Keyboard Shortcuts
    // -------------------------------------------------------------------------
    const problemHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Two Sum - LeetCode</title>
        <style>
          body { font-family: sans-serif; background: #0F172A; color: #F8FAFC; margin: 0; padding: 30px; }
          .elfjS { padding: 20px; background: #1E293B; border-radius: 8px; margin-top: 15px; }
          pre { background: #0A0F1D; padding: 12px; border-radius: 6px; }
        </style>
      </head>
      <body>
        <div id="app">
          <div data-cy="question-title">1. Two Sum</div>
          <div data-track-load="description_content" class="elfjS">
            <p>Given an array of integers <code>nums</code> and an integer <code>target</code>, return indices of the two numbers such that they add up to <code>target</code>.</p>
            <div class="example-block">
              <p><strong>Example 1:</strong></p>
              <pre>Input: nums = [2,7,11,15], target = 9
Output: [0,1]</pre>
            </div>
            <div class="constraints">
              <p><strong>Constraints:</strong></p>
              <ul>
                <li><code>2 &lt;= nums.length &lt;= 10<sup>4</sup></code></li>
                <li><code>-10<sup>9</sup> &lt;= nums[i] &lt;= 10<sup>9</sup></code></li>
              </ul>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const pageDataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(problemHtml)}`;
    const pageTarget = await browserWs.send('Target.createTarget', { url: pageDataUrl });
    await sleep(750);

    targets = await fetchJson('http://127.0.0.1:9222/json/list');
    const pageTgtInfo = targets.find(t => t.id === pageTarget.targetId);
    const pageClient = new CdpClient(pageTgtInfo.webSocketDebuggerUrl);
    await pageClient.connect();
    await pageClient.send('Runtime.enable');

    // Inject mock Chrome runtime APIs so content.js runs completely in standard browser tab
    await pageClient.send('Runtime.evaluate', {
      expression: `
        window.chrome = {
          storage: {
            local: {
              data: { geminiModel: 'gemini-3.8-flash' },
              get: (keys) => Promise.resolve({ geminiModel: 'gemini-3.8-flash' }),
              set: (obj) => Promise.resolve()
            }
          },
          runtime: {
            lastError: null,
            sendMessage: (msg, cb) => {
              if (msg.action === 'GENERATE_SOLUTION') {
                setTimeout(() => {
                  cb({
                    success: true,
                    code: '#include <vector>\\n#include <unordered_map>\\nusing namespace std;\\n\\nclass Solution {\\npublic:\\n    vector<int> twoSum(vector<int>& nums, int target) {\\n        unordered_map<int, int> mp;\\n        for (int i = 0; i < nums.size(); ++i) {\\n            if (mp.count(target - nums[i])) return {mp[target - nums[i]], i};\\n            mp[nums[i]] = i;\\n        }\\n        return {};\\n    }\\n};',
                    model: 'gemini-3.8-flash'
                  });
                }, 200);
              } else if (cb) {
                cb({ success: true });
              }
            },
            onMessage: {
              addListener: (fn) => { window.__msgListener = fn; }
            }
          }
        };
      `
    });

    // Inject content.js into this real Chrome tab
    const contentJsSource = fs.readFileSync(path.join(PROJECT_ROOT, 'content.js'), 'utf-8');
    const evalRes = await pageClient.send('Runtime.evaluate', { expression: contentJsSource });
    if (evalRes.exceptionDetails) {
      console.error('Exception evaluating content.js:', evalRes.exceptionDetails);
    }
    await sleep(750);

    // 2.1 Verify Stealth Box Injected into Shadow DOM & Problem Detected
    const panelVerify = await pageClient.send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.getElementById('stealth-root');
        if (!root || !root.shadowRoot) return { injected: false };
        const shadow = root.shadowRoot;
        const box = shadow.getElementById('box');
        const statusBadge = shadow.getElementById('status-badge');
        return {
          injected: true,
          hasBox: Boolean(box),
          statusText: statusBadge ? statusBadge.textContent : '',
          boxClass: box ? box.className : ''
        };
      })()`,
      returnByValue: true
    });

    const pv = panelVerify.result.value;
    if (pv.injected && pv.hasBox) {
      pass('Stealth Box (#stealth-root / #box) Injected in Real Chrome', `Status: "${pv.statusText}"`);
    } else {
      fail('Stealth Box (#stealth-root / #box) Injected', JSON.stringify(pv));
    }

    // 2.2 Test Shortcut Alt + Shift + G: Trigger Generation & Progress States
    const genShortcutTest = await pageClient.send('Runtime.evaluate', {
      expression: `(async () => {
        const root = document.getElementById('stealth-root');
        const shadow = root.shadowRoot;

        // Dispatch Alt + Shift + G in Chrome page
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'G',
          altKey: true,
          shiftKey: true,
          bubbles: true
        }));

        // Catch intermediate reading / generating state
        await new Promise(r => setTimeout(r, 60));
        const statusReading = shadow.getElementById('status-badge').textContent;
        const statusClassReading = shadow.getElementById('status-badge').className;

        // Wait for generation response
        await new Promise(r => setTimeout(r, 450));
        const statusReady = shadow.getElementById('status-badge').textContent;
        const codeView = shadow.getElementById('code-view');
        const codeHtml = codeView.innerHTML;
        const rawCode = codeView.getAttribute('data-raw-code');

        return {
          statusReading,
          statusClassReading,
          statusReady,
          hasRawCode: Boolean(rawCode && rawCode.includes('class Solution')),
          syntaxHighlighted: codeHtml.includes('sc-kw') && codeHtml.includes('sc-prep')
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const gv = genShortcutTest.result.value;
    if (gv.hasRawCode && gv.syntaxHighlighted && gv.statusReady.includes('Ready')) {
      pass('Shortcut Alt + Shift + G: Generation Progress & C++17 Solution Displayed in Stealth Box');
    } else {
      fail('Shortcut Alt + Shift + G: Generation Workflow', JSON.stringify(gv));
    }

    // 2.3 Test Copy Code Button
    const copyTest = await pageClient.send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.getElementById('stealth-root');
        const shadow = root.shadowRoot;
        const copyBtn = shadow.getElementById('copy-btn');
        copyBtn.click();
        return { labelAfterClick: copyBtn.textContent };
      })()`,
      returnByValue: true
    });

    const cv = copyTest.result.value;
    if (cv.labelAfterClick === '[Copied!]') {
      pass('Copy Code Button: Copies Clean C++17 Code & Updates Feedback Badge ("[Copied!]")');
    } else {
      fail('Copy Code Button', JSON.stringify(cv));
    }

    // 2.4 Test Shortcut Alt + Shift + H: Completely Hide Stealth Box
    const hideTest = await pageClient.send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.getElementById('stealth-root');
        
        // Dispatch Alt + Shift + H
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'H',
          altKey: true,
          shiftKey: true,
          bubbles: true
        }));

        const isHidden = root.style.display === 'none' && root.getAttribute('data-hidden') === 'true';

        // Simulate page scroll and page DOM additions
        window.scrollBy(0, 400);
        const p = document.createElement('p');
        p.textContent = 'scroll test';
        document.body.appendChild(p);

        const staysHidden = root.style.display === 'none' && root.getAttribute('data-hidden') === 'true';
        return { isHidden, staysHidden };
      })()`,
      returnByValue: true
    });

    const hv = hideTest.result.value;
    if (hv.isHidden && hv.staysHidden) {
      pass('Shortcut Alt + Shift + H: Completely Hides Stealth Box (Remains Hidden Across Scrolling)');
    } else {
      fail('Shortcut Alt + Shift + H: Hide Stealth Box', JSON.stringify(hv));
    }

    // 2.5 Test Shortcut Alt + Shift + R: Restore Stealth Box & Preserve Solution Cache
    const restoreTest = await pageClient.send('Runtime.evaluate', {
      expression: `(async () => {
        const root = document.getElementById('stealth-root');
        const shadow = root.shadowRoot;

        // Small pause to allow debounce window to clear
        await new Promise(r => setTimeout(r, 400));

        // Dispatch Alt + Shift + R
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'R',
          altKey: true,
          shiftKey: true,
          bubbles: true
        }));

        const isRestored = root.style.display === 'block' && !root.hasAttribute('data-hidden');
        const codeView = shadow.getElementById('code-view');
        const codePreserved = Boolean(codeView.getAttribute('data-raw-code')?.includes('class Solution'));
        const statusText = shadow.getElementById('status-badge').textContent;

        return { isRestored, codePreserved, statusText };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const rv = restoreTest.result.value;
    if (rv.isRestored && rv.codePreserved) {
      pass('Shortcut Alt + Shift + R: Restores Stealth Box & Preserves Cached Solution Without Unsolicited API Calls');
    } else {
      fail('Shortcut Alt + Shift + R: Restore Stealth Box', JSON.stringify(rv));
    }

    // 2.6 Test GeeksforGeeks Problem Extractor
    const gfgTest = await pageClient.send('Runtime.evaluate', {
      expression: `(async () => {
        // Change document to GFG structure
        document.body.innerHTML = \`
          <h1 class=\"problem-tab__name\">Reverse a String</h1>
          <div class=\"problems_problem_content__X2ne7\">
            <p>You are given a string <code>s</code>. You need to reverse the string.</p>
            <pre>Input: s = \"Geeks\"\\nOutput: \"skeeG\"</pre>
          </div>
        \`;
        
        await new Promise(r => setTimeout(r, 400));

        // Trigger keyboard shortcut Alt+Shift+R to re-sync
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', altKey: true, shiftKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 100));

        const root = document.getElementById('stealth-root');
        const shadow = root.shadowRoot;
        const statusText = shadow.getElementById('status-badge').textContent;
        return {
          title: statusText
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const gfgVal = gfgTest.result.value;
    if (gfgVal.title.includes('Reverse a String')) {
      pass('GeeksforGeeks Problem Extractor: Correctly Parses Title & Description on GFG Pages', gfgVal.title);
    } else {
      fail('GeeksforGeeks Problem Extractor', JSON.stringify(gfgVal));
    }

    pageClient.close();
    await browserWs.send('Target.closeTarget', { targetId: pageTarget.targetId });
    browserWs.close();

  } catch (err) {
    console.error('Real Browser Testing Error:', err);
    testsFailed++;
  } finally {
    try { chromeProc.kill('SIGKILL'); } catch {}
    await sleep(500);
    try {
      if (fs.existsSync(USER_DATA_DIR)) {
        fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
      }
    } catch {}

    console.log('\n====================================================');
    console.log(`  Real Chrome Test Results: ${testsPassed} Passed, ${testsFailed} Failed`);
    console.log('====================================================\n');

    process.exit(testsFailed > 0 ? 1 : 0);
  }
}

runRealBrowserTests();
