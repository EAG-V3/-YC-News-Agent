/**
 * background.js — The Agentic Core
 * 
 * This is where the magic happens. It implements the agentic loop:
 * 1. User sends a message
 * 2. We call Gemini with tool declarations
 * 3. If Gemini returns a functionCall → execute the tool → feed result back
 * 4. Repeat until Gemini returns a text response
 * 5. Send the final answer to the popup
 */

import {
  get_top_stories,
  get_new_stories,
  get_story_details,
  search_stories,
  get_story_comments,
  get_hn_user,
  summarize_url,
  web_search,
  get_current_time,
} from './tools.js';

// ============================================================
// Constants
// ============================================================
const MAX_ITERATIONS = 6; // Strict limit to prevent infinite loops and save quota
const MAX_RETRIES = 2;
const DELAY_BETWEEN_ITERATIONS_MS = 15000; // 15s delay between iterations
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ============================================================
// Conversation History (maintained across messages in a session)
// ============================================================
let conversationHistory = [];

// ============================================================
// Concurrency Control — prevent multiple loops running at once
// ============================================================
let isRunning = false;
let currentAbortId = 0; // increments on each new request; old loops check this to self-abort

// ============================================================
// LLM Logging System
// ============================================================
let sessionLogs = [];

function logEvent(type, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    ...data,
  };
  sessionLogs.push(entry);
  // Persist to chrome.storage.local (keep last 500 entries max)
  chrome.storage.local.get(['agentLogs'], (result) => {
    const allLogs = result.agentLogs || [];
    allLogs.push(entry);
    // Trim to last 500
    const trimmed = allLogs.slice(-500);
    chrome.storage.local.set({ agentLogs: trimmed });
  });
  // Also log to service worker console for debugging
  console.log(`[YC Agent] ${type}:`, data);
}

// ============================================================
// Utility: Sleep (for rate limit delays)
// ============================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// System Prompt — Agent personality & instructions
// ============================================================
const SYSTEM_PROMPT = `You are **YC News Agent**, an expert AI assistant specialized in YCombinator / Hacker News.

Your capabilities:
- Fetch and summarize top, new, or best stories from Hacker News
- Search Hacker News for specific topics
- Get detailed information about any story including comments/discussion
- Fact-check news stories by cross-referencing with web search
- Look up companies mentioned in stories
- Research story publishers/submitters (HN users)
- Summarize linked articles
- Answer any questions about tech news, startups, and the HN community

**CRITICAL — Be efficient with tool calls:**
1. MINIMIZE the number of tool calls. Each call costs API quota.
2. Call ONLY the tools you truly need. Do NOT call tools "just in case".
3. When you get results from one tool, try to answer with that data before calling another.
4. For top stories: call get_top_stories ONCE, then work with the results — do NOT call get_story_details for each story individually.
5. For fact-checking: use web_search with a specific query. Do NOT chain 4+ tools if 1-2 will suffice.
6. For company/publisher lookups: prefer web_search directly with the name, rather than chaining multiple tools.
7. If you already have enough information to answer, STOP calling tools and give your answer.

**How to behave:**
1. When asked about current HN stories, use your tools to fetch live data — never guess.
2. When summarizing or discussing ANY story, ALWAYS use web_search to fact-check it. Do not just blindly trust the article. Actively look for underlying business incentives, profit motives, biases, or counter-narratives that the original author/company might be hiding.
3. When looking up companies, extract the company name and use web_search directly.
4. When looking up publishers, use get_hn_user for their HN profile.
5. For discussion-style questions, fetch relevant comments and synthesize.
6. Be thorough but concise. Use markdown formatting (bold, lists, links).
7. Always cite your sources — link to HN stories, articles, and search results.
8. If a tool call fails, explain what happened and move on.

**Formatting guidelines:**
- Use **bold** for key terms and story titles
- Use bullet points for lists
- Use > for quoting comments
- Include [links](url) to sources
- Use emoji sparingly for visual flair (📰 ✅ 🏢 👤 💬)`;

