"""Terminal stand-in for a Linux produce-scale UI using the Python SDK.

    python examples/linux-demo/scale_demo.py es
"""
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to a legacy code page

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdks", "python"))
from nativeloc import NativeLoc  # noqa: E402

locale = sys.argv[1] if len(sys.argv) > 1 else "es"
loc = NativeLoc(
    os.environ.get("NATIVELOC_URL", "http://localhost:4600"),
    "pb_demo_scale",
    locale=locale,
    cache_dir=os.path.join(os.path.dirname(__file__), ".nativeloc-cache"),
    fallback={"en": {"Place item on the scale": "Place item on the scale"}},
)

print("bundle v%s (%s)" % (loc.version or "-", locale))
print("=" * 40)
print(loc.t("Place item on the scale"))
print(loc.t("Weight: %s kg", arg1="0.42"))
print(loc.t("%d label printed", arg1=3))
print("[ " + loc.t("button\u0004Print label") + " ]")
print(loc.t("Hello %(name)s, you saved %(amount)s", name="Sam", amount="$1.20"))
