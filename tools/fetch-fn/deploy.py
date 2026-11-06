"""Deploy the picture mover to Tencent Cloud ap-guangzhou. Keys are read from local files and never printed.

Run:  <python with tencentcloud-sdk-python-scf> -I tools/fetch-fn/deploy.py [region, default ap-guangzhou; ap-singapore is the one the site uses]
Reads ~/.cho-siren-cos.json and ~/.enzoban-fetch.token (made on first run, mode 600).
Prints only the function URL.
"""
import base64, io, json, os, secrets, time, zipfile
from tencentcloud.common import credential
from tencentcloud.scf.v20180416 import scf_client, models

import sys
NAME, REGION = "enzoban-picture-mover", (sys.argv[1] if len(sys.argv) > 1 else "ap-guangzhou")
HERE = os.path.dirname(os.path.abspath(__file__))
home = os.path.expanduser
c = json.load(open(home("~/.cho-siren-cos.json")))
token_file = home("~/.enzoban-fetch.token")
if not os.path.exists(token_file):
    with open(token_file, "w") as f:
        f.write(secrets.token_urlsafe(32))
    os.chmod(token_file, 0o600)
token = open(token_file).read().strip()

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(os.path.join(HERE, "index.py"), "index.py")
code = base64.b64encode(buf.getvalue()).decode()
variables = [{"Key": "COS_SECRET_ID", "Value": c["secretId"]}, {"Key": "COS_SECRET_KEY", "Value": c["secretKey"]},
             {"Key": "COS_BUCKET", "Value": c["bucket"]}, {"Key": "COS_REGION", "Value": c["region"]},
             {"Key": "COS_PREFIX", "Value": "enzoban-studio/"}, {"Key": "TOKEN", "Value": token}]
cl = scf_client.ScfClient(credential.Credential(c["secretId"], c["secretKey"]), REGION)


def call(name, payload):
    request = getattr(models, name + "Request")()
    request.from_json_string(json.dumps(payload))
    return json.loads(getattr(cl, name)(request).to_json_string())


def status():
    try:
        return call("GetFunction", {"FunctionName": NAME}).get("Status")
    except Exception:
        return None


def wait():
    for _ in range(60):
        st = status()
        if st in ("Active", "CreateFailed", "UpdateFailed"):
            return st
        time.sleep(3)


if status() is None:
    call("CreateFunction", {"FunctionName": NAME, "Runtime": "Python3.9", "Handler": "index.main_handler",
                            "Timeout": 90, "MemorySize": 256, "Code": {"ZipFile": code},
                            "Description": "enzoban.com: copy RunningHub pictures into COS",
                            "Environment": {"Variables": variables}})
    print("created", wait())
else:
    call("UpdateFunctionCode", {"FunctionName": NAME, "ZipFile": code, "Handler": "index.main_handler"})
    wait()
    call("UpdateFunctionConfiguration", {"FunctionName": NAME, "Timeout": 90, "MemorySize": 256,
                                         "Environment": {"Variables": variables}})
    print("updated", wait())

triggers = call("ListTriggers", {"FunctionName": NAME}).get("Triggers") or []
http = [t for t in triggers if t["Type"] == "http"]
if not http:
    call("CreateTrigger", {"FunctionName": NAME, "TriggerName": "url", "Type": "http",
                           "TriggerDesc": json.dumps({"AuthType": "NONE", "NetConfig": {
                               "EnableIntranet": False, "EnableExtranet": True}})})
    http = [t for t in call("ListTriggers", {"FunctionName": NAME})["Triggers"] if t["Type"] == "http"]
print("url", json.loads(http[0]["TriggerDesc"])["NetConfig"]["ExtranetUrl"])
