/**
 * Smart-Coder Gemini - Service Worker (Manifest V3 Background Script)
 * Handles secure communication with the Google Gemini API, prevents duplicate requests,
 * and coordinates shortcut triggers with content scripts and popup UI.
 */

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 8192;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_REQUEST_TIMEOUT_MS = 90000; // 90 seconds (1 minute 30 seconds)

/**
 * Structured error class containing diagnostic metadata for transparent UI feedback.
 */
class GeminiApiError extends Error {
  constructor(message, { category = 'UNKNOWN', httpStatus = 0, providerMessage = '', stage = 'API_CALL' } = {}) {
    super(message);
    this.name = 'GeminiApiError';
    this.category = category;
    this.httpStatus = httpStatus;
    this.providerMessage = providerMessage;
    this.stage = stage;
  }
}

/**
 * Safe logging helper that outputs diagnostics without sensitive keys.
 * NEVER logs API keys, headers with x-goog-api-key, or secret-bearing URLs.
 */
function logDiagnostic(stage, data = {}) {
  const sanitized = { ...data };
  delete sanitized.apiKey;
  delete sanitized.key;
  delete sanitized.headers;
  console.log(`[Smart-Coder Gemini][Diagnostic][SW] ${stage}:`, sanitized);
}

// In-flight generation lock to prevent concurrent duplicate API requests
let isGenerating = false;

/**
 * Normalizes C++ response text:
 * 1. Strips Markdown fences (```cpp ... ```) without corrupting inner source code.
 * 2. When platform uses an online judge driver (e.g. GeeksforGeeks, LeetCode),
 *    isolates class Solution, strips redundant #include directives, "using namespace std;",
 *    explanatory comments, unnecessary "std::" prefixes, and any echoed problem/page text.
 */
function normalizeCppCode(rawText, { isPlatformWithDriver = false } = {}) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }

  let text = rawText.trim();

  // 1. If wrapped in or contains ```cpp ... ``` or ```c++ ... ``` or ``` ... ```
  const codeBlockMatch = text.match(/```(?:cpp|c\+\+|cc|c)?\r?\n([\s\S]*?)\r?\n```/i);
  if (codeBlockMatch && codeBlockMatch[1] !== undefined) {
    text = codeBlockMatch[1].trim();
  } else {
    // 2. Handle unclosed leading ```cpp / trailing ``` without exact newline bounds
    const openFenceMatch = text.match(/^```(?:cpp|c\+\+|cc|c)?\r?\n([\s\S]*)/i);
    if (openFenceMatch && openFenceMatch[1] !== undefined) {
      text = openFenceMatch[1].replace(/\r?\n?```\s*$/, '').trim();
    } else if (text.startsWith('```')) {
      text = text.replace(/^```[a-zA-Z0-9+\-_]*\r?\n?/, '');
      text = text.replace(/\r?\n?```$/, '');
      text = text.trim();
    }
  }

  // 3. For online judge platforms (GFG, LeetCode) with a driver,
  // isolate the exact class Solution (and any helper struct) and discard any echoed prompt/preamble/explanation.
  if (isPlatformWithDriver && /class\s+Solution\b/.test(text)) {
    const classIdx = text.search(/\bclass\s+Solution\b/);
    if (classIdx !== -1) {
      const beforeClass = text.substring(0, classIdx);
      const helperMatch = beforeClass.match(/(?:(?:template\s*<[^>]+>\s*)?(?:struct|class)\s+[a-zA-Z0-9_]+\s*\{[\s\S]*?\}\s*;\s*)+$/);
      const startIdx = helperMatch ? (classIdx - helperMatch[0].length) : classIdx;
      text = text.substring(startIdx);

      let braceCount = 0;
      let inClass = false;
      let endIdx = text.length;

      for (let i = 0; i < text.length; i++) {
        if (text.substring(i).startsWith('class Solution')) {
          inClass = true;
        }
        if (inClass) {
          if (text[i] === '{') {
            braceCount++;
          } else if (text[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              endIdx = (text[i + 1] === ';') ? (i + 2) : (i + 1);
              break;
            }
          }
        }
      }
      text = text.substring(0, endIdx).trim();
    }
  }

  // 4. If target platform is an online judge with a driver (GFG, LeetCode), strip boilerplate & comments
  if (isPlatformWithDriver) {
    const lines = text.split('\n');
    const filteredLines = [];

    for (let line of lines) {
      const trimmed = line.trim();
      // Remove #include directives
      if (trimmed.startsWith('#include')) {
        continue;
      }
      // Remove using namespace std;
      if (/^using\s+namespace\s+std\s*;/.test(trimmed)) {
        continue;
      }
      // Remove full-line comments (explanatory comments)
      if (trimmed.startsWith('//')) {
        continue;
      }
      // Remove markdown headings if present
      if (/^#{1,6}\s+/.test(trimmed)) {
        continue;
      }
      filteredLines.push(line);
    }

    text = filteredLines.join('\n').trim();

    // Remove block comments /* ... */
    text = text.replace(/\/\*[\s\S]*?\*\//g, '').trim();

    // Remove unnecessary std:: prefixes (std::vector -> vector, std::string -> string, etc.)
    text = text.replace(/\bstd::(?=[a-zA-Z_])/g, '');
  }

  return text;
}

