#!/usr/bin/env python3
"""Endpoint-by-endpoint check of a gateway session, run ON the box (the API key never leaves it).

    python3 -I verify.py read  [session]      read-only endpoints
    python3 -I verify.py send  [session]      the send checks, to the account's own chat only (5 sends; once per session
                                              unless --again)
    python3 -I verify.py events [n]           shapes of the last n events the test sink received

Every response is printed through `gateway redact`: strings become <str:len>, JIDs keep only their server,
numbers only for known numeric fields. Nothing personal (numbers, names, content) is printed.
"""
import base64
import json
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

GW = "/opt/wagw/gateway"
BASE = "http://127.0.0.1:3000"
SINK = "/var/lib/wagw-sink/sink.jsonl"


def key():
    for line in open("/etc/wagw/wagw.env"):
        if line.startswith("WAGW_API_KEY="):
            return line.strip().split("=", 1)[1]
    raise SystemExit("no key")


KEY = key()
results = []


def redact(raw: bytes, keys_only=False) -> str:
    args = [GW, "redact"] + (["-keys"] if keys_only else [])
    p = subprocess.run(args, input=raw, capture_output=True)
    return p.stdout.decode()


def call(method, path, body=None, headers=None, expect=None, show=True, max_lines=30, label=None):
    data = None
    h = {"X-Api-Key": KEY}
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            code, raw, ctype = r.status, r.read(), r.headers.get("Content-Type", "")
            clen = r.headers.get("Content-Length")
    except urllib.error.HTTPError as e:
        code, raw, ctype, clen = e.code, e.read(), e.headers.get("Content-Type", ""), e.headers.get("Content-Length")
    ms = int((time.time() - t0) * 1000)
    shown_path = label or path
    ok = expect is None or code in (expect if isinstance(expect, (list, tuple)) else [expect])
    results.append((method, shown_path, code, ok))
    print(f"\n== {method} {shown_path} -> {code} ({ms} ms, {ctype.split(';')[0]}, {len(raw)} bytes){'' if ok else '  <-- UNEXPECTED'}")
    if show and raw and "json" in ctype:
        out = redact(raw).splitlines()
        print("\n".join(out[:max_lines]) + ("\n  …" if len(out) > max_lines else ""))
    parsed = None
    if raw and "json" in ctype:
        try:
            parsed = json.loads(raw)
        except Exception:
            pass
    return code, parsed, raw, ctype, clen


def q(s):
    return urllib.parse.quote(s, safe="")


def summary():
    print("\n== summary")
    for m, p, c, ok in results:
        print(f"{'ok ' if ok else 'BAD'} {c} {m} {p}")


