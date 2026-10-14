"""Report only evidence about input progress; never infer a failed call did nothing."""
import json


class InputRefusal(ValueError):
    def __init__(self, code, message, **details):
        self.details = {'code': code, 'error': message, 'execution_state': 'not_executed',
                        'action_not_executed': True, 'action_not_retried': True, 'is_error': True, **details}
        super().__init__(json.dumps(self.details, ensure_ascii=True))


class InputProgress:
    def __init__(self, owner):
        self.owner = owner
        self.completed = 0
        self.last = None
        self.attempting = None
        self.finished = False

    def step(self, name, operation):
        self.owner.checkpoint_current()
        self.attempting = name
        operation()
        self.completed += 1
        self.last = name
        self.attempting = None
        self.owner.record_step_current()

    def failure(self, error):
        state = ('executed' if self.finished else 'partially_executed' if self.completed
                 else 'execution_unknown' if self.attempting else 'not_executed')
        value = {'code': 'INPUT_FAILED', 'error': str(error), 'is_error': True,
                 'execution_state': state, 'action_not_executed': state == 'not_executed',
                 'action_not_retried': True, 'completed_steps': self.completed,
                 'last_completed_step': self.last, 'attempted_step': self.attempting,
                 'next_action': 'Inspect the field before deciding what remains; do not repeat the entire action.'}
        if isinstance(error, InputRefusal):
            value.update({k: v for k, v in error.details.items() if k not in ('execution_state', 'action_not_executed')})
        return value
