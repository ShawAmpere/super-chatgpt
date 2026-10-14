"""One persistent file-write lock and an atomic, non-replaying publish channel."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'shared'))
from os_support import acquire_lock


def digest(file):
    with open(file, 'rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def publish(request):
    temporary, target = request['temporary'], request['target']
    if Path(temporary).parent != Path(target).parent or not Path(temporary).name.startswith('.local-mcp-write-'):
        raise ValueError('Invalid publish staging path.')
    if digest(temporary) != request['sha256']:
        return {'ok': False, 'code': 'STAGING_CHANGED', 'error': 'Staged bytes changed before publication.'}
    expected = request.get('expected_sha256')
    if expected is None:
        # Windows os.rename does not overwrite an existing target. On POSIX use
        # an exclusive hard-link publication instead of replacing another file.
        try:
            if os.name == 'nt':
                os.rename(temporary, target)
            else:
                os.link(temporary, target)
                os.unlink(temporary)
        except FileExistsError:
            return {'ok': False, 'code': 'FILE_EXISTS', 'error': 'Another caller created this file; nothing was overwritten.'}
    else:
        try:
            before = os.lstat(target)
        except FileNotFoundError:
            return {'ok': False, 'code': 'FILE_CHANGED', 'error': 'The inspected file disappeared.'}
        if not stat.S_ISREG(before.st_mode) or before.st_nlink > 1:
            return {'ok': False, 'code': 'UNSAFE_FILE_TARGET', 'error': 'Target must remain a regular, non-linked file.'}
        actual = digest(target)
        after = os.lstat(target)
        if actual != expected or (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            return {'ok': False, 'code': 'FILE_CHANGED', 'error': 'The file changed before publication; inspect it again.'}
        os.replace(temporary, target)
    return {'ok': True}


handle = None
try:
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            operation = request['operation']
            if operation == 'acquire':
                if handle is not None:
                    raise RuntimeError('File-write lock already held.')
                handle = acquire_lock(sys.argv[1], float(request.get('seconds', 5)))
                value = {'ok': True}
            elif operation == 'release':
                if handle is None:
                    raise RuntimeError('File-write lock not held.')
                handle.close()
                handle = None
                value = {'ok': True}
            elif operation == 'publish' and handle is not None:
                value = publish(request)
            else:
                raise ValueError('Unknown or unlocked file-write operation.')
            reply = {'value': value}
        except Exception as error:
            reply = {'error': str(error)}
        if '_request_id' in request:
            reply['_request_id'] = request['_request_id']
        print(json.dumps(reply), flush=True)
finally:
    if handle is not None:
        handle.close()
