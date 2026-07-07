// ============================================
// Discord Multi-Chat — Renderer App (中文版 v2)
// Features: 账号分组好友, 按最近消息排序, 头像代理缓存, 自定义表情
// ============================================

const API_BASE = 'http://127.0.0.1:7233';

// State
let accounts = [];
let friends = {};
let selectedFriendId = null;
let selectedAccountId = null; // which account to use for sending

// Attachment queue
let pendingFiles = [];

// Collapsible group state (which account groups are expanded)
let collapsedGroups = new Set();

// EM (emoji shortcodes → emoji)
const EMOJI_MAP = {
  ':smile:': '😊', ':grin:': '😁', ':joy:': '😂', ':rofl:': '🤣',
  ':smiley:': '😃', ':laughing:': '😆', ':slight_smile:': '🙂',
  ':upside_down:': '🙃', ':wink:': '😉', ':blush:': '😊',
  ':heart_eyes:': '😍', ':kissing_heart:': '😘', ':kissing:': '😗',
  ':relaxed:': '☺️', ':stuck_out_tongue_winking_eye:': '😜',
  ':stuck_out_tongue:': '😛', ':yum:': '😋', ':sunglasses:': '😎',
  ':neutral_face:': '😐', ':expressionless:': '😑', ':unamused:': '😒',
  ':sweat:': '😓', ':pensive:': '😔', ':confused:': '😕',
  ':disappointed:': '😞', ':cry:': '😢', ':sob:': '😭',
  ':angry:': '😠', ':rage:': '😡', ':triumph:': '😤',
  ':tired_face:': '😫', ':fearful:': '😨', ':scream:': '😱',
  ':cold_sweat:': '😰', ':flushed:': '😳', ':dizzy_face:': '😵',
  ':astonished:': '😲', ':hugging:': '🤗', ':thinking:': '🤔',
  ':nerd:': '🤓', ':zipper_mouth:': '🤐', ':shushing_face:': '🤫',
  ':rolling_eyes:': '🙄', ':monocle:': '🧐', ':exploding_head:': '🤯',
  ':skull:': '💀', ':poop:': '💩', ':clown:': '🤡', ':alien:': '👽',
  ':robot:': '🤖', ':ghost:': '👻', ':wave:': '👋', ':raised_hand:': '✋',
  ':ok_hand:': '👌', ':pinched_fingers:': '🤌', ':v:': '✌️',
  ':crossed_fingers:': '🤞', ':pray:': '🙏', ':clap:': '👏',
  ':muscle:': '💪', ':brain:': '🧠', ':eyes:': '👀',
  ':thumbsup:': '👍', ':thumbsdown:': '👎', ':fist:': '✊',
  ':point_right:': '👉', ':point_left:': '👈', ':point_up:': '👆',
  ':point_down:': '👇', ':raised_hands:': '🙌', ':heart:': '❤️',
  ':orange_heart:': '🧡', ':yellow_heart:': '💛', ':green_heart:': '💚',
  ':blue_heart:': '💙', ':purple_heart:': '💜', ':broken_heart:': '💔',
  ':fire:': '🔥', ':star:': '⭐', ':sparkles:': '✨', ':zap:': '⚡',
  ':boom:': '💥', ':tada:': '🎉', ':100:': '💯', ':check:': '✅',
  ':x:': '❌', ':warning:': '⚠️', ':question:': '❓', ':bulb:': '💡',
  ':rocket:': '🚀', ':art:': '🎨', ':crown:': '👑', ':gem:': '💎',
  ':cookie:': '🍪', ':pizza:': '🍕', ':coffee:': '☕', ':beer:': '🍺',
  ':dog:': '🐶', ':cat:': '🐱', ':unicorn:': '🦄', ':sunny:': '☀️',
  ':moon:': '🌙', ':rainbow:': '🌈', ':cloud:': '☁️', ':snowflake:': '❄️',
};

const EMOJI_LIST = Object.values([...new Set(Object.values(EMOJI_MAP))]);

