// SkipClick - Job Radar - Content Script

let sponsorMap = {};
let prefixMap = {}; // 2-word prefix lookup: "word1 word2" -> [key1, key2, ...]
let config = {};
let clearanceRegex = null;
let sponsorRejectRegex = null;
let sponsorAcceptRegex = null;
let currentDescriptionJobId = null;

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
  const { companyName } = card ? getCardMetadata(card) : getDetailsPaneMetadata();
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

  const badgeText = stats ? `H1B: ${stats[0]}${isGroupMatch ? " (Group)" : ""}` : "No H1B History";
  const badgeClass = stats ? "sc-badge-green" : "sc-badge-yellow";

  if (card) {
    injectBadge(card, badgeText, badgeClass);
    if (stats) {
      card.classList.add('skipclick-card-verified');
    }
  }
  
  // Also inject on the top card!
  injectTopCardBadge(badgeText, badgeClass);
}

// Locate the main job details top card component
function getTopCard() {
  return document.querySelector(
    '.job-details-jobs-unified-top-card, ' +
    '.jobs-unified-top-card, ' +
    '.jobs-details-top-card, ' +
    '.jobs-box'
  );
}

// Extract company name and job title from the job details pane
function getDetailsPaneMetadata() {
  const topCard = getTopCard();
  if (!topCard) return { companyName: "", jobTitle: "" };

  const companyEl = topCard.querySelector(
    '.job-details-jobs-unified-top-card__company-name, ' +
    '.jobs-unified-top-card__company-name, ' +
    '.jobs-details-top-card__company-url, ' +
    '[class*="unified-top-card__company-name"] a, ' +
    'a[href*="/company/"], ' +
    '[class*="company-name"]'
  );
  
  const titleEl = topCard.querySelector(
    '.job-details-jobs-unified-top-card__job-title, ' +
    '.jobs-unified-top-card__job-title, ' +
    '[class*="unified-top-card__job-title"], ' +
    'h1, h2, ' +
    '[class*="job-title"]'
  );

  const companyName = companyEl ? companyEl.innerText.trim() : "";
  const jobTitle = titleEl ? titleEl.innerText.trim() : "";
  return { companyName, jobTitle };
}

// Get or create the badge container in the top card
function getTopCardBadgeContainer() {
  const topCard = getTopCard();
  if (!topCard) return null;

  let container = topCard.querySelector('.skipclick-top-card-badge-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'skipclick-badge-container skipclick-top-card-badge-container';
    
    // Find target area to append the container inside the top card
    const targetArea = topCard.querySelector(
      '.job-details-jobs-unified-top-card__primary-description, ' +
      '.jobs-unified-top-card__primary-description, ' +
      '[class*="primary-description"], ' +
      '.job-details-jobs-unified-top-card__company-name, ' +
      '.jobs-unified-top-card__company-name'
    );
    if (targetArea) {
      targetArea.appendChild(container);
    } else {
      topCard.appendChild(container);
    }
  }
  return container;
}

// Inject a single badge into the top card
function injectTopCardBadge(text, className) {
  const container = getTopCardBadgeContainer();
  if (!container) return;

  const existingBadges = Array.from(container.querySelectorAll('.sc-badge'));
  if (existingBadges.some(b => b.innerText === text)) return;

  const badge = document.createElement('span');
  badge.className = `sc-badge ${className}`;
  badge.innerText = text;
  container.appendChild(badge);
}

// Inject badge to both sidebar card (if present) and top card
function injectBadgeBoth(card, text, className) {
  if (card) {
    injectBadge(card, text, className);
  }
  injectTopCardBadge(text, className);
}

// Remove badge from both sidebar card (if present) and top card
function removeBadgeBoth(card, text) {
  if (card) {
    const container = getOrCreateBadgeContainer(card);
    if (container) {
      const badge = Array.from(container.querySelectorAll('.sc-badge')).find(b => b.innerText === text);
      if (badge) badge.remove();
    }
  }
  const tcContainer = getTopCardBadgeContainer();
  if (tcContainer) {
    const badge = Array.from(tcContainer.querySelectorAll('.sc-badge')).find(b => b.innerText === text);
    if (badge) badge.remove();
  }
}

// Apply Gemini AI analysis results
function applyGeminiResult(card, res) {
  if (res.clearance_required) {
    injectBadgeBoth(card, "DoD / Citizen Only", "sc-badge-red");
    if (card) card.classList.add('skipclick-card-blocked');
  }
  
  if (res.sponsorship_available === false) {
    injectBadgeBoth(card, "Explicit No (AI)", "sc-badge-red");
    if (card) card.classList.add('skipclick-card-blocked');
  } else if (res.sponsorship_available === true) {
    injectBadgeBoth(card, "Sponsor (AI)", "sc-badge-green");
    if (card) {
      card.classList.remove('skipclick-card-blocked');
      card.classList.add('skipclick-card-verified');
    }
  } else {
    injectBadgeBoth(card, "Unknown Visa", "sc-badge-gray");
  }
}

