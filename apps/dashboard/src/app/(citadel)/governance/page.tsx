"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFleetAuth } from "@/hooks/useFleetAuth";
import { FleetLogin } from "@/components/citadel/FleetLogin";
import { ThemeToggle } from "@/components/ThemeToggle";
import { FONT_MONO } from "@whiteroom/ui";

// ── Types ──────────────────────────────────────────────────────────

type RuleType = "spend_cap" | "loop_breaker" | "model_allowlist";
type RuleMode = "off" | "watch" | "enforce";

interface SpendCapParams { dailyCap: number; scope: "run" | "day"; unit: "tokens" | "dollars" }
interface LoopBreakerParams { threshold: number; scope: "run" | "day"; ignoreTools: string[] }
interface ModelAllowlistParams { allowedModels: string[] }

type AnyRuleParams = SpendCapParams | LoopBreakerParams | ModelAllowlistParams;

interface FleetRule {
  id: string;
  fleetId: string;
  ruleType: RuleType;
  params: AnyRuleParams;
  mode: RuleMode;
  version: number;
  changedBy: string;
  changedAt: string;
}

interface HistoryEntry {
  ruleType: RuleType;
  description: string;
  time: string;
  by: string;
}

// ── localStorage mock layer ────────────────────────────────────────

const STORAGE_KEY = "wr_citadel_rules";
const HISTORY_KEY = "wr_citadel_history";

function readStore(fleetId: string): FleetRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as FleetRule[]).filter((r) => r.fleetId === fleetId);
  } catch { return []; }
}

function writeStore(fleetId: string, rules: FleetRule[]) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all: FleetRule[] = raw ? JSON.parse(raw) : [];
    const other = all.filter((r) => r.fleetId !== fleetId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...other, ...rules]));
  } catch { /* */ }
}

function readHistory(fleetId: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as (HistoryEntry & { fleetId: string })[])
      .filter((h) => h.fleetId === fleetId);
  } catch { return []; }
}

function pushHistory(fleetId: string, ruleType: RuleType, description: string, by: string) {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const all = raw ? JSON.parse(raw) : [];
    all.unshift({ fleetId, ruleType, description, time: new Date().toISOString(), by });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all.slice(0, 100)));
  } catch { /* */ }
}

const DEFAULT_PARAMS: Record<RuleType, AnyRuleParams> = {
  spend_cap: { dailyCap: 50000, scope: "run", unit: "tokens" },
  loop_breaker: { threshold: 5, scope: "run", ignoreTools: [] },
  model_allowlist: { allowedModels: [] },
};

function mockSetRule(fleetId: string, ruleType: RuleType, mode: RuleMode, params?: AnyRuleParams): FleetRule {
  const existing = readStore(fleetId);
  const prev = existing.find((r) => r.ruleType === ruleType);
  const rule: FleetRule = {
    id: prev?.id ?? `rule_${fleetId}_${ruleType}`,
    fleetId,
    ruleType,
    params: params ?? prev?.params ?? DEFAULT_PARAMS[ruleType],
    mode,
    version: (prev?.version ?? 0) + 1,
    changedBy: "dashboard",
    changedAt: new Date().toISOString(),
  };
  const updated = prev ? existing.map((r) => (r.ruleType === ruleType ? rule : r)) : [...existing, rule];
  writeStore(fleetId, updated);
  return rule;
}

// ── Rule descriptions ──────────────────────────────────────────────

const RULE_SECTIONS: { key: RuleType; section: string }[] = [
  { key: "spend_cap", section: "SPEND" },
  { key: "loop_breaker", section: "BEHAVIOR" },
  { key: "model_allowlist", section: "MODELS" },
];

const RULE_LABELS: Record<RuleType, string> = {
  spend_cap: "Spend cap",
  loop_breaker: "Loop breaker",
  model_allowlist: "Model allowlist",
};

