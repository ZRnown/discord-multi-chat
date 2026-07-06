"""
Multi-account Discord manager using discord.py-self.
Each account is an independent discord.Client with its own event loop in a daemon thread.
"""

import asyncio
import threading
import queue
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

import discord


@dataclass
class AccountInfo:
    id: str
    token: str
    username: str = ""
    global_name: str = ""
    avatar: str = ""
    status: str = "offline"
    client: Optional[discord.Client] = None
    friends: list = field(default_factory=list)


class DiscordManager:
    """
    Manages multiple Discord accounts.

    Each account runs its own discord.Client in a background daemon thread with
    its own asyncio event loop. Communication between threads uses thread-safe
    queues (result_q) so the main Flask thread can ask a client thread to do
    something and get the result back.
    """

    def __init__(self):
        self.accounts: dict[str, AccountInfo] = {}

    # ---------- public API (called from Flask routes, main thread) ----------

    def login(self, token: str) -> dict:
        """Blocking: log in a new account and return its info."""
        acc_id = str(uuid.uuid4())[:8]
        acc = AccountInfo(id=acc_id, token=token)
        self.accounts[acc_id] = acc

        result_q: queue.Queue = queue.Queue()

        def run_client():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            client = discord.Client(intents=discord.Intents.default())

            @client.event
            async def on_ready():
                acc.client = client
                acc.username = str(client.user)
                acc.global_name = client.user.display_name or client.user.name
                acc.avatar = str(client.user.display_avatar.url) if client.user.display_avatar else ""
                acc.status = "online"

                # Fetch friend list
                friends = []
                for f in client.friends:
                    friends.append({
                        "id": str(f.id),
                        "username": f.name,
                        "global_name": f.display_name or f.name,
                        "avatar": str(f.display_avatar.url) if f.display_avatar else "",
                        "status": str(f.status),
                    })
                acc.friends = friends
                result_q.put({"ok": True, "account": self._acc_dict(acc)})

            try:
                loop.run_until_complete(client.start(token, reconnect=False))
            except discord.LoginFailure:
                result_q.put({"ok": False, "error": "Invalid token. Login failed."})
            except Exception as e:
                result_q.put({"ok": False, "error": str(e)})
            finally:
                acc.status = "offline"

        t = threading.Thread(target=run_client, daemon=True)
        t.start()

        try:
            result = result_q.get(timeout=30)
            if not result["ok"]:
                del self.accounts[acc_id]
                return result
            return result
        except queue.Empty:
            del self.accounts[acc_id]
            return {"ok": False, "error": "Login timed out after 30 seconds."}

    def logout(self, account_id: str) -> dict:
        acc = self.accounts.pop(account_id, None)
        if acc and acc.client:
            result_q: queue.Queue = queue.Queue()

            def do_logout():
                async def _logout():
                    await acc.client.close()
                    result_q.put({"ok": True})

                loop = acc.client.loop
                if loop and not loop.is_closed():
                    asyncio.run_coroutine_threadsafe(_logout(), loop)
                else:
                    result_q.put({"ok": True})

            t = threading.Thread(target=do_logout, daemon=True)
            t.start()
            try:
                return result_q.get(timeout=5)
            except queue.Empty:
                return {"ok": True}
        return {"ok": True}

    def get_accounts(self) -> dict:
        return {
            "accounts": [
                {
                    "id": a.id,
                    "username": a.global_name or a.username,
                    "avatar": a.avatar,
                    "status": a.status,
                }
                for a in self.accounts.values()
                if a.client and not a.client.is_closed()
            ]
        }

    def get_friends(self, account_id: str) -> dict:
        """Return friends for a specific account."""
        acc = self.accounts.get(account_id)
        if not acc:
            return {"friends": []}
        # Refresh friends in case they changed
        if acc.client and not acc.client.is_closed():
            friends = []
            for f in acc.client.friends:
                friends.append({
                    "id": str(f.id),
                    "username": f.name,
                    "global_name": f.display_name or f.name,
                    "avatar": str(f.display_avatar.url) if f.display_avatar else "",
                    "status": str(f.status),
                })
            acc.friends = friends

        return {"friends": acc.friends}

    def send_message(
        self,
        account_id: str,
        friend_id: str,
        content: str,
        attachment_paths: list = None,
    ) -> dict:
        """
        Send a DM to a friend from a specific account.
        Runs the async call on the account's client event loop.
        """
        acc = self.accounts.get(account_id)
        if not acc or not acc.client or acc.client.is_closed():
            return {"ok": False, "error": "Account not logged in."}

        result_q: queue.Queue = queue.Queue()

        async def _send():
            try:
                user = await acc.client.fetch_user(int(friend_id))
                if not user:
                    result_q.put({"ok": False, "error": "Friend not found."})
                    return

                # Build discord.File list for attachments
                files = []
                for path in (attachment_paths or []):
                    try:
                        files.append(discord.File(path))
                    except Exception as e:
                        result_q.put({"ok": False, "error": f"Cannot attach file {path}: {e}"})
                        return

                msg = await user.send(content=content or None, files=files)
                result_q.put({"ok": True, "message_id": str(msg.id)})
            except discord.Forbidden:
                result_q.put({"ok": False, "error": "Cannot send DMs to this user."})
            except Exception as e:
                result_q.put({"ok": False, "error": str(e)})

        loop = acc.client.loop
        if not loop or loop.is_closed():
            return {"ok": False, "error": "Account event loop closed."}

        asyncio.run_coroutine_threadsafe(_send(), loop)

        try:
            return result_q.get(timeout=15)
        except queue.Empty:
            return {"ok": False, "error": "Send timed out."}

    def get_emojis(self) -> dict:
        """Return built-in Discord-compatible emoji list."""
        return {"emojis": BUILTIN_EMOJIS}

    def get_custom_emojis(self) -> dict:
        """Return custom emojis from all guilds across all accounts."""
        all_emojis = {}
        for acc in self.accounts.values():
            if acc.client and not acc.client.is_closed():
                for guild in acc.client.guilds:
                    for emoji in guild.emojis:
                        all_emojis[f":{emoji.name}:"] = str(emoji.url)
        return all_emojis

    # ---------- helpers ----------

    def _acc_dict(self, acc: AccountInfo) -> dict:
        return {
            "id": acc.id,
            "username": acc.global_name or acc.username,
            "avatar": acc.avatar,
            "status": acc.status,
        }

    def shutdown(self):
        for aid in list(self.accounts.keys()):
            self.logout(aid)


