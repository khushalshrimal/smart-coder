# Smart-Coder Gemini - Test Plan & QA Verification Suite

## 1. Overview & Objectives

This test plan validates the functionality, resilience, security, and developer ergonomics of **Smart-Coder Gemini**, a Manifest V3 Google Chrome extension engineered for permitted coding practice that produces complete C++17 solutions using Google Gemini API.

---

## 2. Test Matrix & Minimum Requirements

| ID | Category | Requirement / Test Focus | Verification Method | Status |
|---|---|---|---|---|
| **TC-01** | Manifest V3 | Valid JSON, Manifest V3 format, permissions (`storage`, `activeTab`, `scripting`), action popup, commands (`Alt+Shift+G`), options page, icons | Automated (`tests/run-tests.js`) | Automated |
| **TC-02** | Syntax Integrity | All JS files parse cleanly with zero syntax errors | Automated (`node --check` / VM parse) | Automated |
| **TC-03** | API Request Construction | Correct endpoint, `x-goog-api-key` header, model ID, JSON structure, low temperature (0.2), token limits | Automated Mock Suite | Automated |
| **TC-04** | API Response Parsing | Handles candidate parsing, finishReason `STOP`/`MAX_TOKENS`/`SAFETY`, safely normalizes markdown fences | Automated Mock Suite | Automated |
| **TC-05** | HTTP Error Handling | Proper error translation for 400, 401, 403, 404, 429, 500, 503, malformed JSON, and network errors | Automated Mock Suite | Automated |
| **TC-06** | Missing API Key | Fails fast with clear descriptive error when key is omitted | Automated Mock Suite | Automated |
| **TC-07** | In-Flight Lock | Prevents parallel duplicate requests; always releases lock in `finally` | Automated Mock Suite | Automated |
| **TC-08** | Code Normalization | Safely strips ````cpp ... ```` or ```` ... ```` without corrupting C++ code or inline strings | Automated Unit Tests | Automated |
| **TC-09** | Keyboard Shortcut | `Alt+Shift+G` declared in `manifest.json` under `commands.generate-solution` | Automated Manifest Check | Automated |
| **TC-10** | Problem Extraction | Defensive DOM selectors, noise filtration (removes nav, scripts, SVGs), fallback to selection | Content Script Logic & Manual Browser Test | Automated + Manual |
| **TC-11** | Manual Input Fallback | Popup allows manual pasting and generating without requiring page extraction | Popup Logic Test & Manual Browser Test | Automated + Manual |
| **TC-12** | Editor Insertion Verification | Verifies editor contents before reporting success; safely falls back to popup/clipboard without false claims | Automated Mock & Manual Browser Test | Automated + Manual |
| **TC-13** | Storage Security | No API key hardcoded in source code; stored only in `chrome.storage.local`; masked UI | Automated Code Audit (`tests/run-tests.js`) | Automated |
| **TC-14** | Zero-Dependency & No Build | Extension runs standalone with pure vanilla JS/HTML/CSS without npm/build step | Directory & Dependency Audit | Automated |
| **TC-15** | Automatic Detection | Platform-specific extractors for LeetCode, GeeksforGeeks, HackerRank, Codeforces | Automated Unit Tests (`tests/run-tests.js`) | Automated |
| **TC-16** | Side Panel Drawer | Shadow DOM-isolated resizable drawer with syntax-highlighted C++17 viewer | Automated Syntax & Unit Tests | Automated |
| **TC-17** | SPA Navigation Monitor | Detects client-side route changes (`pushState`, `replaceState`, `popstate`) without reload | Automated Unit Tests (`tests/run-tests.js`) | Automated |
| **TC-18** | Duplicate API Prevention | Session caching & question hashing ensures same question doesn't trigger extra calls | Automated Unit Tests (`tests/run-tests.js`) | Automated |
| **TC-19** | Workflow State Progress | Transitions through `Searching` -> `Detected` -> `Reading` -> `Generating` -> `Ready` | Automated Unit Tests (`tests/run-tests.js`) | Automated |
| **TC-20** | Responsive Collapsibility | Panel collapses to sleek tab on small screens (<1180px) and stays out of editor way | Automated & Manual Browser Test | Automated + Manual |
| **TC-21** | Alt + Shift + A | First-time activation: validates key before setting `isActivated`, notifies if already active | Automated & Manual Browser Test | Automated + Manual |
| **TC-22** | Alt + Shift + G | Generate solution: extracts on-screen question, generates C++17, reuses session cache | Automated & Manual Browser Test | Automated + Manual |
| **TC-23** | Alt + Shift + H | Hide panel: completely hides panel overlay, preserves memory/cache and API key | Automated & Manual Browser Test | Automated + Manual |
| **TC-24** | Alt + Shift + R | Restore panel: unhides panel, displays cached solution or prompts Alt+Shift+G without extra API call | Automated & Manual Browser Test | Automated + Manual |

