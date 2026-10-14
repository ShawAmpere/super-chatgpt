"""Input tools — Click, Type, Scroll, Move, Shortcut, Wait, WaitFor."""

import json
import asyncio
import math
import re
import time
import win32gui
from collections.abc import Callable, Iterator
from typing import Any, Literal

from mcp.types import ToolAnnotations
from windows_mcp.desktop.utils import as_bool as _as_bool
from windows_mcp.infrastructure import with_analytics
from fastmcp import Context
from windows_mcp.infrastructure.thread_affinity import run_uia_affine
from windows_mcp.tools.wait_poll import poll_condition
from windows_mcp.desktop.input_result import InputRefusal
import windows_mcp.uia as uia


WaitForCondition = Literal[
    "text_exists",
    "active_window",
    "element_exists",
    "element_enabled",
    "focused_element",
]


def _resolve_label(desktop: Any, label: int) -> list[int]:
    """Resolve a UI element label to screen coordinates."""
    if desktop.desktop_state is None:
        raise ValueError("Desktop state is empty. Please call Snapshot first.")
    nodes = [*desktop.desktop_state.tree_state.interactive_nodes, *desktop.desktop_state.tree_state.scrollable_nodes]
    if label < 0 or label >= len(nodes):
        raise InputRefusal('LABEL_NOT_FOUND', 'Label is absent from the current tree; get a new snapshot.')
    node = nodes[label]
    loc = [node.center.x, node.center.y]
    handle = node.metadata.get('window_handle')
    hit = win32gui.WindowFromPoint(tuple(loc))
    root = win32gui.GetAncestor(hit, 2) if hit else None  # GA_ROOT
    if not handle or root != handle:
        raise InputRefusal('TARGET_OCCLUDED', 'The label point no longer hits its captured window; focus the target and re-observe.', label=label, target_handle=handle, hit_handle=root)
    runtime_id = node.metadata.get('runtime_id')
    if not runtime_id:
        raise InputRefusal('TARGET_IDENTITY_UNAVAILABLE', 'This control has no stable UIA identity. Re-observe and use an explicit coordinate only after checking the target; the label was not executed.', label=label)
    if runtime_id:
        # Reject a replaced control even when its parent window remains unchanged.
        try:
            current = uia.ControlFromPoint(*loc)
            found = False
            for _ in range(12):
                if current is None:
                    break
                if tuple(current.GetRuntimeId()) == tuple(runtime_id):
                    found = True
                    break
                current = current.GetParentControl()
        except Exception:
            found = False
        if not found:
            raise InputRefusal('TARGET_ELEMENT_CHANGED', 'The control at this label point changed; take a new snapshot.', label=label)
    return loc