# Singleton
manager = DiscordManager()

# ---------- Built-in emojis (same as frontend) ----------
BUILTIN_EMOJIS = []
_raw = [
    "😀","😃","😄","😁","😅","😂","🤣","😊","😇","🙂","😉","😌","😍","🥰","😘",
    "😗","😙","😚","😋","😛","😜","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐",
    "😑","😶","😏","😒","🙄","😬","🤥","😪","😴","🥱","😷","🤒","🤕","🤢","🤮",
    "🥵","🥶","😵","🤯","🤠","😎","🤓","🧐","😟","😕","🙁","😮","😯","😲","😳",
    "🥺","😢","😭","😱","😨","😰","😥","😓","🤤","😤","😡","😠","🤬","💀","☠️",
    "💩","🤡","👹","👺","👻","👽","👾","🤖","😺","😸","😹","😻","😼","😽","🙀",
    "😿","😾","💋","💌","💘","💝","💖","💗","💓","💞","💕","💟","❤️","🧡","💛",
    "💚","💙","💜","🤎","🖤","🤍","👍","👎","👌","✌️","🤞","🤟","🤘","🤙","👈",
    "👉","👆","👇","☝️","✋","🤚","🖐️","🖖","👋","🤏","✍️","👏","🙌","🤝","🙏",
    "💪","🦵","🦶","👂","🦻","👃","🧠","🦷","🦴","👀","👁️","👅","👄","💯","🔥",
    "⭐","🌟","✨","💫","🎉","🎊","🎈","🎂","🎀","🎁","🎃","🎄","🎅","🦌","🎵",
    "🎶","🎸","🎹","🎮","🎲","🏆","🥇","🥈","🥉","🏅","🎖️","🏵️","💎","🔮","🍕",
    "🍔","🍟","🍩","🍪","🍰","🧁","☕","🍵","🍺","🍻","🥂","🍷","🍸","🍹","💻",
    "🖥️","⌨️","🖱️","📱","📷","🎥","📹","🎙️","🎧","📻","⏰","📅","📌","📎","✂️",
    "🔒","🔓","🔑","💰","💳","📊","📈","📉","🚀","✈️","🚗","🚲","🏠","🏢","🌍",
    "🌎","🌏",
]
_name_map = {
    "😀":"grinning","😂":"joy","🤣":"rofl","😊":"blush","😍":"heart_eyes",
    "😘":"kissing_heart","😜":"wink_tongue","🤔":"thinking","😎":"sunglasses",
    "🥺":"pleading","😭":"sob","😡":"rage","🤬":"cursing","💀":"skull",
    "❤️":"heart","🔥":"fire","⭐":"star","🎉":"tada","🎂":"birthday",
    "🍕":"pizza","☕":"coffee","🚀":"rocket","💻":"computer","👍":"+1",
    "👎":"-1","👏":"clap","🙏":"pray","💪":"muscle","💰":"moneybag",
    "🎮":"video_game","🎵":"musical_note","📱":"iphone","🙂":"slight_smile",
    "😐":"neutral_face","😒":"unamused","😱":"scream","🤯":"exploding_head",
    "💯":"100","✨":"sparkles","🖤":"black_heart","🤍":"white_heart",
}
for i, ch in enumerate(_raw):
    BUILTIN_EMOJIS.append({
        "char": ch,
        "name": _name_map.get(ch, f"emoji_{i}"),
        "id": f"e{i}",
    })
