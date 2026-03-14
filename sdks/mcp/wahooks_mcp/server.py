"""WAHooks MCP Server.

Remote (OAuth via Supabase):
  Deployed at api.wahooks.com/mcp — users just add the URL and log in.

Local (API key):
  WAHOOKS_API_KEY=wh_... wahooks-mcp

Claude Desktop config:
  {
    "mcpServers": {
      "wahooks": { "url": "https://api.wahooks.com/mcp" }
    }
  }
"""

import os
import sys

import httpx
from fastmcp import FastMCP, Context

API_BASE = os.environ.get("WAHOOKS_API_URL", "https://api.wahooks.com")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://fvatjlbtyegsqjuwbxxx.supabase.co")


def _build_auth():
    """Build auth provider: OAuth for remote, None for local with API key."""
    api_key = os.environ.get("WAHOOKS_API_KEY")
    if api_key:
        return None  # Local mode — API key from env

    # Remote mode — OAuth via Supabase
    from fastmcp.server.auth.providers.supabase import SupabaseProvider

    base_url = os.environ.get("MCP_BASE_URL", "https://api.wahooks.com")
    return SupabaseProvider(
        project_url=SUPABASE_URL,
        base_url=base_url,
    )


auth = _build_auth()

mcp = FastMCP(
    name="WAHooks",
    instructions=(
        "WAHooks MCP server for managing WhatsApp connections, "
        "sending/receiving messages, and configuring webhooks. "
        "Use list_connections to see active connections, "
        "send_message to send WhatsApp messages, "
        "and create_webhook to receive message notifications."
    ),
    auth=auth,
)


# ---------------------------------------------------------------------------
# HTTP client helpers
# ---------------------------------------------------------------------------

_local_client: httpx.AsyncClient | None = None


def _get_local_client() -> httpx.AsyncClient:
    """Get a shared client for local (API key) mode."""
    global _local_client
    if _local_client is None or _local_client.is_closed:
        api_key = os.environ["WAHOOKS_API_KEY"]
        _local_client = httpx.AsyncClient(
            base_url=f"{API_BASE}/api",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=120.0,
        )
    return _local_client


async def _client_for_ctx(ctx: Context) -> httpx.AsyncClient:
    """Get an HTTP client authenticated as the current user."""
    api_key = os.environ.get("WAHOOKS_API_KEY")
    if api_key:
        return _get_local_client()

    # OAuth mode — extract the Supabase access token from the HTTP request
    try:
        request = ctx.get_http_request()
        auth_header = request.headers.get("authorization", "")
        token = auth_header.replace("Bearer ", "") if auth_header else ""
    except Exception:
        token = ""

    return httpx.AsyncClient(
        base_url=f"{API_BASE}/api",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        timeout=120.0,
    )


async def _get(path: str, ctx: Context) -> dict | list:
    client = await _client_for_ctx(ctx)
    r = await client.get(path)
    r.raise_for_status()
    return r.json()


async def _post(path: str, ctx: Context, json: dict | None = None) -> dict:
    client = await _client_for_ctx(ctx)
    r = await client.post(path, json=json)
    r.raise_for_status()
    return r.json()


async def _put(path: str, ctx: Context, json: dict) -> dict:
    client = await _client_for_ctx(ctx)
    r = await client.put(path, json=json)
    r.raise_for_status()
    return r.json()


async def _delete(path: str, ctx: Context) -> dict:
    client = await _client_for_ctx(ctx)
    r = await client.delete(path)
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# Connection tools
# ---------------------------------------------------------------------------

@mcp.tool
async def list_connections(ctx: Context) -> list[dict]:
    """List all active WhatsApp connections."""
    return await _get("/connections", ctx)


@mcp.tool
async def create_connection(ctx: Context) -> dict:
    """Create a new WhatsApp connection. Returns connection ID and status.
    After creation, use get_qr to get the QR code for linking."""
    return await _post("/connections", ctx)


@mcp.tool
async def get_connection(connection_id: str, ctx: Context) -> dict:
    """Get details of a specific connection."""
    return await _get(f"/connections/{connection_id}", ctx)


@mcp.tool
async def delete_connection(connection_id: str, ctx: Context) -> dict:
    """Delete a WhatsApp connection. This stops the session and unlinks the number."""
    return await _delete(f"/connections/{connection_id}", ctx)


@mcp.tool
async def restart_connection(connection_id: str, ctx: Context) -> dict:
    """Restart a WhatsApp connection. The user will need to scan QR again."""
    return await _post(f"/connections/{connection_id}/restart", ctx)