const AGENT_RESPONSE: Record<RuleType, string> = {
  spend_cap: `403 governance_block
reason: budget_exceeded
retryable: false
resets: next run`,
  loop_breaker: `403 governance_block
reason: loop_detected
retryable: false
resets: next run`,
  model_allowlist: `403 governance_block
reason: model_not_allowed
retryable: false
resets: never`,
};

const MODE_DESCRIPTION: Record<RuleType, Record<RuleMode, string>> = {
  spend_cap: { off: "Off. Not counting.", watch: "Would-block only. Counting.", enforce: "Stops before the next call" },
  loop_breaker: { off: "Off. Not counting.", watch: "Would-block only. Counting.", enforce: "Stops after the Nth call" },
  model_allowlist: { off: "Off. Not counting.", watch: "Would-block only. Counting.", enforce: "Stops before the call" },
};

// ── Three-way toggle ───────────────────────────────────────────────

function ModeToggle({ mode, onChange }: { mode: RuleMode; onChange: (m: RuleMode) => void }) {
  const modes: RuleMode[] = ["off", "watch", "enforce"];
  return (
    <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)" }}>
      {modes.map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          style={{
            padding: "4px 12px",
            fontSize: 11,
            fontWeight: 500,
            textTransform: "capitalize",
            cursor: "pointer",
            border: "none",
            transition: "background 0.15s, color 0.15s",
            ...(mode === m
              ? m === "enforce"
                ? { background: "#f59e0b", color: "#0f172a" }
                : m === "watch"
                ? { background: "#06b6d4", color: "#0f172a" }
                : { background: "#334155", color: "var(--tx)" }
              : { background: "transparent", color: "var(--tx3)" }),
          }}
        >
          {m === "off" ? "Off" : m === "watch" ? "Watch" : "Enforce"}
        </button>
      ))}
    </div>
  );
}

// ── Tag input ──────────────────────────────────────────────────────

function TagInput({ tags, onAdd, onRemove, placeholder }: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
      {tags.map((t) => (
        <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#164e63", color: "#67e8f9", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontFamily: FONT_MONO }}>
          {t}
          <button onClick={() => onRemove(t)} style={{ color: "#67e8f9", background: "none", border: "none", cursor: "pointer", padding: 0, marginLeft: 2, fontSize: 13 }}>&times;</button>
        </span>
      ))}
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, 64))}
          onKeyDown={(e) => {
            const trimmed = input.trim();
            if (e.key === "Enter" && trimmed) {
              onAdd(trimmed);
              setInput("");
              e.preventDefault();
            }
          }}
          placeholder={placeholder ?? "+ add"}
          style={{ background: "transparent", border: "none", outline: "none", fontSize: 11, color: "var(--tx3)", width: 64 }}
        />
      </span>
    </span>
  );
}

// ── Inline number input (debounced) ───────────────────────────────

function InlineNumber({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState(value.toLocaleString());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => { setDraft(value.toLocaleString()); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parseInt(e.target.value.replace(/,/g, ""), 10);
        if (!isNaN(n) && n > 0) {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => onChange(n), 300);
        }
      }}
      style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 8px", fontSize: 13, color: "#67e8f9", fontFamily: FONT_MONO, width: 80, textAlign: "center", display: "inline" }}
    />
  );
}

// ── Page ───────────────────────────────────────────────────────────

export default function GovernancePage() {
  const auth = useFleetAuth();

  if (auth.status !== "authenticated") {
    return <FleetLogin auth={auth} />;
  }

  if (!auth.fleetId) return null;

  return <GovernanceContent fleetId={auth.fleetId} />;
}

