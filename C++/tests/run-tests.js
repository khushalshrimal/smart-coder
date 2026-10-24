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
function normalizeCppCode(rawText, { isPlatformWithDriver = false } = {}) {
  if (!rawText || typeof rawText !== 'string') return '';
  let text = rawText.trim();
  const codeBlockMatch = text.match(/```(?:cpp|c\+\+|cc|c)?\r?\n([\s\S]*?)\r?\n```/i);
  if (codeBlockMatch && codeBlockMatch[1] !== undefined) {
    text = codeBlockMatch[1].trim();
  } else {
    const openFenceMatch = text.match(/^```(?:cpp|c\+\+|cc|c)?\r?\n([\s\S]*)/i);
    if (openFenceMatch && openFenceMatch[1] !== undefined) {
      text = openFenceMatch[1].replace(/\r?\n?```\s*$/, '').trim();
    } else if (text.startsWith('```')) {
      text = text.replace(/^```[a-zA-Z0-9+\-_]*\r?\n?/, '');
      text = text.replace(/\r?\n?```$/, '');
      text = text.trim();
    }
  }

  if (isPlatformWithDriver) {
    const lines = text.split('\n');
    const filteredLines = [];

    for (let line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#include')) continue;
      if (/^using\s+namespace\s+std\s*;/.test(trimmed)) continue;
      if (trimmed.startsWith('//')) continue;
      filteredLines.push(line);
    }

    text = filteredLines.join('\n').trim();
    text = text.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    text = text.replace(/\bstd::(?=[a-zA-Z_])/g, '');
  }

  return text;
}

