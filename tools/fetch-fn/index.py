"""enzoban.com picture mover (Tencent SCF, ap-guangzhou, 2026-11-06).

The site's US server cannot download RunningHub results (their picture host refuses it), so this function,
inside Tencent's China network, downloads one RunningHub picture and stores it in the site's COS folder.
POST JSON {"url": ..., "key": "img-<id>" | "ref-<id>", "token": ...}. Standard library only.
"""
import hashlib, hmac, json, os, re, time, urllib.parse, urllib.request

# Any https picture link: the token is what keeps strangers out (RunningHub uses several hosts).
ALLOWED = re.compile(r"^https://[a-z0-9.-]+(:\d+)?/", re.I)
KEY = re.compile(r"^(img|ref)-[0-9A-Za-z_-]{1,64}$")


def sign(method, path):
    now = int(time.time())
    key_time = f"{now - 60};{now + 600}"
    sign_key = hmac.new(os.environ["COS_SECRET_KEY"].encode(), key_time.encode(), hashlib.sha1).hexdigest()
    http_string = f"{method}\n{path}\n\n\n"
    string_to_sign = f"sha1\n{key_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n"
    signature = hmac.new(sign_key.encode(), string_to_sign.encode(), hashlib.sha1).hexdigest()
    return (f"q-sign-algorithm=sha1&q-ak={urllib.parse.quote(os.environ['COS_SECRET_ID'], safe='')}"
            f"&q-sign-time={key_time}&q-key-time={key_time}&q-header-list=&q-url-param-list=&q-signature={signature}")


def reply(code, body):
    return {"isBase64Encoded": False, "statusCode": code, "headers": {"Content-Type": "application/json"},
            "body": json.dumps(body)}


def main_handler(event, context):
    try:
        data = json.loads(event.get("body") or "{}")
    except Exception:
        return reply(400, {"ok": False, "error": "bad json"})
    if not hmac.compare_digest(str(data.get("token", "")), os.environ["TOKEN"]):
        return reply(403, {"ok": False, "error": "forbidden"})
    url, key = str(data.get("url", "")), str(data.get("key", ""))
    if not ALLOWED.match(url) or not KEY.match(key):
        return reply(400, {"ok": False, "error": "url or key not allowed"})
    t = time.time()
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "enzoban-mover"}), timeout=40) as r:
        body = r.read()
    if not body or len(body) > 30 * 1024 * 1024:
        return reply(502, {"ok": False, "error": "bad size"})
    took_dl = time.time() - t
    path = "/" + urllib.parse.quote(os.environ.get("COS_PREFIX", "enzoban-studio/") + key)
    host = f"{os.environ['COS_BUCKET']}.cos.{os.environ['COS_REGION']}.myqcloud.com"
    req = urllib.request.Request(f"https://{host}{path}?{sign('put', urllib.parse.unquote(path))}", data=body, method="PUT",
                                 headers={"Content-Type": "image/png", "x-cos-acl": "private"})
    with urllib.request.urlopen(req, timeout=40) as r:
        status = r.status
    return reply(200, {"ok": status == 200, "bytes": len(body), "download_s": round(took_dl, 2),
                       "total_s": round(time.time() - t, 2)})
