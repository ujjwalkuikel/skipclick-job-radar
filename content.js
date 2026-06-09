// SkipClick - Job Radar - Content Script

let sponsorMap = {};
let prefixMap = {}; // 2-word prefix lookup: "word1 word2" -> [key1, key2, ...]
let config = {};
let clearanceRegex = null;
let sponsorRejectRegex = null;
let sponsorAcceptRegex = null;

// Hardcoded safeguard rejections to ensure false-positives are blocked even if local storage has outdated configs
const HARDCODED_REJECT_REGEX = /(without (visa |h-?1b )?sponsorship|will not provide (visa |h-?1b )?sponsorship|not eligible for (visa |h-?1b )?sponsorship|no visa sponsorship|no h-?1b sponsorship|does not sponsor|no (visa |h-?1b )?sponsorship available|unable to sponsor|unable to provide (visa |h-?1b )?sponsorship|not open to (visa |h-?1b )?sponsorship|no visa support|does not provide (visa |h-?1b )?sponsorship|not offering (visa |h-?1b )?sponsorship|does not offer (visa |h-?1b )?sponsorship|cannot provide (visa |h-?1b )?sponsorship|must not require (visa |h-?1b )?sponsorship)/i;

// Keep track of analyzed job IDs in memory to avoid duplicate parsing
const parsedJobsCache = new Map();

// Helper to get active Job ID from LinkedIn URLs
function getActiveJobId() {
  const match = window.location.pathname.match(/\/jobs\/view\/(\d+)/) || 
                window.location.search.match(/currentJobId=(\d+)/);
  return match ? match[1] : null;
}

// Clean and normalize company names matching the backend Python parser
function normalizeCompanyName(name) {
  if (!name) return "";
  let n = name.toLowerCase();
  
  // Remove punctuation (keep alphanumeric and spaces)
  n = n.replace(/[^\w\s]/g, "");
  
  // Normalize whitespace
  n = n.trim().replace(/\s+/g, " ");
  
  // Remove corporate suffixes at the end of the string
  const suffixes = [
    /\bllc\b/g, /\binc\b/g, /\bcorp\b/g, /\bcorporation\b/g, 
    /\bltd\b/g, /\blimited\b/g, /\bco\b/g, /\bcompany\b/g, 
    /\blp\b/g, /\bpc\b/g, /\bpllc\b/g, /\bincorporated\b/g
  ];
  for (const regex of suffixes) {
    n = n.replace(regex, "").trim();
  }
  
  // Clean up double spaces
  n = n.replace(/\s+/g, " ");
  return n;
}

// Extract company name and job title from a sidebar card
function getCardMetadata(card) {
  // Common LinkedIn selectors for company name
  const companyEl = card.querySelector(
    '.job-card-container__company-name, ' +
    '.job-card-container__primary-description, ' +
    '.artdeco-entity-lockup__subtitle, ' +
    '.subtitle, ' +
    '[class*="company-name"], ' +
    '[class*="primary-description"], ' +
    '[class*="subtitle"], ' +
    'a[href*="/company/"]'
  );
  
  // Common LinkedIn selectors for job title
  const titleEl = card.querySelector(
    '.job-card-list__title, ' +
    '.artdeco-entity-lockup__title, ' +
    '[class*="job-title"], ' +
    '[class*="entity-lockup__title"], ' +
    'a[href*="/jobs/view/"]'
  );

  // Extract job ID from card attributes or links
  let jobId = card.getAttribute('data-occludable-job-id') || 
                card.getAttribute('data-job-id') || 
                card.dataset.jobId || 
                card.dataset.occludableJobId;
                
  if (!jobId) {
    const jobLink = card.querySelector('a[href*="/jobs/view/"]');
    if (jobLink) {
      const match = jobLink.getAttribute('href').match(/\/jobs\/view\/(\d+)/);
      jobId = match ? match[1] : null;
    }
  }

  const companyName = companyEl ? companyEl.innerText.trim() : "";
  const jobTitle = titleEl ? titleEl.innerText.trim() : "";

  return { companyName, jobTitle, jobId };
}

// Injects a badge container or retrieves the existing one on a card
function getOrCreateBadgeContainer(card) {
  let container = card.querySelector('.skipclick-badge-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'skipclick-badge-container';
    
    // Find target area to append the container inside the card layout
    const targetArea = card.querySelector(
      '.artdeco-entity-lockup__content, ' +
      '.job-card-list__entity-lockup, ' +
      '[class*="entity-lockup"]'
    );
    if (targetArea) {
      targetArea.appendChild(container);
    }
  }
  return container;
}

