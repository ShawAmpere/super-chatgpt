"""Compatibility entrypoint for the shared Windows OS primitives."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from os_support import lock, lock_server, supervise, interrupt

try:
    if sys.argv[1] == "lock":
        lock(sys.argv[2], float(sys.argv[3]))
    elif sys.argv[1] == "supervise":
        sys.exit(supervise(sys.argv[2:]))
    else:
        raise ValueError("Unknown process-support operation.")
except Exception as error:
    print("Process support failed: " + str(error), file=sys.stderr, flush=True)
    sys.exit(1)
