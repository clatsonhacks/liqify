/**
 * Ops alerter (#21). Posts to a webhook (ALERT_WEBHOOK_URL — Discord-compatible `content`
 * payload; no-op if unset). Throttled per alert type so a sustained condition doesn't spam.
 */
export class Alerter {
  constructor({ cfg, logger = () => {} }) {
    this.url = cfg.alertWebhookUrl || '';
    this.logger = logger;
    this.lastSentAt = new Map(); // type -> epoch ms
    this.throttleMs = 60_000;
  }

  /** Fire an alert (throttled). type = short key, payload = context object. */
  async notify(type, payload = {}) {
    const now = Date.now();
    if (now - (this.lastSentAt.get(type) || 0) < this.throttleMs) return;
    this.lastSentAt.set(type, now);
    this.logger('warn', 'alert', { type, ...payload });
    if (!this.url) return; // logging-only when no webhook configured
    const content = ` [liquifi] ${type} — ${JSON.stringify(payload).slice(0, 1500)}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, type, payload }),
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (e) {
      this.logger('warn', 'alert_send_failed', { type, error: String(e?.message || e) });
    }
  }
}