// Injects a single badge with style matching the status
function injectBadge(card, text, className) {
  const container = getOrCreateBadgeContainer(card);
  if (!container) return;

  // Prevent duplicate badges with the same text
  const existingBadges = Array.from(container.querySelectorAll('.sc-badge'));
  if (existingBadges.some(b => b.innerText === text)) return;

  const badge = document.createElement('span');
  badge.className = `sc-badge ${className}`;
  badge.innerText = text;
  container.appendChild(badge);
}

// Perform instant offline checks based on company name
function checkCompanySponsorship(card) {
  const { companyName } = getCardMetadata(card);
  if (!companyName) return;

  const normalized = normalizeCompanyName(companyName);
  
  // 1. Attempt exact match lookup
  let stats = sponsorMap[normalized];
  let isGroupMatch = false;

  // 2. Fallback to 2-word prefix match to handle subsidiaries/extensions (e.g. "Goldman Sachs And Co" vs "Goldman Sachs")
  if (!stats) {
    const words = normalized.split(' ');
    if (words.length >= 2) {
      const prefix2 = words[0] + ' ' + words[1];
      const matchedKeys = prefixMap[prefix2];
      if (matchedKeys && matchedKeys.length > 0) {
        let totalApprovals = 0;
        let transferApprovals = 0;
        for (const key of matchedKeys) {
          totalApprovals += sponsorMap[key][0];
          transferApprovals += sponsorMap[key][1];
        }
        stats = [totalApprovals, transferApprovals];
        isGroupMatch = true;
      }
    }
  }

  if (stats) {
    const totalApprovals = stats[0];
    const groupSuffix = isGroupMatch ? " (Group)" : "";
    injectBadge(card, `H1B: ${totalApprovals}${groupSuffix}`, "sc-badge-green");
    card.classList.add('skipclick-card-verified');
  } else {
    injectBadge(card, "No H1B History", "sc-badge-yellow");
  }
}

// Analyzes the loaded job description text and injects badge updates
function analyzeJobDescription(card, text, jobId) {
  if (parsedJobsCache.has(jobId) && parsedJobsCache.get(jobId).localChecked) {
    return; // Already processed locally
  }

  const { companyName, jobTitle } = getCardMetadata(card);
  let status = {
    clearance: false,
    noSponsor: false,
    yesSponsor: false
  };

  // Run local regex checks
  if (clearanceRegex && clearanceRegex.test(text)) {
    status.clearance = true;
  }
  
  // 1. If it's a DoD / Citizen Only role, we flag it immediately and stop
  if (status.clearance) {
    injectBadge(card, "DoD / Citizen Only", "sc-badge-red");
    card.classList.add('skipclick-card-blocked');
  } else {
    // 2. Check for explicit visa rejection (using both user custom regex and the hardcoded safeguard regex)
    const isRejected = (sponsorRejectRegex && sponsorRejectRegex.test(text)) || HARDCODED_REJECT_REGEX.test(text);

    if (isRejected) {
      status.noSponsor = true;
      injectBadge(card, "Explicit No Visa", "sc-badge-red");
      card.classList.add('skipclick-card-blocked');
    } 
    // 3. Check if they explicitly accept sponsorship (Only if NOT explicitly rejected)
    else if (sponsorAcceptRegex && sponsorAcceptRegex.test(text)) {
      status.yesSponsor = true;
      injectBadge(card, "Sponsor Friendly", "sc-badge-green");
      card.classList.remove('skipclick-card-blocked');
      card.classList.add('skipclick-card-verified');
    }
  }

  // Record that local check was done
  parsedJobsCache.set(jobId, {
    localChecked: true,
    clearance: status.clearance,
    noSponsor: status.noSponsor,
    yesSponsor: status.yesSponsor,
    geminiChecked: parsedJobsCache.get(jobId)?.geminiChecked || false
  });

  // If local checks are ambiguous and Gemini fallback is enabled, call Gemini via background script
  const isAmbiguous = !status.clearance && !status.noSponsor && !status.yesSponsor;
  const alreadyGeminiChecked = parsedJobsCache.get(jobId)?.geminiChecked;

  if (isAmbiguous && config.enableGemini && config.geminiApiKey && !alreadyGeminiChecked) {
    // Flag immediately to prevent double query issues while network request runs
    parsedJobsCache.get(jobId).geminiChecked = true;

    injectBadge(card, "Scanning AI...", "sc-badge-blue");

    chrome.runtime.sendMessage({
      action: "queryGemini",
      data: { companyName, jobTitle, description: text }
    }, (response) => {
      // Remove scanning badge
      const container = getOrCreateBadgeContainer(card);
      if (container) {
        const scanningBadge = Array.from(container.querySelectorAll('.sc-badge')).find(b => b.innerText === "Scanning AI...");
        if (scanningBadge) scanningBadge.remove();
      }

      if (response && response.success) {
        const res = response.result;
        
        if (res.clearance_required) {
          injectBadge(card, "DoD / Citizen Only", "sc-badge-red");
          card.classList.add('skipclick-card-blocked');
        }
        
        if (res.sponsorship_available === false) {
          injectBadge(card, "Explicit No (AI)", "sc-badge-red");
          card.classList.add('skipclick-card-blocked');
        } else if (res.sponsorship_available === true) {
          injectBadge(card, "Sponsor (AI)", "sc-badge-green");
          card.classList.remove('skipclick-card-blocked');
          card.classList.add('skipclick-card-verified');
        } else {
          injectBadge(card, "Unknown Visa", "sc-badge-gray");
        }
      } else {
        console.error("SkipClick Gemini Error:", response?.error);
        injectBadge(card, "AI Radar Error", "sc-badge-orange");
      }
    });
  }
}

