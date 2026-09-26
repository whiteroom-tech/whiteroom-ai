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

type RuleScope = "all" | string[];

interface FleetRule {
  id: string;
  fleetId: string;
  ruleType: RuleType;
  params: AnyRuleParams;
  mode: RuleMode;
  appliesTo: RuleScope;
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
    return (JSON.parse(raw) as FleetRule[]).filter((r) => r.fleetId === fleetId).map((r) => ({ ...r, appliesTo: r.appliesTo ?? "all" }));
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

let ruleCounter = Date.now();

function mockCreateRule(fleetId: string, ruleType: RuleType): FleetRule {
  const rule: FleetRule = {
    id: `rule_${fleetId}_${ruleType}_${++ruleCounter}`,
    fleetId,
    ruleType,
    params: structuredClone(DEFAULT_PARAMS[ruleType]),
    mode: "off",
    appliesTo: "all",
    version: 1,
    changedBy: "dashboard",
    changedAt: new Date().toISOString(),
  };
  const existing = readStore(fleetId);
  writeStore(fleetId, [...existing, rule]);
  return rule;
}

function mockUpdateRule(fleetId: string, ruleId: string, updates: Partial<Pick<FleetRule, "mode" | "params" | "appliesTo">>): FleetRule {
  const existing = readStore(fleetId);
  const prev = existing.find((r) => r.id === ruleId);
  if (!prev) throw new Error(`Rule ${ruleId} not found`);
  const rule: FleetRule = {
    ...prev,
    mode: updates.mode ?? prev.mode,
    params: updates.params ?? prev.params,
    appliesTo: updates.appliesTo ?? prev.appliesTo,
    version: prev.version + 1,
    changedBy: "dashboard",
    changedAt: new Date().toISOString(),
  };
  writeStore(fleetId, existing.map((r) => (r.id === ruleId ? rule : r)));
  return rule;
}

function mockDeleteRule(fleetId: string, ruleId: string) {
  const existing = readStore(fleetId);
  writeStore(fleetId, existing.filter((r) => r.id !== ruleId));
}

// ── Mock fleet agents ─────────────────────────────────────────────

const AGENTS_KEY = "wr_citadel_agents";

function readAgents(fleetId: string): string[] {
  try {
    const raw = localStorage.getItem(AGENTS_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as Record<string, string[]>;
    return data[fleetId] ?? [];
  } catch { return []; }
}

function seedAgentsIfEmpty(fleetId: string) {
  const existing = readAgents(fleetId);
  if (existing.length > 0) return;
  try {
    const raw = localStorage.getItem(AGENTS_KEY);
    const data = raw ? JSON.parse(raw) : {};
    data[fleetId] = ["research-agent", "coding-agent", "qa-agent"];
    localStorage.setItem(AGENTS_KEY, JSON.stringify(data));
  } catch { /* */ }
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

// ── Model picker ──────────────────────────────────────────────────

const MODEL_GROUPS: { provider: string; models: { id: string; label: string }[] }[] = [
  {
    provider: "Anthropic",
    models: [
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
      { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
    ],
  },
  {
    provider: "OpenAI",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
      { id: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
      { id: "o3", label: "o3" },
      { id: "o4-mini", label: "o4-mini" },
    ],
  },
  {
    provider: "Google",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    ],
  },
  {
    provider: "AWS Bedrock",
    models: [
      { id: "anthropic.claude-sonnet-4-20250514-v1:0", label: "Claude Sonnet 4" },
      { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", label: "Claude 3.5 Sonnet v2" },
      { id: "anthropic.claude-haiku-4-5-20251001-v1:0", label: "Claude Haiku 4.5" },
      { id: "amazon.nova-pro-v1:0", label: "Nova Pro" },
      { id: "amazon.nova-lite-v1:0", label: "Nova Lite" },
    ],
  },
  {
    provider: "Azure OpenAI",
    models: [
      { id: "azure/gpt-4o", label: "GPT-4o (via Azure)" },
      { id: "azure/gpt-4o-mini", label: "GPT-4o Mini (via Azure)" },
      { id: "azure/gpt-4.1", label: "GPT-4.1 (via Azure)" },
    ],
  },
];

const ALL_KNOWN_MODELS = MODEL_GROUPS.flatMap((g) => g.models);

function ModelPicker({ tags, onAdd, onRemove }: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const tagSet = new Set(tags);

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
      {tags.map((t) => {
        const known = ALL_KNOWN_MODELS.find((m) => m.id === t);
        return (
          <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#164e63", color: "#67e8f9", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontFamily: FONT_MONO }}>
            {known ? known.label : t}
            <button onClick={() => onRemove(t)} style={{ color: "#67e8f9", background: "none", border: "none", cursor: "pointer", padding: 0, marginLeft: 2, fontSize: 13 }}>&times;</button>
          </span>
        );
      })}
      {showCustom ? (
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          <input
            autoFocus
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value.slice(0, 64))}
            onKeyDown={(e) => {
              const trimmed = customInput.trim();
              if (e.key === "Enter" && trimmed) {
                if (!tagSet.has(trimmed)) onAdd(trimmed);
                setCustomInput("");
                setShowCustom(false);
                e.preventDefault();
              }
              if (e.key === "Escape") { setShowCustom(false); setCustomInput(""); }
            }}
            onBlur={() => { setShowCustom(false); setCustomInput(""); }}
            placeholder="deployment name or model ID"
            style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 8px", fontSize: 11, color: "#67e8f9", fontFamily: FONT_MONO, width: 200, outline: "none" }}
          />
        </span>
      ) : (
        <select
          value=""
          onChange={(e) => {
            const val = e.target.value;
            if (val === "__custom__") {
              setShowCustom(true);
            } else if (val && !tagSet.has(val)) {
              onAdd(val);
            }
          }}
          style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "var(--tx3)", fontFamily: FONT_MONO, cursor: "pointer" }}
        >
          <option value="">+ add model</option>
          {MODEL_GROUPS.map((g) => {
            const available = g.models.filter((m) => !tagSet.has(m.id));
            if (available.length === 0) return null;
            return (
              <optgroup key={g.provider} label={g.provider}>
                {available.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </optgroup>
            );
          })}
          <option value="__custom__">Other (type deployment name or model ID)...</option>
        </select>
      )}
    </span>
  );
}

