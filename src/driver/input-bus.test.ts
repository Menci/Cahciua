import { describe, expect, it, vi } from 'vitest';

import { createDriverInputBus } from './input-bus';
import type { RenderedContext } from '../rendering/types';

const context = (receivedAtMs: number): RenderedContext => [{
  receivedAtMs,
  content: [{ type: 'text', text: String(receivedAtMs) }],
}];

describe('createDriverInputBus', () => {
  it('holds the latest context per chat until activation', () => {
    const bus = createDriverInputBus();
    const target = {
      handleEvent: vi.fn(),
      handleTyping: vi.fn(),
    };
    bus.attach(target);

    bus.handleEvent('a', context(1));
    bus.handleEvent('a', context(2));
    bus.handleEvent('b', context(3));
    bus.handleTyping('a');
    expect(target.handleEvent).not.toHaveBeenCalled();
    expect(target.handleTyping).not.toHaveBeenCalled();

    bus.activate();
    expect(target.handleEvent.mock.calls).toEqual([
      ['a', context(2)],
      ['b', context(3)],
    ]);
    bus.handleTyping('a');
    expect(target.handleTyping).toHaveBeenCalledWith('a');
  });

  it('rejects input before attachment and duplicate lifecycle transitions', () => {
    const bus = createDriverInputBus();
    const target = { handleEvent: vi.fn(), handleTyping: vi.fn() };
    expect(() => bus.handleEvent('a', context(1))).toThrow('before Driver activation');
    bus.attach(target);
    expect(() => bus.attach(target)).toThrow('cannot be attached');
    bus.activate();
    expect(() => bus.activate()).toThrow('already active');
    bus.deactivate();
    expect(() => bus.handleTyping('a')).not.toThrow();
    expect(() => bus.handleEvent('a', context(2))).not.toThrow();
  });
});