// ============================================================
// Tool Declarations — JSON schemas Gemini uses to decide calls
// ============================================================
const TOOL_DECLARATIONS = [
  {
    functionDeclarations: [
      {
        name: 'get_top_stories',
        description: 'Fetch the current top stories from Hacker News. Returns story titles, URLs, scores, authors, and comment counts.',
        parameters: {
          type: 'OBJECT',
          properties: {
            count: {
              type: 'INTEGER',
              description: 'Number of top stories to fetch (1-15, default 10)',
            },
          },
        },
      },
      {
        name: 'get_new_stories',
        description: 'Fetch the newest stories from Hacker News. Returns the latest submissions.',
        parameters: {
          type: 'OBJECT',
          properties: {
            count: {
              type: 'INTEGER',
              description: 'Number of new stories to fetch (1-15, default 10)',
            },
          },
        },
      },
      {
        name: 'get_story_details',
        description: 'Get detailed information about a specific Hacker News story by its ID. Returns title, URL, score, author, text content, and comment IDs.',
        parameters: {
          type: 'OBJECT',
          properties: {
            story_id: {
              type: 'INTEGER',
              description: 'The Hacker News story ID',
            },
          },
          required: ['story_id'],
        },
      },
      {
        name: 'search_stories',
        description: 'Search Hacker News stories by keyword/topic using full-text search. Great for finding stories about specific technologies, companies, or topics.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'The search query (e.g., "AI agents", "OpenAI", "Rust programming")',
            },
            count: {
              type: 'INTEGER',
              description: 'Number of results to return (1-15, default 10)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_story_comments',
        description: 'Fetch the top comments and replies for a Hacker News story. Useful for understanding community discussion and sentiment.',
        parameters: {
          type: 'OBJECT',
          properties: {
            story_id: {
              type: 'INTEGER',
              description: 'The Hacker News story ID to get comments for',
            },
            count: {
              type: 'INTEGER',
              description: 'Number of top-level comments to fetch (1-10, default 8)',
            },
          },
          required: ['story_id'],
        },
      },
      {
        name: 'get_hn_user',
        description: 'Look up a Hacker News user profile. Returns their karma, bio, account creation date, and submission count.',
        parameters: {
          type: 'OBJECT',
          properties: {
            username: {
              type: 'STRING',
              description: 'The HN username to look up',
            },
          },
          required: ['username'],
        },
      },
      {
        name: 'summarize_url',
        description: 'Fetch and extract the text content from a URL. Useful for reading the actual article a story links to. Returns the extracted text content.',
        parameters: {
          type: 'OBJECT',
          properties: {
            url: {
              type: 'STRING',
              description: 'The URL to fetch and extract text from',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'web_search',
        description: 'Search the web for current, factual information. Uses Google Search grounding for up-to-date results. Ideal for fact-checking claims, looking up companies, researching people, or finding recent news.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'The web search query (e.g., "Is Company X funding real?", "Who is John Doe CEO?")',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_current_time',
        description: 'Get the current local date and time. Useful when the user asks time-related questions.',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
    ],
  },
];

// ============================================================
// Tool executor — maps function names to implementations
// ============================================================
const toolMap = {
  get_top_stories,
  get_new_stories,
  get_story_details,
  search_stories,
  get_story_comments,
  get_hn_user,
  summarize_url,
  web_search,
  get_current_time,
};

async function executeTool(name, args, apiKey) {
  const fn = toolMap[name];
  if (!fn) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  // web_search needs the API key
  if (name === 'web_search') {
    args.apiKey = apiKey;
  }

  try {
    const result = await fn(args);
    return result;
  } catch (err) {
    return { success: false, error: `Tool execution error: ${err.message}` };
  }
}

// ============================================================
// The Agentic Loop — core of the extension
// ============================================================
async function runAgenticLoop(userMessage, apiKey, sendStatus, myAbortId) {
  // Log user message
  logEvent('USER_MESSAGE', { message: userMessage });

  // Add user message to conversation history
  conversationHistory.push({
    role: 'user',
    parts: [{ text: userMessage }],
  });

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Check if this loop was superseded by a newer request
    if (myAbortId !== currentAbortId) {
      logEvent('LOOP_ABORTED', { iteration, reason: 'Superseded by newer request' });
      return { success: false, error: 'Request cancelled.' };
    }
    sendStatus({ type: 'thinking', iteration });

    try {
      // Build request
      const requestBody = {
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: conversationHistory,
        tools: TOOL_DECLARATIONS,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
        },
      };

      logEvent('GEMINI_API_CALL', {
        iteration,
        model: GEMINI_MODEL,
        historyLength: conversationHistory.length,
        toolCount: TOOL_DECLARATIONS[0].functionDeclarations.length,
      });

      // Call Gemini API with retry logic for rate limits
      let response;
      let lastRateLimitError = '';

      // --- REAL LLM FETCH ---
      for (let retry = 0; retry < MAX_RETRIES; retry++) {
        response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (response.status === 429) {
          lastRateLimitError = await response.text();
          logEvent('RATE_LIMITED', { retry, iteration, error: lastRateLimitError.substring(0, 200) });

          let retryDelaySec = 15;
          const delayMatch = lastRateLimitError.match(/retry in ([\d.]+)s/i);
          if (delayMatch) {
            retryDelaySec = Math.ceil(parseFloat(delayMatch[1])) + 2;
          }

          sendStatus({ type: 'thinking', iteration, message: `⏳ Rate limited. Waiting ${retryDelaySec}s...` });
          await sleep(retryDelaySec * 1000);

          if (myAbortId !== currentAbortId) {
            return { success: false, error: 'Request cancelled.' };
          }
          continue;
        }
        break;
      }

      // If we exhausted retries and still got 429
      if (response.status === 429) {
        logEvent('GEMINI_API_ERROR', { status: 429, error: 'Exhausted retries', iteration });
        const isDailyQuota = lastRateLimitError.includes('billing') || lastRateLimitError.includes('plan');
        if (isDailyQuota) {
          throw new Error('Daily API quota exhausted. Please either:\n1. Wait for the quota to reset (resets daily)\n2. Go to Settings and enter a new API key from a different Google Cloud project\n3. Enable billing at https://aistudio.google.com/apikey');
        }
        throw new Error('Rate limit exceeded after retries. Please wait 1-2 minutes and try again.');
      }

      if (!response.ok) {
        const errText = await response.text();
        logEvent('GEMINI_API_ERROR', { status: response.status, error: errText, iteration });
        throw new Error(`Gemini API error ${response.status}: ${errText}`);
      }

      const data = await response.json();

      if (!data.candidates || data.candidates.length === 0) {
        throw new Error('No response from Gemini. The model may have refused the request.');
      }

      const candidate = data.candidates[0];
      const parts = candidate.content?.parts || [];

      // Check if the response contains function calls
      const functionCalls = parts.filter((p) => p.functionCall);

      if (functionCalls.length > 0) {
        // Gemini wants to call tools!
        logEvent('GEMINI_FUNCTION_CALLS', {
          iteration,
          calls: functionCalls.map((fc) => ({ name: fc.functionCall.name, args: fc.functionCall.args })),
        });

        // Add the model's response (with function calls) to history
        conversationHistory.push({
          role: 'model',
          parts: parts,
        });

        // Execute each function call and collect results
        const functionResponses = [];

        for (const part of functionCalls) {
          const { name, args } = part.functionCall;

          sendStatus({ type: 'tool_call', tool: name, args, iteration });
          logEvent('TOOL_CALL_START', { tool: name, args: args || {}, iteration });

          const result = await executeTool(name, args || {}, apiKey);

          logEvent('TOOL_CALL_RESULT', {
            tool: name,
            success: result.success,
            resultPreview: JSON.stringify(result).substring(0, 500),
            iteration,
          });

          functionResponses.push({
            functionResponse: {
              name: name,
              response: result,
            },
          });
        }

        // Add function responses to history
        conversationHistory.push({
          role: 'user',
          parts: functionResponses,
        });

        // Continue the loop — Gemini will process tool results
        // Add delay between iterations to respect rate limits
        await sleep(DELAY_BETWEEN_ITERATIONS_MS);
        continue;
      }

      // No function calls — this is the final text response
      const textParts = parts.filter((p) => p.text);
      const finalText = textParts.map((p) => p.text).join('\n');

      logEvent('GEMINI_FINAL_RESPONSE', {
        iteration,
        responseLength: finalText.length,
        responsePreview: finalText.substring(0, 300),
        totalToolCalls: iteration,
      });

      // Add model's final response to history
      conversationHistory.push({
        role: 'model',
        parts: [{ text: finalText }],
      });

      return { success: true, text: finalText };
    } catch (err) {
      console.error(`Agentic loop error (iteration ${iteration}):`, err);
      logEvent('AGENTIC_LOOP_ERROR', { iteration, error: err.message });

      if (iteration === MAX_ITERATIONS - 1) {
        return { success: false, error: `Agent reached maximum iterations. Last error: ${err.message}` };
      }

      // For API errors, don't retry — return immediately
      if (err.message.includes('Gemini API error')) {
        return { success: false, error: err.message };
      }
    }
  }

  return { success: false, error: 'Agent reached maximum tool-call iterations without producing a final answer.' };
}

// ============================================================
// Message handler — receives messages from popup.js
// ============================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'chat') {
    handleChatMessage(request, sender);
    return true; // Keep channel open for async
  }

  if (request.action === 'clearHistory') {
    conversationHistory = [];
    currentAbortId++; // abort any running loop
    isRunning = false;
    logEvent('CONVERSATION_CLEARED', {});
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getLogs') {
    chrome.storage.local.get(['agentLogs'], (result) => {
      sendResponse({ success: true, logs: result.agentLogs || [] });
    });
    return true; // async
  }

  if (request.action === 'clearLogs') {
    sessionLogs = [];
    chrome.storage.local.set({ agentLogs: [] });
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'ping') {
    sendResponse({ success: true });
    return false;
  }
});

