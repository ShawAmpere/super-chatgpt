export class DesktopLease {
  constructor(clock = () => Date.now()) { this.clock = clock; this.current = null; this.inFlight = 0; }
  expire() { if (this.current && this.clock() >= this.current.expiresAt && !this.inFlight) this.current = null; }
  status(requester = null) {
    this.expire();
    return this.current ? { owner_id: requester === this.current.owner ? this.current.owner : null, expires_at: new Date(this.current.expiresAt).toISOString(), busy: true, in_flight: this.inFlight > 0 } : { owner_id: null, busy: false, in_flight: false };
  }
  acquire(owner, seconds) {
    this.expire();
    if (this.current && this.current.owner !== owner) return { acquired: false, code: 'DESKTOP_BUSY', ...this.status() };
    this.current = { owner, seconds, expiresAt: this.clock() + seconds * 1000 };
    return { acquired: true, ...this.status(owner) };
  }
  require(owner) {
    this.expire();
    if (!this.current || this.current.owner !== owner) throw new Error('DESKTOP_BUSY: acquire_computer_control for this owner_id before inspecting or operating the desktop.');
    this.current.expiresAt = this.clock() + this.current.seconds * 1000;
  }
  release(owner) {
    this.expire();
    if (!this.current) return { released: true };
    if (this.current.owner !== owner) return { released: false, code: 'NOT_DESKTOP_OWNER', ...this.status() };
    if (this.inFlight) return { released: false, code: 'DESKTOP_OPERATION_RUNNING', ...this.status() };
    this.current = null;
    return { released: true };
  }
}
