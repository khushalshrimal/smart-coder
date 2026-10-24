# Smart-Coder Gemini

> **Lightweight Chrome Extension (Manifest V3) for permitted coding practice, generating clean C++17 solutions using Google Gemini API.**

---

## 📖 Overview

**Smart-Coder Gemini** is a standalone, lightweight Manifest V3 Chrome extension built with pure vanilla HTML, CSS, and JavaScript. It connects directly to the official Google Gemini API to produce clean, optimal, and edge-case-ready **C++17** solutions for coding problems in environments where external AI assistance is explicitly permitted.

- **AI Provider:** Google Gemini API (`v1beta`).
- **Default Model:** `gemini-3.8-flash` (fast, high-intelligence, official GA model optimized for code generation).
- **Target Language:** C++17.
- **Runtime:** 100% vanilla browser runtime. Zero npm dependencies, zero build steps, no webpack, and no local server required.
- **Keyboard Shortcuts:**
  - `Alt + Shift + A`: First-time activation and settings.
  - `Alt + Shift + G`: Generate C++17 solution for currently open question.
  - `Alt + Shift + H`: Completely hide solution side panel.
  - `Alt + Shift + R`: Restore solution side panel.

---

## 📁 Project Structure

```text
Smart-Coder-Gemini/
├── README.md               # Complete setup, usage, and troubleshooting guide
├── .gitignore              # Git exclusions for OS files, logs, and CRX keys
├── manifest.json           # Chrome Manifest V3 configuration & shortcut definitions
├── service-worker.js       # Background service worker: Gemini API caller & lock manager
├── content.js              # Stealth overlay box UI, question extractors & SPA monitor
├── content.css             # Replicated stealth box overlay styling (#stealth-root / #box)
├── popup.html              # Extension toolbar popup interface
├── popup.css               # Styling for popup UI
├── popup.js                # Popup logic: manual input, extraction & clipboard copy
├── settings.html           # Standalone Settings page for API key & preferences
├── settings.css            # Settings dashboard styling
├── settings.js             # Settings logic: save, clear, test connection & validation
├── icons/
│   ├── icon16.png          # 16x16 toolbar icon
│   ├── icon48.png          # 48x48 extension management icon
│   └── icon128.png         # 128x128 high-res Chrome Web Store / detail icon
└── tests/
    ├── test-plan.md        # Comprehensive QA verification test matrix
    ├── run-tests.js        # Automated unit & mock testing runner (33/33 checks)
    └── real-browser-e2e.js # Real Google Chrome browser automation test suite (11/11 checks)
```

---

## 🛡️ Security & Privacy Architecture

1. **Client-Side Storage:**
   - Your Gemini API key is stored exclusively in your browser's private local storage via `chrome.storage.local`.
   - It is **never** sent to any intermediate server, analytics platform, or third party.
2. **Security Limitation:**
   - A key stored inside a browser extension is a client-side secret, not a true server-side secret.
   - **Recommendation:** Do not use an enterprise root or master Google Cloud key. Create a dedicated free or restricted API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
3. **No Key Leakage:**
   - The extension passes the key via the secure HTTP header `x-goog-api-key` (not in URL query parameters).
   - The key is masked in the UI with a toggle show/hide control.
   - The key is **never** logged to the browser console, network errors, UI error banners, or test output.
4. **Single Network Request & In-Flight Lock:**
   - Exactly one HTTP request is dispatched per generation action.
   - Failed requests are **never** automatically retried in infinite loops.
   - An in-flight lock guarantees that rapid keystrokes or duplicate clicks cannot trigger concurrent parallel API requests. The lock is guaranteed to release in a `finally` block.

---

## ⚡ Installation Instructions (Step-by-Step)

1. Open **Google Chrome**.
2. In the URL address bar, navigate to:
   ```text
   chrome://extensions
   ```
3. Look in the top-right corner of the page and toggle **Developer mode** to **ON**.
4. In the top-left corner, click the **Load unpacked** button.
5. In the folder picker dialog, select the `smart-code` folder (the directory that directly contains `manifest.json`).
6. You will see **Smart-Coder Gemini** appear in your list of active extensions with its icon and version `1.0.0`.
7. *(Optional)* Click the Chrome puzzle piece icon in your browser toolbar and pin **Smart-Coder Gemini** for instant access.

---

## ⚙️ Configuration & Settings Flow

You will never be stuck without a way to configure your API key:

### 1. Opening Settings
- Click the **Smart-Coder Gemini** icon in your Chrome toolbar.
- Click the **Settings icon** (top-right of the popup) or the **Open Settings** button in the alert banner.
- Alternatively, right-click the extension icon and select **Options**, or open `chrome://extensions` and click **Details** &rarr; **Extension options**.
- `settings.html` opens cleanly in a full browser tab and works on any page.

### 2. Saving Your API Key
1. Obtain a free Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Paste the key into the **API Key** input field (masked with `••••••••`).
3. Click the eye icon if you need to inspect or verify your key.
4. Choose your preferred Gemini model:
   - `gemini-3.8-flash` *(Default & Recommended: fast, high-intelligence model optimized for code)*
   - `Custom…` *(Enter any custom model identifier)*
5. Adjust **Max Output Tokens** (default: `2048`) and **Temperature** (default: `0.2` for deterministic code).
6. Click **Save Settings**. A green confirmation banner confirms local storage.

### 3. Testing Connection
- In the Settings page, click **Test Connection**.
- The extension performs a lightweight ping to the Google Gemini API using your key and selected model.
- If successful, a green banner confirms valid API access.
- *Notice:* A successful test connection confirms credentials and endpoint availability, but does **not** imply infinite free usage. Google AI Studio quotas (RPM/TPM) and billing limits apply.

