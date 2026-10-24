/**
 * Smart-Coder Gemini - Settings Script
 * Handles first-time activation (Alt+Shift+A), API key verification,
 * model selection, parameters, and persistence in chrome.storage.local.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const activationBanner = document.getElementById('activation-banner');
  const activationIcon = document.getElementById('activation-icon');
  const activationHeadline = document.getElementById('activation-headline');
  const activationSubtext = document.getElementById('activation-subtext');

  const apiKeyInput = document.getElementById('api-key-input');
  const toggleKeyVisibilityBtn = document.getElementById('toggle-key-visibility-btn');
  const eyeIcon = document.getElementById('eye-icon');
  const modelSelect = document.getElementById('model-select');
  const customModelGroup = document.getElementById('custom-model-group');
  const customModelInput = document.getElementById('custom-model-input');
  const maxTokensInput = document.getElementById('max-tokens-input');
  const temperatureInput = document.getElementById('temperature-input');

  const saveActivateBtn = document.getElementById('save-activate-btn');
  const saveActivateLabel = document.getElementById('save-activate-label');
  const testBtn = document.getElementById('test-btn');
  const clearBtn = document.getElementById('clear-btn');

  const savedKeyPill = document.getElementById('saved-key-pill');
  const savedKeyLabel = document.getElementById('saved-key-label');

  const statusCard = document.getElementById('status-card');
  const statusIcon = document.getElementById('status-icon');
  const statusTitle = document.getElementById('status-title');
  const statusMessage = document.getElementById('status-message');

  let isKeyVisible = false;

  // Toggle API key visibility (show/hide)
  toggleKeyVisibilityBtn.addEventListener('click', () => {
    isKeyVisible = !isKeyVisible;
    apiKeyInput.type = isKeyVisible ? 'text' : 'password';

    if (isKeyVisible) {
      eyeIcon.innerHTML = `
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      `;
    } else {
      eyeIcon.innerHTML = `
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      `;
    }
  });

  // Handle Model dropdown change
  modelSelect.addEventListener('change', () => {
    if (modelSelect.value === 'custom') {
      customModelGroup.classList.remove('hidden');
      customModelInput.focus();
    } else {
      customModelGroup.classList.add('hidden');
    }
  });

  // Load existing settings from chrome.storage.local
  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get([
        'geminiApiKey',
        'geminiModel',
        'maxOutputTokens',
        'temperature',
        'isActivated'
      ]);

      const hasKey = Boolean(stored.geminiApiKey && stored.geminiApiKey.trim());
      const isActivated = Boolean(stored.isActivated && hasKey);

      if (hasKey) {
        apiKeyInput.value = stored.geminiApiKey;
      }

      const activeModel = stored.geminiModel || 'gemini-3.8-flash';
      const standardModels = ['gemini-3.8-flash'];

      if (standardModels.includes(activeModel)) {
        modelSelect.value = activeModel;
        customModelGroup.classList.add('hidden');
      } else {
        modelSelect.value = 'custom';
        customModelGroup.classList.remove('hidden');
        customModelInput.value = activeModel;
      }

      if (stored.maxOutputTokens) {
        maxTokensInput.value = stored.maxOutputTokens;
      }

      if (stored.temperature !== undefined) {
        temperatureInput.value = stored.temperature;
      }

      updateActivationBanner(isActivated, activeModel);
      updateStatusPill(isActivated, activeModel);

      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('mode') === 'activation' || !hasKey) {
        apiKeyInput.focus();
      }
    } catch (err) {
      showStatus('error', 'Error Loading Settings', err.message || 'Failed to read settings from storage.');
    }
  }

  function updateActivationBanner(isActivated, model) {
    if (isActivated) {
      activationBanner.className = 'activation-banner banner-active';
      activationIcon.textContent = '✅';
      activationHeadline.textContent = 'Smart-Coder is Activated';
      activationSubtext.innerHTML = `Your Google Gemini API key is configured and active with model <strong>${escapeHtml(model)}</strong>. You can update your key or preferences below at any time.`;
      saveActivateLabel.textContent = 'Update & Re-activate';
    } else {
      activationBanner.className = 'activation-banner banner-pending';
      activationIcon.textContent = '⚡';
      activationHeadline.textContent = 'First-Time Activation (Alt + Shift + A)';
      activationSubtext.innerHTML = `Paste your Google Gemini API key below and click <strong>Save &amp; Activate</strong>. Your key will be tested against the Gemini API before activation.`;
      saveActivateLabel.textContent = 'Save & Activate';
    }
  }

  function updateStatusPill(isActivated, model) {
    if (isActivated) {
      savedKeyPill.className = 'key-pill pill-active';
      savedKeyLabel.textContent = `Activated (${model})`;
    } else {
      savedKeyPill.className = 'key-pill pill-missing';
      savedKeyLabel.textContent = 'Not Activated';
    }
  }

  function getEffectiveModel() {
    if (modelSelect.value === 'custom') {
      return customModelInput.value.trim() || 'gemini-3.8-flash';
    }
    return modelSelect.value;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Save & Activate Handler
  saveActivateBtn.addEventListener('click', async () => {
    const rawKey = apiKeyInput.value.trim();
    const model = getEffectiveModel();
    const maxTokens = parseInt(maxTokensInput.value, 10) || 2048;
    const temp = parseFloat(temperatureInput.value);
    const temperature = isNaN(temp) ? 0.2 : Math.max(0.0, Math.min(1.0, temp));

    if (!rawKey) {
      showStatus('error', 'API Key Required', 'Please enter your Google Gemini API key before attempting activation.');
      apiKeyInput.focus();
      return;
    }

    saveActivateBtn.disabled = true;
    showStatus('loading', 'Validating API Key…', `Testing key with live ping to Google Gemini API (model: ${model}) before activating…`);

    try {
      // Step 1: Validate key with a real Gemini API call via service worker
      const testResponse = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'TEST_CONNECTION', apiKey: rawKey, model },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(res || { success: false, error: 'No response from service worker' });
            }
          }
        );
      });

      if (!testResponse || !testResponse.success) {
        const errorText = testResponse && testResponse.error ? testResponse.error : 'Validation failed. Check your API key.';
        showStatus('error', 'Activation Failed', `${errorText} — Key was NOT activated. Please check your key and retry.`);
        return;
      }

      // Step 2: Validation succeeded! Persist key and activation state in chrome.storage.local
      await chrome.storage.local.set({
        geminiApiKey: rawKey,
        geminiModel: model,
        maxOutputTokens: maxTokens,
        temperature: temperature,
        isActivated: true,
        activatedAt: Date.now()
      });

      updateActivationBanner(true, model);
      updateStatusPill(true, model);
      showStatus(
        'success',
        'Smart-Coder Successfully Activated!',
        `Your Gemini API key was verified with Google Gemini API (${model}). On future visits, you do not need to enter the key again. Press Alt+Shift+G on any problem to generate C++17 solutions.`
      );
    } catch (err) {
      showStatus('error', 'Activation Error', err.message || 'An unexpected error occurred during activation.');
    } finally {
      saveActivateBtn.disabled = false;
    }
  });

  // Clear Key
  clearBtn.addEventListener('click', async () => {
    const confirmClear = confirm('Are you sure you want to remove your saved Gemini API key and deactivate Smart-Coder?');
    if (!confirmClear) return;

    clearBtn.disabled = true;

    try {
      await chrome.storage.local.remove(['geminiApiKey', 'isActivated', 'activatedAt']);
      apiKeyInput.value = '';
      const model = getEffectiveModel();
      updateActivationBanner(false, model);
      updateStatusPill(false, model);
      showStatus('success', 'Key Cleared', 'Your API key and activation status were removed from local storage.');
    } catch (err) {
      showStatus('error', 'Error Clearing Key', err.message || 'Failed to remove key from storage.');
    } finally {
      clearBtn.disabled = false;
    }
  });

  // Test Connection
  testBtn.addEventListener('click', async () => {
    const rawKey = apiKeyInput.value.trim();
    const model = getEffectiveModel();

    if (!rawKey) {
      showStatus('error', 'API Key Required', 'Please enter your Google Gemini API key before testing the connection.');
      apiKeyInput.focus();
      return;
    }

    testBtn.disabled = true;
    showStatus('loading', 'Testing Connection…', `Sending ping request to Google Gemini API (model: ${model})…`);

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'TEST_CONNECTION', apiKey: rawKey, model },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(res || { success: false, error: 'No response from service worker.' });
            }
          }
        );
      });

      if (response && response.success) {
        showStatus('success', 'Connection Verified!', response.message);
      } else {
        const errorText = (response && response.error) ? response.error : 'Connection test failed.';
        showStatus('error', 'Connection Test Failed', errorText);
      }
    } catch (err) {
      showStatus('error', 'Network or Script Error', err.message || 'Failed to communicate with service worker.');
    } finally {
      testBtn.disabled = false;
    }
  });

  function showStatus(type, title, message) {
    statusCard.className = `status-card status-${type}`;
    if (type === 'success') {
      statusIcon.textContent = '✅';
    } else if (type === 'error') {
      statusIcon.textContent = '❌';
    } else if (type === 'loading') {
      statusIcon.textContent = '⏳';
    } else {
      statusIcon.textContent = 'ℹ️';
    }

    statusTitle.textContent = title;
    statusMessage.textContent = message;
    statusCard.classList.remove('hidden');

    statusCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Initialize
  loadSettings();
});
