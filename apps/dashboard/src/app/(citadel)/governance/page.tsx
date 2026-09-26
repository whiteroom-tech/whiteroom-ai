"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFleetAuth } from "@/hooks/useFleetAuth";
import {
  governanceCreateRule,
  governanceDeleteRule,
  governanceList,
  governanceUpdateRule,
  isAuthError,
  performanceFleetHourly,
  performanceIndex,
} from "@/lib/whiteroom/client";
import type {
  GovernanceHistoryEntry,
  GovernanceMode,
  GovernanceParams,
  GovernanceRule,
  GovernanceRuleType,
  GovernanceScope,
  LoopBreakerParams,
  ModelAllowlistParams,
  SpendCapParams,
} from "@/lib/whiteroom/types";
import { computeSuggestions, RULE_LABELS, type GovernanceSuggestions } from "@/lib/governance";
import { FleetLogin } from "@/components/citadel/FleetLogin";
import { ThemeToggle } from "@/components/ThemeToggle";
import { FONT_MONO } from "@whiteroom/ui";

// ── Types ──────────────────────────────────────────────────────────

type RuleType = GovernanceRuleType;
type RuleMode = GovernanceMode;
type AnyRuleParams = GovernanceParams;
type RuleScope = GovernanceScope;
type FleetRule = GovernanceRule;
type HistoryEntry = GovernanceHistoryEntry;

type Suggestions = GovernanceSuggestions;

// The engine caps performance queries at 336h (hours_back check in security.ts).
const SUGGESTION_HOURS = 14 * 24;

// ── Rule descriptions ──────────────────────────────────────────────

const RULE_SECTIONS: { key: RuleType; section: string }[] = [
  { key: "spend_cap", section: "SPEND" },
  { key: "loop_breaker", section: "BEHAVIOR" },
  { key: "model_allowlist", section: "MODELS" },
];

const REASON: Record<RuleType, string> = {
  spend_cap: "budget_exceeded",
  loop_breaker: "loop_detected",
  model_allowlist: "model_not_allowed",
};

/** The 403 the engine returns for this rule (see the engine's blockResponseBody). */
function agentResponse(rule: FleetRule): string {
  const resets = rule.ruleType === "model_allowlist"
    ? "never"
    : (rule.params as SpendCapParams | LoopBreakerParams).scope === "day" ? "next day (00:00 UTC)" : "next run";
  return `403 governance_block
reason: ${REASON[rule.ruleType]}
retryable: false
resets: ${resets}`;
}

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

  return <GovernanceContent fleetId={auth.fleetId} authKey={auth.authKey} onAuthError={auth.resetSession} />;
}

