"""Shared OS lock compatibility entrypoint for Broker startup."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from os_support import lock
try:
    lock(sys.argv[1], float(sys.argv[2]))
except Exception as error:
    print("Broker lock failed: " + str(error), file=sys.stderr, flush=True)
    sys.exit(1)
