'use client';

import { useState } from 'react';
import { SegmentedControl } from '@whiteroom/ui';
import { CopyChip } from '@/components/citadel/CopyChip';
import { AGENT_HEADER_LINE, AGENT_NAME_LINES, AGENT_NAME_TITLE, AGENT_NAME_WHY } from '@/lib/setup';

type Lang = 'python' | 'typescript';

const LANGS: { value: Lang; label: string }[] = [
  { value: 'python', label: 'Python' },
  { value: 'typescript', label: 'TypeScript' },
];

const SDK_LABEL = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;

/**
 * How to name an agent that has no system prompt, collapsed by default since
 * most agents are named automatically. `provider` narrows the examples to one
 * SDK (Azure uses the OpenAI one); without it, both are shown.
 */
export function AgentNaming({ provider }: { provider?: 'anthropic' | 'openai' }) {
  const [lang, setLang] = useState<Lang>('python');
  const sdks = provider ? [provider] : (['anthropic', 'openai'] as const);
  return (
    <details style={{ fontSize: 12.5, color: 'var(--tx2)' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{AGENT_NAME_TITLE}</summary>
      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        <span>{AGENT_NAME_WHY}</span>
        <CopyChip text={AGENT_HEADER_LINE} label="Copy the agent name header" />
        <SegmentedControl<Lang> label="Language" value={lang} onChange={setLang} options={LANGS} size={24} />
        {sdks.map((sdk) => (
          <CopyChip key={sdk} text={AGENT_NAME_LINES[lang][sdk]} label={`Copy the ${SDK_LABEL[sdk]} agent name line`} />
        ))}
        {provider !== 'openai' && (
          <>
            <span>Claude Code</span>
            <CopyChip text={AGENT_NAME_LINES.claudeCode} label="Copy the Claude Code agent name line" />
          </>
        )}
      </div>
    </details>
  );
}
