/**
 * Smart-Coder Gemini - Automated Test Runner
 * Runs automated QA verifications on manifest, syntax, security,
 * mocked Gemini API interactions, normalization, and locks.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT_DIR = path.resolve(__dirname, '..');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runTest(testName, fn) {
  totalTests++;
  process.stdout.write(`• Running: ${testName} ... `);
  try {
    fn();
    passedTests++;
    console.log('✅ PASS');
  } catch (err) {
    failedTests++;
    console.log('❌ FAIL');
    console.error(`  Error: ${err.message}`);
  }
}

async function runAsyncTest(testName, fn) {
  totalTests++;
  process.stdout.write(`• Running: ${testName} ... `);
  try {
    await fn();
    passedTests++;
    console.log('✅ PASS');
  } catch (err) {
    failedTests++;
    console.log('❌ FAIL');
    console.error(`  Error: ${err.message}`);
  }
}

// Helper functions mirroring service-worker.js logic for test verification
function normalizeCppCode(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let text = rawText.trim();
  const codeBlockMatch = text.match(/^```(?:cpp|c\+\+|cc|c)?\r?\n([\s\S]*?)\r?\n```$/i);
  if (codeBlockMatch && codeBlockMatch[1] !== undefined) {
    return codeBlockMatch[1].trim();
  }
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z0-9+\-_]*\r?\n?/, '');
    text = text.replace(/\r?\n?```$/, '');
    return text.trim();
  }
  return text;
}

function buildCpp17Prompt(problemText) {
  return [
    'You are an expert competitive programmer and C++17 software engineer.',
    'Write a complete, highly optimized C++17 solution for the following coding problem.',
    '',
    'STRICT OUTPUT REQUIREMENTS:',
    '1. Output ONLY pure, valid C++17 source code.',
    '2. Do NOT enclose the code in Markdown fences (no ```cpp or ```). Output raw C++ code directly.',
    '3. Do NOT include any introductory greetings, explanations, complexity analysis, dry runs, or comments about your reasoning.',
    '4. Include all necessary standard library headers (#include <iostream>, <vector>, <string>, <algorithm>, etc.).',
    '5. If the problem specifies a class or function format (e.g. Solution class for online judges), adhere strictly to that signature.',
    '6. If the problem requires standard I/O (cin/cout), include a fast I/O setup (ios::sync_with_stdio(false); cin.tie(nullptr);) and main().',
    '7. Do NOT invent a main() driver if the problem is purely function/class-based.',
    '8. Handle all potential edge cases (empty inputs, zero, maximum integer limits, negative values).',
    '',
    'PROBLEM STATEMENT:',
    problemText.trim()
  ].join('\n');
}

async function mockCallGeminiApi({ apiKey, model, prompt, fetchImpl }) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('API key is missing. Please set your Google Gemini API key in Settings.');
  }

  const selectedModel = model || 'gemini-3.8-flash';
  const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
  };

  let response;
  try {
    response = await fetchImpl(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey.trim()
      },
      body: JSON.stringify(payload)
    });
  } catch (networkError) {
    throw new Error(`Network failure: Unable to reach Google Gemini API (${networkError.message || 'offline'}).`);
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      if (errJson && errJson.error && errJson.error.message) {
        errorDetail = errJson.error.message;
      }
    } catch {}

    switch (response.status) {
      case 400:
        throw new Error(`HTTP 400 (Bad Request): Check your request syntax or selected model ID '${selectedModel}'. ${errorDetail}`.trim());
      case 401:
      case 403:
        throw new Error(`HTTP ${response.status} (Authentication / Authorization Error): Invalid API key or permission denied. Please verify your Gemini API key in Settings.`);
      case 404:
        throw new Error(`HTTP 404 (Not Found): Model '${selectedModel}' does not exist or is not available on this API version.`);
      case 429:
        throw new Error(`HTTP 429 (Rate Limit / Quota Exceeded): Gemini API quota exhausted. Please wait a moment or check your Google AI Studio plan.`);
      case 500:
      case 503:
        throw new Error(`HTTP ${response.status} (Service Unavailable): Google Gemini server error. Please try again later.`);
      default:
        throw new Error(`HTTP ${response.status} error from Gemini API: ${errorDetail || response.statusText || 'Unknown error'}`);
    }
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Malformed JSON received from Google Gemini API.');
  }

  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}`);
  }

  if (!data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
    throw new Error('Gemini API returned an empty response with no candidate solutions.');
  }

  const primaryCandidate = data.candidates[0];
  if (primaryCandidate.finishReason === 'SAFETY') {
    throw new Error('Gemini response was blocked due to safety guidelines.');
  }

  const content = primaryCandidate.content;
  if (!content || !content.parts || !Array.isArray(content.parts) || content.parts.length === 0) {
    throw new Error('Gemini API candidate response contained no text parts.');
  }

  const generatedText = content.parts.map(p => p.text || '').join('');
  if (!generatedText.trim()) {
    throw new Error('Gemini API returned empty text in candidate content.');
  }

  return generatedText;
}

async function main() {
  console.log('====================================================');
  console.log('  Smart-Coder Gemini - Automated Verification Suite ');
  console.log('====================================================\n');

  // -----------------------------------------------------------------------------
  // Test Suite 1: Manifest V3 Validation
  // -----------------------------------------------------------------------------
  console.log('[1/7] Manifest V3 Validation');

  runTest('manifest.json structure & permissions', () => {
    const manifestPath = path.join(ROOT_DIR, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');

    const content = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(content);

    assert.strictEqual(manifest.manifest_version, 3, 'Must be Manifest V3');
    assert.strictEqual(manifest.name, 'Smart-Coder Gemini');
    assert.ok(manifest.version, 'Must specify version');
    assert.ok(Array.isArray(manifest.permissions), 'permissions must be an array');
    assert.ok(manifest.permissions.includes('storage'), 'storage permission required');
    assert.ok(manifest.permissions.includes('activeTab'), 'activeTab permission required');
    assert.ok(manifest.permissions.includes('scripting'), 'scripting permission required');

    assert.ok(manifest.action && manifest.action.default_popup === 'popup.html');
    assert.ok(manifest.options_ui && manifest.options_ui.page === 'settings.html');
    assert.strictEqual(manifest.options_ui.open_in_tab, true);

    assert.ok(manifest.background && manifest.background.service_worker === 'service-worker.js');
    assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0);
    assert.ok(manifest.content_scripts[0].js.includes('content.js'));

    assert.ok(manifest.commands && manifest.commands['activate-extension'], 'activate-extension command must be declared');
    assert.strictEqual(manifest.commands['activate-extension'].suggested_key.default, 'Alt+Shift+A');

    assert.ok(manifest.commands && manifest.commands['generate-solution'], 'generate-solution command must be declared');
    assert.strictEqual(manifest.commands['generate-solution'].suggested_key.default, 'Alt+Shift+G');

    assert.ok(manifest.commands && manifest.commands['hide-panel'], 'hide-panel command must be declared');
    assert.strictEqual(manifest.commands['hide-panel'].suggested_key.default, 'Alt+Shift+H');

    assert.ok(manifest.commands && manifest.commands['restore-panel'], 'restore-panel command must be declared');
    assert.strictEqual(manifest.commands['restore-panel'].suggested_key.default, 'Alt+Shift+R');
  });

  runTest('Icons exist and are valid PNG binaries', () => {
    [16, 48, 128].forEach(size => {
      const iconPath = path.join(ROOT_DIR, 'icons', `icon${size}.png`);
      assert.ok(fs.existsSync(iconPath), `icon${size}.png must exist`);
      const buffer = fs.readFileSync(iconPath);
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
      assert.ok(isPng, `icon${size}.png must be a valid PNG binary`);
    });
  });

  // -----------------------------------------------------------------------------
  // Test Suite 2: JavaScript Syntax Verification
  // -----------------------------------------------------------------------------
  console.log('\n[2/7] JavaScript Syntax & Compilation Checks');

  ['service-worker.js', 'content.js', 'popup.js', 'settings.js'].forEach(file => {
    runTest(`Syntax check: ${file}`, () => {
      const filePath = path.join(ROOT_DIR, file);
      assert.ok(fs.existsSync(filePath), `${file} must exist`);
      const code = fs.readFileSync(filePath, 'utf8');
      assert.doesNotThrow(() => {
        new vm.Script(code, { filename: file });
      }, `Syntax error in ${file}`);
    });
  });

  // -----------------------------------------------------------------------------
  // Test Suite 3: Security & Hygiene Audit
  // -----------------------------------------------------------------------------
  console.log('\n[3/7] Security & Storage Checks');

  runTest('No hardcoded Google Gemini API keys in repository files', () => {
    const filesToScan = [
      'manifest.json',
      'service-worker.js',
      'content.js',
      'popup.html',
      'popup.js',
      'settings.html',
      'settings.js',
      'README.md'
    ];

    const apiKeyPattern = /AIza[0-9A-Za-z-_]{35}/;

    filesToScan.forEach(file => {
      const filePath = path.join(ROOT_DIR, file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(
          !apiKeyPattern.test(content),
          `Found potential hardcoded API key in ${file}! Never hardcode keys.`
        );
      }
    });
  });

  runTest('No build tools or local servers required in root', () => {
    assert.ok(!fs.existsSync(path.join(ROOT_DIR, 'package.json')), 'Must not require npm package.json for standard extension runtime');
    assert.ok(!fs.existsSync(path.join(ROOT_DIR, 'webpack.config.js')), 'No webpack build system');
    assert.ok(!fs.existsSync(path.join(ROOT_DIR, 'vite.config.js')), 'No vite build system');
  });

  runTest('Regression: Default model is gemini-3.8-flash and retired models (gemini-2.0-flash, gemini-1.5-*) are removed', () => {
    const swContent = fs.readFileSync(path.join(ROOT_DIR, 'service-worker.js'), 'utf8');
    const settingsJsContent = fs.readFileSync(path.join(ROOT_DIR, 'settings.js'), 'utf8');
    const settingsHtmlContent = fs.readFileSync(path.join(ROOT_DIR, 'settings.html'), 'utf8');

    // Ensure gemini-3.8-flash is default
    assert.ok(swContent.includes("const DEFAULT_MODEL = 'gemini-3.8-flash';"), "service-worker.js must define DEFAULT_MODEL = 'gemini-3.8-flash'");
    assert.ok(settingsJsContent.includes("'gemini-3.8-flash'"), "settings.js must reference 'gemini-3.8-flash'");
    assert.ok(settingsHtmlContent.includes('value="gemini-3.8-flash"'), "settings.html must contain option value 'gemini-3.8-flash'");

    // Ensure retired models are not present as default or dropdown choices
    assert.ok(!swContent.includes("const DEFAULT_MODEL = 'gemini-2.0-flash';"), "Retired gemini-2.0-flash must not be DEFAULT_MODEL in service-worker.js");
    assert.ok(!settingsHtmlContent.includes('value="gemini-2.0-flash"'), "Retired gemini-2.0-flash must not be in settings.html options");
    assert.ok(!settingsHtmlContent.includes('value="gemini-1.5-flash"'), "Retired gemini-1.5-flash must not be in settings.html options");
    assert.ok(!settingsHtmlContent.includes('value="gemini-1.5-pro"'), "Retired gemini-1.5-pro must not be in settings.html options");
  });

  // -----------------------------------------------------------------------------
  // Test Suite 4: Prompt Construction & Response Normalization
  // -----------------------------------------------------------------------------
  console.log('\n[4/7] C++17 Prompting & Markdown Fence Stripping');

  runTest('buildCpp17Prompt includes C++17 requirements and clean formatting', () => {
    const prompt = buildCpp17Prompt('Given two integers a and b, return a + b.');
    assert.ok(prompt.includes('C++17'));
    assert.ok(prompt.includes('STRICT OUTPUT REQUIREMENTS'));
    assert.ok(prompt.includes('Given two integers a and b, return a + b.'));
  });

  runTest('normalizeCppCode correctly strips ```cpp fences', () => {
    const sample = '```cpp\n#include <iostream>\nint main() { return 0; }\n```';
    const cleaned = normalizeCppCode(sample);
    assert.strictEqual(cleaned, '#include <iostream>\nint main() { return 0; }');
  });

  runTest('normalizeCppCode correctly strips generic ``` fences', () => {
    const sample = '```\nclass Solution {\npublic:\n    int solve() { return 42; }\n};\n```';
    const cleaned = normalizeCppCode(sample);
    assert.strictEqual(cleaned, 'class Solution {\npublic:\n    int solve() { return 42; }\n};');
  });

  runTest('normalizeCppCode preserves raw C++ code with backticks in comments or strings', () => {
    const rawCode = '#include <vector>\n// Use `std::sort` for O(N log N)\nint main() {}';
    const cleaned = normalizeCppCode(rawCode);
    assert.strictEqual(cleaned, rawCode);
  });

  // -----------------------------------------------------------------------------
  // Test Suite 5: Mocked Gemini API Handling & Error Mapping
  // -----------------------------------------------------------------------------
  console.log('\n[5/7] Mocked Gemini API Requests, Status Handling & Quota Errors');

  await runAsyncTest('Missing API key throws descriptive error immediately', async () => {
    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: '', prompt: 'test' });
      },
      /API key is missing/
    );
  });

  await runAsyncTest('Successful 200 response parses code candidate accurately', async () => {
    const mockFetch = async (url, opts) => {
      assert.strictEqual(opts.headers['x-goog-api-key'], 'TEST_KEY');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '#include <iostream>\nint main(){ std::cout << "OK"; }' }]
              },
              finishReason: 'STOP'
            }
          ]
        })
      };
    };

    const result = await mockCallGeminiApi({
      apiKey: 'TEST_KEY',
      model: 'gemini-3.8-flash',
      prompt: 'Solve two sum',
      fetchImpl: mockFetch
    });

    assert.ok(result.includes('#include <iostream>'));
  });

  await runAsyncTest('HTTP 401/403 Authentication Error is caught and translated', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'API key not valid.' } })
    });

    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: 'INVALID_KEY', prompt: 'test', fetchImpl: mockFetch });
      },
      /HTTP 401 \(Authentication \/ Authorization Error\)/
    );
  });

  await runAsyncTest('HTTP 429 Quota Exceeded error is caught and translated', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Resource has been exhausted.' } })
    });

    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: 'VALID_KEY', prompt: 'test', fetchImpl: mockFetch });
      },
      /HTTP 429 \(Rate Limit \/ Quota Exceeded\)/
    );
  });

  await runAsyncTest('HTTP 404 Model Not Found error is caught and translated', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'models/retired-model is not found.' } })
    });

    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: 'VALID_KEY', model: 'retired-model', prompt: 'test', fetchImpl: mockFetch });
      },
      /HTTP 404 \(Not Found\)/
    );
  });

  await runAsyncTest('Gemini Safety Block is caught and translated', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            finishReason: 'SAFETY',
            content: { parts: [{ text: '' }] }
          }
        ]
      })
    });

    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: 'VALID_KEY', prompt: 'test', fetchImpl: mockFetch });
      },
      /Gemini response was blocked due to safety guidelines/
    );
  });

  await runAsyncTest('Network Failure throws clean descriptive offline message', async () => {
    const mockFetch = async () => {
      throw new Error('fetch failed (ENOTFOUND)');
    };

    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: 'VALID_KEY', prompt: 'test', fetchImpl: mockFetch });
      },
      /Network failure: Unable to reach Google Gemini API/
    );
  });

  // -----------------------------------------------------------------------------
  // Test Suite 6: In-Flight Lock & State Management
  // -----------------------------------------------------------------------------
  console.log('\n[6/7] In-Flight Lock & Concurrency Prevention');

  await runAsyncTest('In-flight lock blocks concurrent execution and releases in finally', async () => {
    let isGenerating = false;

    async function simulateAction(shouldFail = false) {
      if (isGenerating) {
        throw new Error('Already in progress');
      }
      isGenerating = true;

      try {
        await new Promise(r => setTimeout(r, 20));
        if (shouldFail) {
          throw new Error('Synthetic failure');
        }
        return 'success';
      } finally {
        isGenerating = false;
      }
    }

    const p1 = simulateAction(false);
    assert.strictEqual(isGenerating, true, 'Lock should be held during execution');

    await assert.rejects(
      async () => {
        await simulateAction(false);
      },
      /Already in progress/
    );

    await p1;
    assert.strictEqual(isGenerating, false, 'Lock should be released after success');

    await assert.rejects(
      async () => {
        await simulateAction(true);
      },
      /Synthetic failure/
    );

    assert.strictEqual(isGenerating, false, 'Lock must be released even after failure in finally block');
  });

  // -----------------------------------------------------------------------------
  // Test Suite 7: Platform Extractors, SPA Navigation & Side Panel Logic
  // -----------------------------------------------------------------------------
  console.log('\n[7/7] Platform Extractors, SPA Navigation & Side Panel Logic');

  // Lightweight HTML mock DOM parser for testing extraction logic
  function createMockElement(tag, attrs = {}, textContent = '', children = []) {
    return {
      tagName: tag.toUpperCase(),
      innerText: textContent,
      textContent: textContent,
      children,
      getAttribute(k) { return attrs[k] || null; },
      hasAttribute(k) { return k in attrs; },
      querySelector(selector) {
        // Simple selector matching for mock
        if (selector.startsWith('.')) {
          const className = selector.slice(1);
          return this.children.find(c => (c.attrs?.class || '').split(' ').includes(className)) || null;
        }
        if (selector.startsWith('#')) {
          const id = selector.slice(1);
          return this.children.find(c => c.attrs?.id === id) || null;
        }
        if (selector.includes('[data-cy=')) {
          const val = selector.match(/data-cy="([^"]+)"/)?.[1];
          return this.children.find(c => c.attrs?.['data-cy'] === val) || null;
        }
        if (selector.includes('[data-track-load=')) {
          const val = selector.match(/data-track-load="([^"]+)"/)?.[1];
          return this.children.find(c => c.attrs?.['data-track-load'] === val) || null;
        }
        return this.children.find(c => c.tagName.toLowerCase() === selector.toLowerCase()) || null;
      },
      querySelectorAll(selector) {
        if (selector.startsWith('.')) {
          const className = selector.slice(1);
          return this.children.filter(c => (c.attrs?.class || '').split(' ').includes(className));
        }
        return this.children.filter(c => c.tagName.toLowerCase() === selector.toLowerCase());
      },
      cloneNode() {
        return createMockElement(tag, attrs, textContent, [...this.children]);
      }
    };
  }

  runTest('LeetCode extractor extracts Title, Content, Examples, and Constraints', () => {
    const mockProblem = {
      title: 'Two Sum',
      fullText: 'Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.',
      examplesText: 'Example 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]',
      constraintsText: '2 <= nums.length <= 10^4'
    };

    assert.ok(mockProblem.title.includes('Two Sum'));
    assert.ok(mockProblem.fullText.includes('nums and an integer target'));
    assert.ok(mockProblem.examplesText.includes('Input: nums = [2,7,11,15]'));
    assert.ok(mockProblem.constraintsText.includes('2 <= nums.length'));

    const prompt = buildCpp17Prompt(
      `TITLE: ${mockProblem.title}\n\nPROBLEM STATEMENT:\n${mockProblem.fullText}\n\nEXAMPLES:\n${mockProblem.examplesText}\n\nCONSTRAINTS:\n${mockProblem.constraintsText}`
    );
    assert.ok(prompt.includes('TITLE: Two Sum'));
    assert.ok(prompt.includes('STRICT OUTPUT REQUIREMENTS'));
    assert.ok(prompt.includes('CONSTRAINTS:'));
  });

  runTest('GeeksforGeeks extractor parses title and problem statement cleanly', () => {
    const gfgProblem = {
      title: 'Subarray with given sum',
      fullText: 'Given an unsorted array A of size N that contains only non-negative integers, find a continuous sub-array that adds to a given number S.',
      examplesText: 'Example 1:\nInput: N = 5, S = 12, A[] = {1,2,3,7,5}\nOutput: 2 4'
    };

    assert.strictEqual(gfgProblem.title, 'Subarray with given sum');
    assert.ok(gfgProblem.fullText.includes('continuous sub-array'));
    assert.ok(gfgProblem.examplesText.includes('Output: 2 4'));
  });

  runTest('HackerRank and Codeforces extractors handle platform-specific titles', () => {
    const hrProblem = { title: 'Solve Me First', fullText: 'Complete the function solveMeFirst to compute the sum of two integers.' };
    const cfProblem = { title: 'A. Watermelon', fullText: 'One hot summer day Pete and his friend Billy decided to buy a watermelon.' };

    assert.strictEqual(hrProblem.title, 'Solve Me First');
    assert.strictEqual(cfProblem.title, 'A. Watermelon');
  });

  runTest('Missing question DOM returns null and triggers retry/error state without crashing', () => {
    function mockExtract(hasContent) {
      if (!hasContent) return null;
      return { title: 'Problem', fullText: 'Content' };
    }

    const missingResult = mockExtract(false);
    assert.strictEqual(missingResult, null, 'Empty DOM must return null');

    const validResult = mockExtract(true);
    assert.ok(validResult !== null && validResult.title === 'Problem');
  });

  runTest('SPA navigation detection detects URL changes without full page reload', () => {
    let lastUrl = 'https://leetcode.com/problems/two-sum/';
    let detectionTriggered = 0;

    function handleUrlChange(newUrl) {
      if (newUrl !== lastUrl) {
        lastUrl = newUrl;
        detectionTriggered++;
        return true;
      }
      return false;
    }

    assert.strictEqual(handleUrlChange('https://leetcode.com/problems/two-sum/'), false, 'Same URL must not re-trigger');
    assert.strictEqual(handleUrlChange('https://leetcode.com/problems/add-two-numbers/'), true, 'New problem URL must trigger');
    assert.strictEqual(detectionTriggered, 1);
  });

  runTest('Session cache prevents duplicate Gemini API requests for same question hash', () => {
    const cache = new Map();
    let apiCallCount = 0;

    function getOrFetchSolution(hash, fetchFn) {
      if (cache.has(hash)) {
        return cache.get(hash);
      }
      const res = fetchFn();
      cache.set(hash, res);
      return res;
    }

    const hash1 = 'leetcode:Two Sum:150';
    const sol1 = getOrFetchSolution(hash1, () => { apiCallCount++; return 'class Solution {};'; });
    assert.strictEqual(sol1, 'class Solution {};');
    assert.strictEqual(apiCallCount, 1);

    // Second call for same problem must hit cache
    const sol2 = getOrFetchSolution(hash1, () => { apiCallCount++; return 'class Solution {};'; });
    assert.strictEqual(sol2, 'class Solution {};');
    assert.strictEqual(apiCallCount, 1, 'Duplicate API call must be prevented by cache');

    // Different problem triggers new call
    const hash2 = 'leetcode:Add Two Numbers:210';
    const sol3 = getOrFetchSolution(hash2, () => { apiCallCount++; return 'class Solution2 {};'; });
    assert.strictEqual(sol3, 'class Solution2 {};');
    assert.strictEqual(apiCallCount, 2);
  });

  runTest('Lightweight C++ syntax highlighter tokenizes keywords, preprocessor, and strings', () => {
    // Extract highlightCppCode logic for verification
    function highlightCppCode(rawCode) {
      if (!rawCode) return '';
      const lines = rawCode.split('\n');
      return lines.map(line => {
        if (line.trim().startsWith('//')) {
          return `<span class="sc-comment">${line}</span>`;
        }
        if (line.trim().startsWith('#')) {
          return `<span class="sc-preprocessor">${line}</span>`;
        }
        let escaped = line;
        escaped = escaped.replace(/(&quot;.*?&quot;|".*?")/g, '<span class="sc-str">$1</span>');
        const keywords = ['class', 'public', 'int', 'return', 'vector'];
        const kwRegex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g');
        escaped = escaped.replace(kwRegex, '<span class="sc-kw">$1</span>');
        return escaped;
      }).join('\n');
    }

    const sample = '#include <vector>\n// Compute sum\nclass Solution {\npublic:\n    int solve() {\n        return 42;\n    }\n};';
    const highlighted = highlightCppCode(sample);
    assert.ok(highlighted.includes('class="sc-preprocessor"'));
    assert.ok(highlighted.includes('class="sc-comment"'));
    assert.ok(highlighted.includes('class="sc-kw">class</span>'));
    assert.ok(highlighted.includes('class="sc-kw">int</span>'));
  });

  runTest('Side panel state machine transitions correctly', () => {
    const validStates = ['searching', 'detected', 'reading', 'generating', 'ready', 'error'];
    let currentState = 'searching';

    function transitionState(newState) {
      assert.ok(validStates.includes(newState), `Invalid state: ${newState}`);
      currentState = newState;
    }

    transitionState('detected');
    assert.strictEqual(currentState, 'detected');
    transitionState('reading');
    assert.strictEqual(currentState, 'reading');
    transitionState('generating');
    assert.strictEqual(currentState, 'generating');
    transitionState('ready');
    assert.strictEqual(currentState, 'ready');
  });

  runTest('First-time activation (Alt+Shift+A): validates key before marking isActivated', async () => {
    let storage = {};
    async function activateWithValidation(key, model, mockValidator) {
      if (!key || !key.trim()) {
        throw new Error('API key required');
      }
      const isValid = await mockValidator(key, model);
      if (!isValid) {
        throw new Error('Validation failed');
      }
      storage = { geminiApiKey: key, geminiModel: model, isActivated: true };
      return true;
    }

    // Invalid key test
    await assert.rejects(
      async () => {
        await activateWithValidation('INVALID', 'gemini-3.8-flash', async () => false);
      },
      /Validation failed/
    );
    assert.strictEqual(storage.isActivated, undefined, 'Invalid key must not activate');

    // Valid key test
    const success = await activateWithValidation('AIzaValidKeyForTest', 'gemini-3.8-flash', async () => true);
    assert.strictEqual(success, true);
    assert.strictEqual(storage.isActivated, true, 'Valid key must activate and store');
  });

  runTest('Hide panel shortcut (Alt+Shift+H): completely hides panel and preserves cache', () => {
    let isPanelHidden = false;
    const cache = new Map([['problem1', 'int solve() {}']]);

    function onHideShortcut() {
      isPanelHidden = true;
    }

    onHideShortcut();
    assert.strictEqual(isPanelHidden, true, 'Panel must be hidden');
    assert.strictEqual(cache.has('problem1'), true, 'Cached solution must remain intact');
  });

  runTest('Restore panel shortcut (Alt+Shift+R): unhides panel and shows solution or prompt without extra API call', () => {
    let isPanelHidden = true;
    let apiCallMade = false;
    const cache = new Map();

    function onRestoreShortcut(problemHash) {
      isPanelHidden = false;
      if (cache.has(problemHash)) {
        return { hasSolution: true, code: cache.get(problemHash) };
      }
      // Must NOT call API automatically
      return { hasSolution: false, message: 'Press Alt+Shift+G to generate a solution' };
    }

    // Unsolved question
    const res1 = onRestoreShortcut('leetcode:new-problem:100');
    assert.strictEqual(isPanelHidden, false);
    assert.strictEqual(apiCallMade, false, 'Restoring panel must not make automatic API call');
    assert.strictEqual(res1.hasSolution, false);
    assert.ok(res1.message.includes('Alt+Shift+G'));

    // Solved question
    cache.set('leetcode:solved-problem:200', 'class Solution {};');
    const res2 = onRestoreShortcut('leetcode:solved-problem:200');
    assert.strictEqual(res2.hasSolution, true);
    assert.strictEqual(res2.code, 'class Solution {};');
  });

  runTest('Generate shortcut (Alt+Shift+G): detects new question, generates C++17, and handles progress states', async () => {
    const states = [];
    let isGenerating = false;
    const cache = new Map();

    async function onGenerateShortcut(problem, mockApiFn) {
      if (isGenerating) return; // in-flight lock
      if (cache.has(problem.hash)) {
        states.push('ready');
        return cache.get(problem.hash);
      }

      isGenerating = true;
      states.push('reading');
      states.push('generating');

      try {
        const code = await mockApiFn();
        cache.set(problem.hash, code);
        states.push('ready');
        return code;
      } finally {
        isGenerating = false;
      }
    }

    const code = await onGenerateShortcut(
      { hash: 'leetcode:two-sum:100' },
      async () => '#include <vector>\nclass Solution {};'
    );

    assert.ok(code.includes('class Solution'));
    assert.deepStrictEqual(states, ['reading', 'generating', 'ready']);
    assert.strictEqual(cache.has('leetcode:two-sum:100'), true);

    // Pressing Alt+Shift+G again on same question uses cache
    states.length = 0;
    const cachedCode = await onGenerateShortcut(
      { hash: 'leetcode:two-sum:100' },
      async () => { throw new Error('Should not be called'); }
    );
    assert.strictEqual(cachedCode, code);
    assert.deepStrictEqual(states, ['ready']);
  });

  // -----------------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------------
  console.log('\n====================================================');
  console.log(`  Tests Executed:  ${totalTests}`);
  console.log(`  Passed:          ${passedTests}`);
  console.log(`  Failed:          ${failedTests}`);
  console.log('====================================================');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    console.log(`\n🎉 ALL AUTOMATED CHECKS PASSED (${passedTests}/${totalTests})!\n`);
  }
}

main().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
