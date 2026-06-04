// Default settings configuration
const DEFAULTS = {
  geminiApiKey: "",
  enableGemini: false,
  clearanceRegex: "(u\\.s\\.\\s*citizen|security clearance|secret clearance|top secret|dod|green card required|lawful permanent resident)",
  sponsorshipRejectRegex: "(no visa sponsorship|does not sponsor|no (visa |h-?1b )?sponsorship available|must not require (visa |h-?1b )?sponsorship|unable to sponsor|unable to provide (visa |h-?1b )?sponsorship|not open to (visa |h-?1b )?sponsorship|no visa support|no h-?1b sponsorship|does not provide (visa |h-?1b )?sponsorship|without (visa |h-?1b )?sponsorship|will not provide (visa |h-?1b )?sponsorship|not eligible for (visa |h-?1b )?sponsorship|not offering (visa |h-?1b )?sponsorship|does not offer (visa |h-?1b )?sponsorship|cannot provide (visa |h-?1b )?sponsorship)",
  sponsorshipAcceptRegex: "(visa sponsorship|h-?1b sponsorship|sponsorship is available|eligible for sponsorship|will sponsor)"
};

// Save options to chrome.storage.local
function saveOptions(e) {
  e.preventDefault();
  
  const settings = {
    geminiApiKey: document.getElementById("geminiApiKey").value.trim(),
    enableGemini: document.getElementById("enableGemini").checked,
    clearanceRegex: document.getElementById("clearanceRegex").value.trim(),
    sponsorshipRejectRegex: document.getElementById("sponsorshipRejectRegex").value.trim(),
    sponsorshipAcceptRegex: document.getElementById("sponsorshipAcceptRegex").value.trim()
  };

  chrome.storage.local.set(settings, () => {
    const status = document.getElementById("status");
    status.textContent = "Settings saved successfully!";
    status.className = "status-msg success";
    status.style.display = "block";
    
    setTimeout(() => {
      status.style.display = "none";
    }, 3000);
  });
}

// Restore options from storage or use defaults
function restoreOptions() {
  chrome.storage.local.get(DEFAULTS, (items) => {
    document.getElementById("geminiApiKey").value = items.geminiApiKey;
    document.getElementById("enableGemini").checked = items.enableGemini;
    document.getElementById("clearanceRegex").value = items.clearanceRegex;
    document.getElementById("sponsorshipRejectRegex").value = items.sponsorshipRejectRegex;
    document.getElementById("sponsorshipAcceptRegex").value = items.sponsorshipAcceptRegex;
  });
}

document.addEventListener("DOMContentLoaded", restoreOptions);
document.getElementById("settingsForm").addEventListener("submit", saveOptions);