// Scans all job cards currently in the DOM
// Scans all job cards currently in the DOM
function scanJobCards() {
  const cardSelectors = [
    '.jobs-search-results__list-item',
    '.job-card-container',
    '[data-occludable-job-id]',
    '.scaffold-layout__list-item',
    '[class*="job-card-list-item"]'
  ];

  let jobCards = [];
  for (const sel of cardSelectors) {
    const cards = document.querySelectorAll(sel);
    if (cards.length > 0) {
      jobCards = Array.from(cards);
      break;
    }
  }

  const activeJobId = getActiveJobId();

  jobCards.forEach(card => {
    // Process local sponsor database check
    const { jobId } = getCardMetadata(card);
    if (!jobId) return;

    if (!card.dataset.skipclickLocalProcessed) {
      card.dataset.skipclickLocalProcessed = "true";
      checkCompanySponsorship(card);
    }

    // If this card is the currently active one (already loaded on right pane), trigger description analysis
    if (activeJobId === jobId && !card.dataset.skipclickDescriptionProcessed) {
      card.dataset.skipclickDescriptionProcessed = "true";
      setTimeout(() => {
        triggerDescriptionScan(card, jobId);
      }, 500);
    }

    // Bind click listener to scan descriptions on-demand (disabled hover scans to avoid race conditions)
    if (!card.dataset.skipclickListenersBound) {
      card.dataset.skipclickListenersBound = "true";

      card.addEventListener('click', () => {
        card.dataset.skipclickDescriptionProcessed = "true";
        setTimeout(() => {
          triggerDescriptionScan(card, jobId);
        }, 200);
      });
    }
  });
}

// Injects a floating copy button into the job description container
function injectCopyButton(container, text) {
  // Ensure parent has position relative for absolute positioning
  container.style.position = 'relative';

  let copyWrapper = container.querySelector('.skipclick-copy-container');
  if (copyWrapper) {
    const btn = copyWrapper.querySelector('.skipclick-copy-btn');
    if (btn) {
      btn.dataset.textToCopy = text;
      btn.classList.remove('copied');
      btn.querySelector('span').innerText = 'Copy Description';
      btn.querySelector('svg').innerHTML = `
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      `;
    }
    return;
  }

  copyWrapper = document.createElement('div');
  copyWrapper.className = 'skipclick-copy-container';

  const btn = document.createElement('button');
  btn.className = 'skipclick-copy-btn';
  btn.dataset.textToCopy = text;
  
  btn.innerHTML = `
    <svg class="sc-copy-icon" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    <span>Copy Description</span>
  `;

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const textToCopy = btn.dataset.textToCopy;
    try {
      await navigator.clipboard.writeText(textToCopy);
      
      btn.classList.add('copied');
      btn.querySelector('span').innerText = 'Copied!';
      btn.querySelector('svg').innerHTML = `
        <polyline points="20 6 9 17 4 12"></polyline>
      `;

      setTimeout(() => {
        btn.classList.remove('copied');
        btn.querySelector('span').innerText = 'Copy Description';
        btn.querySelector('svg').innerHTML = `
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        `;
      }, 2000);
    } catch (err) {
      console.error('SkipClick: Failed to copy description:', err);
    }
  });

  copyWrapper.appendChild(btn);
  container.appendChild(copyWrapper);
}