// Custom emoji cache per account
let customEmojis = {}; // {account_id: [emojis]}

// ============================================
// DOM refs
// ============================================
const $ = (id) => document.getElementById(id);

const accountsList = $('accounts-list');
const friendsList = $('friends-list');
const messagesList = $('messages-list');
const messageInput = $('message-input');
const btnSend = $('btn-send');
const btnAttach = $('btn-attach');
const btnEmoji = $('btn-emoji');
const fileInput = $('file-input');
const attachmentPreview = $('attachment-preview');
const emojiPicker = $('emoji-picker');
const loginModal = $('login-modal');
const loginTokenInput = $('login-token-input');
const loginError = $('login-error');
const chatFriendName = $('chat-friend-name');
const chatFriendAvatar = $('chat-friend-avatar');

// ============================================
// API helpers
// ============================================
async function api(method, path, body, isForm = false) {
  const opts = { method, headers: {} };
  if (isForm) {
    opts.body = body;
  } else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  return res.json();
}

// ============================================
// Avatar proxy helper — route Discord CDN through backend cache
// ============================================
function avatarUrl(url) {
  if (!url) return '';
  if (url.includes('discordapp.com') || url.includes('discord.com')) {
    return `${API_BASE}/avatar?url=${encodeURIComponent(url)}`;
  }
  return url;
}

// ============================================
// Init
// ============================================
async function init() {
  await loadAccounts();
  await loadFriends();
  setupEmojiPicker();
}

async function loadAccounts() {
  try {
    const data = await api('GET', '/accounts');
    accounts = data.accounts || [];
    renderAccounts();
  } catch (e) {
    console.error('加载账号失败:', e);
    accounts = [];
    renderAccounts();
  }
}

async function loadFriends() {
  try {
    const data = await api('GET', '/friends');
    friends = data.friends || {};
    renderFriends();
  } catch (e) {
    console.error('加载好友失败:', e);
    friends = {};
    renderFriends();
  }
}

// ============================================
// Render: Accounts
// ============================================
function renderAccounts() {
  if (accounts.length === 0) {
    accountsList.innerHTML = '<div class="empty-state">暂无账号，点击 + 添加</div>';
    return;
  }
  accountsList.innerHTML = accounts.map(a => {
    const initial = (a.name || '?')[0]?.toUpperCase() || '?';
    const avatarSrc = avatarUrl(a.avatar_url);
    const avatarHtml = avatarSrc
      ? `<img src="${escHtml(avatarSrc)}" alt="${escHtml(a.name)}">`
      : initial;
    return `
    <div class="account-item" data-account-id="${escHtml(a.account_id)}">
      <div class="account-avatar">${avatarHtml}</div>
      <div class="account-info">
        <div class="account-name">${escHtml(a.name || '未知')}</div>
        <div class="account-status">在线</div>
      </div>
      <button class="account-remove" data-remove="${escHtml(a.account_id)}">×</button>
    </div>`;
  }).join('');

  // Remove handlers
  accountsList.querySelectorAll('.account-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.remove;
      await api('DELETE', `/accounts/${id}`);
      await loadAccounts();
      await loadFriends();
      if (selectedFriendId) selectFriend(selectedFriendId);
    });
  });
}

