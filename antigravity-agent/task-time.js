// Compute elapsed duration on the server; retain offsets on every display timestamp.
export function taskTime(record, now = Date.now()) {
  const started = Date.parse(record.startedAt || record.createdAt);
  const finished = record.finishedAt ? Date.parse(record.finishedAt) : now;
  const seconds = Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, Math.floor((finished - started) / 1000)) : null;
  const local = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const offset = -date.getTimezoneOffset();
    const localDate = new Date(date.getTime() + offset * 60000);
    const sign = offset < 0 ? '-' : '+';
    const abs = Math.abs(offset);
    return localDate.toISOString().slice(0, -1) + sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
  };
  return {
    created_at: record.createdAt || null, started_at: record.startedAt || null,
    finished_at: record.finishedAt || null, server_now: new Date(now).toISOString(),
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    created_at_local: local(record.createdAt), started_at_local: local(record.startedAt),
    finished_at_local: local(record.finishedAt), server_now_local: local(now),
    elapsed_seconds: seconds,
    elapsed: seconds === null ? null : `${Math.floor(seconds / 3600)}小时${Math.floor(seconds / 60) % 60}分${seconds % 60}秒`,
    elapsed_basis: 'server_clock_since_task_start_including_continuations',
  };
}
