/**
 * popup.js — Chat UI Logic for YC News Agent
 *
 * Handles:
 * - Sending messages to background.js
 * - Receiving tool call status updates and final responses
 * - Rendering markdown in agent responses
 * - Settings modal for API key
 * - Quick-action chips
 * - Auto-growing textarea
 */

document.addEventListener('DOMContentLoaded', async () => {
  // ============================================================
  // DOM Elements
  // ============================================================
  const chatArea = document.getElementById('chat-area');
  const welcome = document.getElementById('welcome');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const clearBtn = document.getElementById('clear-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const closeSettings = document.getElementById('close-settings');
  const apiKeyInput = document.getElementById('api-key-input');
  const saveSettings = document.getElementById('save-settings');
  const settingsStatus = document.getElementById('settings-status');
  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const quickActions = document.getElementById('quick-actions');
  const logsBtn = document.getElementById('logs-btn');
  const logsPanel = document.getElementById('logs-panel');
  const logsContent = document.getElementById('logs-content');
  const clearLogsBtn = document.getElementById('clear-logs-btn');
  const closeLogsBtn = document.getElementById('close-logs-btn');

  let isProcessing = false;
  let typingIndicatorEl = null;

  // ============================================================
  // Init — Check API key
  // ============================================================
  const data = await chrome.storage.local.get(['geminiApiKey']);
  if (!data.geminiApiKey) {
    openSettings();
  }

  // ============================================================
  // Message Listener — Receives status + responses from background
  // ============================================================
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'agentStatus') {
      handleStatusUpdate(msg);
    } else if (msg.action === 'agentResponse') {
      handleAgentResponse(msg);
    }
  });

  // ============================================================
  // Send Message
  // ============================================================
  function sendMessage(text) {
    if (!text.trim() || isProcessing) return;

    // Hide welcome screen
    if (welcome) {
      welcome.classList.add('hidden');
    }

    // Add user message to chat
    addMessage('user', text.trim());

    // Clear input
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;

    // Show typing indicator
    showTypingIndicator();

    // Show status bar
    setStatus('Thinking...', true);

    isProcessing = true;

    // Send to background
    chrome.runtime.sendMessage({
      action: 'chat',
      message: text.trim(),
    });
  }

  // Send button click
  sendBtn.addEventListener('click', () => {
    sendMessage(messageInput.value);
  });

  // Enter to send (Shift+Enter for newline)
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(messageInput.value);
    }
  });

  // Enable/disable send button based on input
  messageInput.addEventListener('input', () => {
    sendBtn.disabled = !messageInput.value.trim() || isProcessing;
    autoGrow(messageInput);
  });

  // Auto-grow textarea
  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 80) + 'px';
  }

  // ============================================================
  // Quick Action Chips
  // ============================================================
  quickActions.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
      const prompt = chip.dataset.prompt;
      sendMessage(prompt);
    }
  });

  // ============================================================
  // Clear Conversation
  // ============================================================
  clearBtn.addEventListener('click', () => {
    // Clear chat UI
    const messages = chatArea.querySelectorAll('.message, .tool-badge, .typing-indicator');
    messages.forEach((m) => m.remove());

    // Show welcome again
    if (welcome) {
      welcome.classList.remove('hidden');
    }

    // Clear backend history
    chrome.runtime.sendMessage({ action: 'clearHistory' });

    // Reset state
    isProcessing = false;
    sendBtn.disabled = !messageInput.value.trim();
    setStatus('Ready', false);
  });

  // ============================================================
  // Settings Modal
  // ============================================================
  function openSettings() {
    settingsModal.classList.add('visible');
    // Load current key
    chrome.storage.local.get(['geminiApiKey'], (data) => {
      if (data.geminiApiKey) {
        apiKeyInput.value = data.geminiApiKey;
      }
    });
  }

  function closeSettingsModal() {
    settingsModal.classList.remove('visible');
    settingsStatus.textContent = '';
    settingsStatus.className = 'settings-feedback';
  }

  settingsBtn.addEventListener('click', openSettings);
  closeSettings.addEventListener('click', closeSettingsModal);

  // Click overlay to close
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      closeSettingsModal();
    }
  });

  saveSettings.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      settingsStatus.textContent = 'API key cannot be empty.';
      settingsStatus.className = 'settings-feedback error';
      return;
    }

    await chrome.storage.local.set({ geminiApiKey: key });
    settingsStatus.textContent = '✓ Settings saved!';
    settingsStatus.className = 'settings-feedback success';

    setTimeout(() => {
      closeSettingsModal();
    }, 800);
  });

  // ============================================================
  // Status Updates
  // ============================================================
  function handleStatusUpdate(msg) {
    if (msg.type === 'thinking') {
      const text = msg.message || `Thinking... (step ${msg.iteration + 1})`;
      setStatus(text, true);
    } else if (msg.type === 'tool_call') {
      const toolName = msg.tool;
      const toolDisplayNames = {
        get_top_stories: '📰 Fetching top stories',
        get_new_stories: '📰 Fetching new stories',
        get_story_details: '📄 Reading story details',
        search_stories: '🔍 Searching Hacker News',
        get_story_comments: '💬 Loading comments',
        get_hn_user: '👤 Looking up user profile',
        summarize_url: '🌐 Reading article',
        web_search: '🔎 Searching the web',
        get_current_time: '🕐 Checking time',
      };

      const display = toolDisplayNames[toolName] || `🔧 Calling ${toolName}`;
      setStatus(display, true);

      // Add tool badge to chat
      addToolBadge(display, toolName);
    }
  }

  function setStatus(text, active) {
    statusText.textContent = text;
    if (active) {
      statusBar.classList.add('active');
    } else {
      statusBar.classList.remove('active');
    }
  }

  // ============================================================
  // Agent Response Handler
  // ============================================================
  function handleAgentResponse(msg) {
    // Remove typing indicator
    removeTypingIndicator();
    setStatus('Ready', false);
    isProcessing = false;
    sendBtn.disabled = !messageInput.value.trim();

    if (msg.type === 'success' && msg.text) {
      addMessage('agent', msg.text);
    } else if (msg.type === 'error') {
      addMessage('agent', `⚠️ **Error:** ${msg.error || 'Something went wrong. Please try again.'}`);
    }
  }

  // ============================================================
  // Add Message to Chat
  // ============================================================
  function addMessage(role, text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = role === 'user' ? 'You' : 'YC Agent';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (role === 'agent') {
      bubble.innerHTML = renderMarkdown(text);
      // Make links open in new tab
      bubble.querySelectorAll('a').forEach((a) => {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      });
    } else {
      bubble.textContent = text;
    }

    messageDiv.appendChild(label);
    messageDiv.appendChild(bubble);
    chatArea.appendChild(messageDiv);

    scrollToBottom();
  }

  // ============================================================
  // Add Tool Badge to Chat
  // ============================================================
  function addToolBadge(display, toolName) {
    const badge = document.createElement('div');
    badge.className = 'tool-badge';
    badge.innerHTML = `<span class="tool-icon">🔧</span> ${display}`;
    chatArea.appendChild(badge);
    scrollToBottom();
  }

  // ============================================================
  // Typing Indicator
  // ============================================================
  function showTypingIndicator() {
    if (typingIndicatorEl) return;
    typingIndicatorEl = document.createElement('div');
    typingIndicatorEl.className = 'typing-indicator';
    typingIndicatorEl.innerHTML = `
      <div class="dot"></div>
      <div class="dot"></div>
      <div class="dot"></div>
    `;
    chatArea.appendChild(typingIndicatorEl);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    if (typingIndicatorEl) {
      typingIndicatorEl.remove();
      typingIndicatorEl = null;
    }
  }

  // ============================================================
  // Scroll to Bottom
  // ============================================================
  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatArea.scrollTop = chatArea.scrollHeight;
    });
  }

  // ============================================================
  // Markdown Renderer (lightweight)
  // ============================================================
  function renderMarkdown(text) {
    if (!text) return '';

    let html = text;

    // Escape HTML first (but preserve intentional markdown)
    html = html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Merge consecutive blockquotes
    html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

    // Unordered lists
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/gs, (match) => {
      return `<ul>${match}</ul>`;
    });

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr>');

    // Line breaks — convert double newlines to paragraphs
    html = html.replace(/\n\n/g, '</p><p>');

    // Single newlines to <br> (except inside tags)
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraph if not already wrapped
    if (!html.startsWith('<')) {
      html = `<p>${html}</p>`;
    }

    // Clean up empty paragraphs
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p>(<h[1-3]>)/g, '$1');
    html = html.replace(/(<\/h[1-3]>)<\/p>/g, '$1');
    html = html.replace(/<p>(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)<\/p>/g, '$1');
    html = html.replace(/<p>(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)<\/p>/g, '$1');
    html = html.replace(/<p>(<blockquote>)/g, '$1');
    html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');
    html = html.replace(/<p>(<hr>)<\/p>/g, '$1');

    return html;
  }

  // ============================================================
  // Logs Panel
  // ============================================================
  logsBtn.addEventListener('click', () => {
    logsPanel.classList.add('visible');
    loadLogs();
  });

  closeLogsBtn.addEventListener('click', () => {
    logsPanel.classList.remove('visible');
  });

  clearLogsBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearLogs' }, () => {
      logsContent.innerHTML = '<p class="logs-empty">Logs cleared.</p>';
    });
  });

  function loadLogs() {
    chrome.runtime.sendMessage({ action: 'getLogs' }, (response) => {
      if (!response || !response.success) {
        logsContent.innerHTML = '<p class="logs-empty">Could not load logs.</p>';
        return;
      }

      const logs = response.logs;
      if (logs.length === 0) {
        logsContent.innerHTML = '<p class="logs-empty">No logs yet. Start a conversation to see agent activity.</p>';
        return;
      }

      logsContent.innerHTML = '';

      logs.forEach((entry) => {
        const el = document.createElement('div');
        const cssClass = getLogEntryClass(entry.type);
        el.className = `log-entry ${cssClass}`;

        const time = new Date(entry.timestamp).toLocaleTimeString();
        const detail = formatLogDetail(entry);

        el.innerHTML = `
          <div class="log-time">${time}</div>
          <div class="log-type">${entry.type.replace(/_/g, ' ')}</div>
          <div class="log-detail">${detail}</div>
        `;

        logsContent.appendChild(el);
      });

      // Auto-scroll to bottom
      logsContent.scrollTop = logsContent.scrollHeight;
    });
  }

  function getLogEntryClass(type) {
    const classMap = {
      USER_MESSAGE: 'user-message',
      GEMINI_API_CALL: 'api-call',
      GEMINI_API_ERROR: 'error',
      GEMINI_FUNCTION_CALLS: 'tool-call',
      TOOL_CALL_START: 'tool-call',
      TOOL_CALL_RESULT: 'tool-result',
      GEMINI_FINAL_RESPONSE: 'final-response',
      AGENTIC_LOOP_ERROR: 'error',
      CONVERSATION_CLEARED: 'info',
    };
    return classMap[type] || 'info';
  }

  function formatLogDetail(entry) {
    switch (entry.type) {
      case 'USER_MESSAGE':
        return escapeHtml(entry.message || '');
      case 'GEMINI_API_CALL':
        return `Key: ${entry.key} | Model: ${entry.model} | Iteration: ${entry.iteration} | Tools: ${entry.toolCount}`;
      case 'GEMINI_API_ERROR':
        return `Status ${entry.status}: ${escapeHtml((entry.error || '').substring(0, 200))}`;
      case 'GEMINI_FUNCTION_CALLS':
        return (entry.calls || []).map((c) => `${c.name}(${JSON.stringify(c.args || {}).substring(0, 80)})`).join(', ');
      case 'TOOL_CALL_START':
        return `${entry.tool}(${JSON.stringify(entry.args || {}).substring(0, 100)})`;
      case 'TOOL_CALL_RESULT':
        return `${entry.tool} → ${entry.success ? '✅ success' : '❌ failed'} | ${escapeHtml((entry.resultPreview || '').substring(0, 200))}`;
      case 'GEMINI_FINAL_RESPONSE':
        return `Length: ${entry.responseLength} chars | Tool calls: ${entry.totalToolCalls} | Preview: ${escapeHtml((entry.responsePreview || '').substring(0, 150))}...`;
      case 'AGENTIC_LOOP_ERROR':
        return `Iteration ${entry.iteration}: ${escapeHtml(entry.error || '')}`;
      case 'CONVERSATION_CLEARED':
        return 'Conversation history cleared.';
      default:
        return JSON.stringify(entry).substring(0, 200);
    }
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
});
