import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export class DesktopRequestError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.details = { code, error: this.message, execution_state: 'not_executed', action_not_executed: true, action_not_retried: true, ...details };
  }
}

// Capture, validation, action and its post-action observation share one lane.
export class DesktopLane {
  constructor(lease) { this.lease = lease; this.tail = Promise.resolve(); }
  async run(owner, action, signal) {
    this.lease.require(owner);
    this.lease.inFlight++;
    const previous = this.tail;
    let unlock;
    this.tail = new Promise(resolve => { unlock = resolve; });
    try {
      await previous;
      signal?.throwIfAborted();
      this.lease.require(owner);
      return await action();
    } finally {
      if (this.lease.current?.owner === owner) this.lease.current.expiresAt = this.lease.clock() + this.lease.current.seconds * 1000;
      this.lease.inFlight--;
      unlock();
    }
  }
}

export class DesktopObservation {
  constructor(clock = () => performance.now(), requireLabelSnapshot = true) {
    this.clock = clock;
    this.requireLabelSnapshot = requireLabelSnapshot;
    this.last = null;
    this.reason = 'no_snapshot';
  }
  invalidate(reason) { this.reason = reason; }
  invalidateAfterUncertainCall(name, requestSent) {
    if (requestSent && ['Click','Type','Scroll','Move','Shortcut','App','Clipboard'].includes(name)) {
      this.invalidate('action_delivery_uncertain');
    }
  }
  record(owner, detail, foreground, treeTarget = foreground) {
    this.last = { id: randomUUID(), owner_id: owner, detail, foreground, treeTarget,
      captured_at: new Date().toISOString(), at: this.clock() };
    this.reason = null;
    return this.describe();
  }
  describe() {
    const age = this.last ? Math.max(0, this.clock() - this.last.at) : null;
    return { snapshot_id: this.last?.id || null, owner_id: this.last?.owner_id || null,
      detail: this.last?.detail || null, captured_at: this.last?.captured_at || null,
      foreground: this.last?.foreground || null, tree_target: this.last?.treeTarget || null,
      age_ms: age === null ? null : Math.round(age), max_age_ms: 60000,
      valid: Boolean(this.last && !this.reason && age <= 60000),
      invalidation_reason: this.reason || (age > 60000 ? 'age_limit' : null) };
  }
  require(owner, label, snapshotId) {
    const current = this.describe();
    const value = { ...current, owner_id: current.owner_id === owner ? owner : null };
    if (!value.valid || value.owner_id !== owner) {
      throw new DesktopRequestError('STALE_DESKTOP_STATE', 'Take a new computer_snapshot for this owner before input.',
        { observation: { ...value, invalidation_reason: current.owner_id && current.owner_id !== owner ? 'owner_changed' : value.invalidation_reason },
          next_action: 'Get a fresh snapshot, then act. Waits that inspect UI elements replace label state; status/lease renewals do not.' });
    }
    if (snapshotId && snapshotId !== value.snapshot_id) {
      throw new DesktopRequestError('STALE_DESKTOP_STATE', 'The referenced snapshot has been replaced.',
        { observation: { ...value, invalidation_reason: 'snapshot_replaced' }, requested_snapshot_id: snapshotId });
    }
    if (label !== undefined && !['elements', 'both'].includes(value.detail)) {
      throw new DesktopRequestError('ELEMENT_LABELS_UNAVAILABLE', 'Use label=N from a new elements/both snapshot.', { observation: value });
    }
    if (label !== undefined) {
      if (this.requireLabelSnapshot && !snapshotId) {
        throw new DesktopRequestError('SNAPSHOT_ID_REQUIRED', 'Label actions must include the snapshot_id that supplied the label.', { observation: value });
      }
      const foreground = this.last.foreground, target = this.last.treeTarget;
      if (!foreground || !target || foreground.handle !== target.handle || foreground.pid !== target.pid) {
        throw new DesktopRequestError('TARGET_WINDOW_NOT_FOREGROUND', 'The captured control tree belongs to a background window. Focus it and take a new snapshot before label input.', { observation: value });
      }
    }
  }
  checkForeground(current) {
    const old = this.last?.foreground;
    if (!old || !current || old.handle !== current.handle || old.pid !== current.pid ||
        old.title !== current.title || JSON.stringify(old.bounds) !== JSON.stringify(current.bounds)) {
      this.invalidate('foreground_changed');
    }
  }
}