function GovernanceContent({ fleetId, authKey, onAuthError }: {
  fleetId: string;
  authKey: string | undefined;
  onAuthError: (msg?: string) => void;
}) {
  const [rules, setRules] = useState<FleetRule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions>({ noCaching: false, onlyModels: null });

  const handleError = useCallback((e: unknown, what: string) => {
    if (isAuthError(e)) { onAuthError(); return; }
    setError(`Couldn't ${what}. Your last change may not have been saved — refreshed from the server.`);
  }, [onAuthError]);

  const fetchData = useCallback(async () => {
    try {
      const d = await governanceList(fleetId, authKey);
      setRules(d.rules);
      setHistory(d.history);
      setAgents(d.agents);
      setLoaded(true);
    } catch (e) {
      if (isAuthError(e)) { onAuthError(); return; }
      setError("Couldn't load governance rules. Retrying on the next change.");
      setLoaded(true);
    }
  }, [fleetId, authKey, onAuthError]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  // Suggested rules come from real traffic. The performance store is optional
  // (503 without a database), so any failure just means no suggestions.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      performanceIndex(fleetId, SUGGESTION_HOURS, authKey),
      performanceFleetHourly(fleetId, SUGGESTION_HOURS, authKey),
    ])
      .then(([index, hourly]) => { if (!cancelled) setSuggestions(computeSuggestions(index, hourly)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fleetId, authKey]);

  /** Apply a server-returned rule, ignoring a response older than what we hold. */
  const applyRule = (rule: FleetRule) => {
    setRules((rs) => rs.map((r) => (r.id === rule.id && rule.version >= r.version ? rule : r)));
  };

  const refreshHistory = () => {
    governanceList(fleetId, authKey).then((d) => { setHistory(d.history); setAgents(d.agents); }).catch(() => {});
  };

  const rulesBy = (rt: RuleType) => rules.filter((r) => r.ruleType === rt);

  const addRule = async (ruleType: RuleType) => {
    setError(null);
    try {
      const { rule } = await governanceCreateRule(fleetId, { ruleType }, authKey);
      setRules((rs) => [...rs, rule]);
      setSelectedId(rule.id);
      refreshHistory();
    } catch (e) { handleError(e, "add the rule"); void fetchData(); }
  };

  const removeRule = async (ruleId: string) => {
    setError(null);
    setRules((rs) => rs.filter((r) => r.id !== ruleId));
    if (selectedId === ruleId) setSelectedId(null);
    try {
      await governanceDeleteRule(fleetId, ruleId, authKey);
      refreshHistory();
    } catch (e) { handleError(e, "remove the rule"); void fetchData(); }
  };

  const update = async (ruleId: string, updates: { mode?: RuleMode; params?: AnyRuleParams; appliesTo?: RuleScope }, what: string, logsHistory: boolean) => {
    setError(null);
    // Optimistic: the controls reflect the change immediately.
    setRules((rs) => rs.map((r) => (r.id === ruleId ? { ...r, ...updates } : r)));
    try {
      const { rule } = await governanceUpdateRule(fleetId, ruleId, updates, authKey);
      applyRule(rule);
      if (logsHistory) refreshHistory();
    } catch (e) { handleError(e, what); void fetchData(); }
  };

  const changeMode = (ruleId: string, _ruleType: RuleType, mode: RuleMode) => {
    setSelectedId(ruleId);
    if (rules.find((r) => r.id === ruleId)?.mode === mode) return;
    void update(ruleId, { mode }, "change the mode", true);
  };

  // Controls send only the field they changed; it is merged onto the latest
  // params here, at save time. Merging onto the params captured at render
  // let a debounced number edit land after a select change and revert it.
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const updateParams = (ruleId: string, patch: Partial<SpendCapParams & LoopBreakerParams & ModelAllowlistParams>) => {
    const latest = rulesRef.current.find((r) => r.id === ruleId);
    if (!latest) return;
    const params = { ...latest.params, ...patch } as AnyRuleParams;
    rulesRef.current = rulesRef.current.map((r) => (r.id === ruleId ? { ...r, params } : r));
    void update(ruleId, { params }, "save the rule settings", true);
  };

  const updateScope = (ruleId: string, _ruleType: RuleType, appliesTo: RuleScope) => {
    void update(ruleId, { appliesTo }, "change who the rule applies to", true);
  };

  const addSuggestedAllowlist = async (models: string[]) => {
    setError(null);
    const description = "Added Model allowlist in Watch (suggested)";
    try {
      const existing = rulesBy("model_allowlist");
      if (existing.length === 0) {
        await governanceCreateRule(fleetId, { ruleType: "model_allowlist", mode: "watch", params: { allowedModels: models }, description }, authKey);
      } else {
        const first = existing[0];
        const prev = (first.params as ModelAllowlistParams).allowedModels;
        await governanceUpdateRule(fleetId, first.id, {
          mode: "watch",
          params: { allowedModels: [...models.filter((m) => !prev.includes(m)), ...prev] },
          description,
        }, authKey);
      }
    } catch (e) { handleError(e, "add the suggested allowlist"); }
    void fetchData();
  };

  const allowlistSuggestion = suggestions.onlyModels && !rulesBy("model_allowlist").some((r) =>
    r.mode !== "off" && suggestions.onlyModels!.every((m) => (r.params as ModelAllowlistParams).allowedModels.includes(m)))
    ? suggestions.onlyModels
    : null;
  const suggestionCount = (suggestions.noCaching ? 1 : 0) + (allowlistSuggestion ? 1 : 0);

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
          <InlineNumber value={p.dailyCap} onChange={(n) => updateParams(rule.id, { dailyCap: n })} />
          {" "}
          <select value={p.unit} onChange={(e) => {
            const newUnit = e.target.value as "tokens" | "dollars";
            const converted = newUnit === "dollars" ? Math.round(p.dailyCap * 0.003 * 100) / 100 : Math.round(p.dailyCap / 0.003);
            updateParams(rule.id, { unit: newUnit, dailyCap: converted || (newUnit === "dollars" ? 5 : 50000) });
          }} style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "#67e8f9", fontFamily: FONT_MONO }}>
            <option value="tokens">tokens</option>
            <option value="dollars">dollars</option>
          </select>
          {" "}in a{" "}
          <select value={p.scope} onChange={(e) => updateParams(rule.id, { scope: e.target.value as "run" | "day" })} style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "#67e8f9", fontFamily: FONT_MONO }}>
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
          <InlineNumber value={p.threshold} onChange={(n) => updateParams(rule.id, { threshold: n })} />
          {" "}times in a{" "}
          <select value={p.scope} onChange={(e) => updateParams(rule.id, { scope: e.target.value as "run" | "day" })} style={{ background: "#1e293b", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "#67e8f9", fontFamily: FONT_MONO }}>
            <option value="run">run</option>
            <option value="day">day</option>
          </select>
          . Ignore:{" "}
          <ToolPicker
            tags={p.ignoreTools}
            onAdd={(t) => { if (!p.ignoreTools.includes(t)) updateParams(rule.id, { ignoreTools: [...p.ignoreTools, t] }); }}
            onRemove={(t) => updateParams(rule.id, { ignoreTools: p.ignoreTools.filter((x) => x !== t) })}
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
          onAdd={(t) => { if (!p.allowedModels.includes(t)) updateParams(rule.id, { allowedModels: [...p.allowedModels, t] }); }}
          onRemove={(t) => updateParams(rule.id, { allowedModels: p.allowedModels.filter((x) => x !== t) })}
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
          {error && (
            <div role="alert" style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--bad)", background: "var(--bad-bg)", color: "var(--tx)", fontSize: 12.5, display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span>{error}</span>
              <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "var(--tx3)", cursor: "pointer", fontSize: 14 }} aria-label="Dismiss">&times;</button>
            </div>
          )}

          {/* Suggested section — computed from the last 14 days of traffic */}
          {suggestionCount > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" as const, color: "var(--tx3)", marginBottom: 12 }}>SUGGESTED · {suggestionCount}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {suggestions.noCaching && (
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: 16, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <p style={{ fontSize: 13, color: "var(--tx)" }}>None of your fleet&apos;s input is cached, so agents pay full price for repeated context.</p>
                  <p style={{ fontSize: 11, color: "var(--tx3)", marginTop: 2 }}>Not a rule. Caching is turned on in your client.</p>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <a href="https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching" target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", padding: "6px 12px", fontSize: 11, border: "1px solid var(--line)", borderRadius: 6, color: "var(--tx)", background: "transparent", cursor: "pointer", textDecoration: "none" }}>How to turn on caching</a>
                </div>
              </div>
              )}
              {allowlistSuggestion && (
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: 16, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <p style={{ fontSize: 13, color: "var(--tx)" }}>
                    Your fleet only used {allowlistSuggestion.join(", ")} in the last 14 days. An allowlist with {allowlistSuggestion.length === 1 ? "that model" : "those models"} would have stopped 0 calls.
                  </p>
                  <p style={{ fontSize: 11, color: "var(--tx3)", marginTop: 2 }}>Turns on Model allowlist in Watch.</p>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <button
                    onClick={() => { void addSuggestedAllowlist(allowlistSuggestion); }}
                    style={{ padding: "6px 12px", fontSize: 11, background: "#06b6d4", color: "#0f172a", fontWeight: 500, borderRadius: 6, border: "none", cursor: "pointer" }}
                  >
                    Add in Watch
                  </button>
                </div>
              </div>
              )}
            </div>
          </div>
          )}

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
                    onClick={() => { void addRule(rt); }}
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
                            onClick={(e) => { e.stopPropagation(); void removeRule(rule.id); }}
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
                      {loaded ? <>No rules configured. Click &quot;+ Add rule&quot; to create one.</> : "Loading…"}
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
                  {agentResponse(selectedRule)}
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
