import { describe, expect, it } from 'vitest';
import { earlyWarningPriorityFlag, priorityToSmppFlag, smsPriorityFlag } from '../src/modules/09-priority/priority.js';

describe('module 09 — priority flagging', () => {
  it('maps early-warning to the highest SMPP priority (3)', () => {
    expect(priorityToSmppFlag('early-warning')).toBe(3);
    expect(earlyWarningPriorityFlag()).toBe(3);
  });

  it('maps the internal taxonomy onto 0..3', () => {
    expect(priorityToSmppFlag('low')).toBe(0);
    expect(priorityToSmppFlag('normal')).toBe(1);
    expect(priorityToSmppFlag('high')).toBe(2);
    expect(priorityToSmppFlag('critical')).toBe(3);
  });

  it('smsPriorityFlag returns 3 for early warnings', () => {
    expect(smsPriorityFlag(true)).toBe(3);
  });

  it('throws on an unknown priority', () => {
    expect(() => priorityToSmppFlag('urgent' as never)).toThrow(RangeError);
  });
});
