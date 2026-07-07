# Discord Multi-Chat - Python Backend
# Multi-account Discord manager + REST API server

import asyncio
import json
import io
import os
import sys
import time
import hashlib
import threading
import urllib.request
from pathlib import Path
from flask import Flask, request, jsonify, Response
from flask_cors import CORS

# ============================================
# Flask app
# ============================================

app = Flask(__name__)
CORS(app)

# State directory
STATE_DIR = Path(__file__).parent / '.state'
STATE_DIR.mkdir(exist_ok=True)

# Avatar cache directory
AVATAR_CACHE_DIR = STATE_DIR / 'avatars'
AVATAR_CACHE_DIR.mkdir(exist_ok=True)

# ============================================
# In-memory store (survives across requests)
# ============================================

accounts = {}      # {account_id: DiscordAccount}
account_meta = {}  # {account_id: {account_id, name, avatar_url}}

# ============================================
# Discord Manager (discord.py-self 2.x compatible)
# ============================================

class DiscordAccount:
    """Manages one Discord self-bot account."""

    def __init__(self, account_id, token):
        self.account_id = account_id
        self.token = token
        self.client = None
        self.ready = False
        self.name = None
        self.avatar_url = None
        self._loop = None
        self._thread = None
        self._friends_cache = {}
        self._friends_lock = threading.Lock()
        self._login_error = None
        # Real-time message tracking
        self._last_message_time = {}   # {friend_id: timestamp}
        self._unread_count = {}        # {friend_id: count}
        self._message_cache = {}       # {friend_id: [messages]}
        self._message_lock = threading.Lock()
        self._selected_friend = None   # currently viewed friend (for unread tracking)

    def start(self):
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        # Wait up to 60 seconds for ready
        deadline = time.time() + 60
        while not self.ready and time.time() < deadline:
            time.sleep(0.3)
        if not self.ready:
            if self._login_error:
                raise RuntimeError(f"\u767b\u5f55\u5931\u8d25: {self._login_error}")
            raise RuntimeError(f"\u8d26\u53f7 {self.account_id} \u8d85\u65f6\u672a\u80fd\u8fde\u63a5")

    def _run_loop(self):
        try:
            import discord
        except ImportError:
            self._login_error = "discord.py-self \u672a\u5b89\u88c5\uff0c\u8bf7\u8fd0\u884c: pip install discord.py-self"
            self.ready = True
            return

        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        self.client = discord.Client(proxy="http://127.0.0.1:7897")

        @self.client.event
        async def on_ready():
            try:
                self.name = str(self.client.user)
                self.avatar_url = str(self.client.user.display_avatar.url) if self.client.user.display_avatar else ''
                self.ready = True
                print(f"[{self.account_id[:6]}...] Logged in as {self.name}")
                asyncio.create_task(self._cache_friends_with_retry())
                # Start background friend refresh
                asyncio.create_task(self._background_friend_refresh())
            except Exception as e:
                print(f"[{self.account_id[:6]}...] on_ready error: {e}")
                self.ready = True

        @self.client.event
        async def on_message(message):
            """Real-time message handler for DMs."""
            # Only care about DMs (not guild messages)
            if message.guild is not None:
                return
            # Don't track our own messages here (they're tracked on send)
            if message.author.id == self.client.user.id:
                return

            friend_id = str(message.author.id)
            timestamp = int(message.created_at.timestamp())

            # Update last message time
            self._last_message_time[friend_id] = timestamp

            # Increment unread if not currently selected
            if friend_id != self._selected_friend:
                self._unread_count[friend_id] = self._unread_count.get(friend_id, 0) + 1

            # Cache the message
            msg_data = self._format_message(message)
            with self._message_lock:
                if friend_id not in self._message_cache:
                    self._message_cache[friend_id] = []
                self._message_cache[friend_id].append(msg_data)
                # Keep only last 200 messages
                if len(self._message_cache[friend_id]) > 200:
                    self._message_cache[friend_id] = self._message_cache[friend_id][-200:]

            print(f"[{self.account_id[:6]}...] New DM from {message.author}: {message.content[:50]}")

        @self.client.event
        async def on_relationship_add(relationship):
            print(f"[{self.account_id[:6]}] Relationship added, refreshing friends...")
            await self._cache_friends_with_retry(max_retries=3, delay=1)

        @self.client.event
        async def on_relationship_remove(relationship):
            await self._cache_friends_with_retry(max_retries=3, delay=1)

        async def _login():
            await self.client.start(self.token)

        try:
            self._loop.run_until_complete(_login())
        except Exception as e:
            print(f"[{self.account_id[:6]}...] Login failed: {e}")
            self._login_error = str(e)
            self.ready = True

    async def _background_friend_refresh(self):
        """Periodically refresh friends cache every 60 seconds."""
        while True:
            await asyncio.sleep(60)
            try:
                await self._cache_friends_with_retry(max_retries=2, delay=1)
            except Exception as e:
                print(f"[{self.account_id[:6]}] Background refresh error: {e}")

    def _format_message(self, msg):
        """Format a discord message into a dict."""
        attachments = []
        for att in msg.attachments:
            attachments.append({
                'url': att.url,
                'filename': att.filename,
                'content_type': att.content_type,
            })
        # Get author avatar URL
        author_avatar_url = ''
        try:
            author_avatar_url = str(msg.author.display_avatar.url) if msg.author.display_avatar else ''
        except Exception:
            pass

        return {
            'id': str(msg.id),
            'content': msg.content or '',
            'author_name': str(msg.author),
            'author_account_id': str(msg.author.id),
            'author_avatar_url': author_avatar_url,
            'timestamp': int(msg.created_at.timestamp()),
            'attachments': attachments,
        }

    async def _cache_friends(self):
        if not self.client or not self.client.is_ready():
            return
        friends = {}
        try:
            for friend in self.client.friends:
                user = getattr(friend, 'user', friend)
                try:
                    name = user.display_name or user.name or str(user)
                except Exception:
                    name = str(user)
                try:
                    avatar_url = str(user.display_avatar.url) if user.display_avatar else ''
                except Exception:
                    avatar_url = ''
                try:
                    status = str(friend.status)
                except Exception:
                    status = 'offline'
                friends[str(friend.id)] = {
                    'id': str(friend.id),
                    'name': name,
                    'avatar_url': avatar_url,
                    'status': status,
                }
        except Exception as e:
            print(f"[{self.account_id[:6]}...] Cache friends error: {e}")
        with self._friends_lock:
            self._friends_cache = friends

    async def _cache_friends_with_retry(self, max_retries=5, delay=2):
        """Retry caching friends. discord.py-self may need time to populate them."""
        for attempt in range(max_retries):
            if not self.client or not self.client.is_ready():
                await asyncio.sleep(delay)
                continue
            friends = {}
            try:
                flist = self.client.friends
                if flist:
                    for friend in flist:
                        user = getattr(friend, 'user', friend)
                        try:
                            name = user.display_name or user.name or str(user)
                        except Exception:
                            name = str(user)
                        try:
                            avatar_url = str(user.display_avatar.url) if user.display_avatar else ''
                        except Exception:
                            avatar_url = ''
                        try:
                            status = str(friend.status)
                        except Exception:
                            status = 'offline'
                        friends[str(friend.id)] = {
                            'id': str(friend.id),
                            'name': name,
                            'avatar_url': avatar_url,
                            'status': status,
                        }
                    with self._friends_lock:
                        self._friends_cache = friends
                    print(f"[{self.account_id[:6]}...] Cached {len(friends)} friends (attempt {attempt+1})")
                    return
                else:
                    print(f"[{self.account_id[:6]}...] No friends yet (attempt {attempt+1}/{max_retries})")
            except Exception as e:
                print(f"[{self.account_id[:6]}...] Cache friends error (attempt {attempt+1}): {e}")
            await asyncio.sleep(delay)
        print(f"[{self.account_id[:6]}...] Failed to cache friends after {max_retries} attempts")

    def get_friends(self):
        with self._friends_lock:
            return dict(self._friends_cache)

    def get_friend(self, friend_id):
        with self._friends_lock:
            return self._friends_cache.get(friend_id)

    def get_last_message_time(self, friend_id):
        return self._last_message_time.get(friend_id, 0)

    def get_unread_count(self, friend_id):
        return self._unread_count.get(friend_id, 0)

    def clear_unread(self, friend_id):
        self._unread_count[friend_id] = 0
        self._selected_friend = friend_id

    def _run_async(self, coro, timeout=30):
        if not self._loop:
            return None
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return future.result(timeout=timeout)
        except Exception as e:
            print(f"Async error for {self.account_id}: {e}")
            return None

    async def _send_message(self, friend_id, text=None, files=None):
        import discord
        if not self.client or not self.client.is_ready():
            raise RuntimeError("\u5ba2\u6237\u7aef\u672a\u5c31\u7eea")

        user = self.client.get_user(int(friend_id))
        if not user:
            try:
                user = await self.client.fetch_user(int(friend_id))
            except Exception:
                raise RuntimeError(f"\u627e\u4e0d\u5230\u597d\u53cb {friend_id}")

        discord_files = []
        if files:
            for fp in files:
                discord_files.append(discord.File(fp))

        msg = await user.send(content=text or None, files=discord_files or None)

        # Update last message time and cache
        timestamp = int(msg.created_at.timestamp())
        self._last_message_time[friend_id] = timestamp
        msg_data = self._format_message(msg)
        with self._message_lock:
            if friend_id not in self._message_cache:
                self._message_cache[friend_id] = []
            self._message_cache[friend_id].append(msg_data)
            if len(self._message_cache[friend_id]) > 200:
                self._message_cache[friend_id] = self._message_cache[friend_id][-200:]

        return msg_data

    async def _get_messages(self, friend_id, limit=50):
        if not self.client or not self.client.is_ready():
            return []

        user = self.client.get_user(int(friend_id))
        if not user:
            try:
                user = await self.client.fetch_user(int(friend_id))
            except Exception:
                return []

        dm = user.dm_channel
        if not dm:
            dm = await user.create_dm()

        messages = []
        async for msg in dm.history(limit=limit):
            messages.append(self._format_message(msg))
        messages.reverse()

        # Update cache with fresh data
        with self._message_lock:
            self._message_cache[friend_id] = messages[-200:]
        # Update last message time
        if messages:
            self._last_message_time[friend_id] = messages[-1]['timestamp']

        return messages

    async def _get_emojis(self):
        """Get all custom emojis from all guilds the account is in."""
        if not self.client or not self.client.is_ready():
            return []
        emojis = []
        try:
            for guild in self.client.guilds:
                for emoji in guild.emojis:
                    try:
                        emojis.append({
                            'id': str(emoji.id),
                            'name': emoji.name,
                            'url': str(emoji.url),
                            'animated': emoji.animated,
                            'guild_name': guild.name,
                        })
                    except Exception:
                        pass
        except Exception as e:
            print(f"[{self.account_id[:6]}] Get emojis error: {e}")
        return emojis

    def get_emojis(self):
        return self._run_async(self._get_emojis(), timeout=30) or []

    def send_message(self, friend_id, text=None, files=None):
        return self._run_async(self._send_message(friend_id, text, files))

    def get_messages(self, friend_id, limit=50):
        return self._run_async(self._get_messages(friend_id, limit)) or []

    def stop(self):
        if self._loop and self.client:
            try:
                asyncio.run_coroutine_threadsafe(self.client.close(), self._loop)
            except Exception:
                pass

