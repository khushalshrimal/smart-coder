/**
 * Smart-Coder Gemini - Popup Script
 * Coordinates user interaction, problem extraction, manual input,
 * solution generation, and settings navigation.
 */

document.addEventListener('DOMContentLoaded', () => {
  // UI Elements
  const keyStatusPill = document.getElementById('key-status-pill');
  const keyStatusText = document.getElementById('key-status-text');
  const missingKeyBanner = document.getElementById('missing-key-banner');
  const openSettingsBtn = document.getElementById('open-settings-btn');
  const alertSettingsBtn = document.getElementById('alert-settings-btn');
  const toggleSidepanelBtn = document.getElementById('toggle-sidepanel-btn');

  const problemInput = document.getElementById('problem-input');
  const extractPageBtn = document.getElementById('extract-page-btn');
  const generateBtn = document.getElementById('generate-btn');
  const generateBtnText = document.getElementById('generate-btn-text');

  const progressIndicator = document.getElementById('progress-indicator');
  const progressText = document.getElementById('progress-text');
  const errorBox = document.getElementById('error-box');
  const errorMessage = document.getElementById('error-message');

  const solutionSection = document.getElementById('solution-section');
  const solutionCode = document.getElementById('solution-code');
  const copySolutionBtn = document.getElementById('copy-solution-btn');
  const copyBtnText = document.getElementById('copy-btn-text');

  let isGenerating = false;

  // Open Settings helper
  function openSettings() {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    }
  }

  openSettingsBtn.addEventListener('click', openSettings);
  alertSettingsBtn.addEventListener('click', openSettings);

  if (toggleSidepanelBtn) {
    toggleSidepanelBtn.addEventListener('click', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
          chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_SIDE_PANEL' }, (res) => {
            if (chrome.runtime.lastError) {
              showError('Cannot communicate with page. Ensure you are on a standard webpage and refresh it.');
            } else {
              window.close(); // Close popup smoothly so user views side panel
            }
          });
        }
      } catch (err) {
        showError(err.message || 'Failed to toggle panel');
      }
    });
  }

  // Check initial extension status
  async function checkStatus() {
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { success: false });
          }
        });
      });

      if (response && response.success) {
        if (response.hasKey) {
          keyStatusPill.className = 'pill pill-active';
          keyStatusText.textContent = `API Key Active (${response.model})`;
          missingKeyBanner.classList.add('hidden');
        } else {
          keyStatusPill.className = 'pill pill-missing';
          keyStatusText.textContent = 'API Key Missing';
          missingKeyBanner.classList.remove('hidden');
        }
      }

      // Check if we have a cached solution to display
      const stored = await chrome.storage.local.get(['lastSolution']);
      if (stored.lastSolution && stored.lastSolution.trim()) {
        solutionCode.textContent = stored.lastSolution;
        solutionSection.classList.remove('hidden');
      }
    } catch (err) {
      keyStatusPill.className = 'pill pill-unknown';
      keyStatusText.textContent = 'Status Check Error';
    }
  }

  // Extract problem from active page
  extractPageBtn.addEventListener('click', async () => {
    extractPageBtn.disabled = true;
    hideError();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        throw new Error('No active browser tab found.');
      }

      if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
        throw new Error('Cannot extract problem text from browser system pages.');
      }

      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT_PROBLEM_TEXT' }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({
              success: false,
              error: 'Cannot communicate with content script. Try refreshing the coding page, or paste the problem text below.'
            });
          } else {
            resolve(res || { success: false, error: 'No response from page script.' });
          }
        });
      });

      if (response && response.success && response.problemText) {
        problemInput.value = response.problemText;
        problemInput.focus();
      } else {
        showError(response.error || 'Could not automatically detect problem text on this page. Please paste it manually.');
      }
    } catch (err) {
      showError(err.message || 'Failed to extract problem from tab.');
    } finally {
      extractPageBtn.disabled = false;
    }
  });

  // Generate Solution handler
  generateBtn.addEventListener('click', async () => {
    if (isGenerating) return;

    const problemText = problemInput.value.trim();
    if (!problemText || problemText.length < 5) {
      showError('Please paste or extract a coding problem statement first.');
      problemInput.focus();
      return;
    }

    hideError();
    setGenerationState(true, 'Thinking…');

    try {
      // Transition to Generating C++ code...
      setTimeout(() => {
        if (isGenerating) {
          updateProgressText('Generating C++ code…');
        }
      }, 500);

      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'GENERATE_SOLUTION', problemText },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(res || { success: false, error: 'Empty response from service worker.' });
            }
          }
        );
      });

      if (!response || !response.success) {
        throw new Error((response && response.error) ? response.error : 'Generation request failed.');
      }

      // Display solution
      solutionCode.textContent = response.code;
      solutionSection.classList.remove('hidden');

      // Verify and scroll into view
      solutionSection.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      showError(err.message || 'An error occurred during generation.');
    } finally {
      setGenerationState(false);
    }
  });

  // Copy solution to clipboard with genuine verification
  copySolutionBtn.addEventListener('click', async () => {
    const code = solutionCode.textContent;
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code);
      copyBtnText.textContent = 'Copied!';
      copySolutionBtn.classList.add('btn-secondary');
      setTimeout(() => {
        copyBtnText.textContent = 'Copy Code';
      }, 2000);
    } catch (clipErr) {
      // Fallback copy using hidden textarea
      try {
        const tempArea = document.createElement('textarea');
        tempArea.value = code;
        tempArea.style.position = 'fixed';
        tempArea.style.left = '-9999px';
        document.body.appendChild(tempArea);
        tempArea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(tempArea);

        if (successful) {
          copyBtnText.textContent = 'Copied!';
          setTimeout(() => {
            copyBtnText.textContent = 'Copy Code';
          }, 2000);
        } else {
          throw new Error('Clipboard copy command was not successful.');
        }
      } catch (fallbackErr) {
        showError('Unable to copy to clipboard automatically. Please select and copy manually.');
      }
    }
  });

  function setGenerationState(generating, message = 'Thinking…') {
    isGenerating = generating;
    generateBtn.disabled = generating;
    extractPageBtn.disabled = generating;

    if (generating) {
      progressText.textContent = message;
      progressIndicator.classList.remove('hidden');
      generateBtnText.textContent = 'Processing…';
    } else {
      progressIndicator.classList.add('hidden');
      generateBtnText.textContent = 'Generate C++17 Solution';
    }
  }

  function updateProgressText(message) {
    progressText.textContent = message;
  }

  function showError(msg) {
    errorMessage.textContent = msg;
    errorBox.classList.remove('hidden');
  }

  function hideError() {
    errorBox.classList.add('hidden');
    errorMessage.textContent = '';
  }

  // Run initial check
  checkStatus();
});
