import os
import sys
import time

sys.path.insert(0, ".")
from wahooks import WAHooks, WAHooksError

API_KEY = os.environ.get("WAHOOKS_API_KEY", "wh_12c6edf917ce7e093a43748def67971e563162ba313e8ca9")
client = WAHooks(api_key=API_KEY)

passed = 0
failed = 0


def test(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  ✓ {name}")
        passed += 1
    except Exception as e:
        print(f"  ✗ {name}: {e}")
        failed += 1


connection_id = ""
webhook_id = ""
token_id = ""


print("Python SDK E2E Tests\n")

# --- Connections ---


def test_list_connections():
    connections = client.list_connections()
    assert isinstance(connections, list), "expected list"


test("list_connections returns list", test_list_connections)


def test_create_connection():
    global connection_id
    conn = client.create_connection()
    assert isinstance(conn["id"], str), "expected id string"
    assert conn["status"] in ("pending", "scan_qr"), f"unexpected status: {conn['status']}"
    connection_id = conn["id"]


test("create_connection returns connection with id", test_create_connection)


def test_get_connection():
    conn = client.get_connection(connection_id)
    assert conn["id"] == connection_id, "id mismatch"


test("get_connection returns same connection", test_get_connection)


def test_list_includes_new():
    connections = client.list_connections()
    assert any(c["id"] == connection_id for c in connections), "connection not found in list"


test("list_connections includes new connection", test_list_includes_new)

# --- Webhooks ---


def test_create_webhook():
    global webhook_id
    wh = client.create_webhook(connection_id, "https://httpbin.org/post", events=["message", "message.any"])
    assert isinstance(wh["id"], str), "expected id"
    assert isinstance(wh["signingSecret"], str), "expected signingSecret"
    assert wh["url"] == "https://httpbin.org/post", "url mismatch"
    assert isinstance(wh["events"], list), "expected events list"
    webhook_id = wh["id"]


test("create_webhook returns webhook with signing secret", test_create_webhook)


def test_list_webhooks():
    webhooks = client.list_webhooks(connection_id)
    assert isinstance(webhooks, list), "expected list"
    assert any(w["id"] == webhook_id for w in webhooks), "webhook not found"


test("list_webhooks returns list with webhook", test_list_webhooks)


def test_update_webhook():
    updated = client.update_webhook(webhook_id, url="https://httpbin.org/anything")
    assert updated["url"] == "https://httpbin.org/anything", "url not updated"


test("update_webhook changes url", test_update_webhook)


def test_test_webhook():
    result = client.test_webhook(webhook_id)
    assert result["success"] is True, "expected success"
    assert isinstance(result["logId"], str), "expected logId"


test("test_webhook enqueues delivery", test_test_webhook)


def test_get_webhook_logs():
    time.sleep(2)
    logs = client.get_webhook_logs(webhook_id)
    assert isinstance(logs, list), "expected list"
    assert len(logs) > 0, "expected at least one log"
    assert logs[0]["eventType"] == "test", "expected test event"


test("get_webhook_logs returns logs", test_get_webhook_logs)


def test_delete_webhook():
    result = client.delete_webhook(webhook_id)
    assert result["success"] is True, "expected success"


test("delete_webhook succeeds", test_delete_webhook)


def test_webhooks_empty_after_delete():
    webhooks = client.list_webhooks(connection_id)
    assert not any(w["id"] == webhook_id for w in webhooks), "webhook should be gone"


test("list_webhooks empty after delete", test_webhooks_empty_after_delete)

# --- Tokens ---


def test_create_token():
    global token_id
    token = client.create_token("test-py-sdk-token")
    assert isinstance(token["token"], str), "expected token string"
    assert token["token"].startswith("wh_"), "expected wh_ prefix"
    assert token["name"] == "test-py-sdk-token", "name mismatch"
    token_id = token["id"]


test("create_token returns raw token", test_create_token)


def test_list_tokens_includes_new():
    tokens = client.list_tokens()
    assert isinstance(tokens, list), "expected list"
    assert any(t["id"] == token_id for t in tokens), "token not found"


test("list_tokens includes new token", test_list_tokens_includes_new)


def test_revoke_token():
    result = client.revoke_token(token_id)
    assert result["success"] is True, "expected success"


test("revoke_token succeeds", test_revoke_token)


def test_list_tokens_excludes_revoked():
    tokens = client.list_tokens()
    assert not any(t["id"] == token_id for t in tokens), "revoked token should be gone"


test("list_tokens excludes revoked token", test_list_tokens_excludes_revoked)

# --- Error handling ---


def test_get_bad_id_404():
    try:
        client.get_connection("00000000-0000-0000-0000-000000000000")
        raise AssertionError("should have thrown")
    except WAHooksError as e:
        assert e.status_code == 404, f"expected 404, got {e.status_code}"


test("get_connection with bad id throws 404", test_get_bad_id_404)


def test_invalid_api_key_401():
    bad_client = WAHooks(api_key="wh_invalid")
    try:
        bad_client.list_connections()
        raise AssertionError("should have thrown")
    except WAHooksError as e:
        assert e.status_code == 401, f"expected 401, got {e.status_code}"


test("invalid API key throws 401", test_invalid_api_key_401)

# --- Cleanup ---


def test_delete_connection():
    result = client.delete_connection(connection_id)
    assert isinstance(result, dict), "expected dict"


test("delete_connection succeeds", test_delete_connection)


def test_list_excludes_deleted():
    connections = client.list_connections()
    assert not any(c["id"] == connection_id for c in connections), "deleted connection should be gone"


test("list_connections excludes deleted connection", test_list_excludes_deleted)

# --- Summary ---
print(f"\n{passed} passed, {failed} failed out of {passed + failed} tests")
sys.exit(1 if failed > 0 else 0)
