"""Preserve text clipboard formats; refuse unsupported contents before any input."""
import win32clipboard
from windows_mcp.desktop.input_result import InputRefusal


class TextClipboard:
    TEXT_FORMATS = {1, 7, 13, 16}  # CF_TEXT, CF_OEMTEXT, CF_UNICODETEXT, CF_LOCALE

    def __init__(self, text, api=win32clipboard):
        self.api = api
        self.text = text
        self.prior = []
        self.sequence = None
        self.restore_status = 'not_needed'

    def _restore(self):
        self.api.EmptyClipboard()
        for kind, data in self.prior:
            self.api.SetClipboardData(kind, data)

    def _formats(self):
        kinds = []
        kind = 0
        while True:
            kind = self.api.EnumClipboardFormats(kind)
            if not kind:
                return kinds
            kinds.append(kind)

    def _rollback_setup(self, error):
        # Confirmation can fail after CloseClipboard. A replacement with the
        # same plain text but added HTML/image formats is a user's new value.
        try:
            self.api.OpenClipboard()
            try:
                kinds = self._formats()
                if 13 not in kinds or set(kinds) - self.TEXT_FORMATS or self.api.GetClipboardData(13) != self.text:
                    self.restore_status = 'user_changed'
                else:
                    self._restore()
                    self.restore_status = 'restored'
            finally:
                self.api.CloseClipboard()
        except Exception as restore_error:
            self.restore_status = 'failed'
            raise InputRefusal('CLIPBOARD_SETUP_FAILED',
                'Clipboard setup failed; original clipboard restoration is uncertain. Inspect it before retrying.',
                clipboard_restore_status='failed', clipboard_state_unknown=True) from restore_error
        raise InputRefusal('CLIPBOARD_SETUP_FAILED',
            'Clipboard setup failed before input; inspect clipboard before retrying.',
            clipboard_restore_status=self.restore_status) from error

    def __enter__(self):
        self.api.OpenClipboard()
        try:
            try:
                kinds = self._formats()
                unsupported = [kind for kind in kinds if kind not in self.TEXT_FORMATS]
                if unsupported:
                    raise InputRefusal('CLIPBOARD_FORMAT_UNSUPPORTED',
                        'Clipboard contains non-text or rich formats. No input was performed and clipboard was not changed.',
                        clipboard_preserved=True, format_ids=unsupported,
                        next_action='Keep the original clipboard: use keys for at most 128 characters per call. Use clipboard_set only if replacing the clipboard has been explicitly requested.')
                if not self.api.GetClipboardSequenceNumber():
                    raise InputRefusal('CLIPBOARD_SEQUENCE_UNAVAILABLE', 'Cannot establish clipboard ownership; no input was performed.')
                self.prior = [(kind, self.api.GetClipboardData(kind)) for kind in kinds]
                self.restore_status = 'pending'
                try:
                    self.api.EmptyClipboard()
                    self.api.SetClipboardData(13, self.text)
                except Exception as error:
                    # This lock is still held: no other process can update the
                    # value between a failed write and restoration here.
                    try:
                        self._restore()
                        self.restore_status = 'restored'
                    except Exception as restore_error:
                        self.restore_status = 'failed'
                        raise InputRefusal('CLIPBOARD_SETUP_FAILED',
                            'Clipboard setup failed; original clipboard restoration is uncertain.',
                            clipboard_restore_status='failed', clipboard_state_unknown=True) from restore_error
                    raise InputRefusal('CLIPBOARD_SETUP_FAILED', 'Clipboard setup failed before input; original data was restored.',
                        clipboard_restore_status='restored') from error
            finally:
                self.api.CloseClipboard()
        except Exception as error:
            if self.restore_status == 'pending':
                self._rollback_setup(error)
            raise
        # Windows commits synthesized text formats and increments the sequence
        # when the write lock closes. A sequence sampled inside that lock is stale.
        try:
            self.sequence = self.api.GetClipboardSequenceNumber()
            if not self.sequence:
                raise RuntimeError('Clipboard sequence unavailable after temporary paste setup')
        except Exception as error:
            # __exit__ is not invoked if __enter__ fails.
            self._rollback_setup(error)
        return self

    def __exit__(self, *ignored):
        try:
            self.api.OpenClipboard()
        except Exception:
            self.restore_status = 'failed'
            raise
        try:
            if self.api.GetClipboardSequenceNumber() != self.sequence:
                self.restore_status = 'user_changed'
                return
            try:
                still_ours = self.api.GetClipboardData(13) == self.text
            except Exception:
                still_ours = False
            if not still_ours:
                self.restore_status = 'user_changed'
                return
            self._restore()
            self.restore_status = 'restored'
        except Exception:
            self.restore_status = 'failed'
            raise
        finally:
            self.api.CloseClipboard()
