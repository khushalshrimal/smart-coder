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

  /**
   * Safe diagnostic logger for content script operations.
   * NEVER logs API keys, private tokens, or user data.
   */
  function logDiagnostic(stage, data = {}) {
    const sanitized = { ...data };
    delete sanitized.apiKey;
    delete sanitized.key;
    delete sanitized.prompt;
    delete sanitized.fullText;
    delete sanitized.problemText;
    console.log(`[Smart-Coder Gemini][Diagnostic][Content] ${stage}:`, sanitized);
  }

  logDiagnostic('INJECTION', {
    host: window.location.hostname || 'local',
    pathname: window.location.pathname,
    isTopFrame: window === window.top
  });

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
    if (url.includes('leetcode.com') || url.includes('leetcode.cn')) {
      const match = url.match(/\/problems\/([^/?#]+)/);
      return { platform: 'leetcode', name: 'LeetCode', slug: match ? match[1] : window.location.pathname };
    }
    if (url.includes('geeksforgeeks.org') || url.includes('gfg')) {
      const match = url.match(/\/problems\/([^/?#]+)/) || url.match(/\/problem\/([^/?#]+)/);
      return { platform: 'gfg', name: 'GeeksforGeeks', slug: match ? match[1] : window.location.pathname };
    }
    if (url.includes('hackerrank.com/challenges/')) {
      const match = url.match(/\/challenges\/([^/?#]+)/);
      return { platform: 'hackerrank', name: 'HackerRank', slug: match ? match[1] : '' };
    }
    if (url.includes('codeforces.com/problemset/problem/') || url.includes('codeforces.com/contest/')) {
      return { platform: 'codeforces', name: 'Codeforces', slug: window.location.pathname };
    }

    // DOM-based fallback for mirrors, staging, local demo or test environments
    if (document.querySelector('[data-track-load="description_content"], .elfjS, div[data-cy="question-title"], div[class*="description__"]')) {
      return { platform: 'leetcode', name: 'LeetCode', slug: window.location.pathname };
    }
    if (document.querySelector('div[class*="problems_problem_content"], div[class*="problem_content"], div[class*="problem-statement"], [class*="problem-tab__name"], [class*="problems_header_content"], [class*="problems_problem_page"]')) {
      return { platform: 'gfg', name: 'GeeksforGeeks', slug: window.location.pathname };
    }

    const genericEl = document.querySelector('.problem-description, #problem-statement, .problem-statement, article.problem-description, div.coding-problem-description, #sample-problem, [data-testid="problem-description"]');
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

  /**
   * Extracts the starter code template from the on-page editor (Monaco, CodeMirror, Ace, or Textarea).
   */
  function extractEditorTemplate() {
    // 1. Monaco Editor (Used on LeetCode and modern GeeksforGeeks)
    const monacoLines = document.querySelectorAll('.monaco-editor .view-lines .view-line');
    if (monacoLines && monacoLines.length > 0) {
      const code = Array.from(monacoLines).map(l => l.textContent).join('\n').trim();
      if (code.length > 10 && /\b(class|struct|int|void|string|vector)\b/.test(code)) {
        return code;
      }
    }

    // 2. CodeMirror Editor
    const cmLines = document.querySelectorAll('.CodeMirror-line');
    if (cmLines && cmLines.length > 0) {
      const code = Array.from(cmLines).map(l => l.textContent).join('\n').trim();
      if (code.length > 10 && /\b(class|struct|int|void|string|vector)\b/.test(code)) {
        return code;
      }
    }

    // 3. Ace Editor
    const aceLines = document.querySelectorAll('.ace_editor .ace_line');
    if (aceLines && aceLines.length > 0) {
      const code = Array.from(aceLines).map(l => l.textContent).join('\n').trim();
      if (code.length > 10 && /\b(class|struct|int|void|string|vector)\b/.test(code)) {
        return code;
      }
    }

    // 4. Textarea editor / embedded code template
    const textareas = document.querySelectorAll('textarea#code, textarea.code, textarea[name="code"], [data-template-code], #template-code');
    for (const ta of textareas) {
      const text = (ta.value || ta.textContent || '').trim();
      if (text.length > 10 && /\b(class|struct|int|void|string|vector)\b/.test(text)) {
        return text;
      }
    }

    // 5. Embedded Next.js script on GFG
    const nextScript = document.getElementById('__NEXT_DATA__');
    if (nextScript && nextScript.textContent) {
      try {
        const parsed = JSON.parse(nextScript.textContent);
        const prob = parsed?.props?.pageProps?.initialState?.problemData?.allData?.probData;
        if (prob) {
          const possibleTemplates = [
            prob.cpp_template,
            prob.code_templates?.cpp,
            prob.code_templates?.['c++'],
            prob.initial_code,
            prob.driver_code
          ];
          for (const t of possibleTemplates) {
            if (t && typeof t === 'string' && t.trim().length > 10) {
              return t.trim();
            }
          }
        }
      } catch {}
    }

    return null;
  }

  /**
   * Attempts to detect function/class signature directly from problem statement text.
   */
  function extractSignatureFromText(fullText) {
    if (!fullText) return null;

    // 1. Look for class Solution { ... } block in text
    const classMatch = fullText.match(/class\s+Solution\s*\{[\s\S]*?\}/);
    if (classMatch) {
      return classMatch[0].trim();
    }

    // 2. Look for "Your Task: ... complete the function <name>(...)"
    const taskMatch = fullText.match(/(?:Your\s+Task|complete\s+the\s+function)[\s\S]*?`?([a-zA-Z0-9_]+)\s*\(([^)]*)\)`?/i);
    if (taskMatch) {
      const fnName = taskMatch[1];
      const params = taskMatch[2];
      return `class Solution { public: auto ${fnName}(${params}); };`;
    }

    // 3. Look for C++ function declaration in problem statement
    const fnDeclMatch = fullText.match(/\b(int|void|string|vector<[^>]+>|bool|long\s+long|double)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
    if (fnDeclMatch) {
      return `class Solution { public: ${fnDeclMatch[0]}; };`;
    }

    return null;
  }

  function extractLeetCodeProblem() {
    const titleEl = document.querySelector('div[data-cy="question-title"]') ||
      document.querySelector('.text-title-large') ||
      document.querySelector('div[class*="titleLarge"]') ||
      document.querySelector('div.flex.items-start.justify-between h4') ||
      document.querySelector('h4[data-cy="question-title"]') ||
      document.querySelector('h1, h2, h3, h4');

    let title = getSafeText(titleEl);
    if (!title) {
      const slugMatch = window.location.pathname.match(/\/problems\/([^/?#]+)/);
      if (slugMatch) {
        title = slugMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      } else if (document.title) {
        title = document.title.split('-')[0].trim();
      }
    }

    const contentEl = document.querySelector('[data-track-load="description_content"]') ||
      document.querySelector('.elfjS') ||
      document.querySelector('div[class*="elfjS"]') ||
      document.querySelector('div[class*="description__"]') ||
      document.querySelector('div[class*="question-content"]') ||
      document.querySelector('div.question-content__JfgR') ||
      document.querySelector('div[data-key="description-content"]');

    let fullText = '';
    let examplesText = '';
    let constraintsText = '';

    if (contentEl) {
      const clone = cleanClone(contentEl);
      fullText = getSafeText(clone);

      const exampleEls = clone.querySelectorAll('.example, pre, .example-block, [class*="example"]');
      exampleEls.forEach((ex, idx) => {
        examplesText += `\nExample ${idx + 1}:\n${getSafeText(ex)}\n`;
      });

      let constraintsEl = null;
      try {
        constraintsEl = clone.querySelector('ul:has(li code)') || clone.querySelector('.constraints, [class*="constraints"]');
      } catch {
        constraintsEl = clone.querySelector('.constraints, [class*="constraints"]') || clone.querySelector('ul');
      }
      constraintsText = constraintsEl ? getSafeText(constraintsEl) : '';
    }

    // Fallback to meta[name="description"] if DOM is not yet populated
    if (fullText.length < 25) {
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc && metaDesc.content && metaDesc.content.trim().length >= 25) {
        fullText = metaDesc.content.trim();
      }
    }

    if (fullText.length < 25) return null;

    const templateCode = extractEditorTemplate();
    const signature = extractSignatureFromText(fullText);

    return {
      title: title || 'LeetCode Problem',
      fullText,
      examplesText: examplesText.trim(),
      constraintsText: constraintsText.trim(),
      templateCode,
      signature
    };
  }

  function extractGFGProblem() {
    // 1. Title extraction from live DOM headings
    const titleEl = document.querySelector('div[class*="problems_header_content__title"]') ||
      document.querySelector('div[class*="problems_header_content"] h3') ||
      document.querySelector('div[class*="problems_header_content"]') ||
      document.querySelector('.problem-tab__name, [class*="problem-tab__name"]') ||
      document.querySelector('.problem-heading, [class*="problem-heading"]') ||
      document.querySelector('h3.g-m-0, [class*="g-m-0"]') ||
      document.querySelector('h3.header, h2.header, h1.header') ||
      document.querySelector('h3, h2, h1');

    let title = getSafeText(titleEl);

    // 2. Parse __NEXT_DATA__ JSON script for embedded Next.js problem state
    let nextDataProblem = null;
    const nextScript = document.getElementById('__NEXT_DATA__');
    if (nextScript && nextScript.textContent) {
      try {
        const parsed = JSON.parse(nextScript.textContent);
        const prob = parsed?.props?.pageProps?.initialState?.problemData?.allData?.probData;
        if (prob && (prob.problem_name || prob.problem_question)) {
          nextDataProblem = prob;
        }
      } catch {}
    }

    if (!title && nextDataProblem?.problem_name) {
      title = nextDataProblem.problem_name;
    }

    if (!title) {
      const slugMatch = window.location.pathname.match(/\/problems\/([^/?#]+)/) ||
        window.location.pathname.match(/\/problem\/([^/?#]+)/);
      if (slugMatch) {
        title = slugMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      } else if (document.title) {
        title = document.title.split('|')[0].split('-')[0].trim();
      }
    }

    // 3. Extract content from DOM:
    // Match dynamic class names such as problems_problem_content__Xm_eO, problems_problem_content__X2ne7, etc.
    const contentEl = document.querySelector('div[class*="problems_problem_content"]') ||
      document.querySelector('div[class*="problem_content"]') ||
      document.querySelector('.problems_problem_content__X2ne7') ||
      document.querySelector('.problems_problem_content__Xm_eO') ||
      document.querySelector('#problem-statement, .problem-statement') ||
      document.querySelector('.problemQuestion, [class*="problemQuestion"]') ||
      document.querySelector('.problem-description, [class*="problem-description"]');

    let fullText = '';
    let examplesText = '';
    let constraintsText = '';

    if (contentEl) {
      const clone = cleanClone(contentEl);
      fullText = getSafeText(clone);

      const examplePres = clone.querySelectorAll('pre');
      examplePres.forEach((ex, idx) => {
        examplesText += `\nExample ${idx + 1}:\n${getSafeText(ex)}\n`;
      });
    }

    // 4. Fallback to __NEXT_DATA__ JSON if DOM content is not yet populated or too short
    if (fullText.length < 25 && nextDataProblem?.problem_question) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = nextDataProblem.problem_question;
      const parsedText = getSafeText(tempDiv);
      if (parsedText.length >= 25) {
        fullText = parsedText;
        constraintsText = nextDataProblem.constraints_display || '';
        const pres = tempDiv.querySelectorAll('pre');
        pres.forEach((ex, idx) => {
          examplesText += `\nExample ${idx + 1}:\n${getSafeText(ex)}\n`;
        });
      }
    }

    // 5. Fallback to meta[name="description"] if still empty
    if (fullText.length < 25) {
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc && metaDesc.content && metaDesc.content.trim().length >= 25) {
        fullText = metaDesc.content.trim();
      }
    }

    if (fullText.length < 25) {
      return null;
    }

    const templateCode = extractEditorTemplate();
    const signature = extractSignatureFromText(fullText);

    return {
      title: title || 'GeeksforGeeks Problem',
      fullText,
      examplesText: examplesText.trim(),
      constraintsText: constraintsText.trim(),
      templateCode,
      signature
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
      '.problem-statement',
      'div.coding-problem-description',
      'div.problem-body',
      'div.question-body',
      'div.question-description',
      'main [role="region"][aria-label*="description" i]',
      'main article',
      'article',
      '[data-testid="problem-description"]',
      '#sample-problem',
      '.sample-problem',
      '.problem-content',
      '#problem-body'
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

    // Try same-origin child iframes if top frame didn't match
    const iframes = document.querySelectorAll('iframe');
    for (const frame of iframes) {
      try {
        if (frame.contentDocument) {
          for (const sel of candidateSelectors) {
            const el = frame.contentDocument.querySelector(sel);
            if (el) {
              const clone = cleanClone(el);
              const fullText = getSafeText(clone);
              if (fullText.length >= 25) {
                const heading = clone.querySelector('h1, h2, h3, h4');
                return {
                  title: heading ? getSafeText(heading) : (frame.contentDocument.title || document.title).split('-')[0].trim(),
                  fullText,
                  examplesText: '',
                  constraintsText: ''
                };
              }
            }
          }
        }
      } catch {}
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
    logDiagnostic('EXTRACTION_START', { platform: platformInfo?.name || 'Generic' });
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

    if (!extractedData || !extractedData.fullText || extractedData.fullText.trim().length < 25) {
      logDiagnostic('EXTRACTION_FAILED', {
        platform: platformInfo?.name || 'None',
        url: window.location.href,
        hasTitle: Boolean(extractedData?.title)
      });
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

    const isJudgePlatform = platformInfo && (platformInfo.platform === 'gfg' || platformInfo.platform === 'leetcode');
    const hasReliableSignature = Boolean(extractedData.templateCode || extractedData.signature);

    const problemResult = {
      platform: platformInfo ? platformInfo.name : 'Coding Problem',
      platformKey: platformInfo ? platformInfo.platform : 'generic',
      title: extractedData.title,
      promptText,
      templateCode: extractedData.templateCode || '',
      signature: extractedData.signature || '',
      needsTemplateInspection: Boolean(isJudgePlatform && !hasReliableSignature),
      fullText: extractedData.fullText,
      examplesText: extractedData.examplesText,
      constraintsText: extractedData.constraintsText,
      hash
    };

    logDiagnostic('EXTRACTION_SUCCESS', {
      platform: problemResult.platform,
      title: problemResult.title,
      textLength: problemResult.promptText.length,
      hash: problemResult.hash
    });

    return problemResult;
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
    // Only inject UI stealth box in top-level frame to avoid broken/duplicate UI in iframes
    if (window !== window.top) {
      return;
    }
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
          background: rgba(0, 0, 0, 0.85);
          color: #00ffcc;
          padding: 6px 10px;
          font-size: 14px;
          font-weight: bold;
          border-radius: 6px;
          font-family: monospace;
          pointer-events: auto;
          max-width: min(720px, 92vw);
          box-sizing: border-box;
          z-index: 2147483647;
          display: block;
        }

        :host([data-hidden="true"]) #box, #box.hidden {
          display: none !important;
        }

        .loading {
          color: yellow !important;
        }

        .success {
          color: #00ffcc !important;
        }

        .error {
          color: red !important;
        }

        .stealth-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          user-select: none;
        }

        .stealth-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .stealth-actions.hidden {
          display: none !important;
        }

        .stealth-btn {
          cursor: pointer;
          color: #00ffcc;
          font-family: monospace;
          font-size: 12px;
          font-weight: bold;
          user-select: none;
        }

        .stealth-btn:hover {
          color: #ffffff;
        }

        #code-box {
          margin: 6px 0 0 0;
          padding: 6px 0 0 0;
          border-top: 1px solid rgba(0, 255, 204, 0.2);
          max-height: 480px;
          overflow-y: auto;
          overflow-x: auto;
        }

        #code-box.hidden {
          display: none !important;
        }

        pre.code-block {
          margin: 0;
          padding: 0;
          font-family: monospace;
          font-size: 13px;
          font-weight: normal;
          line-height: 1.45;
          white-space: pre;
          color: #00ffcc;
        }

        /* Syntax highlight tokens */
        .sc-kw { color: yellow; font-weight: bold; }
        .sc-prep { color: #ff007f; font-weight: bold; }
        .sc-str { color: #00e5ff; }
        .sc-num { color: #ff9100; }
        .sc-comm { color: #78909c; font-style: italic; }

        #code-box::-webkit-scrollbar {
          width: 5px;
          height: 5px;
        }
        #code-box::-webkit-scrollbar-thumb {
          background: rgba(0, 255, 204, 0.35);
          border-radius: 3px;
        }
      `;

      const box = document.createElement('div');
      box.id = 'box';
      box.className = 'success';
      box.innerHTML = `
        <div class="stealth-header">
          <span id="status-badge" class="success">Press Alt+Shift+G to solve</span>
          <div id="action-controls" class="stealth-actions hidden">
            <span id="copy-btn" class="stealth-btn" title="Copy C++17 Solution">[Copy]</span>
            <span id="hide-btn" class="stealth-btn" title="Hide Box (Alt+Shift+H)">[✕]</span>
          </div>
        </div>
        <div id="code-box" class="hidden">
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
  // Status & Display Logic (Faithful to MCQ Look: yellow=loading, #00ffcc=success, red=error)
  // ---------------------------------------------------------------------------

  function updateStatus(text, type = 'success') {
    ensureStealthBoxCreated();
    const statusBadge = shadowRoot.getElementById('status-badge');
    const actionControls = shadowRoot.getElementById('action-controls');
    const codeBox = shadowRoot.getElementById('code-box');

    if (actionControls) actionControls.classList.add('hidden');
    if (codeBox) codeBox.classList.add('hidden');

    boxEl.className = type;
    statusBadge.textContent = text;
    statusBadge.className = type;
  }

  function displaySolutionInBox(title, code) {
    ensureStealthBoxCreated();
    const statusBadge = shadowRoot.getElementById('status-badge');
    const actionControls = shadowRoot.getElementById('action-controls');
    const codeBox = shadowRoot.getElementById('code-box');
    const codeView = shadowRoot.getElementById('code-view');

    boxEl.className = 'success';
    statusBadge.textContent = title ? `⚡ ${title} (C++17 Ready)` : '⚡ C++17 Solution Ready';
    statusBadge.className = 'success';

    codeView.setAttribute('data-raw-code', code);
    codeView.innerHTML = highlightCppCode(code);

    if (actionControls) actionControls.classList.remove('hidden');
    if (codeBox) codeBox.classList.remove('hidden');
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
      displaySolutionInBox(currentProblem.title, solutionCache.get(currentProblem.hash));
    } else {
      updateStatus(currentProblem ? `⚡ ${currentProblem.title}: Press Alt+Shift+G` : 'Press Alt+Shift+G to solve', 'success');
      const codeBox = shadowRoot.getElementById('code-box');
      const codeView = shadowRoot.getElementById('code-view');
      if (codeView) codeView.removeAttribute('data-raw-code');
      if (codeBox) codeBox.classList.add('hidden');
    }
  }

  function syncQuestionMetadata() {
    const problem = extractProblem();
    if (problem) {
      currentProblem = problem;
      if (solutionCache.has(problem.hash)) {
        displaySolutionInBox(problem.title, solutionCache.get(problem.hash));
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

    // If required signature cannot be identified reliably on LeetCode/GFG, report that template needs inspection
    if (problem.needsTemplateInspection) {
      updateStatus('Template inspection needed: editor signature not found', 'error');
      return;
    }

    currentProblem = problem;

    // Check session cache first
    if (solutionCache.has(problem.hash)) {
      const cached = solutionCache.get(problem.hash);
      displaySolutionInBox(problem.title, cached);
      lastSolvedHash = problem.hash;
      return;
    }

    // Progress State: ... -> ... Reading question -> ... Generating C++17
    isGenerating = true;
    updateStatus('...', 'loading');

    try {
      setTimeout(() => {
        if (isGenerating) {
          updateStatus('... Reading question', 'loading');
        }
      }, 300);

      setTimeout(() => {
        if (isGenerating) {
          updateStatus('... Generating C++17', 'loading');
        }
      }, 800);

      if (!chrome.runtime || !chrome.runtime.sendMessage) {
        throw new Error('Extension context invalidated. Please refresh the page.');
      }

      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'GENERATE_SOLUTION',
            problemText: problem.promptText,
            platform: problem.platformKey,
            templateCode: problem.templateCode || '',
            signature: problem.signature || ''
          },
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
        if (errorText.includes('API key is missing') || errorText.includes('Invalid API Key')) {
          updateStatus('KEY! Press Alt+Shift+A to configure', 'error');
        } else if (response.category === 'TOKEN_LIMIT_TRUNCATED' || errorText.includes('MAX_TOKENS') || errorText.includes('token limit')) {
          updateStatus('Error: Output truncated. Increase tokens in Settings', 'error');
        } else {
          updateStatus(`Error: ${errorText.substring(0, 50)}`, 'error');
        }
        return;
      }

      const solutionCode = response.code;
      solutionCache.set(problem.hash, solutionCode);
      lastSolvedHash = problem.hash;

      displaySolutionInBox(problem.title, solutionCode);
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
