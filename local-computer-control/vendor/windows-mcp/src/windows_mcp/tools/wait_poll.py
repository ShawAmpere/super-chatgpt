"""Deadline-bounded read-only polling, independent of Windows and MCP."""
import asyncio
import time


async def poll_condition(probe, condition, timeout, interval):
    started = time.monotonic()
    deadline = started + timeout
    attempts = 0
    detail = 'condition was not evaluated'
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            status, matched = 'timeout', False
            break
        attempts += 1
        try:
            matched, detail = await asyncio.wait_for(probe(), timeout=remaining)
        except TimeoutError:
            # A blocked UIA provider is not evidence that a condition is absent.
            status, matched, detail = 'probe_timeout', None, 'UI inspection did not finish within the deadline'
            break
        if time.monotonic() >= deadline:
            status, matched = 'timeout', False
            break
        if matched:
            status = 'matched'
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            status = 'timeout'
            break
        await asyncio.sleep(min(interval, remaining))
    return {'condition': condition, 'condition_met': matched, 'timed_out': status != 'matched',
            'status': status, 'attempts': attempts, 'elapsed_seconds': round(time.monotonic() - started, 3),
            'detail': detail}