// Locate description container, wait for content load, and run parsing
function triggerDescriptionScan(card, jobId) {
  const descriptionSelectors = [
    '.jobs-description__content',
    '.jobs-box__html-content',
    '[class*="jobs-description-content"]',
    '.jobs-description'
  ];

  let container = null;
  for (const sel of descriptionSelectors) {
    container = document.querySelector(sel);
    if (container) break;
  }

  if (!container) return;

  // Poll briefly for active jobId in URL to match card jobId, and text to load
  let attempts = 0;
  const checkText = () => {
    const currentActiveId = getActiveJobId();
    
    // Only analyze if the URL's active jobId matches the card we clicked
    if (currentActiveId === jobId) {
      // Clone container to parse clean text without including our injected copy button
      const clone = container.cloneNode(true);
      const copyWrapper = clone.querySelector('.skipclick-copy-container');
      if (copyWrapper) copyWrapper.remove();
      const text = clone.innerText.trim();
      
      // Check if description has loaded and is not a default loading state
      if (text.length > 100) {
        analyzeJobDescription(card, text, jobId);
        injectCopyButton(container, text);
      } else if (attempts < 15) {
        attempts++;
        setTimeout(checkText, 150);
      }
    } else if (attempts < 15) {
      // The active job ID in the URL hasn't matched yet, keep waiting
      attempts++;
      setTimeout(checkText, 150);
    }
  };
  
  checkText();
}

// Helper to construct index of 2-word prefixes for fuzzy group matching
function buildPrefixIndex() {
  prefixMap = {};
  for (const key of Object.keys(sponsorMap)) {
    const words = key.split(' ');
    if (words.length >= 2) {
      const prefix2 = words[0] + ' ' + words[1];
      if (!prefixMap[prefix2]) {
        prefixMap[prefix2] = [];
      }
      prefixMap[prefix2].push(key);
    }
  }
}

// Initial script loader
async function init() {
  // Load local database of sponsors
  try {
    const dbUrl = chrome.runtime.getURL('company_db.json');
    const response = await fetch(dbUrl);
    sponsorMap = await response.json();
    buildPrefixIndex(); // Index prefixes for fuzzy group matching
  } catch (err) {
    console.error("SkipClick: Failed to load company H1B sponsor database:", err);
  }

  // Load storage configs
  chrome.storage.local.get({
    geminiApiKey: "",
    enableGemini: false,
    clearanceRegex: "(u\\.s\\.\\s*citizen|security clearance|secret clearance|top secret|dod|green card required|lawful permanent resident)",
    sponsorshipRejectRegex: "(no visa sponsorship|does not sponsor|no (visa |h-?1b )?sponsorship available|must not require (visa |h-?1b )?sponsorship|unable to sponsor|unable to provide (visa |h-?1b )?sponsorship|not open to (visa |h-?1b )?sponsorship|no visa support|no h-?1b sponsorship|does not provide (visa |h-?1b )?sponsorship|without (visa |h-?1b )?sponsorship|will not provide (visa |h-?1b )?sponsorship|not eligible for (visa |h-?1b )?sponsorship|not offering (visa |h-?1b )?sponsorship|does not offer (visa |h-?1b )?sponsorship|cannot provide (visa |h-?1b )?sponsorship)",
    sponsorshipAcceptRegex: "(visa sponsorship|h-?1b sponsorship|sponsorship is available|eligible for sponsorship|will sponsor)"
  }, (items) => {
    config = items;
    
    try {
      if (items.clearanceRegex) clearanceRegex = new RegExp(items.clearanceRegex, 'i');
      if (items.sponsorshipRejectRegex) sponsorRejectRegex = new RegExp(items.sponsorshipRejectRegex, 'i');
      if (items.sponsorshipAcceptRegex) sponsorAcceptRegex = new RegExp(items.sponsorshipAcceptRegex, 'i');
    } catch (e) {
      console.error("SkipClick: Invalid custom Regex parameters:", e);
    }

    // Initial DOM scanning
    scanJobCards();

    // Start watching the page body for dynamic updates (SPA navigation & page loads)
    const observer = new MutationObserver((mutations) => {
      // Limit layout scanner frequency using a micro debounce
      if (window.scanTimeout) clearTimeout(window.scanTimeout);
      window.scanTimeout = setTimeout(scanJobCards, 200);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// Run setup on injection
init();