# ============================================
# Account management
# ============================================

def _make_account_id(token):
    return hashlib.sha256(token.encode()).hexdigest()[:16]

def add_account(token):
    account_id = _make_account_id(token)
    if account_id in accounts:
        return account_meta[account_id]

    mgr = DiscordAccount(account_id, token)
    try:
        mgr.start()
    except Exception as e:
        raise RuntimeError(f"\u767b\u5f55\u5931\u8d25: {e}")

    accounts[account_id] = mgr
    account_meta[account_id] = {
        'account_id': account_id,
        'name': mgr.name or 'Unknown',
        'avatar_url': mgr.avatar_url or '',
    }
    return account_meta[account_id]

def remove_account(account_id):
    if account_id in accounts:
        try:
            accounts[account_id].stop()
        except Exception:
            pass
        del accounts[account_id]
    if account_id in account_meta:
        del account_meta[account_id]

def get_all_friends():
    merged = {}
    for acc_id, mgr in accounts.items():
        for fid, friend in mgr.get_friends().items():
            if fid in merged:
                merged[fid]['account_ids'].append(acc_id)
                merged[fid]['account_names'].append(account_meta.get(acc_id, {}).get('name', 'Unknown'))
            else:
                merged[fid] = {
                    **friend,
                    'account_ids': [acc_id],
                    'account_names': [account_meta.get(acc_id, {}).get('name', 'Unknown')],
                }
        # Add last_message_time and unread_count
        acc_name = account_meta.get(acc_id, {}).get('name', 'Unknown')
    # Merge last_message_time and unread across all accounts
    for fid in list(merged.keys()):
        max_time = 0
        total_unread = 0
        for acc_id, mgr in accounts.items():
            t = mgr.get_last_message_time(fid)
            if t > max_time:
                max_time = t
            total_unread += mgr.get_unread_count(fid)
        merged[fid]['last_message_time'] = max_time
        merged[fid]['unread_count'] = total_unread
    return merged

