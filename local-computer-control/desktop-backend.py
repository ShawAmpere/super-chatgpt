"""Load the versioned, vendored engine that belongs to this Broker release."""
from pathlib import Path
import runpy
import sys

source = Path(__file__).resolve().parent / 'vendor' / 'windows-mcp' / 'src'
if not (source / 'windows_mcp' / '__main__.py').is_file():
    raise RuntimeError('The desktop backend source is missing from this release')
sys.path.insert(0, str(source))
runpy.run_module('windows_mcp', run_name='__main__')