// ── Tool picker ───────────────────────────────────────────────────

const TOOL_GROUPS: { category: string; tools: string[] }[] = [
  {
    category: "File & code",
    tools: ["read_file", "write_file", "list_directory", "search_files", "edit_file"],
  },
  {
    category: "Web & API",
    tools: ["http_request", "fetch_url", "web_search", "api_call"],
  },
  {
    category: "Execution",
    tools: ["run_command", "execute_code", "shell", "bash"],
  },
  {
    category: "Memory & state",
    tools: ["get_memory", "set_memory", "read_context", "save_state"],
  },
];

const ALL_KNOWN_TOOLS = TOOL_GROUPS.flatMap((g) => g.tools);

function ToolPicker({ tags, onAdd, onRemove }: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const tagSet = new Set(tags);

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
      {tags.map((t) => (
        <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#164e63", color: "#67e8f9", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontFamily: FONT_MONO }}>
          {t}
          <button onClick={() => onRemove(t)} style={{ color: "#67e8f9", background: "none", border: "none", cursor: "pointer", padding: 0, marginLeft: 2, fontSize: 13 }}>&times;</button>
        </span>
      ))}
      {showCustom ? (
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          <input
            autoFocus
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value.slice(0, 64))}
            onKeyDown={(e) => {
              const trimmed = customInput.trim();
              if (e.key === "Enter" && trimmed) {
                if (!tagSet.has(trimmed)) onAdd(trimmed);
                setCustomInput("");
                setShowCustom(false);
                e.preventDefault();
              }
              if (e.key === "Escape") { setShowCustom(false); setCustomInput(""); }
            }}
            onBlur={() => { setShowCustom(false); setCustomInput(""); }}
            placeholder="tool name"
            style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 8px", fontSize: 11, color: "#67e8f9", fontFamily: FONT_MONO, width: 140, outline: "none" }}
          />
        </span>
      ) : (
        <select
          value=""
          onChange={(e) => {
            const val = e.target.value;
            if (val === "__custom__") {
              setShowCustom(true);
            } else if (val && !tagSet.has(val)) {
              onAdd(val);
            }
          }}
          style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "var(--tx3)", fontFamily: FONT_MONO, cursor: "pointer" }}
        >
          <option value="">+ add tool</option>
          {TOOL_GROUPS.map((g) => {
            const available = g.tools.filter((t) => !tagSet.has(t));
            if (available.length === 0) return null;
            return (
              <optgroup key={g.category} label={g.category}>
                {available.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </optgroup>
            );
          })}
          <option value="__custom__">Other (type tool name)...</option>
        </select>
      )}
    </span>
  );
}

