// The Sandbox pieces that differ for Azure OpenAI, Foundry and Bedrock tests,
// kept out of TestRunFlow so each can be rendered and tested on its own.

import { ROUTES } from '@/lib/routes';
import {
  CLOUD_FIELDS, type CloudProvider, isCloudProvider, SANDBOX_PROVIDER_LABELS, type SandboxProvider,
} from '@/lib/sandbox/providers';
import s from './guided.module.css';

/** The choices on Start your test, in order, with what each one asks for. */
export const PROVIDER_CHOICES: { value: SandboxProvider; sub: string }[] = [
  { value: 'anthropic', sub: 'sk-ant-… key' },
  { value: 'openai', sub: 'sk-… key' },
  { value: 'azure-openai', sub: 'Your resource endpoint' },
  { value: 'foundry', sub: 'Your resource endpoint' },
  { value: 'bedrock-mantle', sub: 'Your AWS region' },
];

/** Native radios in a fieldset: arrow keys, focus and the group name come from the browser. */
export function ProviderChoices({ value, unsupported, disabled, followsKey, onPick }: {
  value: SandboxProvider;
  /** Choices the engine refused: shown, but disabled. */
  unsupported: readonly CloudProvider[];
  disabled?: boolean;
  /** An sk- key is pasted, so Anthropic vs OpenAI comes from it. */
  followsKey?: boolean;
  onPick: (p: SandboxProvider) => void;
}) {
  return (
    <fieldset className={s.choiceGroup}>
      <legend className={s.formLabel}>Where your agent’s model runs</legend>
      <div className={s.choices}>
        {PROVIDER_CHOICES.map(c => {
          const off = isCloudProvider(c.value) && unsupported.includes(c.value);
          return (
            <label key={c.value} className={`${s.choice} ${value === c.value ? s.choiceOn : ''} ${off ? s.choiceOff : ''}`}>
              <input type="radio" name="sandbox-provider" value={c.value} checked={value === c.value} disabled={off || disabled} onChange={() => onPick(c.value)} className={s.choiceInput} />
              <span className={s.choiceText}>
                <span className={s.choiceName}>{SANDBOX_PROVIDER_LABELS[c.value]}</span>
                <span className={s.choiceSub}>{off ? 'Not available yet' : c.sub}</span>
              </span>
            </label>
          );
        })}
      </div>
      {followsKey && <p className={s.small} style={{ marginTop: 6 }}>Provider follows your key.</p>}
    </fieldset>
  );
}

export function CloudEndpointField({ provider, value, error, onChange, onSubmit }: {
  provider: CloudProvider;
  value: string;
  error: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const f = CLOUD_FIELDS[provider];
  return (
    <div className={s.formGroup}>
      <label className={s.formLabel} htmlFor="sandbox-endpoint">{f.endpointLabel}</label>
      <input id="sandbox-endpoint" className={s.formInput} type="text" inputMode="url" autoComplete="off" spellCheck={false} value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && value.trim()) onSubmit(); }}
        placeholder={f.endpointPlaceholder} aria-invalid={error ? true : undefined} aria-describedby="sandbox-endpoint-hint" />
      <p id="sandbox-endpoint-hint" className={s.small} style={{ marginTop: 6 }} aria-live="polite">
        {error ? <span style={{ color: 'var(--bad)' }}>{error}</span> : <>{f.endpointHelp} {f.keyNote}</>}
      </p>
    </div>
  );
}

/** Shown when this tab has no proxy key for the test, so the recipe has a placeholder. */
export function ProxyKeyNotice({ disabled, onRecover }: { disabled?: boolean; onRecover: () => void }) {
  return (
    <div className={s.notice} style={{ marginTop: 10 }}>
      This tab doesn’t have this test’s proxy URL, so the code shows a placeholder.{' '}
      <button className={`${s.btn} ${s.btnSecondary}`} onClick={onRecover} disabled={disabled} style={{ marginLeft: 8, minHeight: 28, padding: '4px 12px', fontSize: 12 }}>Get a new proxy URL</button>
      <span className={s.small} style={{ display: 'block', marginTop: 6 }}>Your agent’s current URL stops working as soon as you do.</span>
    </div>
  );
}

/** The cloud lines of "Nothing happening?". */
export function CloudTroubleshooting({ provider, endpointHost }: { provider: CloudProvider; endpointHost?: string | null }) {
  const host = endpointHost ? <> (<code>{endpointHost}</code>)</> : null;
  return <>
    <li>Use the address exactly as shown above. It includes this test’s proxy key.</li>
    <li>Every call needs the <code>x-whiteroom-agent</code> header from the code above.</li>
    {provider === 'azure-openai'
      ? <li>With the OpenAI client, the address ends in <code>/openai/v1</code>. With the AzureOpenAI client, use the address without it.</li>
      : provider === 'foundry'
        ? <li>Your agent’s key must be for the Foundry resource this test started with{host}.</li>
        : <li>Your agent needs a Bedrock API key with access to Claude in the region this test started with{host}.</li>}
  </>;
}

/** "Ready to go live" for a cloud test. */
export function CloudGoLive({ provider }: { provider: CloudProvider }) {
  if (provider === 'foundry') {
    return <p>Claude on Foundry can’t be added on Fleet key yet. Download your report and contact us to go live.</p>;
  }
  return <p>To run this agent on your live fleet, add your {SANDBOX_PROVIDER_LABELS[provider]} endpoint on <a href={ROUTES.fleetKey}>Fleet key</a> and use the proxy URL it gives you in place of this test’s.</p>;
}
