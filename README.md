# 📡 SkipClick - Job Radar

**SkipClick - Job Radar** is a lightweight, high-performance Chrome Extension (Manifest V3) designed to help job seekers instantly evaluate U.S. visa sponsorship history and government security clearance requirements directly within the LinkedIn Jobs interface. 

It functions as an offline, safe-tinting visual layer to help you skip clicks on non-viable roles and focus on matching positions.

---

## 🚀 Key Features

* **Rich H-1B History Overlay (Local DB):** Matches visible company names instantly against a pre-compiled database of **65,372 approved H-1B sponsors** (aggregated from official USCIS 2025-2026 data). Displays total approval counts on the listing card.
* **Fuzzy Group Matching:** Automatically aggregates statistics for parent companies and their diverse filing subsidiaries (e.g., combining *Goldman Sachs & Co*, *Goldman Sachs Bank*, and *Goldman Sachs Services* into a unified group count).
* **Prioritized Description Scanner (On-Demand):** Reads the active right-pane job description reactively when a card is selected:
  1. **DoD / U.S. Citizen Only Check:** Flags security clearances immediately and blocks card evaluation.
  2. **Role-Specific Visa Check:** Scans for explicit sponsorship denials (e.g., *"not offering sponsorship for this role"*). If matched, marks as `Explicit No Visa` and dims the card.
* **Zero-Block / Read-Only Safety:** Designed to follow human browsing speeds and makes **zero extra network requests to LinkedIn**. It is 100% invisible to LinkedIn's anti-automation monitors.
* **Options Dashboard:** Set custom regex thresholds and configure an optional Gemini API key for advanced AI verification.

---

## 📂 Project Structure

```
SkipClick - Job Radar/
├── manifest.json         # Extension MV3 configuration & permissions
├── content.js            # Main content script (DOM observer & parsing logic)
├── background.js         # Service worker for API queries (Gemini integrations)
├── styles.css            # Custom badge visual parameters (vibrant green, red, yellow)
├── company_db.json       # Precompiled 2025/2026 approved H-1B sponsors list
├── options.html          # Configuration dashboard UI
├── options.js            # Settings storage handler (chrome.storage.local)
└── .gitignore            # Excludes large raw data sources
```

---

## 🛠️ Installation & Setup

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/ujjwalkuikel/skipclick-job-radar.git
   ```
2. **Open Chrome Extensions:**
   Navigate to `chrome://extensions/` in your Chrome browser.
3. **Enable Developer Mode:**
   Toggle the **Developer mode** switch in the top-right corner.
4. **Load Unpacked Extension:**
   Click the **Load unpacked** button in the top-left corner and select this project folder.
5. **Configure Rules (Optional):**
   Click the extension details to open the **Options** page. Save your Gemini API Key and tweak regex check parameters as needed.

---

## 🛡️ License

This project is licensed under the MIT License.
