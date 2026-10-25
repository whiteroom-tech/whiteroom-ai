import { describe, expect, it } from 'vitest';
import { inferredNameNote } from '@/lib/home';

describe('Home note for agents named from their prompt', () => {
  it('says nothing when every agent sent its own name', () => {
    expect(inferredNameNote([{}, { nameInferred: false }])).toBeNull();
  });

  it('counts agents named from their instructions and says how to fix it', () => {
    expect(inferredNameNote([{ nameInferred: true }, {}])).toBe(
      '1 agent has no name set, so WhiteRoom named it from its instructions. Agents with the same instructions count as one. Give each agent its own name with the x-whiteroom-agent header.',
    );
    expect(inferredNameNote([{ nameInferred: true }, { nameInferred: true }])).toMatch(/^2 agents have no name set, so WhiteRoom named them from their instructions\./);
  });
});