---

## 💻 Keyboard Shortcuts & Interaction Workflow

### The 4 Manifest V3 Shortcuts:
1. **`Alt + Shift + A` — First-Time Activation:**
   - Opens the clean Activation & Settings dashboard in a tab.
   - Enter your Google Gemini API key and click **Save & Activate**.
   - The extension validates the key with a live ping before activation succeeds.
   - Once activated, your key is saved locally in `chrome.storage.local` and you do not need to enter it again. If already activated, pressing `Alt+Shift+A` opens Settings and lets you update your configuration.

2. **`Alt + Shift + G` — Generate Solution:**
   - On any open LeetCode, GeeksforGeeks, HackerRank, or Codeforces problem page, extracts the visible problem statement, examples, and constraints.
   - Shows progress: `Reading question…` &rarr; `Generating C++ solution…` &rarr; `Solution ready (C++17)`.
   - If the side panel is hidden, it unhides it and displays the solution.
   - If a solution for this question was already generated in this session, reuses the cached solution without making an unnecessary API request.
   - If you navigate to another problem and press `Alt+Shift+G`, detects the new problem and generates its solution.
   - In-flight locking prevents duplicate concurrent calls.

3. **`Alt + Shift + H` — Hide Box:**
   - Completely hides the on-screen stealth box so the webpage and coding editor remain 100% unobstructed.
   - Keeps your generated solution in memory/session cache.
   - Does not delete the key or disable the extension.
   - The box will not automatically pop up until you press `Alt+Shift+R` or `Alt+Shift+G`.

4. **`Alt + Shift + R` — Restore Box:**
   - Restores the stealth box back in its original position on the webpage.
   - If a solution already exists for the current question, displays it immediately.
   - If no solution has been generated yet, shows `Press Alt+Shift+G to solve` without triggering an automatic API request.

---

### Managing Shortcut Conflicts:
Chrome permits up to 4 global/suggested keyboard shortcuts. If a shortcut conflicts with an existing extension or operating system keybinding:
1. Open Google Chrome and navigate to:
   ```text
   chrome://extensions/shortcuts
   ```
2. Locate **Smart-Coder Gemini**.
3. Click the pencil icon next to any command (`activate-extension`, `generate-solution`, `hide-panel`, `restore-panel`) and reassign it to your preferred shortcut.

---

## 🔍 Workflow & Status Indicator Reference

| State | Indicator | Meaning |
|---|---|---|
| **`Searching question…`** | Gray badge | Detecting supported platform DOM and problem elements. |
| **`Question detected`** | Cyan badge | Title, statement, examples, and constraints parsed. |
| **`Reading question…`** | Blue badge | Preparing prompt and verifying API credentials. |
| **`Generating C++ solution…`** | Pulsing Cyan spinner | Waiting for response from Gemini API (`gemini-3.8-flash`). |
| **`Solution ready`** | Green checkmark | Verified C++17 code displayed and ready to copy. |
| **`Error: [details]`** | Red alert | Informative failure description with Retry button. |

---

## 🛠️ Diagnostics & Troubleshooting

| Error Code / Symptom | Root Cause | How to Fix |
|---|---|---|
| **`API key is missing`** | No API key saved in local storage. | Click extension icon &rarr; Open Settings &rarr; Enter Gemini key &rarr; Save Settings. |
| **`HTTP 401 / 403`** | Invalid API key or permission denied. | Verify that you copied the complete key from Google AI Studio. Check for extra leading/trailing whitespace. |
| **`HTTP 404 (Not Found)`** | Model ID does not exist or has been retired. | Select `gemini-3.8-flash` in Settings. |
| **`HTTP 429 (Rate Limit)`** | Google AI Studio free tier quota exhausted. | Wait 60 seconds before making another request, or check your quota at Google AI Studio dashboard. |
| **`HTTP 500 / 503`** | Google Gemini server temporary downtime. | Wait a few moments and try again. |
| **`Network failure`** | Computer offline or DNS blocked. | Check your internet connection. Ensure firewalls or adblockers do not block `generativelanguage.googleapis.com`. |
| **`Could not detect problem on page`** | Custom page layout or dynamic iframe. | Use the manual input box in the popup: paste the problem statement directly. |
| **`Shortcut does not trigger`** | Conflicting Chrome extension shortcut. | Go to `chrome://extensions/shortcuts` and reassign `Alt+Shift+G` if another extension captured it. |

---

## 🧪 Running Automated Tests

Run the built-in automated test suite using Node.js:

```bash
node tests/run-tests.js
```

### Verified Checks:
- ✅ Manifest V3 JSON schema & required permissions (`storage`, `activeTab`, `scripting`).
- ✅ Binary PNG validation for all icon sizes (16px, 48px, 128px).
- ✅ JavaScript syntax verification for all runtime files (`service-worker.js`, `content.js`, `popup.js`, `settings.js`).
- ✅ Security audit confirming zero hardcoded API keys.
- ✅ Verification that zero build systems or local servers are required.
- ✅ C++17 prompt structure and markdown code-fence stripping normalization.
- ✅ Mocked Gemini API unit tests for 200 OK, 400 Bad Request, 401/403 Auth Error, 404 Model Not Found, 429 Rate Limit, and Safety Blocks.
- ✅ In-flight lock testing ensuring concurrency prevention and `finally` lock release.

---

## 📜 Permitted Use Notice

This extension is intended exclusively for permitted self-study, learning, and practice environments where AI assistance is explicitly authorized. Do not use this tool on timed assessments, contests, proctored exams, or platforms that prohibit external AI assistance.
