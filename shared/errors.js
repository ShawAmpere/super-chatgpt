// Keep errors useful without forwarding credential assignments or echoed keys.
export function redactSecrets(value, privateValues = []) {
  if (typeof value === 'string') {
    let text = value.replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|xox[baprs]-[\w-]+)\b/g, '[REDACTED]')
      .replace(/(\bbearer\s+)[^\s"',;]+/ig, '$1[REDACTED]')
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*["']?\s*[:=]\s*["']?)[^\s,;"']+/ig, '$1[REDACTED]');
    for (const secret of privateValues.filter(Boolean)) text = text.replaceAll(secret, '[PRIVATE_WORKFLOW]');
    return text;
  }
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, privateValues));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,
    /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)$/i.test(key) && item != null ? '[REDACTED]' : redactSecrets(item,privateValues)]));
  return value;
}

export function forwardingFailure(name, dispatched) {
  const guidance = ['write_local_file','edit_local_file'].includes(name) ? 'Inspect the target file and SHA256 before deciding what remains.'
    : name === 'computer_action' ? 'Take a new desktop snapshot before deciding what remains.'
    : 'Inspect service and saved state before retrying.';
  return { execution_state: dispatched ? 'execution_unknown' : 'not_executed', action_not_retried: true,
    next_action: dispatched ? guidance + ' Do not automatically replay.' : 'The service was unavailable before forwarding; inspect get_gateway_status before retrying.' };
}

export function readFailure(error) {
  const message=String(error?.message||error), temporary=/busy|expired|changed|stopped|timeout|timed out|exceeded 30 seconds/i.test(message);
  const kind=error.code==='ENOENT'?'path_missing':/binary/i.test(message)?'binary_format':/encod|decod|UTF|character/i.test(message)?'encoding':/cursor|paging/i.test(message)?'cursor':/parser|worker|converter|conversion/i.test(message)?'document_worker':'read';
  return {error:redactSecrets(message),code:temporary?'RETRY_OR_RESTART':'READ_FAILED',error_kind:kind,retryable:temporary,
    next_action:temporary?'Retry when idle; restart paging if the source changed or its cursor expired.':'Check the path, format and encoding; inspect get_reader_capabilities for alternatives.'};
}