# ============================================
# REST API
# ============================================

@app.route('/accounts', methods=['GET'])
def list_accounts():
    return jsonify({'accounts': list(account_meta.values())})

@app.route('/accounts/add', methods=['POST'])
def api_add_account():
    data = request.get_json(force=True)
    token = data.get('token', '').strip()
    if not token:
        return jsonify({'error': '\u8bf7\u8f93\u5165 token'}), 400
    try:
        info = add_account(token)
        return jsonify(info), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 400

@app.route('/accounts/<account_id>', methods=['DELETE'])
def api_remove_account(account_id):
    remove_account(account_id)
    return jsonify({'ok': True})

@app.route('/friends', methods=['GET'])
def api_get_friends():
    return jsonify({'friends': get_all_friends()})

@app.route('/friends/refresh', methods=['POST'])
def api_refresh_friends():
    """Force refresh friends cache for all accounts."""
    for acc_id, mgr in accounts.items():
        try:
            mgr._run_async(mgr._cache_friends_with_retry(max_retries=3, delay=1), timeout=30)
        except Exception as e:
            print(f"[{acc_id[:6]}...] Refresh error: {e}")
    return jsonify({'ok': True, 'friends': get_all_friends()})

@app.route('/send/<account_id>/<friend_id>', methods=['POST'])
def api_send_message(account_id, friend_id):
    mgr = accounts.get(account_id)
    if not mgr:
        return jsonify({'error': '\u8d26\u53f7\u4e0d\u5b58\u5728'}), 404

    text = None
    files = []

    if request.is_json:
        data = request.get_json(force=True)
        text = data.get('text', '').strip() or None
    else:
        text = request.form.get('text', '').strip() or None
        upload_dir = STATE_DIR / 'uploads'
        upload_dir.mkdir(exist_ok=True)
        for key in request.files:
            f = request.files[key]
            fp = upload_dir / f"{account_id}_{friend_id}_{int(time.time())}_{f.filename}"
            f.save(str(fp))
            files.append(str(fp))

    if not text and not files:
        return jsonify({'error': '\u6ca1\u6709\u5185\u5bb9'}), 400

    try:
        result = mgr.send_message(friend_id, text=text, files=files if files else None)
        if result is None:
            return jsonify({'error': '\u53d1\u9001\u5931\u8d25\uff08\u5ba2\u6237\u7aef\u672a\u5c31\u7eea\uff09'}), 500
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/messages/<account_id>/<friend_id>', methods=['GET'])
def api_get_messages(account_id, friend_id):
    mgr = accounts.get(account_id)
    if not mgr:
        return jsonify({'error': '\u8d26\u53f7\u4e0d\u5b58\u5728'}), 404
    limit = request.args.get('limit', 50, type=int)
    # Clear unread when messages are viewed
    mgr.clear_unread(friend_id)
    try:
        messages = mgr.get_messages(friend_id, limit=limit)
        return jsonify({'messages': messages})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/emojis/<account_id>', methods=['GET'])
