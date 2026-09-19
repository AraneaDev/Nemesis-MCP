import { expect, it, vi } from 'vitest';
import { Channel, Feed } from '../src/Feed';

it('experiments with a stub that outlived the async signature', () => {
  const feed = new Feed();
  // `latest` is no longer async, so the caller now receives a promise.
  vi.spyOn(feed, 'latest').mockResolvedValue('item');
  // `Sms` was removed from the channel enum, and the name still parses.
  vi.spyOn(feed, 'channel').mockReturnValue(Channel.Sms);
  expect(feed).not.toBeNull();
});
