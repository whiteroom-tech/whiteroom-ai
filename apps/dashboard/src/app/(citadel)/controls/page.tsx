"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { SuggestionDraft } from "./_components/SuggestionDraft";
import { useFleetAuth } from "@/hooks/useFleetAuth";
import {
  governanceCreateRule,
  governanceDeleteRule,
  governanceList,
  governanceUpdateRule,
  ruleWouldAct,
  isAuthError,
  controlFailure,
  performanceFleetHourly,
  performanceIndex,
} from "@/lib/whiteroom/client";
import type {
  RuleWouldActResult,
  GovernanceHistoryEntry,
  GovernanceMode,
  GovernanceParams,
  GovernanceRule,
  GovernanceResponse,
  GovernanceRuleType,
  GovernanceScope,
  LoopBreakerParams,
  ModelAllowlistParams,
  SpendCapParams,
  ToolListParams,
  CallRateParams,
} from "@/lib/whiteroom/types";
import { computeSuggestions, convertSpendCap, RESPONSE_EFFECT, RESPONSE_LABEL, responseOptions, RULE_LABELS, type GovernanceSuggestions } from "@/lib/governance";
import { FleetLogin } from "@/components/citadel/FleetLogin";
import { PageHeader } from "@/components/citadel/PageChrome";
import { FONT_MONO, SelectChip } from "@whiteroom/ui";
import { timeAgo } from "@/lib/format";
import { fetchControlActors, historyWho, oldestTime, type ControlActor } from "@/lib/control-actors";
import { stopCheck, stopPhrase, watchSummary } from "@/lib/controls-guard";
import { ConfirmDialog } from "@/components/citadel/ConfirmDialog";
import { ROUTES } from "@/lib/routes";

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
  { key: "call_rate", section: "RATE" },
  { key: "model_allowlist", section: "MODELS" },
  { key: "tool_list", section: "TOOLS" },
];

const REASON: Record<RuleType, string> = {
  spend_cap: "budget_exceeded",
  loop_breaker: "loop_detected",
  model_allowlist: "model_not_allowed",
  tool_list: "tool_not_allowed",
  call_rate: "rate_exceeded",
};

/** What the agent gets for this rule (see the engine's blockResponseBody): nothing for Just tell me. */
function agentResponse(rule: FleetRule): string {
  const response = rule.response ?? "block";
  if (response === "notify") return "Nothing: the call goes through.\nYou get told; the agent doesn't.";
  const resets = response !== "block" ? "when someone resumes it" : rule.ruleType === "call_rate" ? "next minute"
    : rule.ruleType === "model_allowlist" || rule.ruleType === "tool_list"
    ? "never"
    : (rule.params as SpendCapParams | LoopBreakerParams).scope === "day" ? "next day (00:00 UTC)" : "next run";
  return `403 governance_block
response: ${response}
reason: ${REASON[rule.ruleType]}
retryable: false
resets: ${resets}`;
}

const MODE_DESCRIPTION: Record<RuleType, Record<RuleMode, string>> = {
  spend_cap: { off: "Off. Not counting.", watch: "Watch only. Counting, never acting.", enforce: "Acts before the next call" },
  loop_breaker: { off: "Off. Not counting.", watch: "Watch only. Counting, never acting.", enforce: "Acts on the Nth call" },
  model_allowlist: { off: "Off. Not counting.", watch: "Watch only. Counting, never acting.", enforce: "Acts before the call" },
  tool_list: { off: "Off. Not counting.", watch: "Watch only. Counting, never acting.", enforce: "Acts before the agent gets the tool call" },
  call_rate: { off: "Off. Not counting.", watch: "Watch only. Counting, never acting.", enforce: "Acts on the call over the limit" },
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
                ? { background: "var(--warn)", color: "var(--on-brand)" }
                : m === "watch"
                ? { background: "var(--brand)", color: "var(--on-brand)" }
                : { background: "var(--line2)", color: "var(--tx)" }
              : { background: "transparent", color: "var(--tx3)" }),
          }}
        >
          {m === "off" ? "Off" : m === "watch" ? "Watch" : "Enforce"}
        </button>
      ))}
    </div>
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

// One picker for both lists: chips for what's chosen, a grouped select to
// add more, and "Other…" for a value that isn't listed.
type PickGroup = { label: string; options: { id: string; label: string }[] };

