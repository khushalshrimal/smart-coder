/**
 * Smart-Coder Gemini - Content Script (Stealth C++17 Solution Overlay)
 * Replicates the on-screen stealth box UI from the reference MCQ extension (Stealth Pro).
 * 
 * Features & Keyboard Shortcuts:
 * - Alt + Shift + G: Read current coding question & generate/retrieve C++17 solution in stealth box.
 * - Alt + Shift + H: Completely hide the stealth box from view (preserving state and cached solutions).
 * - Alt + Shift + R: Restore the stealth box in its original position (showing cached solution or prompt).
 * - Alt + Shift + A: First-time activation / settings shortcut.
 * - Multi-platform extraction: LeetCode, GeeksforGeeks, and generic coding pages.
 * - Monospace stealth overlay with #00ffcc text, dark translucent background, Copy Code button.
 * - Session cache (question fingerprint -> C++17 solution).
 * - SPA navigation monitoring without unsolicited API requests.
 */

(() => {
  if (window.__SMART_CODER_GEMINI_ACTIVE__) {
    return;
  }
  window.__SMART_CODER_GEMINI_ACTIVE__ = true;

  // ---------------------------------------------------------------------------
  // State Management
  // ---------------------------------------------------------------------------
  let shadowRoot = null;
  let stealthRoot = null;
  let boxEl = null;

  let isBoxHidden = false; // Controlled by Alt+Shift+H and Alt+Shift+R
  let isGenerating = false;

  let currentProblem = null;
  let lastSolvedHash = null;
  const solutionCache = new Map(); // hash -> C++17 solution code

  let lastCheckedUrl = window.location.href;
  let navDebounceTimer = null;
  let lastShortcutTriggerTime = 0;

  // ---------------------------------------------------------------------------
  // Platform Detection & Specific DOM Extractors
  // ---------------------------------------------------------------------------

  function getSafeText(element) {
    if (!element) return '';
    return (element.innerText || element.textContent || '').trim();
  }

  function getPlatformInfo(url = window.location.href) {
    if (url.includes('leetcode.com/problems/') || url.includes('leetcode.cn/problems/')) {
      const match = url.match(/\/problems\/([^/?#]+)/);
      return { platform: 'leetcode', name: 'LeetCode', slug: match ? match[1] : '' };
    }
    if (url.includes('geeksforgeeks.org/problems/') || url.includes('practice.geeksforgeeks.org/problems/')) {
      const match = url.match(/\/problems\/([^/?#]+)/);
      return { platform: 'gfg', name: 'GeeksforGeeks', slug: match ? match[1] : '' };
    }
    if (url.includes('hackerrank.com/challenges/')) {
      const match = url.match(/\/challenges\/([^/?#]+)/);
      return { platform: 'hackerrank', name: 'HackerRank', slug: match ? match[1] : '' };
    }
    if (url.includes('codeforces.com/problemset/problem/') || url.includes('codeforces.com/contest/')) {
      return { platform: 'codeforces', name: 'Codeforces', slug: window.location.pathname };
    }

    // DOM-based fallback for mirrors, staging or test environments
    if (document.querySelector('[data-track-load="description_content"], .elfjS, div[data-cy="question-title"]')) {
      return { platform: 'leetcode', name: 'LeetCode', slug: window.location.pathname };
    }
    if (document.querySelector('.problems_problem_content__X2ne7, .problem-tab__name')) {
      return { platform: 'gfg', name: 'GeeksforGeeks', slug: window.location.pathname };
    }

    const genericEl = document.querySelector('.problem-description, #problem-statement, article.problem-description, div.coding-problem-description');
    if (genericEl) {
      return { platform: 'generic', name: 'Coding Practice', slug: window.location.pathname };
    }

    return null;
  }

  function cleanClone(element) {
    if (!element) return null;
    const clone = element.cloneNode(true);
    const removals = clone.querySelectorAll('script, style, svg, noscript, button, nav, footer, header, .action-btn, [role="button"]');
    removals.forEach(n => n.remove());
    return clone;
  }

  function extractLeetCodeProblem() {
    const titleEl = document.querySelector('div[data-cy="question-title"]') ||
      document.querySelector('.text-title-large') ||
      document.querySelector('div.flex.items-start.justify-between h4') ||
      document.querySelector('h4[data-cy="question-title"]');

    let title = getSafeText(titleEl);
    if (!title) {
      const slugMatch = window.location.pathname.match(/\/problems\/([^/?#]+)/);
      if (slugMatch) {
        title = slugMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
    }

    const contentEl = document.querySelector('[data-track-load="description_content"]') ||
      document.querySelector('.elfjS') ||
      document.querySelector('div.question-content__JfgR') ||
      document.querySelector('div[data-key="description-content"]');

    if (!contentEl) return null;

    const clone = cleanClone(contentEl);
    const fullText = getSafeText(clone);
    if (fullText.length < 25) return null;

    const exampleEls = clone.querySelectorAll('.example, pre, .example-block');
    let examplesText = '';
    exampleEls.forEach((ex, idx) => {
      examplesText += `\nExample ${idx + 1}:\n${getSafeText(ex)}\n`;
    });

    let constraintsEl = null;
    try {
      constraintsEl = clone.querySelector('ul:has(li code)') || clone.querySelector('.constraints');
    } catch {
      constraintsEl = clone.querySelector('.constraints') || clone.querySelector('ul');
    }
    const constraintsText = constraintsEl ? getSafeText(constraintsEl) : '';

    return {
      title: title || 'LeetCode Problem',
      fullText,
      examplesText: examplesText.trim(),
      constraintsText: constraintsText.trim()
    };
  }

  function extractGFGProblem() {
    const titleEl = document.querySelector('.problem-tab__name') ||
      document.querySelector('.problem-heading') ||
      document.querySelector('.g-m-0') ||
      document.querySelector('h3.header');

    let title = getSafeText(titleEl);
    if (!title) {
      const slugMatch = window.location.pathname.match(/\/problems\/([^/?#]+)/);
      if (slugMatch) {
        title = slugMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
    }

    const contentEl = document.querySelector('.problems_problem_content__X2ne7') ||
      document.querySelector('#problem-statement') ||
      document.querySelector('.problemQuestion') ||
      document.querySelector('.problem-description');

    if (!contentEl) return null;

    const clone = cleanClone(contentEl);
    const fullText = getSafeText(clone);
    if (fullText.length < 25) return null;

    const examplePres = clone.querySelectorAll('pre');
    let examplesText = '';
    examplePres.forEach((ex, idx) => {
      examplesText += `\nExample ${idx + 1}:\n${getSafeText(ex)}\n`;
    });

    return {
      title: title || 'GeeksforGeeks Problem',
      fullText,
      examplesText: examplesText.trim(),
      constraintsText: ''
    };
  }

  function extractHackerRankProblem() {
    const titleEl = document.querySelector('.challenge-page-label') ||
      document.querySelector('.ui-icon-label-page') ||
      document.querySelector('h1');

    const title = titleEl ? getSafeText(titleEl) : 'HackerRank Problem';
    const contentEl = document.querySelector('.problem-statement') ||
      document.querySelector('.problem-description-content') ||
      document.querySelector('.challenge-body-html');

    if (!contentEl) return null;

    const clone = cleanClone(contentEl);
    const fullText = getSafeText(clone);

    return { title, fullText, examplesText: '', constraintsText: '' };
  }

  function extractCodeforcesProblem() {
    const titleEl = document.querySelector('.problem-statement .title');
    const title = titleEl ? getSafeText(titleEl) : 'Codeforces Problem';
    const contentEl = document.querySelector('.problem-statement');

    if (!contentEl) return null;

    const clone = cleanClone(contentEl);
    const fullText = getSafeText(clone);

    return { title, fullText, examplesText: '', constraintsText: '' };
  }

  function extractGenericProblem() {
    const candidateSelectors = [
      'article.problem-description',
      'section.problem-description',
      '.problem-description',
      '#problem-statement',
      'div.coding-problem-description',
      'main [role="region"][aria-label*="description" i]',
      'main article'
    ];

    for (const sel of candidateSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const clone = cleanClone(el);
        const fullText = getSafeText(clone);
        if (fullText.length >= 25) {
          const heading = clone.querySelector('h1, h2, h3, h4');
          return {
            title: heading ? getSafeText(heading) : document.title.split('-')[0].trim(),
            fullText,
            examplesText: '',
            constraintsText: ''
          };
        }
      }
    }

    const selection = window.getSelection() ? window.getSelection().toString().trim() : '';
    if (selection.length >= 30) {
      return {
        title: 'Selected Coding Problem',
        fullText: selection,
        examplesText: '',
        constraintsText: ''
      };
    }

    return null;
  }

  function extractProblem() {
    const platformInfo = getPlatformInfo();
    let extractedData = null;

    if (platformInfo) {
      if (platformInfo.platform === 'leetcode') {
        extractedData = extractLeetCodeProblem();
      } else if (platformInfo.platform === 'gfg') {
        extractedData = extractGFGProblem();
      } else if (platformInfo.platform === 'hackerrank') {
        extractedData = extractHackerRankProblem();
      } else if (platformInfo.platform === 'codeforces') {
        extractedData = extractCodeforcesProblem();
      }
    }

    if (!extractedData) {
      extractedData = extractGenericProblem();
    }

    if (!extractedData || !extractedData.fullText) {
      return null;
    }

    const parts = [
      `TITLE: ${extractedData.title}`,
      '',
      'PROBLEM STATEMENT & SPECIFICATIONS:',
      extractedData.fullText
    ];

    if (extractedData.examplesText) {
      parts.push('', 'EXAMPLES & TEST CASES:', extractedData.examplesText);
    }

    if (extractedData.constraintsText) {
      parts.push('', 'CONSTRAINTS:', extractedData.constraintsText);
    }

    const promptText = parts.join('\n');
    const hash = `${platformInfo ? platformInfo.platform : 'generic'}:${extractedData.title.trim().substring(0, 35)}:${promptText.length}`;

    return {
      platform: platformInfo ? platformInfo.name : 'Coding Problem',
      title: extractedData.title,
      promptText,
      fullText: extractedData.fullText,
      examplesText: extractedData.examplesText,
      constraintsText: extractedData.constraintsText,
      hash
    };
  }

  // ---------------------------------------------------------------------------
  // Lightweight C++ Syntax Highlighter (Stealth Neon Palette)
  // ---------------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function highlightCppCode(rawCode) {
    if (!rawCode) return '';

    const lines = rawCode.split('\n');
    return lines.map(line => {
      if (line.trim().startsWith('//')) {
        return `<span class="sc-comm">${escapeHtml(line)}</span>`;
      }

      if (line.trim().startsWith('#')) {
        return `<span class="sc-prep">${escapeHtml(line)}</span>`;
      }

      let escaped = escapeHtml(line);
      escaped = escaped.replace(/(&quot;.*?&quot;)/g, '<span class="sc-str">$1</span>');

      const keywords = [
        'class', 'struct', 'public', 'private', 'protected', 'virtual', 'override',
        'int', 'long', 'double', 'float', 'bool', 'char', 'void', 'auto', 'size_t',
        'const', 'static', 'inline', 'constexpr', 'template', 'typename',
        'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
        'return', 'new', 'delete', 'nullptr', 'true', 'false', 'using', 'namespace',
        'std', 'vector', 'string', 'unordered_map', 'map', 'unordered_set', 'set',
        'pair', 'queue', 'deque', 'stack', 'priority_queue', 'algorithm', 'cout', 'cin'
      ];

      const kwRegex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g');
      escaped = escaped.replace(kwRegex, '<span class="sc-kw">$1</span>');
      escaped = escaped.replace(/\b(\d+)\b/g, '<span class="sc-num">$1</span>');

      return escaped;
    }).join('\n');
  }

  // ---------------------------------------------------------------------------
  // Reused MCQ Stealth Box Construction
  // ---------------------------------------------------------------------------

  function ensureStealthBoxCreated() {
    let root = document.getElementById('stealth-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'stealth-root';
      root.style.position = 'fixed';
      root.style.top = '0';
      root.style.left = '0';
      root.style.zIndex = '2147483647';
      root.style.pointerEvents = 'none';

      document.documentElement.appendChild(root);

      const shadow = root.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = `
        #box {
          position: fixed;
          top: 10px;
          left: 10px;
          transform: translateZ(9999px);
          background: rgba(0, 0, 0, 0.88);
          color: #00ffcc;
          padding: 8px 12px;
          font-size: 13px;
          border-radius: 6px;
          font-family: monospace;
          pointer-events: auto;
          max-width: min(720px, 92vw);
          min-width: 280px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.65);
          border: 1px solid rgba(0, 255, 204, 0.28);
          box-sizing: border-box;
          z-index: 2147483647;
          display: block;
        }

        :host([data-hidden="true"]) #box, #box.hidden {
          display: none !important;
        }

        .header-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          user-select: none;
        }

        .status-badge {
          font-weight: bold;
          font-size: 13px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 480px;
        }

        .loading {
          color: yellow !important;
        }

        .success {
          color: #00ffcc !important;
        }

        .error {
          color: #ff5252 !important;
        }

        .btn-group {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }

        .stealth-btn {
          background: rgba(0, 255, 204, 0.12);
          color: #00ffcc;
          border: 1px solid rgba(0, 255, 204, 0.35);
          padding: 2px 7px;
          border-radius: 4px;
          cursor: pointer;
          font-family: monospace;
          font-size: 11px;
          font-weight: bold;
          user-select: none;
          transition: background 0.15s ease;
        }

        .stealth-btn:hover {
          background: rgba(0, 255, 204, 0.25);
        }

        .stealth-btn:active {
          transform: scale(0.96);
        }

        .code-container {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(0, 255, 204, 0.2);
          max-height: 480px;
          overflow-y: auto;
          overflow-x: auto;
        }

        .code-container.hidden {
          display: none !important;
        }

        pre.code-block {
          margin: 0;
          padding: 0;
          font-family: monospace;
          font-size: 12.5px;
          line-height: 1.45;
          white-space: pre;
          color: #00ffcc;
        }

        /* Syntax highlight tokens */
        .sc-kw { color: #ffff00; font-weight: bold; }
        .sc-prep { color: #ff007f; font-weight: bold; }
        .sc-str { color: #00e5ff; }
        .sc-num { color: #ff9100; }
        .sc-comm { color: #78909c; font-style: italic; }

        .code-container::-webkit-scrollbar {
          width: 5px;
          height: 5px;
        }
        .code-container::-webkit-scrollbar-thumb {
          background: rgba(0, 255, 204, 0.3);
          border-radius: 3px;
        }
      `;

      const box = document.createElement('div');
      box.id = 'box';
      box.innerHTML = `
        <div class="header-row">
          <span id="status-badge" class="status-badge success">⚡ Smart-Coder C++17</span>
          <div class="btn-group">
            <button id="copy-btn" class="stealth-btn" title="Copy C++17 Solution">[Copy]</button>
            <button id="hide-btn" class="stealth-btn" title="Hide Box (Alt+Shift+H)">[✕]</button>
          </div>
        </div>
        <div id="code-container" class="code-container hidden">
          <pre class="code-block"><code id="code-view"></code></pre>
        </div>
      `;

      shadow.appendChild(style);
      shadow.appendChild(box);

      shadowRoot = shadow;
      stealthRoot = root;
      boxEl = box;

      setupStealthBoxEvents();
    } else {
      stealthRoot = root;
      shadowRoot = root.shadowRoot;
      boxEl = shadowRoot.getElementById('box');
    }

    return { root: stealthRoot, shadow: shadowRoot, box: boxEl };
  }

  function setupStealthBoxEvents() {
    const copyBtn = shadowRoot.getElementById('copy-btn');
    const hideBtn = shadowRoot.getElementById('hide-btn');
    const codeView = shadowRoot.getElementById('code-view');

    copyBtn.addEventListener('click', async () => {
      const rawCode = codeView.getAttribute('data-raw-code') || codeView.textContent;
      if (!rawCode || rawCode.startsWith('// Press Alt+Shift+G')) {
        return;
      }

      try {
        await navigator.clipboard.writeText(rawCode);
        copyBtn.textContent = '[Copied!]';
        setTimeout(() => { copyBtn.textContent = '[Copy]'; }, 2000);
      } catch {
        const temp = document.createElement('textarea');
        temp.value = rawCode;
        temp.style.position = 'fixed';
        temp.style.left = '-9999px';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        copyBtn.textContent = '[Copied!]';
        setTimeout(() => { copyBtn.textContent = '[Copy]'; }, 2000);
      }
    });

    hideBtn.addEventListener('click', () => {
      hideStealthBox();
    });
  }

  // ---------------------------------------------------------------------------
  // Status & Display Logic (Preserving MCQ Look: yellow=loading, #00ffcc=success, red=error)
  // ---------------------------------------------------------------------------

  function updateStatus(text, type = 'success') {
    ensureStealthBoxCreated();
    const statusBadge = shadowRoot.getElementById('status-badge');
    statusBadge.textContent = text;
    statusBadge.className = `status-badge ${type}`;
  }

  function displaySolutionInBox(code) {
    ensureStealthBoxCreated();
    const codeContainer = shadowRoot.getElementById('code-container');
    const codeView = shadowRoot.getElementById('code-view');

    codeView.setAttribute('data-raw-code', code);
    codeView.innerHTML = highlightCppCode(code);
    codeContainer.classList.remove('hidden');
  }

  function hideStealthBox() {
    ensureStealthBoxCreated();
    isBoxHidden = true;
    stealthRoot.style.display = 'none';
    stealthRoot.setAttribute('data-hidden', 'true');
  }

  function restoreStealthBox() {
    ensureStealthBoxCreated();
    isBoxHidden = false;
    stealthRoot.removeAttribute('data-hidden');
    stealthRoot.style.display = 'block';

    // Sync question detection without making API call
    syncQuestionMetadata();

    // If solution exists for this problem, show it; else prompt
    if (currentProblem && solutionCache.has(currentProblem.hash)) {
      displaySolutionInBox(solutionCache.get(currentProblem.hash));
      updateStatus(`⚡ ${currentProblem.title} (C++17 Ready)`, 'success');
    } else {
      updateStatus(currentProblem ? `⚡ ${currentProblem.title}: Press Alt+Shift+G` : 'Press Alt+Shift+G to solve', 'success');
      const codeContainer = shadowRoot.getElementById('code-container');
      const codeView = shadowRoot.getElementById('code-view');
      codeView.removeAttribute('data-raw-code');
      codeContainer.classList.add('hidden');
    }
  }

  function syncQuestionMetadata() {
    const problem = extractProblem();
    if (problem) {
      currentProblem = problem;
      if (solutionCache.has(problem.hash)) {
        displaySolutionInBox(solutionCache.get(problem.hash));
        updateStatus(`⚡ ${problem.title} (C++17 Ready)`, 'success');
      } else {
        updateStatus(`⚡ ${problem.title}: Press Alt+Shift+G`, 'success');
      }
    } else {
      updateStatus('Press Alt+Shift+G to solve', 'success');
    }
  }

  // ---------------------------------------------------------------------------
  // C++17 Solution Generation Workflow (Alt + Shift + G)
  // ---------------------------------------------------------------------------

  async function triggerGenerateSolution() {
    if (isGenerating) {
      return; // In-flight lock prevents duplicate calls
    }

    ensureStealthBoxCreated();
    if (isBoxHidden) {
      isBoxHidden = false;
      stealthRoot.removeAttribute('data-hidden');
      stealthRoot.style.display = 'block';
    }

    const problem = extractProblem();
    if (!problem) {
      updateStatus('Could not detect question. Open LeetCode/GFG and retry.', 'error');
      return;
    }

    currentProblem = problem;

    // Check session cache first
    if (solutionCache.has(problem.hash)) {
      const cached = solutionCache.get(problem.hash);
      displaySolutionInBox(cached);
      lastSolvedHash = problem.hash;
      updateStatus(`⚡ ${problem.title} (from cache)`, 'success');
      return;
    }

    // Progress State: Reading question… -> Generating C++ solution… -> Solution ready
    isGenerating = true;
    updateStatus('Reading question…', 'loading');

    try {
      setTimeout(() => {
        if (isGenerating) {
          updateStatus(`Generating C++17: ${problem.title.substring(0, 24)}…`, 'loading');
        }
      }, 400);

      if (!chrome.runtime || !chrome.runtime.sendMessage) {
        throw new Error('Extension context invalidated. Please refresh the page.');
      }

      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'GENERATE_SOLUTION', problemText: problem.promptText },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(res || { success: false, error: 'No response from service worker' });
            }
          }
        );
      });

      if (!response || !response.success) {
        const errorText = response && response.error ? response.error : 'Generation failed.';
        if (errorText.includes('API key is missing')) {
          updateStatus('API key missing. Press Alt+Shift+A to activate.', 'error');
        } else {
          updateStatus(`Error: ${errorText.substring(0, 60)}`, 'error');
        }
        return;
      }

      const solutionCode = response.code;
      solutionCache.set(problem.hash, solutionCode);
      lastSolvedHash = problem.hash;

      displaySolutionInBox(solutionCode);
      updateStatus(`⚡ ${problem.title} (C++17 Ready)`, 'success');
    } catch (err) {
      updateStatus(`Error: ${err.message || 'Generation error'}`, 'error');
    } finally {
      isGenerating = false;
    }
  }

  // ---------------------------------------------------------------------------
  // SPA Navigation Watcher (LeetCode / GFG SPA Routing)
  // ---------------------------------------------------------------------------

  function handleSpaNavigation() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastCheckedUrl) {
      lastCheckedUrl = currentUrl;

      // When problem changes, if box is visible, update title without unsolicited API call
      if (!isBoxHidden) {
        if (navDebounceTimer) clearTimeout(navDebounceTimer);
        navDebounceTimer = setTimeout(() => {
          if (!isBoxHidden && getPlatformInfo()) {
            syncQuestionMetadata();
          }
        }, 600);
      }
    }
  }

  const origPushState = history.pushState;
  history.pushState = function() {
    origPushState.apply(this, arguments);
    handleSpaNavigation();
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function() {
    origReplaceState.apply(this, arguments);
    handleSpaNavigation();
  };

  window.addEventListener('popstate', handleSpaNavigation);
  setInterval(handleSpaNavigation, 1200);

  // ---------------------------------------------------------------------------
  // Keyboard Shortcuts (Alt+Shift+G, Alt+Shift+H, Alt+Shift+R, Alt+Shift+A)
  // ---------------------------------------------------------------------------

  function handleInPageKeyboardShortcut(e) {
    if (!e.altKey || !e.shiftKey) {
      return;
    }

    const key = (e.key || '').toUpperCase();
    if (!['G', 'H', 'R', 'A'].includes(key)) {
      return;
    }

    const now = Date.now();
    if (now - lastShortcutTriggerTime < 350) {
      return;
    }
    lastShortcutTriggerTime = now;

    if (key === 'G') {
      e.preventDefault();
      e.stopPropagation();
      triggerGenerateSolution();
    } else if (key === 'H') {
      e.preventDefault();
      e.stopPropagation();
      hideStealthBox();
    } else if (key === 'R') {
      e.preventDefault();
      e.stopPropagation();
      restoreStealthBox();
    } else if (key === 'A') {
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ action: 'OPEN_SETTINGS' });
      } catch {}
    }
  }

  window.addEventListener('keydown', handleInPageKeyboardShortcut, true);

  // ---------------------------------------------------------------------------
  // Chrome Commands & Runtime Messages Listener
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) {
      return false;
    }

    // 1. Shortcut: Alt + Shift + G
    if (message.action === 'SHORTCUT_GENERATE_SOLUTION' || message.action === 'TRIGGER_GENERATE_FROM_PAGE') {
      const now = Date.now();
      if (now - lastShortcutTriggerTime >= 350) {
        lastShortcutTriggerTime = now;
        triggerGenerateSolution();
      }
      sendResponse({ status: 'started' });
      return false;
    }

    // 2. Shortcut: Alt + Shift + H
    if (message.action === 'SHORTCUT_HIDE_PANEL') {
      const now = Date.now();
      if (now - lastShortcutTriggerTime >= 350) {
        lastShortcutTriggerTime = now;
        hideStealthBox();
      }
      sendResponse({ status: 'hidden' });
      return false;
    }

    // 3. Shortcut: Alt + Shift + R
    if (message.action === 'SHORTCUT_RESTORE_PANEL') {
      const now = Date.now();
      if (now - lastShortcutTriggerTime >= 350) {
        lastShortcutTriggerTime = now;
        restoreStealthBox();
      }
      sendResponse({ status: 'restored' });
      return false;
    }

    // Toggle box
    if (message.action === 'TOGGLE_SIDE_PANEL') {
      if (isBoxHidden) {
        restoreStealthBox();
      } else {
        hideStealthBox();
      }
      sendResponse({ success: true, isHidden: isBoxHidden });
      return false;
    }

    // Extraction request
    if (message.action === 'EXTRACT_PROBLEM_TEXT') {
      const problem = extractProblem();
      sendResponse({
        success: Boolean(problem && problem.promptText),
        problemText: problem ? problem.promptText : '',
        title: problem ? problem.title : '',
        platform: problem ? problem.platform : ''
      });
      return false;
    }

    return false;
  });

  // ---------------------------------------------------------------------------
  // Initial Boot
  // ---------------------------------------------------------------------------
  const platform = getPlatformInfo();
  if (platform) {
    ensureStealthBoxCreated();
    // Silently detect metadata without making unsolicited Gemini API calls
    setTimeout(syncQuestionMetadata, 600);
  }
})();
