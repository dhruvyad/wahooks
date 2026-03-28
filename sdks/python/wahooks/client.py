from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

DEFAULT_BASE_URL = "https://api.wahooks.com"


class WAHooksError(Exception):
    def __init__(self, message: str, status_code: int, body: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class WAHooks:
    """Official WAHooks Python SDK.

    Usage::

        from wahooks import WAHooks

        client = WAHooks(api_key="wh_...")

        # List connections
        connections = client.list_connections()

        # Send a message
        client.send_message(connection_id, chat_id="1234@s.whatsapp.net", text="Hello!")

        # Create a webhook
        webhook = client.create_webhook(connection_id, url="https://example.com/hook")
    """

    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL):
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._http = httpx.Client(
            base_url=f"{self.base_url}/api",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "WAHooks":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _request(self, method: str, path: str, json: Any = None) -> Any:
        response = self._http.request(method, path, json=json)
        data = response.json() if response.content else None
        if not response.is_success:
            message = data.get("message", response.reason_phrase) if isinstance(data, dict) else response.reason_phrase
            raise WAHooksError(message, response.status_code, data)
        return data

    # --- Connections ---

    def list_connections(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/connections")

    def create_connection(self) -> Dict[str, Any]:
        return self._request("POST", "/connections")

    def get_or_create_scannable_connection(self) -> Dict[str, Any]:
        """Get a connection ready to scan. Reuses an idle one if available, or creates new.

        Returns ``{"id": "...", "status": "scan_qr", "qr": "iVBOR..."}``
        — one call instead of list + filter + restart/create.
        """
        return self._request("POST", "/connections/get-or-create")

    def get_connection(self, connection_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/connections/{connection_id}")

    def delete_connection(self, connection_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/connections/{connection_id}")

    def restart_connection(self, connection_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/connections/{connection_id}/restart")

    def get_qr(self, connection_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/connections/{connection_id}/qr")

    def get_chats(self, connection_id: str) -> List[Dict[str, Any]]:
        return self._request("GET", f"/connections/{connection_id}/chats")

    def get_profile(self, connection_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/connections/{connection_id}/me")

    def send_message(self, connection_id: str, chat_id: str, text: str, *, skip_presence: bool = False, reply_to: Optional[str] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {"chatId": chat_id, "text": text, "skipPresence": skip_presence}
        if reply_to:
            body["replyTo"] = reply_to
        return self._request("POST", f"/connections/{connection_id}/send", json=body)

    def react(self, connection_id: str, chat_id: str, message_id: str, reaction: str) -> Dict[str, Any]:
        """React to a message with an emoji. Pass empty string to remove reaction."""
        return self._request("POST", f"/connections/{connection_id}/react", json={"chatId": chat_id, "messageId": message_id, "reaction": reaction})

    def mark_read(self, connection_id: str, chat_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/connections/{connection_id}/mark-read", json={"chatId": chat_id})

    def start_typing(self, connection_id: str, chat_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/connections/{connection_id}/typing", json={"chatId": chat_id})

    def stop_typing(self, connection_id: str, chat_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/connections/{connection_id}/typing/stop", json={"chatId": chat_id})

    def send_image(self, connection_id: str, chat_id: str, *, url: Optional[str] = None, data: Optional[str] = None, mimetype: Optional[str] = None, caption: Optional[str] = None, skip_presence: bool = False) -> Dict[str, Any]:
        """Send an image. Provide ``url`` (public URL) or ``data`` (base64) + ``mimetype``. Presence (seen/typing/delay) runs by default."""
        return self._request("POST", f"/connections/{connection_id}/send-image", json={"chatId": chat_id, "url": url, "data": data, "mimetype": mimetype, "caption": caption, "skipPresence": skip_presence})

    def send_document(self, connection_id: str, chat_id: str, *, url: Optional[str] = None, data: Optional[str] = None, mimetype: Optional[str] = None, filename: Optional[str] = None, caption: Optional[str] = None, skip_presence: bool = False) -> Dict[str, Any]:
        """Send a document/file. Provide ``url`` or ``data`` + ``mimetype``. Presence runs by default."""
        return self._request("POST", f"/connections/{connection_id}/send-document", json={"chatId": chat_id, "url": url, "data": data, "mimetype": mimetype, "filename": filename, "caption": caption, "skipPresence": skip_presence})

    def send_video(self, connection_id: str, chat_id: str, *, url: Optional[str] = None, data: Optional[str] = None, mimetype: Optional[str] = None, caption: Optional[str] = None, skip_presence: bool = False) -> Dict[str, Any]:
        """Send a video. Provide ``url`` or ``data`` + ``mimetype``. Presence runs by default."""
        return self._request("POST", f"/connections/{connection_id}/send-video", json={"chatId": chat_id, "url": url, "data": data, "mimetype": mimetype, "caption": caption, "skipPresence": skip_presence})

    def send_audio(self, connection_id: str, chat_id: str, *, url: Optional[str] = None, data: Optional[str] = None, mimetype: Optional[str] = None, skip_presence: bool = False) -> Dict[str, Any]:
        """Send audio/voice. Provide ``url`` or ``data`` + ``mimetype``. Presence runs by default."""
        return self._request("POST", f"/connections/{connection_id}/send-audio", json={"chatId": chat_id, "url": url, "data": data, "mimetype": mimetype, "skipPresence": skip_presence})

    def send_location(self, connection_id: str, chat_id: str, latitude: float, longitude: float, name: Optional[str] = None, address: Optional[str] = None, skip_presence: bool = False) -> Dict[str, Any]:
        """Send a location. Presence runs by default."""
        return self._request("POST", f"/connections/{connection_id}/send-location", json={"chatId": chat_id, "latitude": latitude, "longitude": longitude, "name": name, "address": address, "skipPresence": skip_presence})

    def send_contact(self, connection_id: str, chat_id: str, contact_name: str, contact_phone: str, skip_presence: bool = False) -> Dict[str, Any]:
        """Send a contact card. Presence runs by default."""
        return self._request("POST", f"/connections/{connection_id}/send-contact", json={"chatId": chat_id, "contactName": contact_name, "contactPhone": contact_phone, "skipPresence": skip_presence})

    # --- Real-time Events ---

    def listen(self, on_event: Any = None) -> "WAHooksEventStream":
        """Connect to the real-time event stream via WebSocket.

        Usage::

            def handler(event):
                print(event["event"], event["connectionId"], event["payload"])

            stream = client.listen(on_event=handler)
            stream.run_forever()  # blocks
            # or: stream.close() to stop
        """
        ws_protocol = "wss" if self.base_url.startswith("https") else "ws"
        ws_host = self.base_url.replace("https://", "").replace("http://", "")
        ws_url = f"{ws_protocol}://{ws_host}/api/ws?token={self._api_key}"
        return WAHooksEventStream(ws_url, on_event=on_event)

    # --- Webhooks ---

    def list_webhooks(self, connection_id: str) -> List[Dict[str, Any]]:
        return self._request("GET", f"/connections/{connection_id}/webhooks")

    def create_webhook(self, connection_id: str, url: str, events: Optional[List[str]] = None) -> Dict[str, Any]:
        return self._request("POST", f"/connections/{connection_id}/webhooks", json={"url": url, "events": events or ["*"]})

    def update_webhook(self, webhook_id: str, **kwargs: Any) -> Dict[str, Any]:
        return self._request("PUT", f"/webhooks/{webhook_id}", json=kwargs)

    def delete_webhook(self, webhook_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/webhooks/{webhook_id}")

    def get_webhook_logs(self, webhook_id: str) -> List[Dict[str, Any]]:
        return self._request("GET", f"/webhooks/{webhook_id}/logs")

    def test_webhook(self, webhook_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/webhooks/{webhook_id}/test")

    # --- API Tokens ---

    def list_tokens(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/tokens")

    def create_token(self, name: str) -> Dict[str, Any]:
        return self._request("POST", "/tokens", json={"name": name})

    def revoke_token(self, token_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/tokens/{token_id}")


class WAHooksEventStream:
    """Real-time event stream over WebSocket. Auto-reconnects on disconnect.

    Usage::

        import json
        from wahooks import WAHooks

        client = WAHooks(api_key="wh_...")
        stream = client.listen(on_event=lambda e: print(e))
        stream.run_forever()
    """

    def __init__(self, url: str, on_event: Any = None):
        self._url = url
        self.on_event = on_event
        self._closed = False
        self._ws: Any = None

    def run_forever(self) -> None:
        """Block and listen for events. Reconnects automatically."""
        import websocket  # type: ignore[import-untyped]

        while not self._closed:
            try:
                self._ws = websocket.WebSocketApp(
                    self._url,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                self._ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception:
                pass
            if not self._closed:
                import time
                time.sleep(5)

    def close(self) -> None:
        self._closed = True
        if self._ws:
            self._ws.close()

    def _on_message(self, ws: Any, message: str) -> None:
        import json as _json
        try:
            event = _json.loads(message)
            if self.on_event:
                self.on_event(event)
        except Exception:
            pass

    def _on_error(self, ws: Any, error: Any) -> None:
        pass

    def _on_close(self, ws: Any, close_status_code: Any, close_msg: Any) -> None:
        pass
