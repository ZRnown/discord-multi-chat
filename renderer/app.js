// ============================================
// Discord Multi-Chat — Renderer App
// ============================================

const API_BASE = 'http://127.0.0.1:7233';

// State
let accounts = [];
let friends = {};
let selectedFriendId = null;

// Attachment queue
let pendingFiles = [];

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
    console.error('Failed to load accounts:', e);
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
    console.error('Failed to load friends:', e);
    friends = {};
    renderFriends();
  }
}

// ============================================
// Render: Accounts
// ============================================
function renderAccounts() {
  if (accounts.length === 0) {
    accountsList.innerHTML = '<div class="empty-state">No accounts. Click + to add one.</div>';
    return;
  }
  accountsList.innerHTML = accounts.map(a => {
    const initial = (a.name || '?')[0]?.toUpperCase() || '?';
    const avatarHtml = a.avatar_url
      ? `<img src="${escHtml(a.avatar_url)}" alt="${escHtml(a.name)}">`
      : initial;
    return `
    <div class="account-item" data-account-id="${escHtml(a.account_id)}">
      <div class="account-avatar">${avatarHtml}</div>
      <div class="account-info">
        <div class="account-name">${escHtml(a.name || 'Unknown')}</div>
        <div class="account-status">Online</div>
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
// Render: Friends
// ============================================
function renderFriends() {
  const entries = Object.entries(friends);
  if (entries.length === 0) {
    friendsList.innerHTML = '<div class="empty-state">No friends loaded</div>';
    return;
  }

  // Sort: online first, then alphabetically
  entries.sort((a, b) => {
    const aOnline = a[1].status === 'online' || a[1].status === 'idle' ? 0 : 1;
    const bOnline = b[1].status === 'online' || b[1].status === 'idle' ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    return (a[1].name || '').localeCompare(b[1].name || '');
  });

  friendsList.innerHTML = entries.map(([fid, f]) => {
    const initial = (f.name || '?')[0]?.toUpperCase() || '?';
    const avatarHtml = f.avatar_url
      ? `<img src="${escHtml(f.avatar_url)}" alt="">`
      : initial;
    const tagsHtml = (f.account_names || []).slice(0, 3).map(n =>
      `<span class="friend-tag">${escHtml(n)}</span>`
    ).join('');

    const activeClass = selectedFriendId === fid ? ' active' : '';

    return `
    <div class="friend-item${activeClass}" data-friend-id="${escHtml(fid)}">
      <div class="friend-avatar">
        ${avatarHtml}
        <div class="friend-status-dot ${f.status || 'offline'}"></div>
      </div>
      <div class="friend-info">
        <div class="friend-name">${escHtml(f.name)}</div>
        <div class="friend-account-tags">${tagsHtml}</div>
      </div>
    </div>`;
  }).join('');

  // Click handlers
  friendsList.querySelectorAll('.friend-item').forEach(el => {
    el.addEventListener('click', () => selectFriend(el.dataset.friendId));
  });
}

// ============================================
// Select friend
// ============================================
async function selectFriend(friendId) {
  selectedFriendId = friendId;
  const f = friends[friendId];
  if (!f) return;

  // Update top bar
  chatFriendName.textContent = f.name;
  const initial = (f.name || '?')[0]?.toUpperCase() || '?';
  chatFriendAvatar.textContent = initial;
  if (f.avatar_url) {
    chatFriendAvatar.innerHTML = `<img src="${escHtml(f.avatar_url)}" style="width:100%;height:100%;border-radius:50%;" alt="">`;
  }

  // Enable input
  messageInput.disabled = false;
  updateSendButton();

  // Highlight friend
  friendsList.querySelectorAll('.friend-item').forEach(el => {
    el.classList.toggle('active', el.dataset.friendId === friendId);
  });

  // Load messages from first available account for this friend
  await loadMessages(friendId);

  // Highlight friend
  renderFriends();
}

// ============================================
// Load & render messages
// ============================================
async function loadMessages(friendId) {
  const f = friends[friendId];
  if (!f || !f.account_ids || f.account_ids.length === 0) {
    messagesList.innerHTML = '<div class="message system"><div class="message-content">No messages to display</div></div>';
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
    messagesList.innerHTML = '<div class="message system"><div class="message-content">No messages yet. Say hello!</div></div>';
  } else {
    // Show newest at bottom
    messages.reverse();
    messagesList.innerHTML = messages.map(m => renderMessage(m, f)).join('');
  }

  // Scroll to bottom
  $('messages-container').scrollTop = $('messages-container').scrollHeight;
}

function renderMessage(m, friendInfo) {
  const time = new Date(m.timestamp * 1000);
  const timeStr = time.toLocaleDateString() + ' ' + time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const isMe = m.author_account_id && accounts.some(a => {
    // Check by matching: the author IS one of our accounts (not the friend)
    return true; // Simplification: show all, style by author
  });

  const attachmentsHtml = (m.attachments || []).map(att => {
    if (att.content_type?.startsWith('image/')) {
      return `<div class="message-attachment"><img src="${escHtml(att.url)}" alt="${escHtml(att.filename || '')}" loading="lazy"></div>`;
    } else if (att.content_type?.startsWith('video/')) {
      return `<div class="message-attachment"><video src="${escHtml(att.url)}" controls></video></div>`;
    } else {
      return `<div class="message-attachment"><a href="${escHtml(att.url)}" target="_blank">📎 ${escHtml(att.filename || 'file')}</a></div>`;
    }
  }).join('');

  const authorInitial = (m.author_name || '?')[0]?.toUpperCase() || '?';
  const isOwn = accounts.some(a => a.account_id === m.author_account_id);

  return `
  <div class="message">
    <div class="message-avatar">${authorInitial}</div>
    <div class="message-content">
      <div class="message-author">
        ${escHtml(m.author_name)}
        <span class="timestamp">${timeStr}${isOwn ? ' (you)' : ''}</span>
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
    return `<img class="custom-emoji" src="https://cdn.discordapp.com/emojis/${id}.${ext}" alt=":${name}:" title=":${name}:" style="width:22px;height:22px;vertical-align:middle;">`;
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
  } catch (e) {
    console.error('Send failed:', e);
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
// Emoji picker
// ============================================
function setupEmojiPicker() {
  emojiPicker.innerHTML = EMOJI_LIST.map(e =>
    `<div class="emoji-item" data-emoji="${e}">${e}</div>`
  ).join('');

  emojiPicker.querySelectorAll('.emoji-item').forEach(el => {
    el.addEventListener('click', () => {
      const emoji = el.dataset.emoji;
      insertAtCursor(messageInput, emoji);
      emojiPicker.classList.add('hidden');
      messageInput.focus();
      updateSendButton();
    });
  });
}

btnEmoji.addEventListener('click', () => {
  emojiPicker.classList.toggle('hidden');
});

// Close emoji picker when clicking outside
document.addEventListener('click', (e) => {
  if (!emojiPicker.contains(e.target) && e.target !== btnEmoji) {
    emojiPicker.classList.add('hidden');
  }
});

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
    loginError.textContent = 'Connection failed. Is the backend running?';
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
// Poll for updates
// ============================================
setInterval(async () => {
  await loadFriends();
  if (selectedFriendId) {
    const currentSelected = selectedFriendId;
    await loadMessages(currentSelected);
  }
}, 10000);

// ============================================
// Start
// ============================================
init();
