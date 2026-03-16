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

    def send_message(self, connection_id: str, chat_id: str, text: str) -> Dict[str, Any]:
        return self._request("POST", f"/connections/{connection_id}/send", json={"chatId": chat_id, "text": text})

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
