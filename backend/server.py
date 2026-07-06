# Discord Multi-Chat — Python Backend
# Multi-account Discord manager + REST API server

import asyncio
import json
import io
import os
import sys
import time
import threading
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS

# ============================================
# Flask app
# ============================================

app = Flask(__name__)
CORS(app)

# State directory
STATE_DIR = Path(__file__).parent / '.state'
STATE_DIR.mkdir(exist_ok=True)

# ============================================
# In-memory store (survives across requests)
# ============================================

accounts = {}      # {account_id: manager}
account_meta = {}  # {account_id: {name, avatar_url, token}}

# ============================================
# Discord Manager (lazy-import discord.py-self)
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
    
    def start(self):
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        # Wait up to 15 seconds for ready
        deadline = time.time() + 15
        while not self.ready and time.time() < deadline:
            time.sleep(0.3)
        if not self.ready:
            raise RuntimeError(f"Account {self.account_id} failed to become ready within timeout")
    
    def _run_loop(self):
        try:
            import discord
        except ImportError:
            raise ImportError("discord.py-self is required. Install: pip install discord.py-self")
        
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        
        self.client = discord.Client()
        
        @self.client.event
        async def on_ready():
            self.name = str(self.client.user)
            self.avatar_url = str(self.client.user.avatar_url) if self.client.user.avatar else ''
            self.ready = True
            print(f"[{self.account_id[:6]}...] Logged in as {self.name}")
            # Cache friends
            await self._cache_friends()
        
        @self.client.event
        async def on_relationship_add(relationship):
            await self._cache_friends()
        
        @self.client.event
        async def on_relationship_remove(relationship):
            await self._cache_friends()
        
        @self.client.event
        async def on_message(message):
            # Stored externally if needed
            pass
        
        async def _login():
            await self.client.start(self.token, bot=False)
        
        try:
            self._loop.run_until_complete(_login())
        except Exception as e:
            print(f"[{self.account_id[:6]}...] Login failed: {e}")
            self.ready = True  # Mark ready so caller can get error
            raise
    
    async def _cache_friends(self):
        if not self.client or not self.client.is_ready():
            return
        friends = {}
        for friend in self.client.user.friends:
            friends[str(friend.id)] = {
                'id': str(friend.id),
                'name': str(friend),
                'avatar_url': str(friend.avatar_url) if friend.avatar else '',
                'status': str(friend.status) if hasattr(friend, 'status') else 'offline',
            }
        with self._friends_lock:
            self._friends_cache = friends
    
    def get_friends(self):
        with self._friends_lock:
            return dict(self._friends_cache)
    
    def get_friend(self, friend_id):
        with self._friends_lock:
            return self._friends_cache.get(friend_id)
    
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
        if not self.client or not self.client.is_ready():
            raise RuntimeError("Client not ready")
        
        user = self.client.get_user(int(friend_id))
        if not user:
            # Try fetching
            try:
                user = await self.client.fetch_user(int(friend_id))
            except:
                raise RuntimeError(f"Friend {friend_id} not found")
        
        discord_files = []
        if files:
            for fp in files:
                discord_files.append(discord.File(fp))
        
        msg = await user.send(content=text or None, files=discord_files or None)
        return {
            'id': str(msg.id),
            'content': msg.content,
            'timestamp': int(msg.created_at.timestamp()),
        }
    
    async def _get_messages(self, friend_id, limit=50):
        if not self.client or not self.client.is_ready():
            return []
        
        user = self.client.get_user(int(friend_id))
        if not user:
            try:
                user = await self.client.fetch_user(int(friend_id))
            except:
                return []
        
        dm = user.dm_channel
        if not dm:
            dm = await user.create_dm()
        
        messages = []
        async for msg in dm.history(limit=limit):
            attachments = []
            for att in msg.attachments:
                attachments.append({
                    'url': att.url,
                    'filename': att.filename,
                    'content_type': att.content_type,
                })
            messages.append({
                'id': str(msg.id),
                'content': msg.content or '',
                'author_name': str(msg.author),
                'author_account_id': str(msg.author.id),
                'timestamp': int(msg.created_at.timestamp()),
                'attachments': attachments,
            })
        return messages
    
    def send_message(self, friend_id, text=None, files=None):
        return self._run_async(self._send_message(friend_id, text, files))
    
    def get_messages(self, friend_id, limit=50):
        return self._run_async(self._get_messages(friend_id, limit)) or []
    
    def stop(self):
        if self._loop and self.client:
            asyncio.run_coroutine_threadsafe(self.client.close(), self._loop)

# ============================================
# Account management
# ============================================

def _make_account_id(token):
    import hashlib
    return hashlib.sha256(token.encode()).hexdigest()[:16]

def add_account(token):
    account_id = _make_account_id(token)
    if account_id in accounts:
        return account_meta[account_id]
    
    mgr = DiscordAccount(account_id, token)
    try:
        mgr.start()
    except Exception as e:
        raise RuntimeError(f"Failed to login: {e}")
    
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
        except:
            pass
        del accounts[account_id]
    if account_id in account_meta:
        del account_meta[account_id]

def get_all_friends():
    """Merge friends from all accounts. Same friend across multiple accounts is merged."""
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
    return merged

# ============================================
# REST API
# ============================================

@app.route('/accounts', methods=['GET'])
def list_accounts():
    return jsonify({
        'accounts': list(account_meta.values())
    })

@app.route('/accounts/add', methods=['POST'])
def api_add_account():
    data = request.get_json(force=True)
    token = data.get('token', '').strip()
    if not token:
        return jsonify({'error': 'Token is required'}), 400
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

@app.route('/send/<account_id>/<friend_id>', methods=['POST'])
def api_send_message(account_id, friend_id):
    mgr = accounts.get(account_id)
    if not mgr:
        return jsonify({'error': 'Account not found'}), 404
    
    text = None
    files = []
    
    if request.is_json:
        data = request.get_json(force=True)
        text = data.get('text', '').strip() or None
    else:
        text = request.form.get('text', '').strip() or None
        # Save uploaded files to temp
        upload_dir = STATE_DIR / 'uploads'
        upload_dir.mkdir(exist_ok=True)
        for key in request.files:
            f = request.files[key]
            fp = upload_dir / f"{account_id}_{friend_id}_{int(time.time())}_{f.filename}"
            f.save(str(fp))
            files.append(str(fp))
    
    if not text and not files:
        return jsonify({'error': 'No content'}), 400
    
    try:
        result = mgr.send_message(friend_id, text=text, files=files if files else None)
        if result is None:
            return jsonify({'error': 'Failed to send (client not ready)'}), 500
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/messages/<account_id>/<friend_id>', methods=['GET'])
def api_get_messages(account_id, friend_id):
    mgr = accounts.get(account_id)
    if not mgr:
        return jsonify({'error': 'Account not found'}), 404
    limit = request.args.get('limit', 50, type=int)
    try:
        messages = mgr.get_messages(friend_id, limit=limit)
        return jsonify({'messages': messages})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'ok': True,
        'accounts': len(accounts),
    })

# ============================================
# Main
# ============================================

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 7233))
    print(f"Discord Multi-Chat backend starting on port {port}...")
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)