// ============================================
// Render: Friends — grouped by account, collapsible
// ============================================
function renderFriends() {
  const entries = Object.entries(friends);
  if (entries.length === 0) {
    friendsList.innerHTML = '<div class="empty-state">暂无私信</div>';
    return;
  }

  // Sort friends: by last_message_time descending (most recent first), then alphabetically
  entries.sort((a, b) => {
    const aTime = a[1].last_message_time || 0;
    const bTime = b[1].last_message_time || 0;
    if (aTime !== bTime) return bTime - aTime; // most recent first
    return (a[1].name || '').localeCompare(b[1].name || '');
  });

  // Group by account
  const groups = {}; // {account_id: {name, friends: []}}
  const noAccountFriends = []; // friends with no account_ids (shouldn't happen but safe)

  for (const [fid, f] of entries) {
    if (!f.account_ids || f.account_ids.length === 0) {
      noAccountFriends.push([fid, f]);
      continue;
    }
    // Use first account as the group
    const accId = f.account_ids[0];
    if (!groups[accId]) {
      const accName = f.account_names?.[0] || 'Unknown';
      groups[accId] = { name: accName, friends: [] };
    }
    groups[accId].friends.push([fid, f]);
  }

  // Sort groups by most recent message time across all friends in the group
  const groupEntries = Object.entries(groups).sort((a, b) => {
    const aMax = Math.max(0, ...a[1].friends.map(([, f]) => f.last_message_time || 0));
    const bMax = Math.max(0, ...b[1].friends.map(([, f]) => f.last_message_time || 0));
    return bMax - aMax;
  });

  // Build HTML
  let html = '';

  for (const [accId, group] of groupEntries) {
    const isCollapsed = collapsedGroups.has(accId);
    const friendCount = group.friends.length;

    html += `
    <div class="friend-group" data-account-id="${escHtml(accId)}">
      <div class="friend-group-header">
        <span class="group-collapse-icon">${isCollapsed ? '▶' : '▼'}</span>
        <span class="group-name">${escHtml(group.name)}</span>
        <span class="group-count">${friendCount}</span>
      </div>
      ${isCollapsed ? '' : group.friends.map(([fid, f]) => renderFriendItem(fid, f)).join('')}
    </div>`;
  }

  // Add ungrouped friends
  if (noAccountFriends.length > 0) {
    html += noAccountFriends.map(([fid, f]) => renderFriendItem(fid, f)).join('');
  }

  friendsList.innerHTML = html;

  // Group header click — toggle collapse
  friendsList.querySelectorAll('.friend-group-header').forEach(header => {
    header.addEventListener('click', () => {
      const groupId = header.parentElement.dataset.accountId;
      if (collapsedGroups.has(groupId)) {
        collapsedGroups.delete(groupId);
      } else {
        collapsedGroups.add(groupId);
      }
      renderFriends();
    });
  });

  // Friend item click
  friendsList.querySelectorAll('.friend-item').forEach(el => {
    el.addEventListener('click', () => selectFriend(el.dataset.friendId));
  });
}

function renderFriendItem(fid, f) {
  const avatarSrc = avatarUrl(f.avatar_url);
  const initial = (f.name || '?')[0]?.toUpperCase() || '?';
  const avatarHtml = avatarSrc
    ? `<img src="${escHtml(avatarSrc)}" alt="">`
    : initial;
  const activeClass = selectedFriendId === fid ? ' active' : '';
  const unread = f.unread_count || 0;
  const unreadHtml = unread > 0 ? `<span class="unread-badge">${unread}</span>` : '';

  // Show last message time
  let timeHtml = '';
  if (f.last_message_time) {
    const d = new Date(f.last_message_time * 1000);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      timeHtml = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      timeHtml = (d.getMonth() + 1) + '/' + d.getDate();
    }
  }

  return `
  <div class="friend-item${activeClass}" data-friend-id="${escHtml(fid)}">
    <div class="friend-avatar">
      ${avatarHtml}
      <div class="friend-status-dot ${f.status || 'offline'}"></div>
    </div>
    <div class="friend-info">
      <div class="friend-name">${escHtml(f.name)}</div>
      <div class="friend-meta">
        <span class="friend-time">${timeHtml}</span>
      </div>
    </div>
    ${unreadHtml}
  </div>`;
}