function GroupPicker({ tags, onAdd, onRemove, groups, addLabel, addAria, otherLabel, placeholder, inputAria, inputWidth }: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  groups: PickGroup[];
  addLabel: string;
  addAria: string;
  otherLabel: string;
  placeholder: string;
  inputAria: string;
  inputWidth: number;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const tagSet = new Set(tags);
  const labelOf = (id: string) => groups.flatMap((g) => g.options).find((o) => o.id === id)?.label ?? id;

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
      {tags.map((t) => (
        <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--brand-dim)", color: "var(--brand)", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontFamily: FONT_MONO }}>
          {labelOf(t)}
          <button onClick={() => onRemove(t)} aria-label={`Remove ${t}`} style={{ color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 14, width: 24, height: 24, margin: "-4px -6px -4px 0", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>&times;</button>
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
            placeholder={placeholder}
            aria-label={inputAria}
            style={{ background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 8px", fontSize: 11, color: "var(--brand)", fontFamily: FONT_MONO, width: inputWidth, outline: "none" }}
          />
        </span>
      ) : (
        <select
          aria-label={addAria}
          value=""
          onChange={(e) => {
            const val = e.target.value;
            if (val === "__custom__") {
              setShowCustom(true);
            } else if (val && !tagSet.has(val)) {
              onAdd(val);
            }
          }}
          style={{ background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "var(--tx3)", fontFamily: FONT_MONO, cursor: "pointer" }}
        >
          <option value="">{addLabel}</option>
          {groups.map((g) => {
            const available = g.options.filter((o) => !tagSet.has(o.id));
            if (available.length === 0) return null;
            return (
              <optgroup key={g.label} label={g.label}>
                {available.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </optgroup>
            );
          })}
          <option value="__custom__">{otherLabel}</option>
        </select>
      )}
    </span>
  );
}

const MODEL_PICK_GROUPS: PickGroup[] = MODEL_GROUPS.map((g) => ({ label: g.provider, options: g.models }));

function ModelPicker(props: { tags: string[]; onAdd: (tag: string) => void; onRemove: (tag: string) => void }) {
  return (
    <GroupPicker {...props} groups={MODEL_PICK_GROUPS} addLabel="+ add model" addAria="Add a model"
      otherLabel="Other (type deployment name or model ID)..." placeholder="deployment name or model ID"
      inputAria="Custom model or deployment name" inputWidth={200} />
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

const TOOL_PICK_GROUPS: PickGroup[] = TOOL_GROUPS.map((g) => ({ label: g.category, options: g.tools.map((t) => ({ id: t, label: t })) }));

function ToolPicker({ purpose = "ignore", ...props }: { tags: string[]; onAdd: (tag: string) => void; onRemove: (tag: string) => void; purpose?: "ignore" | "block" }) {
  return (
    <GroupPicker {...props} groups={TOOL_PICK_GROUPS} addLabel="+ add tool" addAria={`Add a tool to ${purpose}`}
      otherLabel="Other (type tool name)..." placeholder="tool name" inputAria={`Tool name to ${purpose}`} inputWidth={140} />
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
        aria-label="Which agents this rule applies to"
        value={isAll ? "__all__" : "__specific__"}
        onChange={(e) => {
          if (e.target.value === "__all__") onChange("all");
          else onChange([]);
        }}
        style={{ background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "var(--brand)", fontFamily: FONT_MONO, cursor: "pointer" }}
      >
        <option value="__all__">All agents</option>
        <option value="__specific__">Specific agents</option>
      </select>
      {!isAll && (
        <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
          {selected.map((a) => (
            <span key={a} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--brand-dim)", color: "var(--brand)", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontFamily: FONT_MONO }}>
              {a}
              <button onClick={() => onChange(selected.filter((x) => x !== a))} aria-label={`Remove ${a}`} style={{ color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 14, width: 24, height: 24, margin: "-4px -6px -4px 0", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>&times;</button>
            </span>
          ))}
          <select
            aria-label="Add an agent"
            value=""
            onChange={(e) => {
              if (e.target.value && !selected.includes(e.target.value)) {
                onChange([...selected, e.target.value]);
              }
            }}
            style={{ background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "var(--tx3)", fontFamily: FONT_MONO, cursor: "pointer" }}
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

function InlineNumber({ value, onChange, allowDecimals = false, ariaLabel }: { value: number; onChange: (n: number) => void; allowDecimals?: boolean; ariaLabel: string }) {
  const [draft, setDraft] = useState(value.toLocaleString());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => { setDraft(value.toLocaleString()); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <input
      type="text"
      inputMode={allowDecimals ? "decimal" : "numeric"}
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const raw = e.target.value.replace(/,/g, "");
        const n = allowDecimals ? Number(raw) : parseInt(raw, 10);
        if (!isNaN(n) && n > 0) {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => onChange(n), 300);
        }
      }}
      style={{ background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 8px", fontSize: 13, color: "var(--brand)", fontFamily: FONT_MONO, width: 80, textAlign: "center", display: "inline" }}
    />
  );
}

// ── Page ───────────────────────────────────────────────────────────

export default function ControlsPage() {
  const auth = useFleetAuth();

  if (auth.status !== "authenticated") {
    return <FleetLogin auth={auth} />;
  }

  if (!auth.fleetId) return null;

  // useSearchParams (the ?rec= Diagnosis suggestion) needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <ControlsContent fleetId={auth.fleetId} authKey={auth.authKey} onAuthError={auth.resetSession} />
    </Suspense>
  );
}

function ControlsContent({ fleetId, authKey, onAuthError }: {
  fleetId: string;
  authKey: string | undefined;
  onAuthError: (msg?: string) => void;
}) {
  const [rules, setRules] = useState<FleetRule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [actors, setActors] = useState<ControlActor[]>([]);
  // Only the newest lookup may set names: an older one finishing last would undo it.
  const actorsReq = useRef(0);
  const loadActors = useCallback((h: HistoryEntry[]) => {
    const id = ++actorsReq.current;
    return fetchControlActors(fleetId, oldestTime(h)).then((a) => { if (id === actorsReq.current) setActors(a); });
  }, [fleetId]);
  const [agents, setAgents] = useState<string[]>([]);
  const [govV1, setGovV1] = useState(false);
  // A rule about to get "Stop the agent": confirmed first (README › Screen 6b).
  const [confirmStopRule, setConfirmStopRule] = useState<string | null>(null);
  // Which change the Stop confirmation is for: picking Stop, or setting a Stop rule to Enforce.
  const [confirmStopVia, setConfirmStopVia] = useState<"response" | "mode">("response");
  // null until loaded, or when loading failed: then no Watch line, rather than a false "hasn't fired".
  /** rule_would_act per Watch rule, keyed `${id}@${version}`; missing while loading or after a failed read. */
  const [wouldActs, setWouldActs] = useState<Record<string, RuleWouldActResult>>({});
  const wouldReq = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions>({ noCaching: false, onlyModels: null });
  // A Diagnosis suggestion opened from Performance: /controls?rec=<id>.
  const searchParams = useSearchParams();
  const router = useRouter();
  const suggestionRec = searchParams.get("rec");
  const [notice, setNotice] = useState<string | null>(null);
  // Selecting a rule closes an open suggestion draft, so the panel shows it.
  const selectRule = useCallback((id: string | null) => {
    if (suggestionRec) router.replace(ROUTES.controls);
    setNotice(null);
    setSelectedId(id);
  }, [suggestionRec, router]);

  /** Every change starts clean: the last error and notice are about something else. */
  const startChange = () => { setError(null); setNotice(null); };

  const handleError = useCallback((e: unknown, what: string) => {
    const failure = controlFailure(e);
    if (failure === 'sign-out') { onAuthError(); return; }
    if (failure === 'refused') { setError((e as Error).message); return; }
    setError(`Couldn't ${what}. Your last change may not have been saved — refreshed from the server.`);
  }, [onAuthError]);

  /** Reloads the rules; resolves false if that failed. */
  const fetchData = useCallback(async (): Promise<boolean> => {
    try {
      const d = await governanceList(fleetId, authKey);
      // Engine totals over the whole stored trail, one read per Watch rule. A
      // failed read leaves that rule without a line rather than "hasn't fired".
      const watching = d.rules.filter((r) => r.mode === "watch");
      // Only the newest reload may set them: an older one finishing last would undo it.
      const req = ++wouldReq.current;
      void Promise.all(watching.map((r) => ruleWouldAct(fleetId, r.id, r.version, authKey).then((c) => [`${r.id}@${r.version}`, c] as const, () => null)))
        .then((pairs) => { if (req === wouldReq.current) setWouldActs(Object.fromEntries(pairs.filter((p) => p !== null))); });
      setRules(d.rules);
      setHistory(d.history);
      void loadActors(d.history);
      setAgents(d.agents);
      setGovV1(!!d.govV1);
      setLoaded(true);
      return true;
    } catch (e) {
      if (isAuthError(e)) { onAuthError(); return false; }
      setError("Couldn't load governance rules. Retrying on the next change.");
      setLoaded(true);
      return false;
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
    governanceList(fleetId, authKey).then((d) => {
      setHistory(d.history);
      setAgents(d.agents);
      return loadActors(d.history);
    }).catch(() => {});
  };

  const rulesBy = (rt: RuleType) => rules.filter((r) => r.ruleType === rt);

  const addRule = async (ruleType: RuleType) => {
    startChange();
    try {
      const { rule } = await governanceCreateRule(fleetId, { ruleType }, authKey);
      setRules((rs) => [...rs, rule]);
      selectRule(rule.id);
      refreshHistory();
    } catch (e) { handleError(e, "add the rule"); void fetchData(); }
  };

  const removeRule = async (ruleId: string) => {
    startChange();
    setRules((rs) => rs.filter((r) => r.id !== ruleId));
    // Through selectRule, like every other panel change, so an open draft closes too.
    if (selectedId === ruleId) selectRule(null);
    try {
      await governanceDeleteRule(fleetId, ruleId, authKey);
      refreshHistory();
    } catch (e) { handleError(e, "remove the rule"); void fetchData(); }
  };

  const update = async (ruleId: string, updates: { mode?: RuleMode; response?: GovernanceResponse; params?: AnyRuleParams; appliesTo?: RuleScope }, what: string, logsHistory: boolean) => {
    startChange();
    // Optimistic: the controls reflect the change immediately.
    setRules((rs) => rs.map((r) => (r.id === ruleId ? { ...r, ...updates } : r)));
    try {
      const { rule } = await governanceUpdateRule(fleetId, ruleId, updates, authKey);
      applyRule(rule);
      if (logsHistory) refreshHistory();
    } catch (e) { handleError(e, what); void fetchData(); }
  };

  // A rule that would stop agents for real (Stop + Enforce) must have run in
  // Watch for a day, and is confirmed by typing who it covers.
  /** True when the change may go ahead now; otherwise shows why not, or asks to confirm. */
  const stopGate = (rule: FleetRule | undefined, change: { mode?: RuleMode; response?: GovernanceResponse }, via: "response" | "mode", confirmed: boolean): boolean => {
    if (!rule || confirmed) return true;
    const check = stopCheck(rule, change, history);
    if (check.kind === "blocked") { setError(check.reason); return false; }
    if (check.kind === "confirm") { setConfirmStopVia(via); setConfirmStopRule(rule.id); return false; }
    return true;
  };

  const changeResponse = (ruleId: string, response: GovernanceResponse, confirmed = false) => {
    selectRule(ruleId);
    const rule = rules.find((r) => r.id === ruleId);
    if ((rule?.response ?? "block") === response) return;
    if (!stopGate(rule, { response }, "response", confirmed)) return;
    setConfirmStopRule(null);
    void update(ruleId, { response }, "change what the rule does", true);
  };

  const changeMode = (ruleId: string, _ruleType: RuleType, mode: RuleMode, confirmed = false) => {
    selectRule(ruleId);
    const rule = rules.find((r) => r.id === ruleId);
    if (rule?.mode === mode) return;
    if (!stopGate(rule, { mode }, "mode", confirmed)) return;
    setConfirmStopRule(null);
    void update(ruleId, { mode }, "change the mode", true);
  };

  // Controls send only the field they changed; it is merged onto the latest
  // params here, at save time. Merging onto the params captured at render
  // let a debounced number edit land after a select change and revert it.
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const updateParams = (ruleId: string, patch: Partial<SpendCapParams & LoopBreakerParams & ModelAllowlistParams & ToolListParams & CallRateParams>) => {
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
    startChange();
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
  const stopRule = confirmStopRule ? rules.find((r) => r.id === confirmStopRule) ?? null : null;

  // Render the natural-language params for a rule
  const renderParams = (rule: FleetRule) => {
    const rt = rule.ruleType;
    if (rt === "spend_cap") {
      const p = rule.params as SpendCapParams;
      return (
        <span>
          When an agent spends more than{" "}
          {p.unit === "dollars" && <span style={{ color: "var(--brand)", fontFamily: FONT_MONO }}>$</span>}
          <InlineNumber ariaLabel="Spend limit" value={p.dailyCap} allowDecimals={p.unit === "dollars"} onChange={(n) => updateParams(rule.id, { dailyCap: n })} />
          {" "}
          <select aria-label="Limit unit" value={p.unit} onChange={(e) => {
            const newUnit = e.target.value as "tokens" | "dollars";
            updateParams(rule.id, { unit: newUnit, dailyCap: convertSpendCap(p.dailyCap, newUnit) });
          }} style={{ background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "var(--brand)", fontFamily: FONT_MONO }}>
            <option value="tokens">tokens</option>
            <option value="dollars">dollars</option>
          </select>
          {" "}in a{" "}
          <select aria-label="Limit period" value={p.scope} onChange={(e) => updateParams(rule.id, { scope: e.target.value as "run" | "day" })} style={{ background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "var(--brand)", fontFamily: FONT_MONO }}>
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
          When an agent makes the same call{" "}
          <InlineNumber ariaLabel="Repeated-call limit" value={p.threshold} onChange={(n) => updateParams(rule.id, { threshold: n })} />
          {" "}times in a{" "}
          <select aria-label="Limit period" value={p.scope} onChange={(e) => updateParams(rule.id, { scope: e.target.value as "run" | "day" })} style={{ background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "var(--brand)", fontFamily: FONT_MONO }}>
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
    if (rt === "call_rate") {
      const p = rule.params as CallRateParams;
      return (
        <span>
          When an agent makes more than{" "}
          <InlineNumber ariaLabel="Calls per minute limit" value={p.maxCalls} onChange={(n) => updateParams(rule.id, { maxCalls: n })} />
          {" "}calls in a minute
        </span>
      );
    }
    if (rt === "tool_list") {
      const p = rule.params as ToolListParams;
      return (
        <span>
          When an agent is about to run any of these tools:{" "}
          <ToolPicker
            purpose="block"
            tags={p.blockedTools}
            onAdd={(t) => { if (!p.blockedTools.includes(t)) updateParams(rule.id, { blockedTools: [...p.blockedTools, t] }); }}
            onRemove={(t) => updateParams(rule.id, { blockedTools: p.blockedTools.filter((x) => x !== t) })}
          />
          <span style={{ display: "block", marginTop: 6, fontSize: 11.5, color: "var(--tx2)" }}>In Enforce, a streamed call is checked before it streams, so its text arrives all at once. In Watch, streamed calls aren’t checked.</span>
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
      <PageHeader title="Controls" fleetId={fleetId} />

      <div className="gov-columns" style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left column — rules */}
        <div className="gov-list" style={{ flex: 1, overflowY: "auto", padding: 24, minWidth: 0 }}>
          {error && (
            <div role="alert" style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--bad)", background: "var(--bad-bg)", color: "var(--tx)", fontSize: 12.5, display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span>{error}</span>
              <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "var(--tx3)", cursor: "pointer", fontSize: 14 }} aria-label="Dismiss">&times;</button>
            </div>
          )}
          {notice && (
            <div role="status" style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--ok)", background: "var(--ok-bg)", color: "var(--tx)", fontSize: 12.5, display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span>{notice}</span>
              <button onClick={() => setNotice(null)} style={{ background: "none", border: "none", color: "var(--tx3)", cursor: "pointer", fontSize: 14 }} aria-label="Dismiss">&times;</button>
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
                    style={{ padding: "6px 12px", fontSize: 11, background: "var(--brand)", color: "var(--on-brand)", fontWeight: 500, borderRadius: 6, border: "none", cursor: "pointer" }}
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
                    style={{ fontSize: 10, fontWeight: 600, color: "var(--brand)", background: "transparent", border: "1px solid var(--brand)", borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}
                  >
                    + Add rule
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {sectionRules.map((rule) => (
                    <div
                      key={rule.id}
                      onClick={() => selectRule(rule.id)}
                      style={{
                        background: "var(--card)",
                        border: `1px solid ${selectedId === rule.id ? "var(--brand)" : "var(--line)"}`,
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
                            style={{ fontSize: 14, color: "var(--tx3)", background: "transparent", border: "none", cursor: "pointer", minWidth: 24, minHeight: 24, padding: "2px 6px" }}
                            title="Remove this rule"
                            aria-label="Remove this rule"
                          >
                            &times;
                          </button>
                        )}
                      </div>
                      {rule.response !== undefined && (
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, fontSize: 12.5, color: "var(--tx2)", flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
                          <span style={{ fontWeight: 600, color: "var(--tx)" }}>then</span>
                          <SelectChip label="What the rule does" value={rule.response} onChange={(v) => changeResponse(rule.id, v)} options={responseOptions(govV1, rule.response)} />
                          <span style={{ flex: "1 1 220px" }}>{RESPONSE_EFFECT[rule.response]}{rule.mode !== "enforce" && " Only once the rule is set to Enforce."}</span>
                        </div>
                      )}
                      {rule.mode === "watch" && wouldActs[`${rule.id}@${rule.version}`] && (() => {
                        const seen = watchSummary(rule, wouldActs[`${rule.id}@${rule.version}`]);
                        return <p style={{ margin: "10px 0 0", fontSize: 12, color: seen ? "var(--warn-tx)" : "var(--tx3)" }}>{seen ?? "Watching: it hasn’t fired since its last change."}</p>;
                      })()}
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
          {/* Was the page footer; the shell has no footer now (README › Screen 5). */}
          <p style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 0", fontSize: 12.5, color: "var(--tx2)" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ flex: "none" }}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
            Traffic that bypasses the proxy, such as Claude Code signed in with OAuth, is not covered by these rules.
          </p>
        </div>

        {/* Right column — a Diagnosis suggestion's draft, or the selected rule */}
        {suggestionRec ? (
          <SuggestionDraft
            fleetId={fleetId}
            authKey={authKey}
            recId={suggestionRec}
            existingRule={rules.find((r) => r.sourceRecommendationId === suggestionRec) ?? null}
            onDone={(ruleId, message) => {
              setNotice(message || null);
              router.replace(ROUTES.controls);
              // Select the new rule only once the list that holds it has loaded.
              void fetchData().then((ok) => { if (ok) setSelectedId(ruleId); });
            }}
            onCancel={(ruleCreated) => {
              router.replace(ROUTES.controls);
              if (ruleCreated) void fetchData();
            }}
          />
        ) : selectedRule && (
          <div className="gov-panel" style={{ width: 420, borderLeft: "1px solid var(--line)", overflowY: "auto", padding: 24, flexShrink: 0 }}>
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
              {selectedRule.sourceRecommendationId && (
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--tx2)" }}>
                  From a Diagnosis suggestion · <Link href="/performance" style={{ color: "var(--brand)" }}>see it in Performance</Link>
                </p>
              )}
            </div>

            {selectedRule.mode !== "off" && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" as const, color: "var(--tx3)", marginBottom: 8 }}>WHAT THE AGENT GETS</div>
                <pre style={{ background: "var(--sunk)", borderRadius: 8, padding: 12, fontSize: 11, color: "var(--tx2)", fontFamily: FONT_MONO, lineHeight: 1.6, overflowX: "auto", margin: 0 }}>
                  {agentResponse(selectedRule)}
                </pre>
                <p style={{ fontSize: 11, color: "var(--tx3)", marginTop: 8 }}>
                  {selectedRule.ruleType === "spend_cap" && "Stops before the next call. Non-retryable, so SDKs should not retry."}
                  {selectedRule.ruleType === "loop_breaker" && "Stops after the repeated call. Non-retryable within the same run."}
                  {selectedRule.ruleType === "model_allowlist" && "Stops before the call. The agent must switch to an allowed model."}
                  {selectedRule.ruleType === "call_rate" && "Stops the call that goes over the limit. Refused calls count too, so an agent that keeps retrying stays over until it slows down."}
                  {selectedRule.ruleType === "tool_list" && "Stops the model’s reply before the agent gets it, so the tool never runs. The model call itself is already spent."}
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
                          {timeAgo(h.time)} · {historyWho(h, actors)}
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

      <ConfirmDialog
        open={confirmStopRule !== null}
        title="Let this rule stop agents?"
        body={<>{RESPONSE_EFFECT.stop} It applies to {stopRule?.appliesTo === "all" || !stopRule ? "every agent in this fleet" : stopRule.appliesTo.join(", ")}, and takes effect now.</>}
        confirmLabel={RESPONSE_LABEL.stop}
        confirmPhrase={stopRule ? stopPhrase(stopRule.appliesTo) : "stop"}
        onConfirm={() => {
          if (!confirmStopRule) return;
          if (confirmStopVia === "mode") changeMode(confirmStopRule, stopRule!.ruleType, "enforce", true);
          else changeResponse(confirmStopRule, "stop", true);
        }}
        onCancel={() => setConfirmStopRule(null)}
      />
    </div>
  );
}