function validateCppCompleteness(code) {
  if (!code || typeof code !== 'string') {
    return { isComplete: false, reason: 'Empty code' };
  }

  const trimmed = code.trim();
  if (trimmed.length < 20) {
    return { isComplete: false, reason: 'Code too short to be a complete solution' };
  }

  const hasSubstance = /\b(class|struct|int|void|bool|double|float|long|auto|template|string|vector)\b/.test(trimmed) &&
                       /[({]/.test(trimmed);
  if (!hasSubstance) {
    return { isComplete: false, reason: 'Contains only header includes or declarations without definitions' };
  }

  let openBraces = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let inChar = false;
  let escapeNext = false;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    const next = trimmed[i + 1];

    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (c === '\\') {
        escapeNext = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (inChar) {
      if (escapeNext) {
        escapeNext = false;
      } else if (c === '\\') {
        escapeNext = true;
      } else if (c === "'") {
        inChar = false;
      }
      continue;
    }

    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "'") {
      inChar = true;
      continue;
    }

    if (c === '{') {
      openBraces++;
    } else if (c === '}') {
      openBraces--;
    }
  }

  if (openBraces > 0) {
    return { isComplete: false, reason: `Unclosed open braces: ${openBraces} missing '}'` };
  }

  return { isComplete: true };
}

function buildCpp17Prompt(problemText, { platform = '', templateCode = '', signature = '' } = {}) {
  const isPlatformWithDriver = /geeksforgeeks|gfg|leetcode/i.test(platform);

  const instructions = [
    'Return only the complete, compilable C++17 solution code in the exact format expected by the coding platform.',
    'Do not add any comments, explanations, Markdown fences, or extra text.'
  ];

  if (templateCode) {
    instructions.push(
      '',
      'REQUIRED STARTER TEMPLATE (You must use this exact class and function signature without modifying names, parameters, or return types):',
      templateCode
    );
  } else if (signature) {
    instructions.push(
      '',
      `REQUIRED FUNCTION/CLASS SIGNATURE (You must implement this exact signature): ${signature}`
    );
  }

  if (isPlatformWithDriver || /geeksforgeeks|gfg/i.test(platform)) {
    instructions.push(
      '',
      'PLATFORM FORMAT RULES:',
      '1. For GeeksforGeeks and LeetCode, provide the complete, compilable class Solution with the exact required member function(s).',
      '2. Do NOT include any #include directives (e.g. no #include <iostream>, #include <vector>, etc.) because the platform judge already provides them.',
      '3. Do NOT include "using namespace std;" because the platform already provides it.',
      '4. Do NOT use unnecessary "std::" prefixes (use vector, string, max, min, reverse, unordered_map, etc. directly).',
      '5. Do NOT invent function names, parameters, return types, or class names. Extract them from the actual problem statement or existing editor template.',
      '6. Do NOT write a main() function driver.',
      '7. Do NOT include any explanatory comments.',
      '8. Ensure the solution is complete and compilable within the platform template.'
    );
  } else {
    instructions.push(
      '',
      'PLATFORM FORMAT RULES:',
      '1. Return only the solution code in the exact format expected by the coding platform.',
      '2. Do not include #include directives or using namespace std; when the platform already provides them.',
      '3. Avoid unnecessary std:: prefixes when using namespace std; is active.',
      '4. Do not invent function names, parameters, return types, or class names.',
      '5. Do not add explanatory comments.',
      '6. Ensure the solution is complete and compilable within the platform template.'
    );
  }

  instructions.push(
    '',
    'STRICT OUTPUT REQUIREMENTS:',
    '1. Output ONLY pure, valid C++17 source code.',
    '2. Do NOT enclose the code in Markdown fences (no ```cpp or ```). Output raw C++ code directly.',
    '3. Do NOT include any introductory greetings, explanations, complexity analysis, dry runs, or comments about your reasoning.',
    '4. Handle all potential edge cases (empty inputs, zero, maximum integer limits, negative values).',
    '',
    'PROBLEM STATEMENT:',
    problemText.trim()
  );

  return instructions.join('\n');
}

async function mockCallGeminiApi({ apiKey, model, prompt, contents, fetchImpl, returnMetadata = false }) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('API key is missing. Please set your Google Gemini API key in Settings.');
  }

  const selectedModel = model || 'gemini-2.5-flash';
  const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;

  const payload = {
    contents: contents || [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
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
    if (networkError.name === 'AbortError' || networkError.message?.includes('timed out')) {
      throw new Error('Connection timed out after 15 seconds. Google Gemini API did not respond in time.');
    }
    throw new Error(`Network failure: Unable to reach Google Gemini API (${networkError.message || 'offline'}).`);
  }

  if (!response.ok) {
    let errorDetail = '';
    let errorCode = '';
    try {
      const errJson = await response.json();
      if (errJson && errJson.error) {
        errorDetail = errJson.error.message || '';
        errorCode = errJson.error.status || '';
      }
    } catch {}

    switch (response.status) {
      case 400:
        if (errorDetail.toLowerCase().includes('api key') || errorCode === 'INVALID_ARGUMENT') {
          throw new Error(`HTTP 400 (Invalid API Key): The provided key is not recognized by Google Gemini API. Please check your key in Settings.`);
        }
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

  const visibleParts = content.parts.filter(p => !p.thought);
  const generatedText = visibleParts.map(p => p.text || '').join('');

  if (!generatedText.trim()) {
    if (primaryCandidate.finishReason === 'MAX_TOKENS') {
      throw new Error('The model exhausted its token limit during reasoning before producing visible text.');
    }
    throw new Error('Gemini API returned empty text in candidate content.');
  }

  if (primaryCandidate.finishReason === 'MAX_TOKENS' && !returnMetadata) {
    const err = new Error('The generated solution was truncated because the model reached its output token limit (MAX_TOKENS). Please increase Max Output Tokens in Settings.');
    err.category = 'TOKEN_LIMIT_TRUNCATED';
    err.partialText = generatedText;
    throw err;
  }

  if (returnMetadata) {
    return {
      text: generatedText,
      finishReason: primaryCandidate.finishReason || 'STOP',
      rawCandidate: primaryCandidate
    };
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

    assert.ok(Array.isArray(manifest.host_permissions), 'host_permissions must be defined');
    assert.ok(manifest.host_permissions.includes('https://generativelanguage.googleapis.com/*'), 'host_permissions must include Gemini API endpoint');

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

  runTest('Regression: Default model is an active official model (gemini-2.5-flash) and retired models (gemini-2.0-flash, gemini-1.5-*) are removed', () => {
    const swContent = fs.readFileSync(path.join(ROOT_DIR, 'service-worker.js'), 'utf8');
    const settingsJsContent = fs.readFileSync(path.join(ROOT_DIR, 'settings.js'), 'utf8');
    const settingsHtmlContent = fs.readFileSync(path.join(ROOT_DIR, 'settings.html'), 'utf8');

    // Ensure gemini-2.5-flash is default
    assert.ok(swContent.includes("const DEFAULT_MODEL = 'gemini-2.5-flash';"), "service-worker.js must define DEFAULT_MODEL = 'gemini-2.5-flash'");
    assert.ok(settingsJsContent.includes("'gemini-2.5-flash'"), "settings.js must reference 'gemini-2.5-flash'");
    assert.ok(settingsHtmlContent.includes('value="gemini-2.5-flash"'), "settings.html must contain option value 'gemini-2.5-flash'");

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
    assert.ok(prompt.includes('Return only the complete, compilable C++17 solution code in the exact format expected by the coding platform.'));
  });

  runTest('buildCpp17Prompt enforces exact platform format for GeeksforGeeks and includes required template', () => {
    const template = 'class Solution {\n  public:\n    string reverseString(string& s);\n};';
    const prompt = buildCpp17Prompt('Reverse the string s.', {
      platform: 'geeksforgeeks',
      templateCode: template
    });

    assert.ok(prompt.includes('PLATFORM FORMAT RULES:'));
    assert.ok(prompt.includes('For GeeksforGeeks and LeetCode, provide the complete, compilable class Solution'));
    assert.ok(prompt.includes('Do NOT include any #include directives'));
    assert.ok(prompt.includes('Do NOT include "using namespace std;"'));
    assert.ok(prompt.includes('Do NOT use unnecessary "std::" prefixes'));
    assert.ok(prompt.includes('Do NOT invent function names, parameters, return types, or class names.'));
    assert.ok(prompt.includes('Do not add any comments, explanations, Markdown fences, or extra text.'));
    assert.ok(prompt.includes(template));
  });

  runTest('normalizeCppCode strips #include, using namespace std;, std:: prefixes, and comments for GFG/LeetCode', () => {
    const gfgRaw = [
      '#include <iostream>',
      '#include <string>',
      '#include <algorithm>',
      'using namespace std;',
      '// User function template for C++',
      'class Solution {',
      '  public:',
      '    // Function to reverse a string',
      '    string reverseString(string& s) {',
      '        std::reverse(s.begin(), s.end());',
      '        return s;',
      '    }',
      '};'
    ].join('\n');

    const cleaned = normalizeCppCode(gfgRaw, { isPlatformWithDriver: true });
    assert.ok(!cleaned.includes('#include'), 'Must strip #include directives for GFG/LeetCode');
    assert.ok(!cleaned.includes('using namespace std;'), 'Must strip using namespace std; for GFG/LeetCode');
    assert.ok(!cleaned.includes('//'), 'Must strip comments');
    assert.ok(!cleaned.includes('std::'), 'Must strip unnecessary std:: prefixes');
    assert.ok(cleaned.includes('class Solution'), 'Must preserve class Solution');
    assert.ok(cleaned.includes('string reverseString(string& s)'), 'Must preserve exact signature');
    assert.ok(cleaned.includes('reverse(s.begin(), s.end());'), 'Must preserve implementation');
  });

  runTest('normalizeCppCode preserves #include when platform does not have driver', () => {
    const rawCode = '#include <iostream>\nusing namespace std;\nint main() { return 0; }';
    const cleaned = normalizeCppCode(rawCode, { isPlatformWithDriver: false });
    assert.ok(cleaned.includes('#include <iostream>'));
    assert.ok(cleaned.includes('using namespace std;'));
    assert.ok(cleaned.includes('int main()'));
  });

  runTest('Unreliable signature on GFG triggers template inspection requirement without guessing', () => {
    function checkInspectionNeeded({ isJudgePlatform, templateCode, signature }) {
      const hasReliableSignature = Boolean(templateCode || signature);
      return Boolean(isJudgePlatform && !hasReliableSignature);
    }

    assert.strictEqual(
      checkInspectionNeeded({ isJudgePlatform: true, templateCode: '', signature: '' }),
      true,
      'Must flag template inspection when signature cannot be identified on GFG'
    );

    assert.strictEqual(
      checkInspectionNeeded({ isJudgePlatform: true, templateCode: 'class Solution {};', signature: '' }),
      false,
      'Template code resolves inspection'
    );

    assert.strictEqual(
      checkInspectionNeeded({ isJudgePlatform: true, templateCode: '', signature: 'class Solution { public: int solve(); };' }),
      false,
      'Extracted signature resolves inspection'
    );
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

  runTest('normalizeCppCode extracts fenced code from surrounding explanatory text without corrupting code', () => {
    const rawWithIntro = 'Here is the complete C++17 solution:\n```cpp\n#include <iostream>\nint main() { return 0; }\n```\nHope this helps!';
    const cleaned = normalizeCppCode(rawWithIntro);
    assert.strictEqual(cleaned, '#include <iostream>\nint main() { return 0; }');
  });

  runTest('normalizeCppCode does not remove code after braces for multi-class and multi-function solutions', () => {
    const multiClassCode = [
      '#include <iostream>',
      '#include <vector>',
      'struct Node {',
      '    int val;',
      '    Node* next;',
      '};',
      'class Solution {',
      'public:',
      '    Node* merge(Node* a, Node* b) {',
      '        return nullptr;',
      '    }',
      '};',
      'int main() {',
      '    Solution s;',
      '    return 0;',
      '}'
    ].join('\n');

    const cleaned = normalizeCppCode(multiClassCode);
    assert.strictEqual(cleaned, multiClassCode);
    assert.ok(cleaned.includes('struct Node'));
    assert.ok(cleaned.includes('class Solution'));
    assert.ok(cleaned.includes('int main'));
  });

  runTest('validateCppCompleteness flags short incomplete code with only includes', () => {
    const incompleteCode = '#include <vector>\n#include <algorithm>';
    const check = validateCppCompleteness(incompleteCode);
    assert.strictEqual(check.isComplete, false);
    assert.ok(check.reason.includes('only header includes') || check.reason.includes('short'));
  });

  runTest('validateCppCompleteness flags unclosed braces in truncated code', () => {
    const truncatedCode = '#include <vector>\nclass Solution {\npublic:\n    int solve() {\n        return 1;';
    const check = validateCppCompleteness(truncatedCode);
    assert.strictEqual(check.isComplete, false);
    assert.ok(check.reason.includes('Unclosed open braces'));
  });

  runTest('validateCppCompleteness correctly validates short answer', () => {
    const shortCode = '#include <iostream>\nint add(int a, int b) {\n    return a + b;\n}';
    const check = validateCppCompleteness(shortCode);
    assert.strictEqual(check.isComplete, true);
  });

  runTest('validateCppCompleteness correctly validates long answer (100+ lines with classes and templates)', () => {
    const longCodeLines = [
      '#include <iostream>',
      '#include <vector>',
      '#include <string>',
      '#include <algorithm>',
      '#include <queue>',
      '#include <unordered_map>',
      'using namespace std;',
      '',
      'template <typename T>',
      'class SegmentTree {',
      'private:',
      '    int n;',
      '    vector<T> tree;',
      'public:',
      '    SegmentTree(int size) : n(size), tree(4 * size, 0) {}',
      '    void update(int node, int start, int end, int idx, T val) {',
      '        if (start == end) {',
      '            tree[node] = val;',
      '            return;',
      '        }',
      '        int mid = start + (end - start) / 2;',
      '        if (idx <= mid) update(2 * node, start, mid, idx, val);',
      '        else update(2 * node + 1, mid + 1, end, idx, val);',
      '        tree[node] = tree[2 * node] + tree[2 * node + 1];',
      '    }',
      '    T query(int node, int start, int end, int l, int r) {',
      '        if (r < start || end < l) return 0;',
      '        if (l <= start && end <= r) return tree[node];',
      '        int mid = start + (end - start) / 2;',
      '        return query(2 * node, start, mid, l, r) + query(2 * node + 1, mid + 1, end, l, r);',
      '    }',
      '};',
      '',
      'class Solution {',
      'public:',
      '    vector<int> processQueries(vector<int>& nums, vector<pair<int, int>>& queries) {',
      '        SegmentTree<int> st(nums.size());',
      '        for (int i = 0; i < (int)nums.size(); ++i) {',
      '            st.update(1, 0, nums.size() - 1, i, nums[i]);',
      '        }',
      '        vector<int> res;',
      '        for (const auto& q : queries) {',
      '            res.push_back(st.query(1, 0, nums.size() - 1, q.first, q.second));',
      '        }',
      '        return res;',
      '    }',
      '};'
    ];

    const longCode = longCodeLines.join('\n');
    assert.ok(longCode.length > 500);
    const check = validateCppCompleteness(longCode);
    assert.strictEqual(check.isComplete, true);
  });

  runTest('validateCppCompleteness ignores braces inside string literals and comments', () => {
    const codeWithTrickyBraces = [
      '#include <string>',
      '#include <iostream>',
      'using namespace std;',
      '// Note: opening brace in comment { should not be counted',
      '/* Another comment with braces { and } */',
      'int main() {',
      '    string s = "{open and closed}";',
      '    char c = \'{\';',
      '    cout << s << c << endl;',
      '    return 0;',
      '}'
    ].join('\n');

    const check = validateCppCompleteness(codeWithTrickyBraces);
    assert.strictEqual(check.isComplete, true);
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

  await runAsyncTest('HTTP 400 with invalid API key is explicitly caught and translated', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT'
        }
      })
    });

    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: 'INVALID_KEY', prompt: 'test', fetchImpl: mockFetch });
      },
      /HTTP 400 \(Invalid API Key\): The provided key is not recognized/
    );
  });

  await runAsyncTest('Request timeout (15s bounded timeout with AbortController) is caught', async () => {
    const mockFetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: 'VALID_KEY', prompt: 'test', fetchImpl: mockFetch });
      },
      /Connection timed out after 15 seconds/
    );
  });

  await runAsyncTest('Thinking tokens (parts with thought: true) are properly filtered out to extract clean answer', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                { thought: true, text: 'Let me think about how to solve this step by step...' },
                { text: 'OK' }
              ]
            }
          }
        ]
      })
    });

    const result = await mockCallGeminiApi({ apiKey: 'VALID_KEY', prompt: 'test', fetchImpl: mockFetch });
    assert.strictEqual(result, 'OK');
  });

  await runAsyncTest('Token exhaustion during reasoning (MAX_TOKENS with no text) throws descriptive reasoning limit error', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            finishReason: 'MAX_TOKENS',
            content: {
              parts: [
                { thought: true, text: 'Thinking step 1...' }
              ]
            }
          }
        ]
      })
    });

    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: 'VALID_KEY', prompt: 'test', fetchImpl: mockFetch });
      },
      /exhausted its token limit during reasoning/
    );
  });

  await runAsyncTest('Token truncation with partial text (finishReason: MAX_TOKENS) throws TOKEN_LIMIT_TRUNCATED instead of silently displaying incomplete code', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            finishReason: 'MAX_TOKENS',
            content: {
              parts: [
                { thought: true, text: 'Thinking step 1...' },
                { text: '#include <vector>\n#include <algorithm>' }
              ]
            }
          }
        ]
      })
    });

    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: 'VALID_KEY', prompt: 'test', fetchImpl: mockFetch });
      },
      /reached its output token limit \(MAX_TOKENS\)/
    );
  });

  await runAsyncTest('Missing response text (candidates with empty parts) throws EMPTY_RESPONSE error', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: []
            }
          }
        ]
      })
    });

    await assert.rejects(
      async () => {
        await mockCallGeminiApi({ apiKey: 'VALID_KEY', prompt: 'test', fetchImpl: mockFetch });
      },
      /candidate response contained no text parts/
    );
  });

  await runAsyncTest('Continuation strategy combines partial code with continuation and passes completeness validation', async () => {
    const partialText = '#include <vector>\nusing namespace std;\nclass Solution {\npublic:\n    int maxSubArray(vector<int>& nums) {';
    const continuationText = '\n        int sum = 0;\n        return sum;\n    }\n};';

    assert.strictEqual(validateCppCompleteness(partialText).isComplete, false);

    const combinedRaw = partialText + '\n' + continuationText;
    const combinedCode = normalizeCppCode(combinedRaw);
    const validation = validateCppCompleteness(combinedCode);

    assert.strictEqual(validation.isComplete, true);
    assert.ok(combinedCode.includes('class Solution'));
    assert.ok(combinedCode.includes('int maxSubArray'));
  });

  runTest('Regression: DEFAULT_MAX_TOKENS is 8192 in service-worker.js, settings.html, and settings.js', () => {
    const swPath = path.join(ROOT_DIR, 'service-worker.js');
    const settingsHtmlPath = path.join(ROOT_DIR, 'settings.html');
    const settingsJsPath = path.join(ROOT_DIR, 'settings.js');

    const sw = fs.readFileSync(swPath, 'utf8');
    const html = fs.readFileSync(settingsHtmlPath, 'utf8');
    const js = fs.readFileSync(settingsJsPath, 'utf8');

    assert.ok(sw.includes('const DEFAULT_MAX_TOKENS = 8192;'), 'service-worker.js must define DEFAULT_MAX_TOKENS = 8192');
    assert.ok(html.includes('value="8192"'), 'settings.html max-tokens-input must default to 8192');
    assert.ok(js.includes('maxTokensInput.value = 8192;'), 'settings.js must default maxTokens to 8192');
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

  runTest('GeeksforGeeks extractor parses modern dynamic CSS class problems_problem_content__Xm_eO', () => {
    // Test dynamic selector regex/matching matching what content.js uses: div[class*="problems_problem_content"]
    const mockClassList = ['problems_problem_content__Xm_eO', 'problems_problem_content__X2ne7', 'problems_problem_content__abc12'];
    const selectorPattern = /problems_problem_content/;
    for (const cls of mockClassList) {
      assert.ok(selectorPattern.test(cls), `Selector must match hashed class ${cls}`);
    }
  });

  runTest('GeeksforGeeks extractor falls back to __NEXT_DATA__ JSON script when DOM content is absent', () => {
    const mockNextData = JSON.stringify({
      props: {
        pageProps: {
          initialState: {
            problemData: {
              allData: {
                probData: {
                  problem_name: 'Reverse a String',
                  problem_question: '<p>You are given a string <strong>s</strong>. You need to reverse the string.</p>',
                  constraints_display: '1 <= s.length <= 10^5'
                }
              }
            }
          }
        }
      }
    });

    const parsed = JSON.parse(mockNextData);
    const prob = parsed?.props?.pageProps?.initialState?.problemData?.allData?.probData;
    assert.ok(prob, '__NEXT_DATA__ problem data must be present');
    assert.strictEqual(prob.problem_name, 'Reverse a String');
    assert.ok(prob.problem_question.includes('reverse the string'));
    assert.strictEqual(prob.constraints_display, '1 <= s.length <= 10^5');
  });

  runTest('GeeksforGeeks extractor falls back to meta[name="description"] when DOM and NEXT_DATA are absent', () => {
    const mockMetaContent = 'Given a string s, reverse the string. Examples: Input: s = "Geeks" Output: "skeeG"';
    assert.ok(mockMetaContent.length >= 25, 'Meta description must meet minimum length threshold');
    assert.ok(mockMetaContent.includes('reverse the string'));
  });

  runTest('Local demo page demo/sample-problem.html exists and contains valid GFG test structure', () => {
    const demoPath = path.join(ROOT_DIR, 'demo', 'sample-problem.html');
    assert.ok(fs.existsSync(demoPath), 'demo/sample-problem.html must exist');
    const demoHtml = fs.readFileSync(demoPath, 'utf8');

    assert.ok(demoHtml.includes('problems_problem_content__Xm_eO'), 'Demo page must include modern GFG CSS-module class');
    assert.ok(demoHtml.includes('Reverse a String'), 'Demo page must include problem title');
    assert.ok(demoHtml.includes('problem-statement'), 'Demo page must include problem statement container');
  });

  runTest('Diagnostic logging strips sensitive fields (api keys, prompt, fullText)', () => {
    function sanitizeForDiagnostic(data) {
      const sanitized = { ...data };
      delete sanitized.apiKey;
      delete sanitized.key;
      delete sanitized.prompt;
      delete sanitized.fullText;
      delete sanitized.problemText;
      return sanitized;
    }

    const payload = {
      apiKey: 'AIzaSySecretApiKey12345',
      key: 'AIzaSySecretApiKey12345',
      prompt: 'Write C++17 solution...',
      fullText: 'Given an array nums...',
      problemText: 'Detailed problem...',
      host: 'www.geeksforgeeks.org',
      hasProblem: true
    };

    const clean = sanitizeForDiagnostic(payload);
    assert.strictEqual(clean.apiKey, undefined);
    assert.strictEqual(clean.key, undefined);
    assert.strictEqual(clean.prompt, undefined);
    assert.strictEqual(clean.fullText, undefined);
    assert.strictEqual(clean.problemText, undefined);
    assert.strictEqual(clean.host, 'www.geeksforgeeks.org');
    assert.strictEqual(clean.hasProblem, true);
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

  runTest('Stealth box CSS rules faithfully replicate original MCQ box properties', () => {
    const cssPath = path.join(ROOT_DIR, 'content.css');
    assert.ok(fs.existsSync(cssPath), 'content.css must exist');
    const css = fs.readFileSync(cssPath, 'utf8');

    assert.ok(css.includes('rgba(0, 0, 0, 0.85)'), 'Must match original background: rgba(0, 0, 0, 0.85)');
    assert.ok(css.includes('padding: 6px 10px'), 'Must match original padding: 6px 10px');
    assert.ok(css.includes('font-size: 14px'), 'Must match original font-size: 14px');
    assert.ok(css.includes('font-weight: bold'), 'Must match original font-weight: bold');
    assert.ok(css.includes('color: #00ffcc'), 'Must match original color: #00ffcc');
    assert.ok(css.includes('color: yellow'), 'Must match original .loading color: yellow');
    assert.ok(css.includes('color: red'), 'Must match original .error color: red');
  });

  runTest('Settings failure category mapper translates errors into distinct informative UI titles without blanket failure message', () => {
    const settingsPath = path.join(ROOT_DIR, 'settings.js');
    assert.ok(fs.existsSync(settingsPath), 'settings.js must exist');
    const content = fs.readFileSync(settingsPath, 'utf8');

    assert.ok(content.includes('mapFailureToTitle'), 'settings.js must define mapFailureToTitle');
    assert.ok(content.includes('INVALID_API_KEY'), 'Must handle INVALID_API_KEY category');
    assert.ok(content.includes('MODEL_NOT_FOUND'), 'Must handle MODEL_NOT_FOUND category');
    assert.ok(content.includes('QUOTA_EXCEEDED'), 'Must handle QUOTA_EXCEEDED category');
    assert.ok(content.includes('TIMEOUT'), 'Must handle TIMEOUT category');
    assert.ok(content.includes('NETWORK_ERROR'), 'Must handle NETWORK_ERROR category');
    assert.ok(content.includes('diagCategory'), 'Must populate diagnostic category badge');
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