def _validate_finite_number(value: object, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")


def _as_loc(value: list | str | None) -> list | None:
    """Coerce a JSON-stringified list back to a list.

    Claude Desktop strips anyOf schemas and the model serializes lists as
    strings (e.g. '[100, 200]'). Parsing here keeps the tools working.
    """
    if value is None or isinstance(value, list):
        return value
    return json.loads(value)


# One optional leading sign followed by decimal digits — exactly what int()
# accepts. `.lstrip("+-").isdigit()` used to strip *any* run of signs, so
# "+-5"/"--5" passed the check and then int() raised a confusing low-level
# error instead of the intended message; `.isdigit()` also accepts digits
# int() rejects (e.g. the superscript "²").
_SIGNED_INT_RE = re.compile(r"^[+-]?\d+$")


def _as_point(value: object, name: str) -> list[int]:
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError(f"{name} must be a list of exactly 2 integers [x, y]")
    parsed = []
    for item in value:
        if isinstance(item, bool):
            raise ValueError(f"{name} must contain integers, not booleans")
        if isinstance(item, int):
            parsed.append(item)
            continue
        if isinstance(item, str):
            stripped = item.strip()
            if _SIGNED_INT_RE.match(stripped):
                parsed.append(int(stripped))
                continue
        raise ValueError(f"{name} must contain exactly 2 integers")
    return parsed


def _text_matches(value: object | None, expected: str | None) -> bool:
    if expected is None:
        return True
    if value is None:
        return False
    return expected.casefold() in str(value).casefold()


def _metadata_text_matches(metadata: dict[str, object], expected: str | None) -> bool:
    return any(_text_matches(value, expected) for value in metadata.values())


def _iter_nodes(desktop_state: Any) -> Iterator[Any]:
    tree_state = getattr(desktop_state, "tree_state", None)
    if tree_state is None:
        return
    yield from getattr(tree_state, "interactive_nodes", [])
    yield from getattr(tree_state, "scrollable_nodes", [])


def _iter_text_sources(desktop_state: Any, window_name: str | None = None) -> Iterator[object]:
    active_window = getattr(desktop_state, "active_window", None)
    if active_window is not None and _text_matches(active_window.name, window_name):
        yield active_window.name

    for window in getattr(desktop_state, "windows", []):
        if _text_matches(window.name, window_name):
            yield window.name

    tree_state = getattr(desktop_state, "tree_state", None)
    if tree_state is None:
        return

    for node in _iter_nodes(desktop_state):
        if not _text_matches(getattr(node, 'window_name', ''), window_name):
            continue
        yield node.name
        yield node.control_type
        yield node.window_name
        for value in getattr(node, "metadata", {}).values():
            yield value

    for node in getattr(tree_state, "dom_informative_nodes", []):
        if not window_name or (active_window is not None and _text_matches(active_window.name, window_name)):
            yield getattr(node, "text", "")


def _node_matches(node: Any, text: str | None, window_name: str | None) -> bool:
    metadata: dict[str, object] = getattr(node, "metadata", {})
    return (
        _text_matches(getattr(node, "name", ""), text)
        or _text_matches(getattr(node, "control_type", ""), text)
        or _metadata_text_matches(metadata, text)
    ) and _text_matches(getattr(node, "window_name", ""), window_name)


def _matches_wait_condition(
    desktop_state: Any,
    condition: WaitForCondition,
    text: str | None,
    window_name: str | None,
) -> tuple[bool, str]:
    if condition == "text_exists":
        for source in _iter_text_sources(desktop_state, window_name):
            if _text_matches(source, text):
                return True, f"text {text!r} appeared"
        return False, f"text {text!r} was absent"

    if condition == "active_window":
        expected = window_name or text
        active_window = getattr(desktop_state, "active_window", None)
        active_name = active_window.name if active_window else ""
        if _text_matches(active_name, expected):
            return True, f"active window matched {active_name!r}"
        return False, f"active window was {active_name!r}"

    if condition in {"element_exists", "element_enabled"}:
        for node in _iter_nodes(desktop_state):
            if _node_matches(node, text, window_name) and (condition != 'element_enabled' or getattr(node, 'metadata', {}).get('is_enabled') is True):
                return True, f"element matched {getattr(node, 'name', '')!r}"
        return False, "matching element was absent"

    if condition == "focused_element":
        for node in _iter_nodes(desktop_state):
            metadata = getattr(node, "metadata", {})
            if metadata.get("has_focused") and _node_matches(node, text, window_name):
                return True, f"focused element matched {getattr(node, 'name', '')!r}"
        return False, "matching focused element was absent"

    raise ValueError(f"Unsupported WaitFor condition: {condition}")


def _validate_wait_for_args(
    condition: str,
    text: str | None,
    window_name: str | None,
    timeout: float,
    interval: float,
) -> WaitForCondition:
    _validate_finite_number(timeout, "timeout")
    _validate_finite_number(interval, "interval")

    normalized = condition.strip().lower().replace("-", "_")
    aliases = {
        "text": "text_exists",
        "window": "active_window",
        "element": "element_exists",
        "enabled": "element_enabled",
        "focused": "focused_element",
    }
    normalized = aliases.get(normalized, normalized)
    valid_conditions = {
        "text_exists",
        "active_window",
        "element_exists",
        "element_enabled",
        "focused_element",
    }
    if normalized not in valid_conditions:
        raise ValueError(
            "condition must be one of: text_exists, active_window, element_exists, "
            "element_enabled, focused_element"
        )

    if timeout <= 0 or timeout > 120:
        raise ValueError("timeout must be greater than 0 and at most 120 seconds")
    if interval <= 0 or interval > 5:
        raise ValueError("interval must be greater than 0 and at most 5 seconds")

    if normalized == "text_exists" and not text:
        raise ValueError("text is required when condition is text_exists")
    if normalized == "active_window" and not (text or window_name):
        raise ValueError("text or window_name is required when condition is active_window")
    if normalized in {"element_exists", "element_enabled"} and not (text or window_name):
        raise ValueError(
            "text or window_name is required when condition is element_exists or element_enabled"
        )

    return normalized


def register(
    mcp: Any,
    *,
    get_desktop: Callable[[], Any],
    get_analytics: Callable[[], Any],
) -> None:
    @mcp.tool(
        name="Click",
        description=(
            "Performs mouse clicks at specified coordinates [x, y] or passing a UI element's label/id. "
            "Supports button types: 'left' for selection/activation, 'right' for context menus, 'middle'. "
            "Supports clicks: 0=hover only (no click), 1=single click (select/focus), 2=double click (open/activate). "
            "Provide either loc or label."
        ),
        annotations=ToolAnnotations(
            title="Click",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Click-Tool", run_sync_in_thread=False)
    def click_tool(
        loc: list[int] | str | None = None,
        label: int | None = None,
        button: Literal["left", "right", "middle"] = "left",
        clicks: int = 1,
        ctx: Context = None,
    ) -> str:
        desktop = get_desktop()
        loc = _as_loc(loc)
        if loc is None and label is None:
            raise ValueError("Either loc or label must be provided.")
        if label is not None:
            loc = _resolve_label(desktop, label)
        if len(loc) != 2:
            raise ValueError("Location must be a list of exactly 2 integers [x, y]")
        x, y = loc[0], loc[1]
        result = desktop.click(loc=loc, button=button, clicks=clicks)
        if isinstance(result, dict) and result.get('is_error'):
            return result
        num_clicks = {0: "Hover", 1: "Single", 2: "Double"}
        return f"{num_clicks.get(clicks)} {button} clicked at ({x},{y})."

    @mcp.tool(
        name="Type",
        description="Types text at specified coordinates [x, y] or passing a UI element's label/id. Set clear=True to clear existing text first, False to append. Set press_enter=True to submit after typing. Set caret_position to 'start' (beginning), 'end' (end), or 'idle' (default). Provide either loc or label. clear and press_enter accept only true or false. An empty text types nothing, so combine it with clear=True to just empty a field.",
        annotations=ToolAnnotations(
            title="Type",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Type-Tool", run_sync_in_thread=False)
    def type_tool(
        text: str,
        loc: list[int] | str | None = None,
        label: int | None = None,
        clear: bool | str = False,
        caret_position: Literal["start", "idle", "end"] = "idle",
        press_enter: bool | str = False,
        input_method: Literal['auto', 'paste', 'keys'] = 'auto',
        focused: bool = False,
        ctx: Context = None,
    ) -> dict:
        desktop = get_desktop()
        loc = _as_loc(loc)
        clear = _as_bool(clear, "clear")
        press_enter = _as_bool(press_enter, "press_enter")
        if focused and (loc is not None or label is not None):
            raise ValueError('focused cannot be combined with loc or label')
        if loc is None and label is None and not focused:
            raise ValueError('Provide loc, label, or explicitly focused=True for Type')
        if label is not None:
            loc = _resolve_label(desktop, label)
        if loc is not None and len(loc) != 2:
            raise ValueError("Location must be a list of exactly 2 integers [x, y]")
        value = desktop.type(
            loc=loc,
            text=text,
            caret_position=caret_position,
            clear=clear,
            press_enter=press_enter,
            input_method=input_method,
        )
        return value

    @mcp.tool(
        name="Scroll",
        description="Scrolls at coordinates [x, y], a UI element's label/id, or current mouse position if loc=None. Type: vertical (default) or horizontal. Direction: up/down for vertical, left/right for horizontal. wheel_times controls amount (1 wheel ≈ 3-5 lines). Use for navigating long content, lists, and web pages.",
        annotations=ToolAnnotations(
            title="Scroll",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Scroll-Tool", run_sync_in_thread=False)
    def scroll_tool(
        loc: list[int] | str | None = None,
        label: int | None = None,
        type: Literal["horizontal", "vertical"] = "vertical",
        direction: Literal["up", "down", "left", "right"] = "down",
        wheel_times: int = 1,
        ctx: Context = None,
    ) -> str:
        desktop = get_desktop()
        loc = _as_loc(loc)
        if label is not None:
            loc = _resolve_label(desktop, label)
        if loc and len(loc) != 2:
            raise ValueError("Location must be a list of exactly 2 integers [x, y]")
        response = desktop.scroll(loc, type, direction, wheel_times)
        if response:
            return response
        return (
            f"Scrolled {type} {direction} by {wheel_times} wheel times"
            + f" at ({loc[0]},{loc[1]})."
            if loc
            else ""
        )

    @mcp.tool(
        name="Move",
        description=(
            "Moves mouse cursor to coordinates [x, y] or passing a UI element's label/id. "
            "Set drag=True to perform a drag-and-drop operation from the current mouse position "
            "to the target coordinates, or provide from_loc=[x, y] to make the drag explicit-start "
            "and atomic in one tool call. Optional duration controls bounded intermediate movement. "
            "Default (drag=False) is a simple cursor move (hover). "
            "Provide either loc or label."
        ),
        annotations=ToolAnnotations(
            title="Move",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Move-Tool", run_sync_in_thread=False)
    def move_tool(
        loc: list[int] | str | None = None,
        label: int | None = None,
        drag: bool | str = False,
        from_loc: list[int] | str | None = None,
        duration: float | int | str | None = None,
        ctx: Context = None,
    ) -> str:
        desktop = get_desktop()
        loc = _as_loc(loc)
        from_loc = _as_loc(from_loc)
        drag = _as_bool(drag, "drag")
        if loc is None and label is None:
            raise ValueError("Either loc or label must be provided.")
        if label is not None:
            loc = _resolve_label(desktop, label)
        if not isinstance(loc, list) or len(loc) != 2:
            raise ValueError("loc must be a list of exactly 2 integers [x, y]")
        if from_loc is not None and (not isinstance(from_loc, list) or len(from_loc) != 2):
            raise ValueError("from_loc must be a list of exactly 2 integers [x, y]")
        has_drag_only_options = any(
            value is not None
            for value in (
                from_loc,
                duration,
            )
        )
        if has_drag_only_options and not drag:
            raise ValueError("from_loc and duration require drag=True")
        if drag:
            loc = _as_point(loc, "loc")
            if from_loc is not None:
                from_loc = _as_point(from_loc, "from_loc")
        x, y = loc[0], loc[1]
        if drag:
            result = desktop.drag(
                loc,
                from_loc=from_loc,
                duration=duration,
            )
            if result.get('is_error'):
                return result
            start_x, start_y = result["start"]
            effective_duration = result["duration"]
            if effective_duration is None:
                return f"Dragged from ({start_x},{start_y}) to ({x},{y})."
            return (
                f"Dragged from ({start_x},{start_y}) to ({x},{y}) "
                f"over {effective_duration:.3f} seconds."
            )
        else:
            desktop.move(loc)
            return f"Moved the mouse pointer to ({x},{y})."

    @mcp.tool(
        name="Shortcut",
        description='Executes keyboard shortcuts using key combinations separated by +. Examples: "ctrl+c" (copy), "ctrl+v" (paste), "alt+tab" (switch apps), "win+r" (Run dialog), "win" (Start menu), "ctrl+shift+esc" (Task Manager). Use for quick actions and system commands.',
        annotations=ToolAnnotations(
            title="Shortcut",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Shortcut-Tool")
    def shortcut_tool(shortcut: str, ctx: Context = None):
        result = get_desktop().shortcut(shortcut)
        if isinstance(result, dict) and result.get('is_error'):
            return result
        return f"Pressed {shortcut}."

    @mcp.tool(
        name="Wait",
        description="Pauses execution for specified duration in seconds. Use when waiting for: applications to launch/load, UI animations to complete, page content to render, dialogs to appear, or between rapid actions. Helps ensure UI is ready before next interaction.",
        annotations=ToolAnnotations(
            title="Wait",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Wait-Tool")
    def wait_tool(duration: int, ctx: Context = None) -> str:
        time.sleep(duration)
        return f"Waited for {duration} seconds."

    @mcp.tool(
        name="WaitFor",
        description=(
            "Waits until a UI condition is satisfied, polling the Windows accessibility tree "
            "inside the tool to avoid repeated Snapshot calls. Conditions: text_exists, "
            "active_window, element_exists, element_enabled, focused_element. Provide text "
            "and/or window_name depending on the condition. Set use_dom=True for browser DOM text."
        ),
        annotations=ToolAnnotations(
            title="WaitFor",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "WaitFor-Tool", run_sync_in_thread=False)
    async def wait_for_tool(
        condition: str,
        text: str | None = None,
        window_name: str | None = None,
        timeout: float = 10.0,
        interval: float = 0.25,
        use_dom: bool | str = False,
        ctx: Context = None,
    ) -> dict:
        normalized = _validate_wait_for_args(
            condition=condition,
            text=text,
            window_name=window_name,
            timeout=timeout,
            interval=interval,
        )
        desktop = get_desktop()
        use_dom_bool = _as_bool(use_dom, "use_dom")
        async def probe():
            from windows_mcp.desktop.control import get_controller
            get_controller().checkpoint_current()
            if normalized == 'active_window':
                # Window titles do not require an accessibility-tree traversal.
                import win32gui
                active_name = await asyncio.to_thread(lambda: win32gui.GetWindowText(win32gui.GetForegroundWindow()))
                get_controller().checkpoint_current()
                matched = _text_matches(active_name, window_name or text)
                return matched, f'active window was {active_name!r}'
            def inspect():
                state = desktop.get_state(use_vision=False, use_dom=use_dom_bool,
                                          use_ui_tree=True, use_annotation=False)
                if not state.tree_state.status:
                    raise RuntimeError('Accessibility inspection failed; the wait condition could not be evaluated')
                return _matches_wait_condition(state, normalized, text, window_name)
            matched = await run_uia_affine(inspect)
            get_controller().checkpoint_current()
            return matched
        return await poll_condition(probe, normalized, timeout, interval)