// Reinject badges from cache to top card
function reinjectBadges(card, status) {
  const { companyName } = card ? getCardMetadata(card) : getDetailsPaneMetadata();
  if (companyName) {
    const normalized = normalizeCompanyName(companyName);
    let stats = sponsorMap[normalized];
    let isGroupMatch = false;
    if (!stats) {
      const words = normalized.split(' ');
      if (words.length >= 2) {
        const prefix2 = words[0] + ' ' + words[1];
        const matchedKeys = prefixMap[prefix2];
        if (matchedKeys && matchedKeys.length > 0) {
          let totalApprovals = 0;
          for (const key of matchedKeys) {
            totalApprovals += sponsorMap[key][0];
          }
          stats = [totalApprovals];
          isGroupMatch = true;
        }
      }
    }
    const badgeText = stats ? `H1B: ${stats[0]}${isGroupMatch ? " (Group)" : ""}` : "No H1B History";
    const badgeClass = stats ? "sc-badge-green" : "sc-badge-yellow";
    injectTopCardBadge(badgeText, badgeClass);
  }

  if (status.clearance) {
    injectTopCardBadge("DoD / Citizen Only", "sc-badge-red");
  } else {
    if (status.noSponsor) {
      injectTopCardBadge("Explicit No Visa", "sc-badge-red");
    } else if (status.yesSponsor) {
      injectTopCardBadge("Sponsor Friendly", "sc-badge-green");
    }
  }

  if (status.geminiResult) {
    applyGeminiResult(card, status.geminiResult);
  }
}

// Analyzes the loaded job description text and injects badge updates
function analyzeJobDescription(card, text, jobId) {
  if (parsedJobsCache.has(jobId) && parsedJobsCache.get(jobId).localChecked) {
    const status = parsedJobsCache.get(jobId);
    reinjectBadges(card, status);
    return;
  }

  const { companyName, jobTitle } = card ? getCardMetadata(card) : getDetailsPaneMetadata();
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
    injectBadgeBoth(card, "DoD / Citizen Only", "sc-badge-red");
    if (card) card.classList.add('skipclick-card-blocked');
  } else {
    // 2. Check for explicit visa rejection
    const isRejected = (sponsorRejectRegex && sponsorRejectRegex.test(text)) || HARDCODED_REJECT_REGEX.test(text);

    if (isRejected) {
      status.noSponsor = true;
      injectBadgeBoth(card, "Explicit No Visa", "sc-badge-red");
      if (card) card.classList.add('skipclick-card-blocked');
    } 
    // 3. Check if they explicitly accept sponsorship (Only if NOT explicitly rejected)
    else if (sponsorAcceptRegex && sponsorAcceptRegex.test(text)) {
      status.yesSponsor = true;
      injectBadgeBoth(card, "Sponsor Friendly", "sc-badge-green");
      if (card) {
        card.classList.remove('skipclick-card-blocked');
        card.classList.add('skipclick-card-verified');
      }
    }
  }

  // Record that local check was done
  parsedJobsCache.set(jobId, {
    localChecked: true,
    clearance: status.clearance,
    noSponsor: status.noSponsor,
    yesSponsor: status.yesSponsor,
    geminiChecked: parsedJobsCache.get(jobId)?.geminiChecked || false,
    geminiResult: parsedJobsCache.get(jobId)?.geminiResult || null
  });

  // If local checks are ambiguous and Gemini fallback is enabled, call Gemini via background script
  const isAmbiguous = !status.clearance && !status.noSponsor && !status.yesSponsor;
  const cachedGemini = parsedJobsCache.get(jobId)?.geminiResult;
  const alreadyGeminiChecked = parsedJobsCache.get(jobId)?.geminiChecked;

  if (isAmbiguous && config.enableGemini && config.geminiApiKey) {
    if (cachedGemini) {
      applyGeminiResult(card, cachedGemini);
    } else if (!alreadyGeminiChecked) {
      // Flag immediately to prevent double query issues while network request runs
      parsedJobsCache.get(jobId).geminiChecked = true;

      injectBadgeBoth(card, "Scanning AI...", "sc-badge-blue");

      chrome.runtime.sendMessage({
        action: "queryGemini",
        data: { companyName, jobTitle, description: text }
      }, (response) => {
        // Remove scanning badge
        removeBadgeBoth(card, "Scanning AI...");

        if (response && response.success) {
          const res = response.result;
          parsedJobsCache.get(jobId).geminiResult = res;
          applyGeminiResult(card, res);
        } else {
          console.error("SkipClick Gemini Error:", response?.error);
          injectBadgeBoth(card, "AI Radar Error", "sc-badge-orange");
        }
      });
    }
  }
}