def png(w=64, h=64):
    """A small valid PNG (a colour gradient), generated here so no file is needed."""
    rows = b"".join(b"\x00" + b"".join(bytes((x * 4 % 256, y * 4 % 256, 160)) for x in range(w)) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def read(s):
    call("GET", "/api/server/version", expect=200)
    call("GET", "/health", expect=200)
    call("GET", "/api/sessions?all=true", expect=200)
    call("GET", f"/api/sessions/{s}", expect=200)
    _, me, _, _, _ = call("GET", f"/api/sessions/{s}/me", expect=200)
    me_id = me["id"]
    digits = me_id.split("@")[0]
    lid = me.get("lid") or ""
    call("GET", f"/api/{s}/auth/qr", expect=422, label=f"/api/{s}/auth/qr (WORKING: expect 422)")
    call("GET", f"/api/{s}/chats?limit=5&sortBy=conversationTimestamp&sortOrder=desc", expect=200)
    _, ov, _, _, _ = call("GET", f"/api/{s}/chats/overview?limit=5&offset=0", expect=200)
    _, allc, _, _, _ = call("GET", f"/api/contacts/all?session={s}&limit=3&offset=0", expect=200, max_lines=20)
    _, every, _, _, _ = call("GET", f"/api/contacts/all?session={s}", expect=200, show=False, label="/api/contacts/all (all, count only)")
    print(f"   contacts total: {len(every or [])}, with lid: {sum(1 for c in every or [] if 'lid' in c)}, lid-keyed: {sum(1 for c in every or [] if c.get('id','').endswith('@lid'))}")
    call("GET", f"/api/contacts?contactId={q(me_id)}&session={s}", expect=200, label="/api/contacts?contactId=<me>")
    call("GET", f"/api/contacts/check-exists?phone={digits}&session={s}", expect=200, label="/api/contacts/check-exists?phone=<me>")
    call("GET", f"/api/contacts/check-exists?phone=1000000000001&session={s}", expect=200, label="/api/contacts/check-exists?phone=<invalid number>")
    call("GET", f"/api/contacts/profile-picture?contactId={q(me_id)}&session={s}", expect=200, label="/api/contacts/profile-picture?contactId=<me>")
    call("GET", f"/api/{s}/lids?limit=2", expect=200)
    call("GET", f"/api/{s}/lids/count", expect=200)
    if lid:
        call("GET", f"/api/{s}/lids/{q(lid)}", expect=200, label=f"/api/{s}/lids/<own lid>")
    call("GET", f"/api/{s}/lids/pn/{q(me_id)}", expect=200, label=f"/api/{s}/lids/pn/<me>")
    call("GET", f"/api/{s}/lids/not-a-lid@c.us", expect=422, label=f"/api/{s}/lids/<pn> (expect 422)")
    call("GET", f"/api/{s}/chats/{q(me_id)}/messages?limit=5&offset=0&downloadMedia=false", expect=200, label=f"/api/{s}/chats/<me>/messages")
    if ov:
        cid = ov[0]["id"]
        _, msgs, _, _, _ = call("GET", f"/api/{s}/chats/{q(cid)}/messages?limit=3&offset=0&downloadMedia=true", expect=200, label=f"/api/{s}/chats/<newest chat>/messages")
        if msgs:
            mid = msgs[0]["id"]
            call("GET", f"/api/{s}/chats/{q(cid)}/messages/{q(mid)}?downloadMedia=true", expect=200, label=f"/api/{s}/chats/<chat>/messages/<id>")
            for m in msgs:
                if m.get("hasMedia") and m.get("media", {}).get("url"):
                    f = m["media"]["url"].rsplit("/", 1)[1]
                    code, _, raw, ctype, clen = call("GET", f"/api/files/{s}/{q(f)}", expect=200, show=False, label=f"/api/files/{s}/<file of existing message>")
                    print(f"   media bytes {len(raw)} content-type {ctype} content-length {clen}")
                    break
    call("GET", f"/api/{s}/chats/{q(me_id)}/messages/NOPE?downloadMedia=true", expect=404, label=f"/api/{s}/chats/<me>/messages/<missing> (expect 404)")
    call("GET", "/api/sessions/does-not-exist", expect=404)
    call("POST", "/api/sendText", {"chatId": "1@c.us", "text": "x"}, expect=422, label="/api/sendText without session (expect 422)")
    code, _, raw, _, _ = call("GET", "/metrics", expect=200, show=False)
    print("\n".join(l for l in raw.decode().splitlines() if not l.startswith("#"))[:1500])
    summary()


def send(s):
    marker = f"/var/lib/wagw/.verify-sends-{s}"
    if os.path.exists(marker) and "--again" not in sys.argv:
        raise SystemExit(f"send checks already ran for {s} (5 real messages); pass --again to send 5 more")
    open(marker, "w").write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    _, me, _, _, _ = call("GET", f"/api/sessions/{s}/me", expect=200, show=False, label=f"/api/sessions/{s}/me")
    me_id = me["id"]
    lines0 = sum(1 for _ in open(SINK))
    call("POST", "/api/sendSeen", {"session": s, "chatId": me_id}, expect=201, label="/api/sendSeen <own chat>")
    call("POST", "/api/startTyping", {"session": s, "chatId": me_id}, expect=201, label="/api/startTyping <own chat>")
    call("POST", "/api/stopTyping", {"session": s, "chatId": me_id}, expect=201, label="/api/stopTyping <own chat>")
    # 1
    _, r1, _, _, _ = call("POST", "/api/sendText", {"session": s, "chatId": me_id, "text": "wagw verification 1/5: text"}, expect=201, label="SEND 1 /api/sendText <own chat>")
    key = (r1 or {}).get("key", {})
    rj = key.get("remoteJid", "").replace("@s.whatsapp.net", "@c.us")
    id1 = f"true_{rj}_{key.get('id')}"
    time.sleep(2)
    # 2
    call("POST", "/api/sendText", {"session": s, "chatId": me_id, "text": "wagw verification 2/5: reply", "reply_to": id1}, expect=201, label="SEND 2 /api/sendText reply_to <1>")
    time.sleep(2)
    # 3
    call("PUT", "/api/reaction", {"session": s, "messageId": id1, "reaction": "👍"}, expect=200, label="SEND 3 /api/reaction <1>")
    time.sleep(2)
    # 4
    call("PUT", f"/api/{s}/chats/{q(me_id)}/messages/{q(id1)}", {"text": "wagw verification 1/5: text (edited, 4/5)"}, expect=200, label=f"SEND 4 PUT /api/{s}/chats/<me>/messages/<1>")
    time.sleep(2)
    # 5
    img = png()
    _, r5, _, _, _ = call("POST", "/api/sendImage", {"session": s, "chatId": me_id, "file": {"mimetype": "image/png", "filename": "wagw.png", "data": base64.b64encode(img).decode()}, "caption": "wagw verification 5/5: image"}, expect=201, label="SEND 5 /api/sendImage <own chat>")
    k5 = (r5 or {}).get("key", {})
    id5 = f"true_{k5.get('remoteJid','').replace('@s.whatsapp.net','@c.us')}_{k5.get('id')}"
    time.sleep(4)
    _, msgs, _, _, _ = call("GET", f"/api/{s}/chats/{q(me_id)}/messages?limit=5&offset=0&downloadMedia=true", expect=200, label=f"/api/{s}/chats/<me>/messages (after sends)", max_lines=60)
    _, m5, _, _, _ = call("GET", f"/api/{s}/chats/{q(me_id)}/messages/{q(id5)}?downloadMedia=true", expect=200, label=f"/api/{s}/chats/<me>/messages/<5>")
    url = ((m5 or {}).get("media") or {}).get("url")
    if url:
        f = url.rsplit("/", 1)[1]
        code, _, raw, ctype, clen = call("GET", f"/api/files/{s}/{q(f)}", expect=200, show=False, label=f"/api/files/{s}/<image 5>")
        print(f"   downloaded {len(raw)} bytes, uploaded {len(img)}, identical: {raw == img}, content-type {ctype}, content-length {clen}")
    call("POST", "/api/sendSeen", {"session": s, "chatId": me_id}, expect=201, label="/api/sendSeen <own chat> (after sends)")
    time.sleep(3)
    print("\n== events received by the sink during the send checks")
    with open(SINK) as fh:
        new = fh.readlines()[lines0:]
    for line in new:
        e = json.loads(line)
        b = e["body"]
        p = b.get("payload") or {}
        print(f"   {b.get('event'):18} ack={p.get('ack')} {p.get('ackName','')} source={p.get('source','')} fromMe={p.get('fromMe','')} hasMedia={p.get('hasMedia','')}")
    summary()


def events(n):
    with open(SINK) as fh:
        lines = fh.readlines()[-n:]
    seen = {}
    for line in lines:
        b = json.loads(line)["body"]
        ev = b.get("event")
        seen.setdefault(ev, line)
    for ev, line in seen.items():
        print(f"\n== {ev}")
        print(redact(line.encode()))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "read"
    arg = sys.argv[2] if len(sys.argv) > 2 else None
    if mode == "read":
        read(arg or "default")
    elif mode == "send":
        send(arg or "default")
    elif mode == "events":
        events(int(arg or 200))
