/**
 * tools.js — Tool implementations for the YC News Agentic AI Plugin
 * 
 * Each tool is a function that the Gemini LLM can autonomously call.
 * These are executed by background.js when Gemini returns a functionCall.
 */

// ============================================================
// HN Firebase API Base
// ============================================================
const HN_API = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA_API = 'https://hn.algolia.com/api/v1';

// ============================================================
// Tool: get_top_stories
// ============================================================
export async function get_top_stories({ count = 10 }) {
  try {
    const res = await fetch(`${HN_API}/topstories.json`);
    const allIds = await res.json();
    const ids = allIds.slice(0, Math.min(count, 15));

    const stories = await Promise.all(
      ids.map(async (id) => {
        const r = await fetch(`${HN_API}/item/${id}.json`);
        const item = await r.json();
        return {
          id: item.id,
          title: item.title,
          url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
          score: item.score,
          author: item.by,
          commentCount: item.descendants || 0,
          time: new Date(item.time * 1000).toISOString(),
        };
      })
    );

    return { success: true, stories };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// Tool: get_new_stories
// ============================================================
export async function get_new_stories({ count = 10 }) {
  try {
    const res = await fetch(`${HN_API}/newstories.json`);
    const allIds = await res.json();
    const ids = allIds.slice(0, Math.min(count, 15));

    const stories = await Promise.all(
      ids.map(async (id) => {
        const r = await fetch(`${HN_API}/item/${id}.json`);
        const item = await r.json();
        return {
          id: item.id,
          title: item.title,
          url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
          score: item.score,
          author: item.by,
          commentCount: item.descendants || 0,
          time: new Date(item.time * 1000).toISOString(),
        };
      })
    );

    return { success: true, stories };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// Tool: get_story_details
// ============================================================
export async function get_story_details({ story_id }) {
  try {
    const res = await fetch(`${HN_API}/item/${story_id}.json`);
    const item = await res.json();

    if (!item) {
      return { success: false, error: `Story ${story_id} not found` };
    }

    return {
      success: true,
      story: {
        id: item.id,
        title: item.title,
        url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
        text: item.text || null,
        score: item.score,
        author: item.by,
        commentCount: item.descendants || 0,
        time: new Date(item.time * 1000).toISOString(),
        type: item.type,
        kids: item.kids ? item.kids.slice(0, 10) : [],
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// Tool: search_stories
// ============================================================
export async function search_stories({ query, count = 10 }) {
  try {
    const res = await fetch(
      `${ALGOLIA_API}/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${Math.min(count, 15)}`
    );
    const data = await res.json();

    const stories = data.hits.map((hit) => ({
      id: hit.objectID,
      title: hit.title,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      score: hit.points,
      author: hit.author,
      commentCount: hit.num_comments || 0,
      time: hit.created_at,
    }));

    return { success: true, totalResults: data.nbHits, stories };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// Tool: get_story_comments
// ============================================================
export async function get_story_comments({ story_id, count = 8 }) {
  try {
    // First get the story to find kid IDs
    const storyRes = await fetch(`${HN_API}/item/${story_id}.json`);
    const story = await storyRes.json();

    if (!story || !story.kids || story.kids.length === 0) {
      return { success: true, storyTitle: story?.title, comments: [], message: 'No comments found' };
    }

    const commentIds = story.kids.slice(0, Math.min(count, 10));

    // Fetch top-level comments with one level of replies
    const comments = await Promise.all(
      commentIds.map(async (id) => {
        const r = await fetch(`${HN_API}/item/${id}.json`);
        const comment = await r.json();

        if (!comment || comment.deleted || comment.dead) {
          return null;
        }

        // Fetch up to 3 replies for each top-level comment
        let replies = [];
        if (comment.kids && comment.kids.length > 0) {
          const replyIds = comment.kids.slice(0, 3);
          replies = await Promise.all(
            replyIds.map(async (rid) => {
              const rr = await fetch(`${HN_API}/item/${rid}.json`);
              const reply = await rr.json();
              if (!reply || reply.deleted || reply.dead) return null;
              return {
                author: reply.by,
                text: stripHtml(reply.text || ''),
                time: new Date(reply.time * 1000).toISOString(),
              };
            })
          );
          replies = replies.filter(Boolean);
        }

        return {
          author: comment.by,
          text: stripHtml(comment.text || ''),
          time: new Date(comment.time * 1000).toISOString(),
          replies,
        };
      })
    );

    return {
      success: true,
      storyTitle: story.title,
      comments: comments.filter(Boolean),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// Tool: get_hn_user
// ============================================================
export async function get_hn_user({ username }) {
  try {
    const res = await fetch(`${HN_API}/user/${username}.json`);
    const user = await res.json();

    if (!user) {
      return { success: false, error: `User ${username} not found` };
    }

    return {
      success: true,
      user: {
        id: user.id,
        karma: user.karma,
        about: stripHtml(user.about || 'No bio available'),
        created: new Date(user.created * 1000).toISOString(),
        submittedCount: user.submitted ? user.submitted.length : 0,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// Tool: summarize_url
// ============================================================
export async function summarize_url({ url }) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; YCNewsAgent/1.0)',
      },
    });

    if (!res.ok) {
      return { success: false, error: `Failed to fetch URL: ${res.status} ${res.statusText}` };
    }

    const html = await res.text();

    // Extract readable text from HTML
    const text = extractReadableText(html);

    if (!text || text.length < 100) {
      return { success: false, error: 'Could not extract meaningful text from this URL. The page may require JavaScript or be behind a paywall.' };
    }

    // Truncate to ~6000 chars to fit in context window
    const truncated = text.length > 6000 ? text.substring(0, 6000) + '...[truncated]' : text;

    return {
      success: true,
      url,
      contentLength: text.length,
      content: truncated,
    };
  } catch (err) {
    return { success: false, error: `Error fetching URL: ${err.message}` };
  }
}

// ============================================================
// Tool: web_search
// ============================================================
export async function web_search({ query, apiKey }) {
  // Uses a separate Gemini call with Google Search grounding
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `Search the web and provide factual, up-to-date information about: ${query}. Include sources and dates where possible. Be thorough and cite your sources.` }],
          },
        ],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Search API error: ${response.status} - ${errText}` };
    }

    const data = await response.json();

    let searchResult = '';
    let groundingMetadata = null;

    if (data.candidates && data.candidates[0]) {
      const parts = data.candidates[0].content?.parts || [];
      searchResult = parts.map((p) => p.text || '').join('\n');
      groundingMetadata = data.candidates[0].groundingMetadata || null;
    }

    // Extract grounding sources if available
    let sources = [];
    if (groundingMetadata && groundingMetadata.groundingChunks) {
      sources = groundingMetadata.groundingChunks
        .filter((chunk) => chunk.web)
        .map((chunk) => ({
          title: chunk.web.title || 'Unknown',
          url: chunk.web.uri || '',
        }));
    }

    return {
      success: true,
      query,
      result: searchResult,
      sources,
    };
  } catch (err) {
    return { success: false, error: `Web search error: ${err.message}` };
  }
}

// ============================================================
// Tool: get_current_time
// ============================================================
export function get_current_time() {
  const now = new Date();
  return {
    success: true,
    dateTime: now.toLocaleString(),
    isoString: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ============================================================
// Utility: Strip HTML tags
// ============================================================
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================
// Utility: Extract readable text from HTML
// ============================================================
function extractReadableText(html) {
  // Remove scripts, styles, nav, footer, header
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');

  // Try to extract article or main content
  const articleMatch = text.match(/<article[\s\S]*?<\/article>/i);
  const mainMatch = text.match(/<main[\s\S]*?<\/main>/i);

  if (articleMatch) {
    text = articleMatch[0];
  } else if (mainMatch) {
    text = mainMatch[0];
  }

  // Strip remaining HTML
  text = text
    .replace(/<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h[1-6][^>]*>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}
