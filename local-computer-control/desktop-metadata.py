"""Fast Win32 window metadata; no UI Automation or input operations."""
import ctypes
from ctypes import wintypes
import json
import sys

user = ctypes.WinDLL("user32", use_last_error=True)
try:
    user.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
except (AttributeError, OSError):
    pass
user.GetForegroundWindow.restype = wintypes.HWND
user.IsWindowVisible.argtypes = [wintypes.HWND]
user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]

def window(handle):
    title = ctypes.create_unicode_buffer(512)
    user.GetWindowTextW(handle, title, len(title))
    rect = wintypes.RECT()
    if not title.value or not user.IsWindowVisible(handle) or not user.GetWindowRect(handle, ctypes.byref(rect)):
        return None
    pid = wintypes.DWORD()
    user.GetWindowThreadProcessId(handle, ctypes.byref(pid))
    return {"handle": int(handle), "pid": pid.value, "title": title.value, "bounds": [rect.left, rect.top, rect.right, rect.bottom]}

def snapshot():
    windows = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    @callback_type
    def collect(handle, _):
        info = window(handle)
        if info and len(windows) < 40:
            windows.append(info)
        return True
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.EnumWindows(collect, 0)
    return {"focused_window": window(user.GetForegroundWindow()), "visible_windows": windows}

if "--serve" in sys.argv:
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if request.get("operation") != "metadata":
                raise ValueError("Unknown metadata operation.")
            reply = {"value": snapshot()}
        except Exception as error:
            reply = {"error": str(error)}
        if '_request_id' in request:
            reply['_request_id'] = request['_request_id']
        print(json.dumps(reply, ensure_ascii=True), flush=True)
else:
    print(json.dumps(snapshot(), ensure_ascii=True))
