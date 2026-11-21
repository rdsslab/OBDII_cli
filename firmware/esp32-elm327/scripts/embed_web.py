"""
Embed the web pages into include/web_assets.h (gzip byte arrays in flash),
so the firmware needs no filesystem upload.

Runs automatically before every PlatformIO build (extra_scripts = pre:...).
The work is done by tools/build-web.mjs (Node.js), which also packs the
shared panel (packages/ui) and the core (packages/core) from this repo.
By hand:  node tools/build-web.mjs
"""
import os
import shutil
import subprocess
import sys

try:
    Import("env")  # noqa: F821  (PlatformIO / SCons)
    ROOT = env.subst("$PROJECT_DIR")  # noqa: F821
except NameError:
    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

node = shutil.which("node")
if not node:
    sys.stderr.write("embed_web: Node.js is required to pack the web panel (https://nodejs.org)\n")
    sys.exit(1)
result = subprocess.run([node, os.path.join(ROOT, "tools", "build-web.mjs")], cwd=ROOT)
if result.returncode != 0:
    sys.exit(result.returncode)
