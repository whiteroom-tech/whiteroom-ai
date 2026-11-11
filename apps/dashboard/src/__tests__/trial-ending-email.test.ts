import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn() }));

vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/email', () => ({ sendEmail: mocks.send }));

const { sendTrialEndingEmails } = await import('@/lib/trial-ending-email');
const { billingStartsEmail, trialEndingEmail } = await import('@/lib/magic-link-email');

const NOW = Date.parse('2026-11-11T12:00:00Z');
const ENDS = '2026-11-15 09:30:00.123456+00';

function due(...ids: string[]) {
  return { rows: ids.map((id) => ({ id, email: `${id}@example.com`, trial_ends_at: ENDS, plan: null, status: null })) };
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

  it('sends a card-backed Pro subscription in its free days the billing notice, not a plan choice', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'p1', email: 'p1@example.com', trial_ends_at: ENDS, plan: 'pro', status: 'trialing' }] });
    expect(await sendTrialEndingEmails(NOW)).toEqual({ sent: 1, failed: 0 });
    const mail = mocks.send.mock.calls[0][0];
    expect(mail.subject).toBe('Your WhiteRoom Pro plan starts billing on November 15, 2026');
    expect(mail.text).toContain('billed to the card you added');
    expect(mail.text).not.toContain('Choose a plan');
  });

  it('selects both kinds in the window, once per free-period end, never comped, Free or closing ones', async () => {
    await sendTrialEndingEmails(NOW);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('trial_ending_email_for IS DISTINCT FROM u2.trial_ends_at');
    expect(sql).toContain("trial_state IS DISTINCT FROM 'not_started'");
    expect(sql).toContain('closes_at IS NULL');
    expect(sql).toContain('s.plan_override IS NULL');
    expect(sql).toContain("s.status = 'trialing' AND NOT s.cancel_at_period_end");
    expect(sql).toContain('FOR UPDATE OF u2 SKIP LOCKED');
    expect(params[0]).toBe(NOW);
    expect(params[1]).toBe(7);
    expect(params[3]).toEqual(['active', 'trialing', 'past_due']);
    expect(params[4]).toBe(true);
  });

  it('releases the claim when a send fails, so the next run tries again', async () => {
    mocks.query.mockResolvedValueOnce(due('u1', 'u2'));
    mocks.send.mockRejectedValueOnce(new Error('resend down'));
    expect(await sendTrialEndingEmails(NOW)).toEqual({ sent: 1, failed: 1 });
    const release = mocks.query.mock.calls[1];
    expect(release[0]).toContain('SET trial_ending_email_for = NULL');
    expect(release[1]).toEqual(['u1', ENDS]);
  });

  it('leaves out plan choices, but still sends billing notices, while no plan can be bought', async () => {
    delete process.env.STRIPE_PRICE_STARTER_SHARE;
    await sendTrialEndingEmails(NOW);
    expect(mocks.query.mock.calls[0][1][4]).toBe(false);
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

describe('billing-starts email', () => {
  it('says when billing starts and on which plan, with nothing to choose', () => {
    const { subject, text } = billingStartsEmail('Pro', 'November 15, 2026', 'https://app.whiteroom.tech/settings');
    expect(subject).toBe('Your WhiteRoom Pro plan starts billing on November 15, 2026');
    expect(text).toContain('From then, your Pro plan is billed to the card you added.');
    expect(text).toContain('https://app.whiteroom.tech/settings');
    expect(text).not.toContain('Choose a plan');
  });
});
