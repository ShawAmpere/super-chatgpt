"""Cheap window summaries; UIA is reserved for the requested control tree."""
import win32gui
import win32process
import win32con
from psutil import Process
from windows_mcp.desktop.views import Window, Status, Browser
from windows_mcp.tree.views import BoundingBox


def window_from_handle(handle, depth=0):
    if not handle or not win32gui.IsWindowVisible(handle):
        return None
    title = win32gui.GetWindowText(handle)
    if not title or win32gui.GetClassName(handle) in ('Progman', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'):
        return None
    left, top, right, bottom = win32gui.GetWindowRect(handle)
    _, pid = win32process.GetWindowThreadProcessId(handle)
    status = Status.MINIMIZED if win32gui.IsIconic(handle) else Status.MAXIMIZED if win32gui.GetWindowPlacement(handle)[1] == win32con.SW_SHOWMAXIMIZED else Status.NORMAL
    try:
        browser = Browser.has_process(Process(pid).name())
    except Exception:
        browser = False
    return Window(title, browser, depth, status, BoundingBox(left, top, right, bottom, right-left, bottom-top), handle, pid)


def window_summaries(handles):
    windows = []
    for depth, handle in enumerate(handles):
        try:
            window = window_from_handle(handle, depth)
            if window is not None:
                windows.append(window)
        except Exception:
            continue  # Windows can disappear while being enumerated.
    return windows


def window_identity(window):
    if window is None:
        return None
    box = window.bounding_box
    return {'handle': window.handle, 'pid': window.process_id, 'title': window.name,
            'bounds': [box.left, box.top, box.right, box.bottom]}


def owned_popup_handles(handles, target):
    if not target:
        return set()
    _, target_pid = win32process.GetWindowThreadProcessId(target)
    result = set()
    for handle in handles:
        try:
            if handle != target and win32process.GetWindowThreadProcessId(handle)[1] == target_pid:
                result.add(handle)
        except Exception:
            continue
    return result