// Scans all job cards currently in the DOM
function scanJobCards() {
  // Only run scanning if we are on a LinkedIn page containing jobs or search
  const isJobsPage = window.location.pathname.includes('/jobs') || 
                     window.location.pathname.includes('/search');
  if (!isJobsPage) {
    currentDescriptionJobId = null; // Reset state when navigating away
    return;
  }

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

  // 1. Process local database check for each card in the sidebar list
  jobCards.forEach(card => {
    const { jobId } = getCardMetadata(card);
    if (!jobId) return;

    if (!card.dataset.skipclickLocalProcessed) {
      card.dataset.skipclickLocalProcessed = "true";
      checkCompanySponsorship(card);
    }
  });

  // 2. Track the active job and scan description if changed or missing copy button
  const activeJobId = getActiveJobId();
  if (activeJobId) {
    // Find the description container
    let hasCopyButton = false;
    let descContainer = null;
    const descriptionSelectors = [
      '.jobs-description__content',
      '.jobs-box__html-content',
      '[class*="jobs-description-content"]',
      '.jobs-description'
    ];
    for (const sel of descriptionSelectors) {
      descContainer = document.querySelector(sel);
      if (descContainer) break;
    }

    if (descContainer) {
      hasCopyButton = descContainer.querySelector('.skipclick-copy-container') !== null;
    }

    if (activeJobId !== currentDescriptionJobId || !hasCopyButton) {
      // Find matching card in the list (if any)
      const activeCard = jobCards.find(card => {
        const { jobId } = getCardMetadata(card);
        return jobId === activeJobId;
      });

      triggerDescriptionScan(activeCard, activeJobId);
    }
  }
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
  container.prepend(copyWrapper);
}

// Locate description container, check content load, and run parsing
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

  // If description container is not in DOM yet, return and wait for next MutationObserver cycle.
  if (!container) return;

  const currentActiveId = getActiveJobId();
  // Only analyze if the URL's active jobId matches the card/job we are scanning
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
      currentDescriptionJobId = jobId; // Mark as successfully scanned!
    }
  }
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

  const OLD_DEFAULT_CLEARANCE = "(u\\.s\\.\\s*citizen|security clearance|secret clearance|top secret|dod|green card required|lawful permanent resident)";
  const NEW_DEFAULT_CLEARANCE = "(u\\.s\\.\\s*citizen|security clearance|secret clearance|top secret|ts/sci|ts\\\\s+sci|\\\\bsci\\\\b|public trust|\\\\bdod\\\\b|green card required|lawful permanent resident|active clearance|polygraph|\\\\bssbi\\\\b)";

  // Load storage configs
  chrome.storage.local.get({
    geminiApiKey: "",
    enableGemini: false,
    clearanceRegex: NEW_DEFAULT_CLEARANCE,
    sponsorshipRejectRegex: "(no visa sponsorship|does not sponsor|no (visa |h-?1b )?sponsorship available|must not require (visa |h-?1b )?sponsorship|unable to sponsor|unable to provide (visa |h-?1b )?sponsorship|not open to (visa |h-?1b )?sponsorship|no visa support|no h-?1b sponsorship|does not provide (visa |h-?1b )?sponsorship|without (visa |h-?1b )?sponsorship|will not provide (visa |h-?1b )?sponsorship|not eligible for (visa |h-?1b )?sponsorship|not offering (visa |h-?1b )?sponsorship|does not offer (visa |h-?1b )?sponsorship|cannot provide (visa |h-?1b )?sponsorship)",
    sponsorshipAcceptRegex: "(visa sponsorship|h-?1b sponsorship|sponsorship is available|eligible for sponsorship|will sponsor)"
  }, (items) => {
    // Migrate from old default if applicable
    if (items.clearanceRegex === OLD_DEFAULT_CLEARANCE) {
      items.clearanceRegex = NEW_DEFAULT_CLEARANCE;
      chrome.storage.local.set({ clearanceRegex: NEW_DEFAULT_CLEARANCE });
    }
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
      // Limit layout scanner frequency using a micro debounce (100ms for responsiveness)
      if (window.scanTimeout) clearTimeout(window.scanTimeout);
      window.scanTimeout = setTimeout(scanJobCards, 100);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// Run setup on injection
init();