// ── Scope picker ──────────────────────────────────────────────────

function ScopePicker({ scope = "all", agents = [], onChange }: {
  scope: RuleScope;
  agents: string[];
  onChange: (s: RuleScope) => void;
}) {
  const isAll = scope === "all" || !Array.isArray(scope);
  const selected = isAll ? [] : scope;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--tx3)", marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
      <span style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, fontSize: 10 }}>Applies to</span>
      <select
        value={isAll ? "__all__" : "__specific__"}
        onChange={(e) => {
          if (e.target.value === "__all__") onChange("all");
          else onChange([]);
        }}
        style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "#67e8f9", fontFamily: FONT_MONO, cursor: "pointer" }}
      >
        <option value="__all__">All agents</option>
        <option value="__specific__">Specific agents</option>
      </select>
      {!isAll && (
        <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
          {selected.map((a) => (
            <span key={a} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#1e3a5f", color: "#93c5fd", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontFamily: FONT_MONO }}>
              {a}
              <button onClick={() => onChange(selected.filter((x) => x !== a))} style={{ color: "#93c5fd", background: "none", border: "none", cursor: "pointer", padding: 0, marginLeft: 2, fontSize: 13 }}>&times;</button>
            </span>
          ))}
          <select
            value=""
            onChange={(e) => {
              if (e.target.value && !selected.includes(e.target.value)) {
                onChange([...selected, e.target.value]);
              }
            }}
            style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "var(--tx3)", fontFamily: FONT_MONO, cursor: "pointer" }}
          >
            <option value="">+ add agent</option>
            {agents.filter((a) => !selected.includes(a)).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </span>
      )}
    </div>
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [agents, setAgents] = useState<string[]>([]);

  const fetchData = useCallback(() => {
    seedAgentsIfEmpty(fleetId);
    setRules(readStore(fleetId));
    setHistory(readHistory(fleetId));
    setAgents(readAgents(fleetId));
  }, [fleetId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const rulesBy = (rt: RuleType) => rules.filter((r) => r.ruleType === rt);

  const addRule = (ruleType: RuleType) => {
    const rule = mockCreateRule(fleetId, ruleType);
    pushHistory(fleetId, ruleType, `Added new ${RULE_LABELS[ruleType]} rule`, "dashboard");
    setRules(readStore(fleetId));
    setHistory(readHistory(fleetId));
    setSelectedId(rule.id);
  };

  const removeRule = (ruleId: string, ruleType: RuleType) => {
    mockDeleteRule(fleetId, ruleId);
    pushHistory(fleetId, ruleType, `Removed ${RULE_LABELS[ruleType]} rule`, "dashboard");
    setRules(readStore(fleetId));
    setHistory(readHistory(fleetId));
    if (selectedId === ruleId) setSelectedId(null);
  };

  const changeMode = (ruleId: string, ruleType: RuleType, mode: RuleMode) => {
    const prevRule = rules.find((r) => r.id === ruleId);
    const prevMode = prevRule?.mode ?? "off";
    const rule = mockUpdateRule(fleetId, ruleId, { mode });
    if (prevMode !== mode) {
      pushHistory(fleetId, ruleType, `${capitalize(prevMode)} → ${capitalize(mode)}`, "dashboard");
    }
    setRules((rs) => rs.map((r) => (r.id === ruleId ? rule : r)));
    setHistory(readHistory(fleetId));
    setSelectedId(ruleId);
  };

  const updateParams = (ruleId: string, params: AnyRuleParams) => {
    const rule = mockUpdateRule(fleetId, ruleId, { params });
    setRules((rs) => rs.map((r) => (r.id === ruleId ? rule : r)));
  };

  const updateScope = (ruleId: string, ruleType: RuleType, appliesTo: RuleScope) => {
    const rule = mockUpdateRule(fleetId, ruleId, { appliesTo });
    const label = appliesTo === "all" ? "All agents" : (appliesTo as string[]).join(", ") || "none";
    pushHistory(fleetId, ruleType, `Scope → ${label}`, "dashboard");
    setRules((rs) => rs.map((r) => (r.id === ruleId ? rule : r)));
    setHistory(readHistory(fleetId));
  };

  const selectedRule = selectedId ? rules.find((r) => r.id === selectedId) ?? null : null;

  // Render the natural-language params for a rule
  const renderParams = (rule: FleetRule) => {
    const rt = rule.ruleType;
    if (rt === "spend_cap") {
      const p = rule.params as SpendCapParams;
      return (
        <span>
          Stop an agent that spends more than{" "}
          {p.unit === "dollars" && <span style={{ color: "#67e8f9", fontFamily: FONT_MONO }}>$</span>}
          <InlineNumber value={p.dailyCap} onChange={(n) => updateParams(rule.id, { ...p, dailyCap: n })} />
          {" "}
          <select value={p.unit} onChange={(e) => {
            const newUnit = e.target.value as "tokens" | "dollars";
            const converted = newUnit === "dollars" ? Math.round(p.dailyCap * 0.003 * 100) / 100 : Math.round(p.dailyCap / 0.003);
            updateParams(rule.id, { ...p, unit: newUnit, dailyCap: converted || (newUnit === "dollars" ? 5 : 50000) });
          }} style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "#67e8f9", fontFamily: FONT_MONO }}>
            <option value="tokens">tokens</option>
            <option value="dollars">dollars</option>
          </select>
          {" "}in a{" "}
          <select value={p.scope} onChange={(e) => updateParams(rule.id, { ...p, scope: e.target.value as "run" | "day" })} style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "#67e8f9", fontFamily: FONT_MONO }}>
            <option value="run">run</option>
            <option value="day">day</option>
          </select>
        </span>
      );
    }
    if (rt === "loop_breaker") {
      const p = rule.params as LoopBreakerParams;
      return (
        <span>
          Stop an agent that makes the same call{" "}
          <InlineNumber value={p.threshold} onChange={(n) => updateParams(rule.id, { ...p, threshold: n })} />
          {" "}times in a{" "}
          <select value={p.scope} onChange={(e) => updateParams(rule.id, { ...p, scope: e.target.value as "run" | "day" })} style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "#67e8f9", fontFamily: FONT_MONO }}>
            <option value="run">run</option>
            <option value="day">day</option>
          </select>
          . Ignore:{" "}
          <ToolPicker
            tags={p.ignoreTools}
            onAdd={(t) => { if (!p.ignoreTools.includes(t)) updateParams(rule.id, { ...p, ignoreTools: [...p.ignoreTools, t] }); }}
            onRemove={(t) => updateParams(rule.id, { ...p, ignoreTools: p.ignoreTools.filter((x) => x !== t) })}
          />
        </span>
      );
    }
    const p = rule.params as ModelAllowlistParams;
    return (
      <span>
        Only allow these models:{" "}
        <ModelPicker
          tags={p.allowedModels}
          onAdd={(t) => { if (!p.allowedModels.includes(t)) updateParams(rule.id, { ...p, allowedModels: [...p.allowedModels, t] }); }}
          onRemove={(t) => updateParams(rule.id, { ...p, allowedModels: p.allowedModels.filter((x) => x !== t) })}
        />
      </span>
    );
  };

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
                      const existing = rulesBy("model_allowlist");
                      if (existing.length === 0) {
                        const rule = mockCreateRule(fleetId, "model_allowlist");
                        mockUpdateRule(fleetId, rule.id, { mode: "watch", params: { allowedModels: ["claude-haiku-4-5"] } as ModelAllowlistParams });
                      } else {
                        const first = existing[0];
                        const prev = first.params as ModelAllowlistParams;
                        mockUpdateRule(fleetId, first.id, {
                          mode: "watch",
                          params: { allowedModels: prev.allowedModels.includes("claude-haiku-4-5") ? prev.allowedModels : ["claude-haiku-4-5", ...prev.allowedModels] } as ModelAllowlistParams,
                        });
                      }
                      pushHistory(fleetId, "model_allowlist", "Added Model allowlist in Watch (suggested)", "dashboard");
                      fetchData();
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
            const sectionRules = rulesBy(rt);
            return (
              <div key={rt} style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" as const, color: "var(--tx3)" }}>
                    {section} · {sectionRules.length || 0}
                  </span>
                  <button
                    onClick={() => addRule(rt)}
                    style={{ fontSize: 10, fontWeight: 600, color: "#06b6d4", background: "transparent", border: "1px solid #06b6d4", borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}
                  >
                    + Add rule
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {sectionRules.map((rule) => (
                    <div
                      key={rule.id}
                      onClick={() => setSelectedId(rule.id)}
                      style={{
                        background: "var(--card)",
                        border: `1px solid ${selectedId === rule.id ? "#06b6d4" : "var(--line)"}`,
                        borderRadius: 8,
                        padding: 16,
                        cursor: "pointer",
                        transition: "border-color 0.15s",
                      }}
                    >
                      <div style={{ fontSize: 13, color: "var(--tx)", marginBottom: 12 }}>
                        {renderParams(rule)}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <ModeToggle mode={rule.mode} onChange={(m) => changeMode(rule.id, rt, m)} />
                          <span style={{ fontSize: 11, color: "var(--tx3)" }}>{MODE_DESCRIPTION[rt][rule.mode]}</span>
                        </div>
                        {sectionRules.length > 1 && (
                          <button
                            onClick={(e) => { e.stopPropagation(); removeRule(rule.id, rt); }}
                            style={{ fontSize: 11, color: "var(--tx3)", background: "transparent", border: "none", cursor: "pointer", padding: "2px 6px" }}
                            title="Remove this rule"
                          >
                            &times;
                          </button>
                        )}
                      </div>
                      <ScopePicker
                        scope={rule.appliesTo}
                        agents={agents}
                        onChange={(s) => updateScope(rule.id, rt, s)}
                      />
                    </div>
                  ))}
                  {sectionRules.length === 0 && (
                    <div style={{ background: "var(--card)", border: "1px dashed var(--line)", borderRadius: 8, padding: 16, textAlign: "center", color: "var(--tx3)", fontSize: 12 }}>
                      No rules configured. Click &quot;+ Add rule&quot; to create one.
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Right column — detail panel */}
        {selectedRule && (
          <div style={{ width: 420, borderLeft: "1px solid var(--line)", overflowY: "auto", padding: 24, flexShrink: 0 }}>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{RULE_LABELS[selectedRule.ruleType]}</h2>
              <p style={{ fontSize: 12, color: "var(--tx3)", marginTop: 4 }}>
                {selectedRule.mode === "enforce" ? "Enforcing" : selectedRule.mode === "watch" ? "Watching" : "Off"}
                {" · "}
                {selectedRule.mode === "enforce"
                  ? "Stops agents when the rule fires."
                  : selectedRule.mode === "watch"
                  ? "Counting would-blocks without stopping agents."
                  : "Not active."}
              </p>
              <p style={{ fontSize: 11, color: "var(--tx3)", marginTop: 4 }}>
                {selectedRule.appliesTo === "all"
                  ? "Applies to all agents in this fleet."
                  : (selectedRule.appliesTo as string[]).length === 0
                  ? "No agents selected."
                  : `Applies to: ${(selectedRule.appliesTo as string[]).join(", ")}`}
              </p>
            </div>

            {selectedRule.mode !== "off" && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" as const, color: "var(--tx3)", marginBottom: 8 }}>WHAT THE AGENT GETS</div>
                <pre style={{ background: "#1e293b", borderRadius: 8, padding: 12, fontSize: 11, color: "#94a3b8", fontFamily: FONT_MONO, lineHeight: 1.6, overflowX: "auto", margin: 0 }}>
                  {AGENT_RESPONSE[selectedRule.ruleType]}
                </pre>
                <p style={{ fontSize: 11, color: "var(--tx3)", marginTop: 8 }}>
                  {selectedRule.ruleType === "spend_cap" && "Stops before the next call. Non-retryable, so SDKs should not retry."}
                  {selectedRule.ruleType === "loop_breaker" && "Stops after the repeated call. Non-retryable within the same run."}
                  {selectedRule.ruleType === "model_allowlist" && "Stops before the call. The agent must switch to an allowed model."}
                </p>
                {selectedRule.ruleType === "spend_cap" && (selectedRule.params as SpendCapParams).unit === "dollars" && (
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
                const filtered = history.filter((h) => h.ruleType === selectedRule.ruleType);
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
