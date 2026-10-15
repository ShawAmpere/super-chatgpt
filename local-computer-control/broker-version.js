// Change the version whenever the detached Broker implementation changes.
export const BROKER_VERSION = '0.1.0';
export const BROKER_PROTOCOL = 1;
export const supportsBroker = health => health?.protocol === BROKER_PROTOCOL ||
  (health?.protocol == null && /^0\.[12]\.\d+$/.test(health?.version || ''));
export const newerBroker = version => {
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!parts) return false;
  const expected = BROKER_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = Number(parts[i + 1]) - expected[i];
    if (difference) return difference > 0;
  }
  return false;
};
