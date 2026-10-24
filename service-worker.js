/**
 * Smart-Coder Gemini - Service Worker (Manifest V3 Background Script)
 * Handles secure communication with the Google Gemini API, prevents duplicate requests,
 * and coordinates shortcut triggers with content scripts and popup UI.
 */

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 2048;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// In-flight generation lock to prevent concurrent duplicate API requests
let isGenerating = false;

/**
 * Normalizes C++ response text by stripping Markdown backticks if present
 * without corrupting inner source code or edge-case string literals.
 */
function normalizeCppCode(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }

  let text = rawText.trim();

  // If wrapped in ```cpp ... ``` or ```c++ ... ``` or ``` ... ```
  const codeBlockMatch = text.match(/^```(?:cpp|c\+\+|cc|c)?\r?\n([\s\S]*?)\r?\n```$/i);
  if (codeBlockMatch && codeBlockMatch[1] !== undefined) {
    return codeBlockMatch[1].trim();
  }

  // Handle leading ```cpp / trailing ``` without exact newline bounds
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z0-9+\-_]*\r?\n?/, '');
    text = text.replace(/\r?\n?```$/, '');
    return text.trim();
  }

  return text;
}

/**
 * Builds the C++17 system prompt and problem request.
 */
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

/**
 * Sends a single POST request to the Google Gemini API.
 * Never retries automatically.
 */
async function callGeminiApi({ apiKey, model, prompt, temperature, maxTokens }) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('API key is missing. Please set your Google Gemini API key in Settings.');
  }

  const selectedModel = (model && model.trim()) ? model.trim() : DEFAULT_MODEL;
  const temp = (typeof temperature === 'number') ? temperature : DEFAULT_TEMPERATURE;
  const tokens = (typeof maxTokens === 'number') ? maxTokens : DEFAULT_MAX_TOKENS;

  // Use x-goog-api-key header to avoid leaking key into URLs or proxy query logs
  const endpointUrl = `${GEMINI_API_BASE}/${encodeURIComponent(selectedModel)}:generateContent`;

  const payload = {
    contents: [
      {
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: temp,
      maxOutputTokens: tokens
    }
  };

  let response;
  try {
    response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey.trim()
      },
      body: JSON.stringify(payload)
    });
  } catch (networkError) {
    throw new Error(`Network failure: Unable to reach Google Gemini API (${networkError.message || 'offline or DNS error'}).`);
  }

  // Handle HTTP status codes defensively
  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      if (errJson && errJson.error && errJson.error.message) {
        errorDetail = errJson.error.message;
      }
    } catch {
      // Body not JSON
    }

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

  // Check prompt feedback for content block
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}`);
  }

  if (!data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
    throw new Error('Gemini API returned an empty response with no candidate solutions.');
  }

  const primaryCandidate = data.candidates[0];

  // Inspect candidate finish reason
  if (primaryCandidate.finishReason && primaryCandidate.finishReason !== 'STOP') {
    if (primaryCandidate.finishReason === 'SAFETY') {
      throw new Error('Gemini response was blocked due to safety guidelines.');
    }
    if (primaryCandidate.finishReason === 'MAX_TOKENS') {
      console.warn('Smart-Coder Gemini: Output reached maxOutputTokens limit.');
    }
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
      try {
        const apiKey = message.apiKey;
        const model = message.model || DEFAULT_MODEL;

        if (!apiKey || !apiKey.trim()) {
          sendResponse({
            success: false,
            error: 'API key is required to test the connection. Please enter a key.'
          });
          return;
        }

        // Test with a tiny ping
        const pingPrompt = 'Reply with the word OK and nothing else.';
        const result = await callGeminiApi({
          apiKey,
          model,
          prompt: pingPrompt,
          temperature: 0.0,
          maxTokens: 10
        });

        sendResponse({
          success: true,
          message: `Connection successful! Connected to model '${model}'. Note: A successful test does not guarantee unlimited free usage; Google Cloud/AI Studio quotas apply.`,
          pingResponse: result.trim()
        });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message || 'Unknown error occurred during connection test.'
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
        const maxTokens = stored.maxOutputTokens ? parseInt(stored.maxOutputTokens, 10) : DEFAULT_MAX_TOKENS;
        const temp = stored.temperature !== undefined ? parseFloat(stored.temperature) : DEFAULT_TEMPERATURE;

        if (!apiKey || !apiKey.trim()) {
          throw new Error('Google Gemini API key is missing. Please click the extension icon, open Settings, and enter your key.');
        }

        const prompt = buildCpp17Prompt(problemText);
        const rawCode = await callGeminiApi({
          apiKey,
          model,
          prompt,
          temperature: temp,
          maxTokens
        });

        const normalizedCode = normalizeCppCode(rawCode);

        // Save last generated solution for quick recovery
        await chrome.storage.local.set({
          lastSolution: normalizedCode,
          lastGeneratedAt: Date.now()
        });

        sendResponse({
          success: true,
          code: normalizedCode,
          model
        });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message || 'Failed to generate solution.'
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