// ============================================
// Select friend
// ============================================
async function selectFriend(friendId) {
  selectedFriendId = friendId;
  const f = friends[friendId];
  if (!f) return;

  // Determine which account to use
  if (f.account_ids && f.account_ids.length > 0) {
    selectedAccountId = f.account_ids[0];
  } else {
    selectedAccountId = null;
  }

  // Update top bar with avatar
  chatFriendName.textContent = f.name;
  const avatarSrc = avatarUrl(f.avatar_url);
  if (avatarSrc) {
    chatFriendAvatar.innerHTML = `<img src="${escHtml(avatarSrc)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" alt="">`;
  } else {
    const initial = (f.name || '?')[0]?.toUpperCase() || '?';
    chatFriendAvatar.textContent = initial;
  }

  // Enable input
  messageInput.disabled = false;
  updateSendButton();

  // Load messages
  await loadMessages(friendId);

  // Re-render friends to update active state and clear unread badge
  renderFriends();

  // Load custom emojis for this account
  if (selectedAccountId) {
    loadCustomEmojis(selectedAccountId);
  }
}

// ============================================
// Load & render messages
// ============================================
async function loadMessages(friendId) {
  const f = friends[friendId];
  if (!f || !f.account_ids || f.account_ids.length === 0) {
    messagesList.innerHTML = '<div class="message system"><div class="message-content">暂无消息</div></div>';
    return;
  }

  const accountId = f.account_ids[0];
  let messages = [];
  try {
    const data = await api('GET', `/messages/${accountId}/${friendId}?limit=50`);
    messages = data.messages || [];
  } catch (e) {
    messages = [];
  }

  if (messages.length === 0) {
    messagesList.innerHTML = '<div class="message system"><div class="message-content">暂无消息，打个招呼吧！</div></div>';
  } else {
    messagesList.innerHTML = messages.map(m => renderMessage(m, f)).join('');
  }

  // Scroll to bottom
  $('messages-container').scrollTop = $('messages-container').scrollHeight;
}

function renderMessage(m, friendInfo) {
  const time = new Date(m.timestamp * 1000);
  const timeStr = time.toLocaleDateString() + ' ' + time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const attachmentsHtml = (m.attachments || []).map(att => {
    const attUrl = avatarUrl(att.url); // use proxy for discord CDN
    if (att.content_type?.startsWith('image/')) {
      return `<div class="message-attachment"><img src="${escHtml(attUrl)}" alt="${escHtml(att.filename || '')}" loading="lazy"></div>`;
    } else if (att.content_type?.startsWith('video/')) {
      return `<div class="message-attachment"><video src="${escHtml(attUrl)}" controls></video></div>`;
    } else {
      return `<div class="message-attachment"><a href="${escHtml(att.url)}" target="_blank">📎 ${escHtml(att.filename || '文件')}</a></div>`;
    }
  }).join('');

  // Render avatar: use author_avatar_url if available, else first letter
  const isOwn = accounts.some(a => a.account_id === m.author_account_id);
  const avatarSrc = avatarUrl(m.author_avatar_url);
  const authorInitial = (m.author_name || '?')[0]?.toUpperCase() || '?';
  const avatarHtml = avatarSrc
    ? `<img src="${escHtml(avatarSrc)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" alt="">`
    : authorInitial;

  return `
  <div class="message ${isOwn ? 'own' : ''}">
    <div class="message-avatar">${avatarHtml}</div>
    <div class="message-content">
      <div class="message-author">
        ${escHtml(m.author_name)}
        <span class="timestamp">${timeStr}${isOwn ? ' (我)' : ''}</span>
      </div>
      <div class="message-text">${renderMessageText(m.content)}</div>
      ${attachmentsHtml}
    </div>
  </div>`;
}

function renderMessageText(text) {
  if (!text) return '';
  // Replace emoji shortcodes
  let out = escHtml(text);
  for (const [code, emoji] of Object.entries(EMOJI_MAP)) {
    out = out.replace(new RegExp(escRegex(code), 'g'), emoji);
  }
  // Discord custom emojis <:name:id>
  out = out.replace(/&lt;(a?):(\w+):(\d+)&gt;/g, (_, animated, name, id) => {
    const ext = animated ? 'gif' : 'png';
    const emojiUrl = `${API_BASE}/avatar?url=${encodeURIComponent('https://cdn.discordapp.com/emojis/' + id + '.' + ext)}`;
    return `<img class="custom-emoji" src="${emojiUrl}" alt=":${name}:" title=":${name}:" style="width:22px;height:22px;vertical-align:middle;">`;
  });
  // Links
  out = out.replace(/(https?:\/\/\S+)/g, '<a href="$1" target="_blank">$1</a>');
  return out;
}

