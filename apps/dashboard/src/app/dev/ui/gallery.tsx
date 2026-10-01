'use client';

import { useState } from 'react';
import {
  Banner, Button, DataTable, Hint, Panel, SegmentedControl, SelectChip, StatusPill, Tag, Toggle, type AgentState,
} from '@whiteroom/ui';

type Run = { id: string; agent: string; started: string; spend: string };
const RUNS: Run[] = [
  { id: '9', agent: 'scout-agent', started: 'Sep 30, 1:58 pm', spend: '$0.12' },
  { id: '14', agent: 'lead-agent', started: 'Sep 30, 1:52 pm', spend: '$1.92' },
  { id: '21', agent: 'writer-agent', started: 'Sep 30, 1:40 pm', spend: '$0.09' },
];
const STATES: AgentState[] = ['working', 'resting', 'idle', 'paused', 'stopped', 'pausing', 'stopping', 'resuming'];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0,1fr)', gap: 16, alignItems: 'center' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tx2)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>{children}</div>
    </div>
  );
}

function Board() {
  const [range, setRange] = useState<'24h' | '3d' | '7d'>('24h');
  const [mode, setMode] = useState<'off' | 'watch' | 'enforce'>('watch');
  const [agent, setAgent] = useState('all');
  const [on, setOn] = useState(true);
  const [picked, setPicked] = useState('14');

  return (
    <div style={{ padding: 24, display: 'grid', gap: 16 }}>
      <Panel title={<>Buttons<Hint text="Primary, secondary, ghost, danger and danger-fill, at 28 / 32 / 36 / 44." /></>} count="5 variants">
        <div style={{ display: 'grid', gap: 12 }}>
          {([28, 32, 36, 44] as const).map((size) => (
            <Row key={size} label={`${size}px`}>
              <Button variant="primary" size={size}>Mark as seen</Button>
              <Button size={size}>Open agent</Button>
              <Button variant="ghost" size={size}>Cancel</Button>
              <Button variant="danger" size={size}>Stop…</Button>
              <Button variant="danger-fill" size={size}>Stop agent</Button>
            </Row>
          ))}
          <Row label="disabled / busy">
            <Button variant="primary" disabled>Resume</Button>
            <Button disabled>Pause</Button>
            <Button variant="primary" busy busyLabel="Saving…">Save</Button>
          </Row>
        </div>
      </Panel>

      <Panel title="Controls">
        <div style={{ display: 'grid', gap: 12 }}>
          <Row label="range"><SegmentedControl label="Time range" value={range} onChange={setRange} options={[{ value: '24h', label: '24h' }, { value: '3d', label: '3d' }, { value: '7d', label: '7d' }]} /></Row>
          <Row label="mode"><SegmentedControl label="Rule mode" value={mode} onChange={setMode} options={[{ value: 'off', label: 'Off' }, { value: 'watch', label: 'Watch only' }, { value: 'enforce', label: 'Enforce', dot: mode === 'enforce' ? 'warn' : undefined }]} /></Row>
          <Row label="disabled seg"><SegmentedControl label="Rule mode, member" value="watch" onChange={() => {}} options={[{ value: 'off', label: 'Off' }, { value: 'watch', label: 'Watch only' }, { value: 'enforce', label: 'Enforce', disabled: true, title: 'Only owners and admins can turn on Enforce.' }]} /></Row>
          <Row label="select"><SelectChip label="Agent" value={agent} onChange={setAgent} options={[{ value: 'all', label: 'All agents' }, { value: 'lead-agent', label: 'lead-agent' }]} /></Row>
          <Row label="toggle"><Toggle label="Email alerts" checked={on} onChange={setOn} /><Toggle label="Email alerts, off" checked={false} onChange={() => {}} /><Toggle label="Not verified yet" checked={false} onChange={() => {}} disabled /></Row>
        </div>
      </Panel>

      <Panel title="Status and tags">
        <div style={{ display: 'grid', gap: 12 }}>
          <Row label="status">{STATES.map((s) => <StatusPill key={s} state={s} />)}</Row>
          <Row label="tags"><Tag tone="ho">Handover</Tag><Tag tone="warn">Paused</Tag><Tag tone="brand">Alert</Tag><Tag>Action taken</Tag></Row>
        </div>
      </Panel>

      <Banner variant="warn" actions={<Button size={28}>Open rule</Button>}>
        <b>What stood out:</b> &lsquo;No writes outside /data&rsquo; blocked write_file. 40 s later the agent called shell_exec aimed at the same file.
      </Banner>
      <Banner variant="info">WhiteRoom paused scout-agent at 2:14 pm · &lsquo;Spend cap&rsquo;. Resume starts a new run.</Banner>
      <Banner variant="error" actions={<><Button size={28}>Try again</Button><Button variant="ghost" size={28}>Dismiss</Button></>}>
        Couldn&rsquo;t stop lead-agent. It&rsquo;s still working and nothing changed.
      </Banner>

      <Panel title="Runs" count="3 in the last 7 days" bodyPadding={0}>
        <DataTable<Run>
          caption="Runs"
          rows={RUNS}
          rowKey={(r) => r.id}
          selectedKey={picked}
          onOpen={(r) => setPicked(r.id)}
          rowHeight={44}
          columns={[
            { key: 'run', header: 'Run', width: '56px', numeric: true, render: (r) => `#${r.id}` },
            { key: 'agent', header: 'Agent', width: 'minmax(140px,1fr)', render: (r) => <span style={{ fontFamily: 'var(--font-mono)' }}>{r.agent}</span> },
            { key: 'started', header: 'Started', width: '150px', numeric: true, render: (r) => r.started },
            { key: 'spend', header: 'Spend', width: '72px', align: 'right', numeric: true, render: (r) => r.spend },
          ]}
          footer={<span>1–3 of 3</span>}
        />
      </Panel>
    </div>
  );
}

export function Gallery() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: '100vh' }}>
      {(['dark', 'light'] as const).map((t) => (
        <div key={t} className="wr-shell" data-theme={t} style={{ background: 'var(--bg)', color: 'var(--tx)', minHeight: '100vh' }}>
          <Board />
        </div>
      ))}
    </div>
  );
}
