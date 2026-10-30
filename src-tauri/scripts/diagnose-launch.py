"""Diagnostic launcher: keep the app outside an enclosing Windows command job."""
from __future__ import annotations
import json
import subprocess
import sys
import threading

process = subprocess.Popen(
    sys.argv[1:], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    creationflags=0x01000000 | 0x08000000,  # BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW
)
print(json.dumps({"applicationPid": process.pid}), flush=True)

def copy(source, destination):
    for data in iter(lambda: source.read(4096), b""):
        destination.buffer.write(data)
        destination.flush()

def commands():
    for line in sys.stdin:
        if line.strip() == "stop":
            process.terminate()
            return

threading.Thread(target=copy, args=(process.stdout, sys.stdout), daemon=True).start()
threading.Thread(target=copy, args=(process.stderr, sys.stderr), daemon=True).start()
threading.Thread(target=commands, daemon=True).start()
code = process.wait()
print(json.dumps({"applicationExitCode": code}), flush=True)
sys.exit(code)