// ============================================
// Send message
// ============================================
async function sendMessage() {
  if (!selectedFriendId) return;
  const text = messageInput.value.trim();
  if (!text && pendingFiles.length === 0) return;

  const f = friends[selectedFriendId];
  if (!f || !f.account_ids || f.account_ids.length === 0) return;

  const accountId = f.account_ids[0]; // Use first linked account

  btnSend.disabled = true;
  messageInput.disabled = true;

  try {
    if (pendingFiles.length > 0) {
      const formData = new FormData();
      if (text) formData.append('text', text);
      for (const fp of pendingFiles) {
        formData.append('files', fp);
      }
      await api('POST', `/send/${accountId}/${selectedFriendId}`, formData, true);
      pendingFiles = [];
    } else {
      await api('POST', `/send/${accountId}/${selectedFriendId}`, { text });
    }

    messageInput.value = '';
    renderAttachmentPreview();
    await loadMessages(selectedFriendId);
    await loadFriends(); // refresh sort order
  } catch (e) {
    console.error('发送失败:', e);
  } finally {
    messageInput.disabled = false;
    updateSendButton();
    messageInput.focus();
  }
}

// ============================================
// Attachments
// ============================================
btnAttach.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  for (const f of fileInput.files) {
    pendingFiles.push({
      path: f.path,
      name: f.name,
      type: f.type,
    });
  }
  fileInput.value = '';
  renderAttachmentPreview();
  updateSendButton();
});

function renderAttachmentPreview() {
  if (pendingFiles.length === 0) {
    attachmentPreview.innerHTML = '';
    return;
  }
  attachmentPreview.innerHTML = pendingFiles.map((f, i) => {
    let inner;
    if (f.type.startsWith('image/')) {
      inner = `<img src="file://${escHtml(f.path)}" alt="">`;
    } else if (f.type.startsWith('video/')) {
      inner = `<video src="file://${escHtml(f.path)}"></video>`;
    } else {
      inner = '<div class="file-icon">📄</div>';
    }
    return `<div class="attachment-preview-item">
      ${inner}
      <button class="remove-attach" data-idx="${i}">×</button>
    </div>`;
  }).join('');

  attachmentPreview.querySelectorAll('.remove-attach').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingFiles.splice(parseInt(btn.dataset.idx), 1);
      renderAttachmentPreview();
      updateSendButton();
    });
  });
}

// ============================================
// Emoji picker (unicode + custom server emojis)
// ============================================
function setupEmojiPicker() {
  let html = '<div class="emoji-section"><div class="emoji-section-title">标准表情</div><div class="emoji-grid">';
  html += EMOJI_LIST.map(e =>
    `<div class="emoji-item" data-emoji="${e}">${e}</div>`
  ).join('');
  html += '</div></div>';
  html += '<div class="emoji-section"><div class="emoji-section-title">服务器表情</div><div class="emoji-grid" id="custom-emoji-grid"><div class="emoji-loading">加载中...</div></div></div>';
  emojiPicker.innerHTML = html;

  // Standard emoji clicks
  emojiPicker.querySelectorAll('.emoji-item[data-emoji]').forEach(el => {
    el.addEventListener('click', () => {
      const emoji = el.dataset.emoji;
      insertAtCursor(messageInput, emoji);
      emojiPicker.classList.add('hidden');
      messageInput.focus();
      updateSendButton();
    });
  });
}