@mcp.tool
async def get_qr(connection_id: str, ctx: Context) -> dict:
    """Get the QR code for linking a WhatsApp account. Returns base64 PNG.
    The user must scan this with WhatsApp > Settings > Linked Devices."""
    return await _get(f"/connections/{connection_id}/qr", ctx)


@mcp.tool
async def get_chats(connection_id: str, ctx: Context) -> list[dict]:
    """Get recent WhatsApp chats for a connection. Returns chat IDs and names."""
    return await _get(f"/connections/{connection_id}/chats", ctx)


@mcp.tool
async def get_profile(connection_id: str, ctx: Context) -> dict:
    """Get the WhatsApp profile info (phone number, display name) for a connection."""
    return await _get(f"/connections/{connection_id}/me", ctx)


@mcp.tool
async def send_message(connection_id: str, chat_id: str, text: str, ctx: Context) -> dict:
    """Send a WhatsApp message.

    Args:
        connection_id: The connection to send from.
        chat_id: Recipient in WhatsApp format (e.g. '1234567890@s.whatsapp.net'
                 for individuals, or 'id@g.us' for groups).
        text: Message text to send.
    """
    return await _post(
        f"/connections/{connection_id}/send", ctx,
        json={"chatId": chat_id, "text": text},
    )


# ---------------------------------------------------------------------------
# Webhook tools
# ---------------------------------------------------------------------------

@mcp.tool
async def list_webhooks(connection_id: str, ctx: Context) -> list[dict]:
    """List webhook configurations for a connection."""
    return await _get(f"/connections/{connection_id}/webhooks", ctx)


@mcp.tool
async def create_webhook(
    connection_id: str,
    url: str,
    ctx: Context,
    events: list[str] | None = None,
) -> dict:
    """Create a webhook to receive WhatsApp events at a URL.

    Args:
        connection_id: The connection to attach the webhook to.
        url: The URL to receive webhook POST requests.
        events: Event types to receive (default: all). Options: 'message',
                'message.any', 'message.ack', 'session.status', 'presence.update'.
    """
    return await _post(
        f"/connections/{connection_id}/webhooks", ctx,
        json={"url": url, "events": events or ["*"]},
    )


@mcp.tool
async def update_webhook(
    webhook_id: str,
    ctx: Context,
    url: str | None = None,
    events: list[str] | None = None,
    active: bool | None = None,
) -> dict:
    """Update a webhook configuration.

    Args:
        webhook_id: The webhook to update.
        url: New URL (optional).
        events: New event filter (optional).
        active: Enable or disable the webhook (optional).
    """
    body: dict = {}
    if url is not None:
        body["url"] = url
    if events is not None:
        body["events"] = events
    if active is not None:
        body["active"] = active
    return await _put(f"/webhooks/{webhook_id}", ctx, json=body)


@mcp.tool
async def delete_webhook(webhook_id: str, ctx: Context) -> dict:
    """Delete a webhook configuration."""
    return await _delete(f"/webhooks/{webhook_id}", ctx)


@mcp.tool
async def get_webhook_logs(webhook_id: str, ctx: Context) -> list[dict]:
    """Get delivery logs for a webhook. Shows event type, status, and payload."""
    return await _get(f"/webhooks/{webhook_id}/logs", ctx)


@mcp.tool
async def test_webhook(webhook_id: str, ctx: Context) -> dict:
    """Send a test event to a webhook to verify it's working."""
    return await _post(f"/webhooks/{webhook_id}/test", ctx)


# ---------------------------------------------------------------------------
# Token tools
# ---------------------------------------------------------------------------

@mcp.tool
async def list_tokens(ctx: Context) -> list[dict]:
    """List active API tokens."""
    return await _get("/tokens", ctx)


@mcp.tool
async def create_token(name: str, ctx: Context) -> dict:
    """Create a new API token. The raw token is shown only once — save it immediately.

    Args:
        name: A descriptive name for the token (e.g. 'my-app', 'production').
    """
    return await _post("/tokens", ctx, json={"name": name})


@mcp.tool
async def revoke_token(token_id: str, ctx: Context) -> dict:
    """Revoke an API token. It will immediately stop working."""
    return await _delete(f"/tokens/{token_id}", ctx)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(description="WAHooks MCP Server")
    parser.add_argument("--http", action="store_true", help="Run as HTTP server")
    parser.add_argument("--port", type=int, default=8000, help="HTTP port (default: 8000)")
    parser.add_argument("--host", default="0.0.0.0", help="HTTP host (default: 0.0.0.0)")
    args = parser.parse_args()

    if args.http:
        mcp.run(transport="http", host=args.host, port=args.port)
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
