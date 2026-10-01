import { describe, expect, it } from 'vitest';
import { generateMetadata } from '@/app/(citadel)/runs/[runId]/layout';

const title = async (runId: string) => (await generateMetadata({ params: Promise.resolve({ runId }) })).title;

describe('Run detail tab title', () => {
  it('names the agent and run, like the page header', async () => {
    expect(await title('lead-agent~7')).toEqual({ absolute: 'lead-agent · run 7 · WhiteRoom' });
    expect(await title('lead%20agent~3')).toEqual({ absolute: 'lead agent · run 3 · WhiteRoom' });
  });

  it('falls back to "Run" for an id it can’t parse', async () => {
    expect(await title('nonsense')).toEqual({ absolute: 'Run · WhiteRoom' });
    expect(await title('%E0%A4%A')).toEqual({ absolute: 'Run · WhiteRoom' });
  });
});