async function loadCustomEmojis(accountId) {
  if (customEmojis[accountId]) {
    renderCustomEmojis(customEmojis[accountId]);
    return;
  }
  try {
    const data = await api('GET', `/emojis/${accountId}`);
    customEmojis[accountId] = data.emojis || [];
    renderCustomEmojis(customEmojis[accountId]);
  } catch (e) {
    console.error('加载表情失败:', e);
    const grid = document.getElementById('custom-emoji-grid');
    if (grid) grid.innerHTML = '<div class="emoji-loading">加载失败</div>';
  }
}

function renderCustomEmojis(emojis) {
  const grid = document.getElementById('custom-emoji-grid');
  if (!grid) return;
  if (!emojis || emojis.length === 0) {
    grid.innerHTML = '<div class="emoji-loading">暂无自定义表情</div>';
    return;
  }
  grid.innerHTML = emojis.map(e => {
    const url = avatarUrl(e.url);
    const fmt = e.animated ? 'a' : '';
    return `<div class="emoji-item custom-emoji-item" data-emoji-code="<${fmt}:${e.name}:${e.id}>" data-emoji-url="${escHtml(url)}" title="${escHtml(e.name)}">
      <img src="${escHtml(url)}" alt=":${escHtml(e.name)}:" style="width:24px;height:24px;">
    </div>`;
  }).join('');

  grid.querySelectorAll('.custom-emoji-item').forEach(el => {
    el.addEventListener('click', () => {
      const code = el.dataset.emojiCode;
      insertAtCursor(messageInput, code);
      emojiPicker.classList.add('hidden');
      messageInput.focus();
      updateSendButton();
    });
  });
}

btnEmoji.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPicker.classList.toggle('hidden');
  if (!emojiPicker.classList.contains('hidden') && selectedAccountId) {
    loadCustomEmojis(selectedAccountId);
  }
});

// Close emoji picker when clicking outside
document.addEventListener('click', (e) => {
  if (!emojiPicker.contains(e.target) && e.target !== btnEmoji) {
    emojiPicker.classList.add('hidden');
  }
});

// ============================================
// Auto-resize textarea
// ============================================
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
});

// ============================================
// Misc helpers
// ============================================
function insertAtCursor(input, text) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = input.value.substring(0, start) + text + input.value.substring(end);
  input.selectionStart = input.selectionEnd = start + text.length;
}

// ============================================
// Login modal
// ============================================
$('btn-add-account').addEventListener('click', () => {
  loginModal.classList.remove('hidden');
  loginTokenInput.value = '';
  loginError.classList.add('hidden');
  loginTokenInput.focus();
});

$('btn-login-cancel').addEventListener('click', () => {
  loginModal.classList.add('hidden');
});

$('btn-login-submit').addEventListener('click', async () => {
  const token = loginTokenInput.value.trim();
  if (!token) return;

  $('btn-login-submit').disabled = true;
  loginError.classList.add('hidden');

  try {
    const result = await api('POST', '/accounts/add', { token });
    if (result.error) {
      loginError.textContent = result.error;
      loginError.classList.remove('hidden');
    } else {
      loginModal.classList.add('hidden');
      await loadAccounts();
      await loadFriends();
    }
  } catch (e) {
    loginError.textContent = '连接失败，后端服务是否在运行？';
    loginError.classList.remove('hidden');
  } finally {
    $('btn-login-submit').disabled = false;
  }
});

// Enter to login
loginTokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-login-submit').click();
});

// Close modal on backdrop click
loginModal.addEventListener('click', (e) => {
  if (e.target === loginModal) loginModal.classList.add('hidden');
});

// ============================================
// Input events
// ============================================
messageInput.addEventListener('input', updateSendButton);
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function updateSendButton() {
  const hasText = messageInput.value.trim().length > 0;
  const hasFiles = pendingFiles.length > 0;
  btnSend.disabled = !hasText && !hasFiles;
}

// ============================================
// Helpers
// ============================================
function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// Poll for updates — faster polling for near real-time
// ============================================
setInterval(async () => {
  await loadFriends();
  if (selectedFriendId) {
    const currentSelected = selectedFriendId;
    await loadMessages(currentSelected);
  }
}, 5000);

// ============================================
// Start
// ============================================
init();