function GovernanceContent({ fleetId }: { fleetId: string }) {
  const [rules, setRules] = useState<FleetRule[]>([]);
  const [selected, setSelected] = useState<RuleType | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const fetchData = useCallback(() => {
    setRules(readStore(fleetId));
    setHistory(readHistory(fleetId));
  }, [fleetId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const changeMode = (ruleType: RuleType, mode: RuleMode) => {
    const prevRule = rules.find((r) => r.ruleType === ruleType);
    const prevMode = prevRule?.mode ?? "off";
    const rule = mockSetRule(fleetId, ruleType, mode);
    if (prevMode !== mode) {
      const label = RULE_LABELS[ruleType];
      if (prevRule) {
        pushHistory(fleetId, ruleType, `${capitalize(prevMode)} → ${capitalize(mode)}`, "dashboard");
      } else {
        pushHistory(fleetId, ruleType, `Created ${label} in ${capitalize(mode)}`, "dashboard");
      }
    }
    setRules((rs) => {
      const idx = rs.findIndex((r) => r.ruleType === ruleType);
      if (idx >= 0) return [...rs.slice(0, idx), rule, ...rs.slice(idx + 1)];
      return [...rs, rule];
    });
    setHistory(readHistory(fleetId));
    setSelected(ruleType);
  };

  const updateParams = (ruleType: RuleType, params: AnyRuleParams) => {
    const existing = rules.find((r) => r.ruleType === ruleType);
    const rule = mockSetRule(fleetId, ruleType, existing?.mode ?? "off", params);
    setRules((rs) => {
      const idx = rs.findIndex((r) => r.ruleType === ruleType);
      if (idx >= 0) return [...rs.slice(0, idx), rule, ...rs.slice(idx + 1)];
      return [...rs, rule];
    });
  };

  const ruleMap = new Map(rules.map((r) => [r.ruleType, r]));
  const selectedRule: FleetRule | null = selected
    ? ruleMap.get(selected) ?? {
        id: `rule_${fleetId}_${selected}`,
        fleetId,
        ruleType: selected,
        params: DEFAULT_PARAMS[selected],
        mode: "off" as RuleMode,
        version: 0,
        changedBy: "",
        changedAt: "",
      }
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, flex: 1 }}>
      {/* Header */}
      <div className="flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: "1px solid var(--line)", padding: "0 20px" }}>
        <span style={{ fontSize: 14, color: "var(--tx3)" }}>
          <b style={{ color: "var(--tx)", fontWeight: 600 }}>Governance</b> / {fleetId}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: "var(--info)", background: "var(--info-bg)", border: "1px solid var(--info)", borderRadius: 4, padding: "2px 8px" }}>BETA</span>
        <span style={{ marginLeft: "auto" }} />
        <ThemeToggle />
        <button onClick={() => { window.location.href = "/auth/sign-out"; }} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--tx2)", border: "1px solid var(--line2)", borderRadius: 6, padding: "6px 12px", background: "var(--card)", cursor: "pointer" }}>Sign out</button>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left column — rules */}
        <div style={{ flex: 1, overflowY: "auto", padding: 24, minWidth: 0 }}>
          {/* Suggested section */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" as const, color: "var(--tx3)", marginBottom: 12 }}>SUGGESTED · 2</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: 16, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <p style={{ fontSize: 13, color: "var(--tx)" }}>None of your fleet&apos;s input is cached, so agents pay full price for repeated context.</p>
                  <p style={{ fontSize: 11, color: "var(--tx3)", marginTop: 2 }}>Not a rule. Caching is turned on in your client.</p>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <button style={{ padding: "6px 12px", fontSize: 11, border: "1px solid var(--line)", borderRadius: 6, color: "var(--tx)", background: "transparent", cursor: "pointer" }}>How to turn on caching</button>
                </div>
              </div>
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: 16, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <p style={{ fontSize: 13, color: "var(--tx)" }}>Your fleet only used claude-haiku-4-5 in the last 30 days. An allowlist with that model would have stopped 0 calls.</p>
                  <p style={{ fontSize: 11, color: "var(--tx3)", marginTop: 2 }}>Turns on Model allowlist in Watch.</p>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <button
                    onClick={() => {
                      const existing = ruleMap.get("model_allowlist");
                      const prev = (existing?.params ?? DEFAULT_PARAMS.model_allowlist) as ModelAllowlistParams;
                      mockSetRule(fleetId, "model_allowlist", "watch", {
                        allowedModels: prev.allowedModels.includes("claude-haiku-4-5") ? prev.allowedModels : ["claude-haiku-4-5", ...prev.allowedModels],
                      } as ModelAllowlistParams);
                      pushHistory(fleetId, "model_allowlist", "Added Model allowlist in Watch (suggested)", "dashboard");
                      fetchData();
                      setSelected("model_allowlist");
                    }}
                    style={{ padding: "6px 12px", fontSize: 11, background: "#06b6d4", color: "#0f172a", fontWeight: 500, borderRadius: 6, border: "none", cursor: "pointer" }}
                  >
                    Add in Watch
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Rule sections */}
          {RULE_SECTIONS.map(({ key: rt, section }) => {
            const rule = ruleMap.get(rt);
            const mode = rule?.mode ?? "off";
            const isSelected = selected === rt;

            return (
              <div key={rt} style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" as const, color: "var(--tx3)", marginBottom: 12 }}>
                  {section} · 1
                </div>
                <div
                  onClick={() => setSelected(rt)}
                  style={{
                    background: "var(--card)",
                    border: `1px solid ${isSelected ? "#06b6d4" : "var(--line)"}`,
                    borderRadius: 8,
                    padding: 16,
                    cursor: "pointer",
                    transition: "border-color 0.15s",
                  }}
                >
                  {/* Natural language rule */}
                  <div style={{ fontSize: 13, color: "var(--tx)", marginBottom: 12 }}>
                    {rt === "spend_cap" && (() => {
                      const p = (rule?.params ?? DEFAULT_PARAMS.spend_cap) as SpendCapParams;
                      return (
                        <span>
                          Stop an agent that spends more than{" "}
                          {p.unit === "dollars" && <span style={{ color: "#67e8f9", fontFamily: FONT_MONO }}>$</span>}
                          <InlineNumber
                            value={p.dailyCap}
                            onChange={(n) => updateParams(rt, { ...p, dailyCap: n })}
                          />
                          {" "}
                          <select
                            value={p.unit}
                            onChange={(e) => {
                              const newUnit = e.target.value as "tokens" | "dollars";
                              const converted = newUnit === "dollars"
                                ? Math.round(p.dailyCap * 0.003 * 100) / 100
                                : Math.round(p.dailyCap / 0.003);
                              updateParams(rt, { ...p, unit: newUnit, dailyCap: converted || (newUnit === "dollars" ? 5 : 50000) });
                            }}
                            style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "#67e8f9", fontFamily: FONT_MONO }}
                          >
                            <option value="tokens">tokens</option>
                            <option value="dollars">dollars</option>
                          </select>
                          {" "}in a{" "}
                          <select
                            value={p.scope}
                            onChange={(e) => updateParams(rt, { ...p, scope: e.target.value as "run" | "day" })}
                            style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "#67e8f9", fontFamily: FONT_MONO }}
                          >
                            <option value="run">run</option>
                            <option value="day">day</option>
                          </select>
                        </span>
                      );
                    })()}
                    {rt === "loop_breaker" && (() => {
                      const p = (rule?.params ?? DEFAULT_PARAMS.loop_breaker) as LoopBreakerParams;
                      return (
                        <span>
                          Stop an agent that makes the same call{" "}
                          <InlineNumber
                            value={p.threshold}
                            onChange={(n) => updateParams(rt, { ...p, threshold: n })}
                          />
                          {" "}times in a{" "}
                          <select
                            value={p.scope}
                            onChange={(e) => updateParams(rt, { ...p, scope: e.target.value as "run" | "day" })}
                            style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "#67e8f9", fontFamily: FONT_MONO }}
                          >
                            <option value="run">run</option>
                            <option value="day">day</option>
                          </select>
                          . Ignore:{" "}
                          <TagInput
                            tags={p.ignoreTools}
                            onAdd={(t) => {
                              if (!p.ignoreTools.includes(t)) updateParams(rt, { ...p, ignoreTools: [...p.ignoreTools, t] });
                            }}
                            onRemove={(t) => updateParams(rt, { ...p, ignoreTools: p.ignoreTools.filter((x) => x !== t) })}
                          />
                        </span>
                      );
                    })()}
                    {rt === "model_allowlist" && (() => {
                      const p = (rule?.params ?? DEFAULT_PARAMS.model_allowlist) as ModelAllowlistParams;
                      return (
                        <span>
                          Only allow these models:{" "}
                          <TagInput
                            tags={p.allowedModels}
                            onAdd={(t) => {
                              if (!p.allowedModels.includes(t)) updateParams(rt, { ...p, allowedModels: [...p.allowedModels, t] });
                            }}
                            onRemove={(t) => updateParams(rt, { ...p, allowedModels: p.allowedModels.filter((x) => x !== t) })}
                            placeholder="+ add"
                          />
                        </span>
                      );
                    })()}
                  </div>

                  {/* Mode toggle + description */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <ModeToggle mode={mode} onChange={(m) => changeMode(rt, m)} />
                      <span style={{ fontSize: 11, color: "var(--tx3)" }}>{MODE_DESCRIPTION[rt][mode]}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right column — detail panel */}
        {selected && selectedRule && (
          <div style={{ width: 420, borderLeft: "1px solid var(--line)", overflowY: "auto", padding: 24, flexShrink: 0 }}>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{RULE_LABELS[selected]}</h2>
              <p style={{ fontSize: 12, color: "var(--tx3)", marginTop: 4 }}>
                {selectedRule.mode === "enforce" ? "Enforcing" : selectedRule.mode === "watch" ? "Watching" : "Off"}
                {" · "}
                {selectedRule.mode === "enforce"
                  ? "Stops agents when the rule fires."
                  : selectedRule.mode === "watch"
                  ? "Counting would-blocks without stopping agents."
                  : "Not active."}
              </p>
            </div>

            {selectedRule.mode !== "off" && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" as const, color: "var(--tx3)", marginBottom: 8 }}>WHAT THE AGENT GETS</div>
                <pre style={{ background: "#1e293b", borderRadius: 8, padding: 12, fontSize: 11, color: "#94a3b8", fontFamily: FONT_MONO, lineHeight: 1.6, overflowX: "auto", margin: 0 }}>
                  {AGENT_RESPONSE[selected]}
                </pre>
                <p style={{ fontSize: 11, color: "var(--tx3)", marginTop: 8 }}>
                  {selected === "spend_cap" && "Stops before the next call. Non-retryable, so SDKs should not retry."}
                  {selected === "loop_breaker" && "Stops after the repeated call. Non-retryable within the same run."}
                  {selected === "model_allowlist" && "Stops before the call. The agent must switch to an allowed model."}
                </p>
                {selected === "spend_cap" && (selectedRule.params as SpendCapParams).unit === "dollars" && (
                  <p style={{ fontSize: 10, color: "var(--tx3)", marginTop: 8 }}>
                    Dollar estimates use a blended rate of $0.003/1K tokens. Actual cost varies by model — see the Performance tab for per-model pricing.
                  </p>
                )}
              </div>
            )}

            {/* History */}
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" as const, color: "var(--tx3)", marginBottom: 8 }}>HISTORY · FROM THE AUDIT CHAIN</div>
              {(() => {
                const filtered = history.filter((h) => h.ruleType === selected);
                return filtered.length === 0 ? (
                  <p style={{ fontSize: 11, color: "var(--tx3)" }}>No history yet.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {filtered.slice(0, 10).map((h, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
                        <span style={{ color: "var(--tx)" }}>{h.description}</span>
                        <span style={{ color: "var(--tx3)", fontSize: 11, flexShrink: 0, marginLeft: 12 }}>
                          {formatTimeAgo(h.time)} · {h.by}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-between" style={{ padding: "6px 20px", borderTop: "1px solid var(--line)", background: "var(--sunk)", fontSize: 11.5, color: "var(--tx3)", flexShrink: 0 }}>
        <span>Traffic that bypasses the proxy, such as Claude Code signed in with OAuth, is not covered.</span>
        <span>WhiteRoom v1.1 Beta</span>
      </div>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
