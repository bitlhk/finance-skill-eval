"""Graceful supervisor shutdown without blocking Windows DLL initialization."""
import os
import sys
import threading
import time


def start_stop_channel(stop):
    try:
        descriptor = sys.stdin.fileno()
    except (AttributeError, OSError, ValueError):
        return
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        import msvcrt
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        peek = kernel.PeekNamedPipe
        peek.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
            ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        peek.restype = wintypes.BOOL
        handle = msvcrt.get_osfhandle(descriptor)
        def available():
            count = wintypes.DWORD()
            if not peek(handle, None, 0, None, ctypes.byref(count), None):
                return None
            return count.value
    else:
        import select
        def available():
            return 4096 if select.select([descriptor], [], [], .1)[0] else 0

    def control():
        buffer = b''
        while True:
            try:
                count = available()
                if count is None:
                    return
                if not count:
                    time.sleep(.05)
                    continue
                # On Windows never call a blocking CRT read on an empty pipe:
                # it can retain the CRT lock while NumPy initializes its DLLs.
                value = os.read(descriptor, min(count, 4096))
                if not value:
                    return
                buffer += value
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    if line.strip() == b'stop':
                        stop()
                        return
                if len(buffer) > 4096:
                    buffer = b''
            except (OSError, ValueError):
                return
    threading.Thread(target=control, daemon=True, name='supervisor-stop').start()
