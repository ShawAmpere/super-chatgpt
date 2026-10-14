"""OS-owned locks and a Windows Job Object for the MCP adapter.

No credentials are persisted. Job ownership is held by this supervisor; closing
its handle (including a supervisor crash) terminates the contained CLI tree.
"""
import ctypes
import json
import os
import subprocess
import sys
import time
import threading
from ctypes import wintypes


def acquire_lock(file, seconds):
    deadline = time.monotonic() + seconds
    # Create the lock file, but initialize its byte only after taking the OS lock.
    try:
        with open(file, "xb"):
            pass
    except FileExistsError:
        pass
    while True:
        handle = None
        try:
            handle = open(file, "r+b", buffering=0)
            # An earlier owner may have crashed after creating an empty file.
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if os.fstat(handle.fileno()).st_size == 0:
                handle.seek(0)
                handle.write(b"\0")
                handle.flush()
            return handle
        except OSError:
            if handle is not None:
                handle.close()
            if time.monotonic() >= deadline:
                raise TimeoutError("Shared task state is busy; retry shortly.")
            time.sleep(0.025)


def lock(file, seconds):
    with acquire_lock(file, seconds):
        print("LOCKED", flush=True)
        sys.stdin.buffer.read()


def lock_server(file):
    handle = None
    try:
        for line in sys.stdin:
            request = {}
            try:
                request = json.loads(line)
                if request["operation"] == "acquire":
                    if handle is not None:
                        raise RuntimeError("Lock already held.")
                    handle = acquire_lock(file, float(request.get("seconds", 5)))
                elif request["operation"] == "release":
                    if handle is None:
                        raise RuntimeError("Lock not held.")
                    handle.close()
                    handle = None
                else:
                    raise ValueError("Unknown lock operation.")
                reply = {"ok": True}
            except Exception as error:
                reply = {"error": str(error)}
            if '_request_id' in request:
                reply['_request_id'] = request['_request_id']
            print(json.dumps(reply), flush=True)
    finally:
        if handle is not None:
            handle.close()


def supervise(command):
    if os.name != "nt":
        raise RuntimeError("Managed CLI execution currently requires Windows.")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    class BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                    ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    class ThreadEntry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ThreadID", wintypes.DWORD), ("th32OwnerProcessID", wintypes.DWORD),
                    ("tpBasePri", wintypes.LONG), ("tpDeltaPri", wintypes.LONG),
                    ("dwFlags", wintypes.DWORD)]

    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    parent = kernel.OpenProcess(0x100000, False, os.getppid())
    if not parent:
        raise RuntimeError("MCP parent process is unavailable.")
    def watch_parent():
        kernel.WaitForSingleObject(parent, 0xffffffff)
        os._exit(1)  # OS closes our job handle and terminates its whole tree.
    threading.Thread(target=watch_parent, daemon=True).start()
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
    kernel.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
    kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenThread.restype = wintypes.HANDLE
    kernel.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel.ResumeThread.restype = wintypes.DWORD
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    child = None
    try:
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE; no breakaway.
        if os.environ.get("PROCESS_JOB_MEMORY_LIMIT"):
            limits.BasicLimitInformation.LimitFlags |= 0x200
            limits.JobMemoryLimit = int(os.environ["PROCESS_JOB_MEMORY_LIMIT"])
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        environment = dict(os.environ)
        environment.pop("CONTROL_PLANE_API_KEY", None)
        control_file = environment.pop("LOCAL_PROCESS_CONTROL_FILE", None)
        startup = subprocess.STARTUPINFO()
        startup.dwFlags = subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 0  # Separate hidden console enables graceful Ctrl+C.
        flags = 0x4 | (0x10 if control_file else 0x08000000)
        child = subprocess.Popen(command, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
                                 env=environment, startupinfo=startup, creationflags=flags)
        if not kernel.AssignProcessToJobObject(job, int(child._handle)):
            raise ctypes.WinError(ctypes.get_last_error())
        snapshot = kernel.CreateToolhelp32Snapshot(0x4, 0)
        if snapshot in (None, ctypes.c_void_p(-1).value):
            raise ctypes.WinError(ctypes.get_last_error())
        resumed = False
        try:
            entry = ThreadEntry()
            entry.dwSize = ctypes.sizeof(entry)
            present = kernel.Thread32First(snapshot, ctypes.byref(entry))
            while present:
                if entry.th32OwnerProcessID == child.pid:
                    thread = kernel.OpenThread(0x2, False, entry.th32ThreadID)
                    if not thread:
                        raise ctypes.WinError(ctypes.get_last_error())
                    try:
                        if kernel.ResumeThread(thread) == 0xffffffff:
                            raise ctypes.WinError(ctypes.get_last_error())
                        resumed = True
                    finally:
                        kernel.CloseHandle(thread)
                present = kernel.Thread32Next(snapshot, ctypes.byref(entry))
        finally:
            kernel.CloseHandle(snapshot)
        if not resumed:
            raise RuntimeError("Could not resume the CLI in its managed job.")
        if control_file:
            with open(control_file, "x", encoding="utf-8") as handle:
                json.dump({"pid": child.pid, "supervisor_pid": os.getpid()}, handle)
        return child.wait()
    finally:
        kernel.CloseHandle(job)
        if child is not None and child.poll() is None:
            child.kill()  # Also covers failure before job assignment.
            child.wait(timeout=10)


def interrupt(pid):
    if os.name != "nt":
        raise RuntimeError("Console interruption requires Windows.")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.FreeConsole()
    if not kernel.AttachConsole(int(pid)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not kernel.SetConsoleCtrlHandler(None, True):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.GenerateConsoleCtrlEvent(0, 0):  # CTRL_C_EVENT on this private console.
            raise ctypes.WinError(ctypes.get_last_error())
        time.sleep(0.2)
        print("INTERRUPT_SENT", flush=True)
    finally:
        kernel.FreeConsole()