---

## 3. Automated Test Suite Execution

Run the built-in automated test suite using Node.js:
```bash
node tests/run-tests.js
```

### Checks Performed by `tests/run-tests.js`:
1. **Manifest Validation**:
   - Manifest version is 3.
   - Required permissions are strictly defined (`storage`, `activeTab`, `scripting`).
   - Action popup references `popup.html`.
   - Options UI references `settings.html` with `open_in_tab: true`.
   - Command `generate-solution` is bound to `Alt+Shift+G`.
   - Icons 16, 48, 128 exist on disk and are valid PNGs.
2. **JavaScript Syntax Verification**:
   - `service-worker.js`
   - `content.js`
   - `popup.js`
   - `settings.js`
3. **Security & Deprecation Regression Audit**:
   - Scans all files for hardcoded API key patterns (e.g. `AIzaSy...`).
   - Ensures keys are passed via headers and stored in `chrome.storage.local`.
   - Regression check: Ensures `gemini-3.8-flash` is active default and retired models (`gemini-2.0-flash`, `gemini-1.5-flash`, `gemini-1.5-pro`) are removed from defaults and dropdown choices.
4. **Mocked Gemini API Unit Tests**:
   - Normalizing raw C++ code from various markdown wrappers.
   - System prompt construction for C++17.
   - HTTP 400 Bad Request error mapping.
   - HTTP 401/403 Authentication error mapping.
   - HTTP 404 Model Not Found error mapping.
   - HTTP 429 Quota Exceeded error mapping.
   - HTTP 500/503 Service Unavailable error mapping.
   - Empty response / candidate missing error mapping.
   - Safety block reason handling.
   - Concurrency lock and `finally` release verification.

---

## 4. Manual End-to-End Verification Guide

### Scenario A: First-Time Activation (`Alt+Shift+A`)
1. Open Google Chrome and load/reload the unpacked extension.
2. Press `Alt+Shift+A` anywhere in Chrome.
3. Verify that `settings.html` opens automatically in a new tab.
4. Verify the activation banner states: `First-Time Setup (Alt + Shift + A)`.
5. Enter your Gemini API key and click **Save & Activate**.
6. Verify that the extension tests the key with a real Gemini ping before marking it active.
7. Upon successful validation, the banner updates to: `Smart-Coder is Activated`.
8. Press `Alt+Shift+A` again; observe that it notifies you that Smart-Coder is already active and allows updating preferences.

### Scenario B: Solution Generation (`Alt+Shift+G`)
1. Open any LeetCode or GeeksforGeeks problem page (e.g. `https://leetcode.com/problems/two-sum/`).
2. Press `Alt+Shift+G`.
3. Observe the side panel appears/expands on the right edge.
4. Progress states transition: `Reading question…` -> `Generating C++ solution…` -> `Solution ready (C++17)`.
5. Observe the complete C++17 solution rendered with syntax highlighting.
6. Click **Copy Code**; verify it shows `Copied!` and copies to clipboard.
7. Press `Alt+Shift+G` again on the same question; verify it immediately reuses the cached solution without making another API request.

### Scenario C: Hide & Restore Panel (`Alt+Shift+H` and `Alt+Shift+R`)
1. While the side panel is visible with a solution, press `Alt+Shift+H`.
2. Verify the side panel hides completely from the webpage without blocking the editor.
3. Verify the generated solution is retained in memory/cache and the API key is not modified.
4. Press `Alt+Shift+R`.
5. Verify the side panel is restored and the previous solution is displayed immediately.
6. Navigate to a new problem in LeetCode/GFG without reloading the page.
7. Press `Alt+Shift+R`: verify it does not show any unwanted prompt or make an unsolicited API call.
8. Press `Alt+Shift+G`: verify it extracts the new problem and generates its solution.

### Scenario D: Edge Cases & Chrome Shortcut Conflicts
1. **Shortcut Conflicts**: If a shortcut doesn't trigger, navigate to `chrome://extensions/shortcuts` to verify or reassign `Alt+Shift+A`, `Alt+Shift+G`, `Alt+Shift+H`, `Alt+Shift+R`.
2. **Invalid API Key**: Enter an invalid key in Activation; verify activation fails with clear error and does not activate.
3. **Restricted Pages**: Pressing shortcuts on `chrome://` or webstore displays safe warning in console and avoids errors.
4. **Duplicate Shortcut Press**: Rapidly pressing `Alt+Shift+G` respects the in-flight lock and avoids duplicate requests.
