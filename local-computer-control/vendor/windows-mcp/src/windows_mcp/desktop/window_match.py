"""Exact-first title matching, with candidates instead of guessed translations."""
import json


class WindowMatchError(ValueError):
    def __init__(self, query, windows, matches):
        candidates = matches or windows
        self.details = {
            'execution_state': 'not_executed', 'action_not_executed': True,
            'code': 'WINDOW_NOT_FOUND' if not matches else 'WINDOW_AMBIGUOUS',
            'query': query,
            'candidate_count': len(candidates),
            'candidates': [{'title': w.name, 'handle': w.handle, 'pid': w.process_id} for w in candidates[:40]],
            'next_action': 'Use a returned actual title that selects one window, or omit window_name to inspect the foreground window.'}
        super().__init__(json.dumps(self.details, ensure_ascii=True))


def select_window(windows, query):
    exact = [w for w in windows if w.name.casefold() == query.casefold()]
    matches = exact or [w for w in windows if query.casefold() in w.name.casefold()]
    if len(matches) != 1:
        raise WindowMatchError(query, windows, matches)
    return matches[0]