def api_get_emojis(account_id):
    mgr = accounts.get(account_id)
    if not mgr:
        return jsonify({'error': '\u8d26\u53f7\u4e0d\u5b58\u5728'}), 404
    try:
        emojis = mgr.get_emojis()
        return jsonify({'emojis': emojis})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/avatar', methods=['GET'])
def api_avatar_proxy():
    """Proxy and cache Discord CDN avatar images to avoid GFW slowness."""
    url = request.args.get('url', '')
    if not url:
        return '', 404

    # Only allow Discord CDN URLs
    if 'discordapp.com' not in url and 'discord.com' not in url:
        return '', 403

    # Cache key from URL hash
    cache_key = hashlib.md5(url.encode()).hexdigest()
    ext = '.png'
    if '.gif' in url:
        ext = '.gif'
    elif '.webp' in url:
        ext = '.webp'
    elif '.jpg' in url or '.jpeg' in url:
        ext = '.jpg'
    cache_file = AVATAR_CACHE_DIR / f"{cache_key}{ext}"

    # Return cached file if exists
    if cache_file.exists():
        with open(cache_file, 'rb') as f:
            data = f.read()
        content_type = 'image/gif' if ext == '.gif' else 'image/png'
        return Response(data, content_type=content_type, headers={
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
        })

    # Fetch from Discord CDN through proxy
    proxy_handler = urllib.request.ProxyHandler({
        'http': 'http://127.0.0.1:7897',
        'https': 'http://127.0.0.1:7897',
    })
    opener = urllib.request.build_opener(proxy_handler)
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
    })
    try:
        resp = opener.open(req, timeout=15)
        data = resp.read()
        # Save to cache
        with open(cache_file, 'wb') as f:
            f.write(data)
        content_type = resp.headers.get('Content-Type', 'image/png')
        return Response(data, content_type=content_type, headers={
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
        })
    except Exception as e:
        print(f"Avatar proxy error: {e}")
        return '', 502

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'accounts': len(accounts)})

# ============================================
# Main
# ============================================

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 7233))
    print(f"Discord Multi-Chat backend starting on port {port}...")
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)
