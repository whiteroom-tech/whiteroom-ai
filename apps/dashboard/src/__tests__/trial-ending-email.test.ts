import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn() }));

vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/email', () => ({ sendEmail: mocks.send }));

const { sendTrialEndingEmails } = await import('@/lib/trial-ending-email');
const { trialEndingEmail } = await import('@/lib/magic-link-email');

const NOW = Date.parse('2026-11-11T12:00:00Z');
const ENDS = '2026-11-15 09:30:00.123456+00';

function due(...ids: string[]) {
  return { rows: ids.map((id) => ({ id, email: `${id}@example.com`, trial_ends_at: ENDS })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_PRICE_STARTER_SHARE = 'price_starter_share';
  process.env.AUTH_URL = 'https://app.whiteroom.tech';
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.send.mockReset().mockResolvedValue(undefined);
});

describe('trial-ending reminders', () => {
  it('claims due accounts and emails each one the date its free period ends', async () => {
    mocks.query.mockResolvedValueOnce(due('u1', 'u2'));
    expect(await sendTrialEndingEmails(NOW)).toEqual({ sent: 2, failed: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    const mail = mocks.send.mock.calls[0][0];
    expect(mail.to).toBe('u1@example.com');
    expect(mail.subject).toBe('Your WhiteRoom free period ends on November 15, 2026');
    expect(mail.html).toContain('https://app.whiteroom.tech/settings');
  });

  it('selects only unpaid accounts in the window, once per free-period end, never Free or closing ones', async () => {
    await sendTrialEndingEmails(NOW);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('trial_ending_email_for IS DISTINCT FROM u2.trial_ends_at');
    expect(sql).toContain("trial_state IS DISTINCT FROM 'not_started'");
    expect(sql).toContain('closes_at IS NULL');
    expect(sql).toContain('plan_override IS NOT NULL');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(params[0]).toBe(NOW);
    expect(params[1]).toBe(7);
    expect(params[3]).toEqual(['active', 'trialing', 'past_due']);
  });

  it('releases the claim when a send fails, so the next run tries again', async () => {
    mocks.query.mockResolvedValueOnce(due('u1', 'u2'));
    mocks.send.mockRejectedValueOnce(new Error('resend down'));
    expect(await sendTrialEndingEmails(NOW)).toEqual({ sent: 1, failed: 1 });
    const release = mocks.query.mock.calls[1];
    expect(release[0]).toContain('SET trial_ending_email_for = NULL');
    expect(release[1]).toEqual(['u1', ENDS]);
  });

  it('sends nothing, and claims nothing, while no plan can be bought', async () => {
    delete process.env.STRIPE_PRICE_STARTER_SHARE;
    expect(await sendTrialEndingEmails(NOW)).toEqual({ sent: 0, failed: 0 });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns null when the database refuses', async () => {
    mocks.query.mockRejectedValueOnce(new Error('connection refused'));
    expect(await sendTrialEndingEmails(NOW)).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('trial-ending email', () => {
  it('says when it ends, what to do, and that choosing now costs nothing yet', () => {
    const { subject, text } = trialEndingEmail('November 15, 2026', 'https://app.whiteroom.tech/settings');
    expect(subject).toBe('Your WhiteRoom free period ends on November 15, 2026');
    expect(text).toContain('Choose a plan before then');
    expect(text).toContain("You won't be charged until your free period is over.");
    expect(text).toContain('https://app.whiteroom.tech/settings');
  });
});
