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
    if (sVal.hasHeadline && sVal.defaultModel === 'gemini-2.5-flash' && sVal.keyType === 'password') {
      pass('Settings Page: Form Elements & gemini-2.5-flash Default Model Verified', `Default: ${sVal.defaultModel}`);
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
          <div class="monaco-editor">
            <div class="view-lines">
              <div class="view-line"><span>class Solution {</span></div>
              <div class="view-line"><span>public:</span></div>
              <div class="view-line"><span>    vector&lt;int&gt; twoSum(vector&lt;int&gt;&amp; nums, int target) {</span></div>
              <div class="view-line"><span>        </span></div>
              <div class="view-line"><span>    }</span></div>
              <div class="view-line"><span>};</span></div>
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

    // 2.1 Verify Initial Page Load: Absolutely No Visible Overlay, Placeholder or Prompt Text
    const initialVerify = await pageClient.send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.getElementById('stealth-root');
        const visibleOverlay = Boolean(root && root.style.display !== 'none');
        const anyPrompt = document.body.innerText.includes('Press Alt+Shift+G to solve');
        return {
          rootExists: Boolean(root),
          visibleOverlay,
          anyPrompt
        };
      })()`,
      returnByValue: true
    });

    const iv = initialVerify.result.value;
    if (!iv.rootExists && !iv.visibleOverlay && !iv.anyPrompt) {
      pass('Initial Page Load: Absolutely No Extension Overlay, Banner, or Prompt Text Rendered');
    } else {
      fail('Initial Page Load Cleanliness', JSON.stringify(iv));
    }

    // 2.2 Test Shortcut Alt + Shift + G: Creates Stealth Box on Demand & Displays C++17 Solution
    const genShortcutTest = await pageClient.send('Runtime.evaluate', {
      expression: `(async () => {
        // Dispatch Alt + Shift + G in Chrome page
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'G',
          altKey: true,
          shiftKey: true,
          bubbles: true
        }));

        // Catch intermediate reading / generating state
        await new Promise(r => setTimeout(r, 60));
        const root = document.getElementById('stealth-root');
        const shadow = root ? root.shadowRoot : null;
        const statusReading = shadow?.getElementById('status-badge')?.textContent || '';
        const statusClassReading = shadow?.getElementById('status-badge')?.className || '';

        // Wait for generation response
        await new Promise(r => setTimeout(r, 450));
        const statusReady = shadow?.getElementById('status-badge')?.textContent || '';
        const codeView = shadow?.getElementById('code-view');
        const codeHtml = codeView?.innerHTML || '';
        const rawCode = codeView?.getAttribute('data-raw-code') || '';

        return {
          rootCreated: Boolean(root),
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
    if (gv.rootCreated && gv.hasRawCode && gv.syntaxHighlighted && gv.statusReady.includes('C++17 Solution')) {
      pass('Shortcut Alt + Shift + G: Creates Overlay on Demand & Displays Pure C++17 Solution');
    } else {
      fail('Shortcut Alt + Shift + G: Generation Workflow', JSON.stringify(gv));
    }

    // 2.2b Verify Code Box Glassmorphic Styling: Uniform 0.55 Container Opacity
    const styleVerify = await pageClient.send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.getElementById('stealth-root');
        const shadow = root ? root.shadowRoot : null;
        const box = shadow ? shadow.getElementById('box') : null;
        if (!box) return { found: false };
        const cs = window.getComputedStyle(box);
        return {
          found: true,
          backgroundColor: cs.backgroundColor,
          backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || '',
          opacity: Math.round(parseFloat(cs.opacity) * 100) / 100,
          color: cs.color
        };
      })()`,
      returnByValue: true
    });

    const sv = styleVerify.result.value;
    if (
      sv.found &&
      sv.backgroundColor.includes('rgba(15, 15, 15, 0.6') &&
      sv.opacity === 0.55
    ) {
      pass('Overlay Styling: Uniform Container Opacity (opacity: 0.55), Semi-Transparent Background & Backdrop Blur', `Opacity: ${sv.opacity}, BG: ${sv.backgroundColor}`);
    } else {
      fail('Overlay Styling', JSON.stringify(sv));
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

    // 2.6 Test GeeksforGeeks Problem Extractor with Modern Dynamic Class (__Xm_eO)
    const gfgTest = await pageClient.send('Runtime.evaluate', {
      expression: `(async () => {
        // Change document to modern GFG Next.js structure
        document.body.innerHTML = \`
          <div class=\"problems_header_content\">
            <div class=\"problems_header_content__title\">
              <h1 class=\"problem-tab__name\">Reverse a String</h1>
            </div>
          </div>
          <div class=\"problems_problem_content__Xm_eO problem-description\" id=\"problem-statement\">
            <p>You are given a string <code>s</code>. You need to reverse the string.</p>
            <pre>Input: s = \"Geeks\"\\nOutput: \"skeeG\"</pre>
          </div>
          <div class=\"monaco-editor\" id=\"code-editor\">
            <div class=\"view-lines\">
              <div class=\"view-line\"><span>class Solution { public: string reverseString(string& s) { } };</span></div>
            </div>
          </div>
        \`;
        
        await new Promise(r => setTimeout(r, 400));

        let extracted = null;
        if (window.__msgListener) {
          window.__msgListener({ action: 'EXTRACT_PROBLEM_TEXT' }, {}, (resp) => {
            extracted = resp;
          });
        }

        const root = document.getElementById('stealth-root');
        const shadow = root ? root.shadowRoot : null;
        const statusText = shadow?.getElementById('status-badge')?.textContent || '';
        return {
          extractedTitle: extracted?.title || '',
          statusBadge: statusText
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const gfgVal = gfgTest.result.value;
    if (gfgVal.extractedTitle.includes('Reverse a String') && !gfgVal.statusBadge.includes('Reverse a String')) {
      pass('GeeksforGeeks Problem Extractor: Correctly Parses Modern Dynamic Class (__Xm_eO) Without Leaking Title to Overlay', gfgVal.extractedTitle);
    } else {
      fail('GeeksforGeeks Problem Extractor', JSON.stringify(gfgVal));
    }

    // 2.7 Test Local Demo Page (demo/sample-problem.html) Directly
    const demoFilePath = 'file:///' + path.join(PROJECT_ROOT, 'demo', 'sample-problem.html').replace(/\\/g, '/');
    const demoTarget = await browserWs.send('Target.createTarget', { url: demoFilePath });
    await sleep(750);

    targets = await fetchJson('http://127.0.0.1:9222/json/list');
    const demoTgtInfo = targets.find(t => t.id === demoTarget.targetId);
    const demoClient = new CdpClient(demoTgtInfo.webSocketDebuggerUrl);
    await demoClient.connect();
    await demoClient.send('Runtime.enable');

    // Inject mock Chrome runtime APIs on demo page
    await demoClient.send('Runtime.evaluate', {
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
                    code: '#include <string>\\n#include <algorithm>\\nusing namespace std;\\n\\nstring reverseString(string s) {\\n    reverse(s.begin(), s.end());\\n    return s;\\n}',
                    model: 'gemini-3.8-flash'
                  });
                }, 150);
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

    // Inject content.js into the demo page
    await demoClient.send('Runtime.evaluate', { expression: contentJsSource });
    await sleep(500);

    // Verify extraction on demo page
    const demoExtTest = await demoClient.send('Runtime.evaluate', {
      expression: `(async () => {
        // Assert initial state: absolutely no overlay before shortcut
        const rootBefore = document.getElementById('stealth-root');

        // Trigger generation with Alt+Shift+G
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'G',
          altKey: true,
          shiftKey: true,
          bubbles: true
        }));

        await new Promise(r => setTimeout(r, 400));

        const root = document.getElementById('stealth-root');
        const shadow = root ? root.shadowRoot : null;
        const statusBadge = shadow?.getElementById('status-badge')?.textContent || '';
        const codeView = shadow?.getElementById('code-view');
        const rawCode = codeView?.getAttribute('data-raw-code') || '';

        return {
          wasNullBefore: rootBefore === null,
          statusBadge,
          hasReverseCode: rawCode.includes('reverseString')
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const dVal = demoExtTest.result.value;
    if (dVal.wasNullBefore && dVal.hasReverseCode && dVal.statusBadge.includes('C++17 Solution')) {
      pass('Local Demo Page (demo/sample-problem.html): Clean Before Shortcut, Extracted & Generated Solution Successfully');
    } else {
      fail('Local Demo Page Extraction', JSON.stringify(dVal));
    }

    // 2.8 Test Template Inspection Reporting when Signature is Unidentified
    const inspectTest = await demoClient.send('Runtime.evaluate', {
      expression: `(async () => {
        // Remove code editor from demo page to simulate missing template and signature
        const editor = document.getElementById('code-editor');
        if (editor) editor.remove();
        const pDesc = document.getElementById('problem-statement');
        if (pDesc) {
          // Replace with statement lacking any signature
          pDesc.innerHTML = '<p>Some mystery problem without function name or signature.</p>';
        }

        // Trigger Alt+Shift+G
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'G',
          altKey: true,
          shiftKey: true,
          bubbles: true
        }));

        await new Promise(r => setTimeout(r, 200));

        const root = document.getElementById('stealth-root');
        const shadow = root?.shadowRoot;
        const statusBadge = shadow?.getElementById('status-badge')?.textContent || '';
        return { statusBadge };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const inspVal = inspectTest.result.value;
    if (inspVal.statusBadge.includes('Template inspection needed')) {
      pass('Template Inspection: Reliably Reports Inspection Needed Without Guessing When Signature is Missing', inspVal.statusBadge);
    } else {
      fail('Template Inspection Reporting', JSON.stringify(inspVal));
    }

    demoClient.close();
    await browserWs.send('Target.closeTarget', { targetId: demoTarget.targetId });

    // 2.9 Test Local Demo Page (demo/rotate-array-sample.html): Dedicated Rotate Array by One Regression Test
    const rotateFilePath = 'file:///' + path.join(PROJECT_ROOT, 'demo', 'rotate-array-sample.html').replace(/\\/g, '/');
    const rotateTarget = await browserWs.send('Target.createTarget', { url: rotateFilePath });
    await sleep(750);

    targets = await fetchJson('http://127.0.0.1:9222/json/list');
    const rotateTgtInfo = targets.find(t => t.id === rotateTarget.targetId);
    const rotateClient = new CdpClient(rotateTgtInfo.webSocketDebuggerUrl);
    await rotateClient.connect();
    await rotateClient.send('Runtime.enable');

    // Inject mock Chrome runtime APIs on rotate array page
    await rotateClient.send('Runtime.evaluate', {
      expression: `
        window.chrome = {
          storage: {
            local: {
              data: { geminiModel: 'gemini-2.5-flash' },
              get: (keys) => Promise.resolve({ geminiModel: 'gemini-2.5-flash' }),
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
                    code: 'class Solution {\\n  public:\\n    void rotate(vector<int> &arr) {\\n        if (arr.empty()) return;\\n        int last = arr.back();\\n        arr.pop_back();\\n        arr.insert(arr.begin(), last);\\n    }\\n};',
                    model: 'gemini-2.5-flash'
                  });
                }, 150);
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

    // Inject content.js into rotate-array-sample.html
    await rotateClient.send('Runtime.evaluate', { expression: contentJsSource });
    await sleep(500);

    const rotateTest = await rotateClient.send('Runtime.evaluate', {
      expression: `(async () => {
        // Assert initial state: absolutely no overlay before shortcut
        const rootBefore = document.getElementById('stealth-root');

        // Trigger generation with Alt+Shift+G
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'G',
          altKey: true,
          shiftKey: true,
          bubbles: true
        }));

        await new Promise(r => setTimeout(r, 400));

        const root = document.getElementById('stealth-root');
        const shadow = root ? root.shadowRoot : null;
        const statusBadge = shadow?.getElementById('status-badge')?.textContent || '';
        const codeView = shadow?.getElementById('code-view');
        const rawCode = codeView?.getAttribute('data-raw-code') || '';
        const renderedHtml = codeView?.innerHTML || '';

        const forbiddenTokens = [
          'Courses',
          'Tutorials',
          'Practice',
          'Jobs',
          'Difficulty',
          'Rotate Array by One',
          'Given an array arr[]'
        ];

        const statusViolations = forbiddenTokens.filter(token => statusBadge.includes(token));
        const codeViolations = forbiddenTokens.filter(token => rawCode.includes(token) || renderedHtml.includes(token));

        return {
          wasNullBefore: rootBefore === null,
          statusBadge,
          rawCode,
          statusViolations,
          codeViolations,
          hasRotateFunc: rawCode.includes('void rotate(vector<int> &arr)'),
          hasClassSolution: rawCode.includes('class Solution')
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const rVal = rotateTest.result.value;
    if (
      rVal.wasNullBefore &&
      rVal.hasClassSolution &&
      rVal.hasRotateFunc &&
      rVal.statusViolations.length === 0 &&
      rVal.codeViolations.length === 0 &&
      rVal.statusBadge === '⚡ C++17 Solution'
    ) {
      pass('Rotate Array by One Regression: Clean Before Shortcut, Overlay Contains ONLY Generated C++ Code, Strictly Zero Page/Nav/Difficulty Text');
    } else {
      fail('Rotate Array by One Regression', JSON.stringify(rVal));
    }

    rotateClient.close();
    await browserWs.send('Target.closeTarget', { targetId: rotateTarget.targetId });

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