async function handleChatMessage(request, sender) {
  const { message } = request;

  // Prevent concurrent loops
  if (isRunning) {
    try {
      chrome.runtime.sendMessage({
        action: 'agentResponse',
        type: 'error',
        error: 'A query is already in progress. Please wait for it to finish, or click ➕ to start a new conversation.',
      });
    } catch (e) { /* ignore */ }
    return;
  }

  // Get API key
  const data = await chrome.storage.local.get(['geminiApiKey']);
  const apiKey = data.geminiApiKey;

  if (!apiKey) {
    chrome.runtime.sendMessage({
      action: 'agentResponse',
      type: 'error',
      error: 'Please set your Gemini API key in Settings first.',
    });
    return;
  }

  // Set lock and abort ID
  isRunning = true;
  currentAbortId++;
  const myAbortId = currentAbortId;

  // Status update sender
  const sendStatus = (status) => {
    try {
      chrome.runtime.sendMessage({
        action: 'agentStatus',
        ...status,
      });
    } catch (e) {
      // Popup may be closed — ignore
    }
  };

  // Run the agentic loop
  const result = await runAgenticLoop(message, apiKey, sendStatus, myAbortId);

  // Release lock
  isRunning = false;

  // Send final response
  try {
    chrome.runtime.sendMessage({
      action: 'agentResponse',
      type: result.success ? 'success' : 'error',
      text: result.text || null,
      error: result.error || null,
    });
  } catch (e) {
    console.error('Failed to send response to popup:', e);
  }
}
