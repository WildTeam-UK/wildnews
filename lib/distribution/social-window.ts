export const SOCIAL_POST_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SOCIAL_POST_WINDOW_MESSAGE = 'Unsent: the two-hour social posting window has closed.';

export class SocialPostingWindowExpired extends Error {
  constructor() { super(SOCIAL_POST_WINDOW_MESSAGE); }
}

export function socialPostingWindowExpired(periodEnd: string, now = Date.now()) {
  const scheduledAt = Date.parse(periodEnd);
  return !Number.isFinite(scheduledAt) || now >= scheduledAt + SOCIAL_POST_WINDOW_MS;
}

export function assertSocialPostingWindow(periodEnd: string) {
  if (socialPostingWindowExpired(periodEnd)) throw new SocialPostingWindowExpired();
}