/**
 * Validates whether C++ code appears complete and compilable rather than truncated mid-stream.
 * Checks for minimum substance and balanced curly braces without stripping any code.
 */
function validateCppCompleteness(code) {
  if (!code || typeof code !== 'string') {
    return { isComplete: false, reason: 'Empty code' };
  }

  const trimmed = code.trim();
  if (trimmed.length < 20) {
    return { isComplete: false, reason: 'Code too short to be a complete solution' };
  }

  // Must contain actual code substance (classes, structs, or functions with body)
  const hasSubstance = /\b(class|struct|int|void|bool|double|float|long|auto|template|string|vector)\b/.test(trimmed) &&
                       /[({]/.test(trimmed);
  if (!hasSubstance) {
    return { isComplete: false, reason: 'Contains only declarations without definitions' };
  }

  // Brace balance verification respecting comments, strings, and character literals
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

/**
 * Builds the C++17 system prompt and problem request.
 * Enforces platform-specific format conventions (GeeksforGeeks, LeetCode, etc.):
 * - Exact class Solution and member function signature.
 * - No #include directives or using namespace std; when platform provides driver.
 * - Avoid unnecessary std:: prefixes.
 * - No invented function names, parameters, return types, or class names.
 * - No explanatory comments.
 * - Complete and compilable within the platform's provided template.
 */
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

/**
 * Sends a single POST request to the Google Gemini API.
 */
async function callGeminiApi({ apiKey, model, prompt, contents, temperature, maxTokens, returnMetadata = false }) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new GeminiApiError('API key is missing. Please set your Google Gemini API key in Settings.', {
      category: 'MISSING_API_KEY',
      httpStatus: 0,
      stage: 'VALIDATION'
    });
  }

  const cleanKey = apiKey.trim().replace(/^["'`]|["'`]$/g, '').trim();
  const cleanModel = (model && model.trim()) ? model.trim().replace(/^models\//, '') : DEFAULT_MODEL;
  const temp = (typeof temperature === 'number') ? temperature : DEFAULT_TEMPERATURE;
  const tokens = (typeof maxTokens === 'number') ? maxTokens : DEFAULT_MAX_TOKENS;

  // Include query parameter for maximum gateway compatibility + x-goog-api-key header
  const endpointUrl = `${GEMINI_API_BASE}/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(cleanKey)}`;
  const safeLogEndpoint = `${GEMINI_API_BASE}/${encodeURIComponent(cleanModel)}:generateContent?key=[REDACTED]`;

  const payload = {
    contents: contents || [
      {
        role: 'user',
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      maxOutputTokens: tokens
    }
  };

  // Only pass temperature for models that support it (Gemini 3+ deprecates temperature in generationConfig)
  if (!cleanModel.startsWith('gemini-3.') && typeof temp === 'number' && !isNaN(temp)) {
    payload.generationConfig.temperature = temp;
  }

  // Pass systemInstruction for strict compilable C++17 output matching platform format
  payload.systemInstruction = {
    parts: [
      {
        text: 'Return only the complete, compilable C++17 solution code in the exact format expected by the coding platform. For GeeksforGeeks and LeetCode, prefer the required class Solution and function signature from the problem template. Do not include #include directives or using namespace std; when the platform already provides them. Avoid unnecessary std:: prefixes. Do not invent function names, parameters, return types, or class names. Do not add explanatory comments. Ensure the solution is complete and compilable within the platform template.'
      }
    ]
  };

  logDiagnostic('PREPARE_REQUEST', {
    model: cleanModel,
    endpoint: safeLogEndpoint,
    maxTokens: tokens,
    hasTemperature: payload.generationConfig.temperature !== undefined,
    keyLength: cleanKey.length
  });

  // 90-second bounded timeout with AbortController (1 minute 30 seconds)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, GEMINI_REQUEST_TIMEOUT_MS);

  let response;
  try {
    logDiagnostic('FETCH_START', { model: cleanModel });
    response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': cleanKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (networkError) {
    if (networkError.name === 'AbortError' || controller.signal.aborted) {
      logDiagnostic('FETCH_TIMEOUT', { model: cleanModel });
      throw new GeminiApiError('Connection timed out after 90 seconds. Google Gemini API did not respond in time.', {
        category: 'TIMEOUT',
        httpStatus: 0,
        providerMessage: 'Request aborted after 90000ms',
        stage: 'NETWORK_FETCH'
      });
    }
    logDiagnostic('FETCH_NETWORK_ERROR', { model: cleanModel, error: networkError.message });
    throw new GeminiApiError(`Network failure: Unable to reach Google Gemini API (${networkError.message || 'offline or DNS error'}).`, {
      category: 'NETWORK_ERROR',
      httpStatus: 0,
      providerMessage: networkError.message || 'Network unreachable',
      stage: 'NETWORK_FETCH'
    });
  } finally {
    clearTimeout(timeoutId);
  }

  logDiagnostic('FETCH_RESPONSE', {
    model: cleanModel,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok
  });

  // Handle HTTP status codes defensively
  if (!response.ok) {
    let errorDetail = '';
    let errorCode = '';
    try {
      const errJson = await response.json();
      if (errJson && errJson.error) {
        errorDetail = errJson.error.message || '';
        errorCode = errJson.error.status || '';
      }
    } catch {
      // Body not JSON
    }

    logDiagnostic('HTTP_ERROR_DETAIL', {
      status: response.status,
      errorCode,
      errorDetail
    });

    switch (response.status) {
      case 400:
        if (errorDetail.toLowerCase().includes('api key') || errorCode === 'INVALID_ARGUMENT') {
          throw new GeminiApiError(`HTTP 400 (Invalid API Key): The provided key is not recognized by Google Gemini API. Please check your key in Google AI Studio.`, {
            category: 'INVALID_API_KEY',
            httpStatus: 400,
            providerMessage: errorDetail || 'API key not valid',
            stage: 'API_GATEWAY'
          });
        }
        throw new GeminiApiError(`HTTP 400 (Bad Request): Check your request syntax or selected model ID '${cleanModel}'. ${errorDetail}`.trim(), {
          category: 'BAD_REQUEST',
          httpStatus: 400,
          providerMessage: errorDetail,
          stage: 'API_GATEWAY'
        });
      case 401:
      case 403:
        throw new GeminiApiError(`HTTP ${response.status} (Authentication / Authorization Error): Invalid API key or permission denied. Please verify your Gemini API key in Google AI Studio.`, {
          category: 'AUTH_DENIED',
          httpStatus: response.status,
          providerMessage: errorDetail,
          stage: 'API_GATEWAY'
        });
      case 404:
        throw new GeminiApiError(`HTTP 404 (Not Found): Model '${cleanModel}' does not exist or is not available on this API version.`, {
          category: 'MODEL_NOT_FOUND',
          httpStatus: 404,
          providerMessage: errorDetail,
          stage: 'ROUTING'
        });
      case 429:
        throw new GeminiApiError(`HTTP 429 (Rate Limit / Quota Exceeded): Gemini API quota exhausted. Please wait a moment or check your Google AI Studio plan.`, {
          category: 'QUOTA_EXCEEDED',
          httpStatus: 429,
          providerMessage: errorDetail,
          stage: 'RATE_LIMIT'
        });
      case 500:
      case 503:
        throw new GeminiApiError(`HTTP ${response.status} (Service Unavailable): Google Gemini server error. Please try again later.`, {
          category: 'PROVIDER_SERVER_ERROR',
          httpStatus: response.status,
          providerMessage: errorDetail,
          stage: 'PROVIDER_BACKEND'
        });
      default:
        throw new GeminiApiError(`HTTP ${response.status} error from Gemini API: ${errorDetail || response.statusText || 'Unknown error'}`, {
          category: 'HTTP_ERROR',
          httpStatus: response.status,
          providerMessage: errorDetail || response.statusText,
          stage: 'HTTP_RESPONSE'
        });
    }
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new GeminiApiError('Malformed JSON received from Google Gemini API.', {
      category: 'MALFORMED_JSON',
      httpStatus: response.status,
      stage: 'PARSE'
    });
  }

  // Check prompt feedback for content block
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new GeminiApiError(`Gemini blocked the request: ${data.promptFeedback.blockReason}`, {
      category: 'PROMPT_BLOCKED',
      httpStatus: 200,
      providerMessage: data.promptFeedback.blockReason,
      stage: 'SAFETY_FILTER'
    });
  }

  if (!data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
    throw new GeminiApiError('Gemini API returned an empty response with no candidate solutions.', {
      category: 'EMPTY_RESPONSE',
      httpStatus: 200,
      stage: 'PARSE'
    });
  }

  const primaryCandidate = data.candidates[0];
  const finishReason = primaryCandidate.finishReason || 'STOP';

  // Inspect candidate finish reason
  if (finishReason === 'SAFETY') {
    throw new GeminiApiError('Gemini response was blocked due to safety guidelines.', {
      category: 'SAFETY_BLOCK',
      httpStatus: 200,
      stage: 'SAFETY_FILTER'
    });
  }

  const content = primaryCandidate.content;
  if (!content || !content.parts || !Array.isArray(content.parts) || content.parts.length === 0) {
    throw new GeminiApiError('Gemini API candidate response contained no text parts.', {
      category: 'EMPTY_RESPONSE',
      httpStatus: response.status,
      providerMessage: 'candidates[0].content.parts is empty',
      stage: 'PARSE'
    });
  }

  // Modern Gemini models (Gemini 2.5 / 3.x) return thinking parts with thought: true
  // Filter out thinking parts to extract the actual solution or response text
  const visibleParts = content.parts.filter(p => !p.thought);
  const generatedText = visibleParts.map(p => p.text || '').join('');

  if (!generatedText.trim()) {
    if (finishReason === 'MAX_TOKENS') {
      throw new GeminiApiError('The model exhausted its token limit during reasoning before producing visible text. Increase max output tokens in Settings.', {
        category: 'THINKING_TOKEN_LIMIT',
        httpStatus: response.status,
        providerMessage: 'finishReason: MAX_TOKENS',
        stage: 'PARSE'
      });
    }
    throw new GeminiApiError('Gemini API candidate response contained no visible text.', {
      category: 'EMPTY_RESPONSE',
      httpStatus: response.status,
      stage: 'PARSE'
    });
  }

  // If finishReason is MAX_TOKENS and caller did not request raw metadata,
  // do not silently return incomplete code!
  if (finishReason === 'MAX_TOKENS' && !returnMetadata) {
    const err = new GeminiApiError('The generated solution was truncated because the model reached its output token limit (MAX_TOKENS). Please increase Max Output Tokens in Settings.', {
      category: 'TOKEN_LIMIT_TRUNCATED',
      httpStatus: 200,
      providerMessage: 'finishReason: MAX_TOKENS',
      stage: 'VALIDATION'
    });
    err.partialText = generatedText;
    throw err;
  }

  if (returnMetadata) {
    return {
      text: generatedText,
      finishReason,
      rawCandidate: primaryCandidate
    };
  }

  return generatedText;
}

/**
 * Handle incoming messages from popup, settings, or content scripts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    return false;
  }

  // Action: OPEN_SETTINGS
  if (message.action === 'OPEN_SETTINGS') {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    }
    sendResponse({ success: true });
    return false;
  }

  // Action: TEST_CONNECTION
  if (message.action === 'TEST_CONNECTION') {
    (async () => {
      const cleanModel = (message.model && message.model.trim()) ? message.model.trim().replace(/^models\//, '') : DEFAULT_MODEL;
      logDiagnostic('TEST_CONNECTION_START', { model: cleanModel });

      try {
        const apiKey = message.apiKey;

        if (!apiKey || !apiKey.trim()) {
          sendResponse({
            success: false,
            error: 'API key is required to test the connection. Please enter a key.',
            category: 'MISSING_API_KEY',
            httpStatus: 0,
            stage: 'INPUT_VALIDATION',
            targetModel: cleanModel
          });
          return;
        }

        // Test with a ping (1024 tokens to accommodate thinking models)
        const pingPrompt = 'Reply with the word OK and nothing else.';
        const result = await callGeminiApi({
          apiKey,
          model: cleanModel,
          prompt: pingPrompt,
          temperature: 0.0,
          maxTokens: 1024
        });

        logDiagnostic('TEST_CONNECTION_SUCCESS', {
          model: cleanModel,
          pingResponse: result.trim().slice(0, 50)
        });

        sendResponse({
          success: true,
          message: `Connection successful! Connected to model '${cleanModel}'. Note: Google AI Studio quotas apply to your account tier.`,
          pingResponse: result.trim(),
          category: 'SUCCESS',
          httpStatus: 200,
          targetModel: cleanModel
        });
      } catch (err) {
        logDiagnostic('TEST_CONNECTION_FAILED', {
          category: err.category || 'UNKNOWN',
          httpStatus: err.httpStatus || 0,
          message: err.message,
          providerMessage: err.providerMessage || '',
          stage: err.stage || 'EXECUTION'
        });

        sendResponse({
          success: false,
          error: err.message || 'Unknown error occurred during connection test.',
          category: err.category || 'UNKNOWN',
          httpStatus: err.httpStatus || 0,
          providerMessage: err.providerMessage || '',
          stage: err.stage || 'EXECUTION',
          targetModel: cleanModel
        });
      }
    })();
    return true; // Keep channel open for async response
  }

  // Action: GENERATE_SOLUTION
  if (message.action === 'GENERATE_SOLUTION') {
    if (isGenerating) {
      sendResponse({
        success: false,
        error: 'A solution generation request is already in progress. Please wait for it to complete.'
      });
      return false;
    }

    isGenerating = true;

    (async () => {
      try {
        const problemText = message.problemText;
        if (!problemText || typeof problemText !== 'string' || problemText.trim().length < 5) {
          throw new Error('Problem description is empty or too short to generate a solution.');
        }

        // Retrieve settings from chrome.storage.local
        const stored = await chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'maxOutputTokens', 'temperature']);
        const apiKey = stored.geminiApiKey;
        const model = stored.geminiModel || DEFAULT_MODEL;
        let maxTokens = stored.maxOutputTokens ? parseInt(stored.maxOutputTokens, 10) : DEFAULT_MAX_TOKENS;
        if (!maxTokens || maxTokens < 4096) {
          maxTokens = DEFAULT_MAX_TOKENS;
        }
        const temp = stored.temperature !== undefined ? parseFloat(stored.temperature) : DEFAULT_TEMPERATURE;

        if (!apiKey || !apiKey.trim()) {
          throw new Error('Google Gemini API key is missing. Please click the extension icon, open Settings, and enter your key.');
        }

        const platform = message.platform || '';
        const templateCode = message.templateCode || '';
        const signature = message.signature || '';
        const isPlatformWithDriver = /geeksforgeeks|gfg|leetcode/i.test(platform);

        const prompt = buildCpp17Prompt(problemText, { platform, templateCode, signature });

        // Attempt 1: Initial generation with returnMetadata to inspect finishReason
        let result = null;
        try {
          result = await callGeminiApi({
            apiKey,
            model,
            prompt,
            temperature: temp,
            maxTokens,
            returnMetadata: true
          });
        } catch (err) {
          if (err.category === 'TOKEN_LIMIT_TRUNCATED') {
            result = { text: err.partialText || '', finishReason: 'MAX_TOKENS' };
          } else {
            throw err;
          }
        }

        let solutionCode = normalizeCppCode(result.text, { isPlatformWithDriver });
        let validation = validateCppCompleteness(solutionCode);
        const isTruncated = (result.finishReason === 'MAX_TOKENS') || !validation.isComplete;

        // Requirement: If response is truncated, retry once with adjusted limit or continuation strategy
        if (isTruncated) {
          logDiagnostic('TRUNCATION_DETECTED_RETRYING', {
            finishReason: result.finishReason,
            validationReason: validation.reason,
            initialLength: solutionCode.length
          });

          let retriedSuccess = false;

          // Strategy A: If maxTokens was below 8192, retry with full 8192 token limit
          if (maxTokens < 8192) {
            try {
              const retryResult = await callGeminiApi({
                apiKey,
                model,
                prompt,
                temperature: temp,
                maxTokens: 8192,
                returnMetadata: true
              });

              const retryCode = normalizeCppCode(retryResult.text, { isPlatformWithDriver });
              const retryValidation = validateCppCompleteness(retryCode);

              if (retryResult.finishReason !== 'MAX_TOKENS' && retryValidation.isComplete) {
                solutionCode = retryCode;
                retriedSuccess = true;
              }
            } catch (retryErr) {
              logDiagnostic('RETRY_ADJUSTED_LIMIT_FAILED', { error: retryErr.message });
            }
          }

          // Strategy B: Continuation strategy if Strategy A was not used or did not produce complete code
          if (!retriedSuccess && solutionCode.length >= 20) {
            try {
              const continuationPrompt = 'Your previous C++17 code was cut off. Return ONLY the remaining continuation C++17 code from the exact cut-off point to complete the solution. No comments, explanations, Markdown fences, or repetition.';
              const continuationContents = [
                { role: 'user', parts: [{ text: prompt }] },
                { role: 'model', parts: [{ text: result.text }] },
                { role: 'user', parts: [{ text: continuationPrompt }] }
              ];

              const contResult = await callGeminiApi({
                apiKey,
                model,
                contents: continuationContents,
                temperature: temp,
                maxTokens: 8192,
                returnMetadata: true
              });

              const combinedRaw = result.text + '\n' + contResult.text;
              const combinedCode = normalizeCppCode(combinedRaw, { isPlatformWithDriver });
              const combinedValidation = validateCppCompleteness(combinedCode);

              if (contResult.finishReason !== 'MAX_TOKENS' && combinedValidation.isComplete) {
                solutionCode = combinedCode;
                retriedSuccess = true;
              }
            } catch (contErr) {
              logDiagnostic('CONTINUATION_RETRY_FAILED', { error: contErr.message });
            }
          }

          // If still truncated or incomplete after retry, throw a clear error
          const finalValidation = validateCppCompleteness(solutionCode);
          if (!finalValidation.isComplete || (result.finishReason === 'MAX_TOKENS' && !retriedSuccess)) {
            throw new GeminiApiError('Code generation incomplete: The model reached its output token limit (MAX_TOKENS) before completing the solution. Please increase Max Output Tokens in Settings.', {
              category: 'TOKEN_LIMIT_TRUNCATED',
              httpStatus: 200,
              providerMessage: `Incomplete code: ${finalValidation.reason || 'MAX_TOKENS'}`,
              stage: 'VALIDATION'
            });
          }
        }

        // Save last generated solution for quick recovery
        await chrome.storage.local.set({
          lastSolution: solutionCode,
          lastGeneratedAt: Date.now()
        });

        sendResponse({
          success: true,
          code: solutionCode,
          model
        });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message || 'Failed to generate solution.',
          category: err.category || 'UNKNOWN'
        });
      } finally {
        // Guarantee in-flight lock release
        isGenerating = false;
      }
    })();
    return true; // Keep message channel open for async response
  }

  // Action: GET_STATUS
  if (message.action === 'GET_STATUS') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'maxOutputTokens', 'temperature', 'lastSolution', 'isActivated']);
        sendResponse({
          success: true,
          hasKey: Boolean(stored.geminiApiKey && stored.geminiApiKey.trim().length > 0),
          isActivated: Boolean(stored.isActivated && stored.geminiApiKey && stored.geminiApiKey.trim().length > 0),
          model: stored.geminiModel || DEFAULT_MODEL,
          maxOutputTokens: stored.maxOutputTokens || DEFAULT_MAX_TOKENS,
          temperature: stored.temperature !== undefined ? stored.temperature : DEFAULT_TEMPERATURE,
          hasLastSolution: Boolean(stored.lastSolution),
          isGenerating
        });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message
        });
      }
    })();
    return true;
  }

  return false;
});

/**
 * Handle registered Manifest V3 keyboard shortcut commands:
 * 1. Alt+Shift+A: activate-extension
 * 2. Alt+Shift+G: generate-solution
 * 3. Alt+Shift+H: hide-panel
 * 4. Alt+Shift+R: restore-panel
 */
chrome.commands.onCommand.addListener(async (command) => {
  logDiagnostic('KEYBOARD_COMMAND_RECEIVED', { command });

  // Command 1: Alt+Shift+A (First-time Activation & Settings)
  if (command === 'activate-extension') {
    try {
      const settingsUrl = chrome.runtime.getURL('settings.html?mode=activation');
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('settings.html*') });
      if (tabs && tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        if (tabs[0].windowId) {
          await chrome.windows.update(tabs[0].windowId, { focused: true });
        }
      } else {
        await chrome.tabs.create({ url: settingsUrl });
      }
    } catch (err) {
      console.error('Smart-Coder Gemini: Failed to handle activation shortcut:', err.message);
    }
    return;
  }

  // Page-level commands (Alt+Shift+G, Alt+Shift+H, Alt+Shift+R)
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.id) {
      return;
    }

    if (!activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://')) {
      console.warn('Smart-Coder Gemini: Shortcut cannot execute on browser system pages.');
      return;
    }

    let actionName = '';
    if (command === 'generate-solution') {
      actionName = 'SHORTCUT_GENERATE_SOLUTION';
    } else if (command === 'hide-panel') {
      actionName = 'SHORTCUT_HIDE_PANEL';
    } else if (command === 'restore-panel') {
      actionName = 'SHORTCUT_RESTORE_PANEL';
    }

    if (actionName) {
      chrome.tabs.sendMessage(activeTab.id, { action: actionName }, async () => {
        if (chrome.runtime.lastError) {
          // Tab does not have content script injected (e.g. extension was just reloaded).
          // Attempt self-healing dynamic injection using scripting API.
          try {
            if (chrome.scripting && chrome.scripting.executeScript) {
              await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                files: ['content.js']
              });
              setTimeout(() => {
                chrome.tabs.sendMessage(activeTab.id, { action: actionName }, () => {
                  if (chrome.runtime.lastError) {
                    // Suppress if tab closed or navigating
                  }
                });
              }, 120);
            }
          } catch (injectErr) {
            console.warn('Smart-Coder Gemini: Self-healing injection failed:', injectErr.message);
          }
        }
      });
    }
  } catch (err) {
    console.error('Smart-Coder Gemini: Failed to handle keyboard command:', command, err.message);
  }
});
