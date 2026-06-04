// Background Service Worker for SkipClick - Job Radar

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "queryGemini") {
    handleGeminiQuery(request.data)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }
});

// Perform API request to Gemini API
async function handleGeminiQuery({ companyName, jobTitle, description }) {
  // Load configuration from local storage
  const config = await new Promise((resolve) => {
    chrome.storage.local.get({
      geminiApiKey: "",
      enableGemini: false
    }, resolve);
  });

  if (!config.enableGemini || !config.geminiApiKey) {
    throw new Error("Gemini query skipped (either disabled or API key is missing)");
  }

  const prompt = `You are a career data parser. Analyze the following job description for the role "${jobTitle}" at "${companyName}".
Identify if:
1. The role requires US Citizenship, permanent residency (Green Card), or specific U.S. government security clearances (DoD, Secret, Top Secret, public trust, etc.).
2. The company explicitly states that visa sponsorship is NOT available or available.

Job Description:
${description.substring(0, 4000)} // Truncate to save tokens and prevent payload overflow

Output your answer as a JSON object matching this structure EXACTLY with no markdown formatting:
{
  "clearance_required": true/false,
  "sponsorship_available": true/false/"unknown",
  "reason": "Short 1-sentence reason"
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.geminiApiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
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
          responseMimeType: "application/json",
          temperature: 0.1
        }
      })
    }
  );

  if (!response.ok) {
    const errorDetails = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorDetails}`);
  }

  const payload = await response.json();
  const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!rawText) {
    throw new Error("Empty response from Gemini API");
  }

  try {
    return JSON.parse(rawText.trim());
  } catch (err) {
    // If response was wrapped in backticks or markdown, strip them
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0].trim());
    }
    throw new Error("Failed to parse Gemini response as JSON");
  }
}
