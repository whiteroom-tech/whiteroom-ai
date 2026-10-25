"use client";

// Controls (spec Rev 1, D1): rules read as sentences, grouped by what they do
// now (Enforcing, Watching, Off), changed in one editor on the right and sent
// to the engine only on Save. Built from the shared primitives and the
// dashboard's own words, so it reads like the other tabs.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Banner, Button, FONT_DISPLAY, FONT_MONO, Panel, SelectChip, StatCard } from "@whiteroom/ui";
import { SuggestionDraft } from "./_components/SuggestionDraft";
import { RuleEditor } from "./_components/RuleEditor";
import { AddRuleDialog } from "./_components/AddRuleDialog";
import { useFleetAuth } from "@/hooks/useFleetAuth";
import {
  controlFailure, governanceCreateRule, governanceDeleteRule, governanceList, governanceUpdateRule, isAuthError,
  performanceFleetHourly, performanceIndex, ruleActions as fetchRuleActions, ruleWouldAct,
} from "@/lib/whiteroom/client";
import type {
  GovernanceHistoryEntry, GovernanceRule, GovernanceRuleType, ModelAllowlistParams, RuleActionsResult, RuleWouldActResult, SpendCapParams,
} from "@/lib/whiteroom/types";
import { computeSuggestions, countsFromRuleActions, governanceFromSummary, RESPONSE_EFFECT, RESPONSE_LABEL, RULE_LABELS, tallyTotal, tallyWords, type GovernanceSuggestions } from "@/lib/governance";
import { FleetLogin } from "@/components/citadel/FleetLogin";
import { ConfirmDialog } from "@/components/citadel/ConfirmDialog";
import { fetchControlActors, oldestTime, type ControlActor } from "@/lib/control-actors";
import { canAct, stopCheck, stopPhrase } from "@/lib/controls-guard";
import { HELP } from "@/lib/metric-definitions";
import { timeAgo } from "@/lib/format";
import { localDay } from "@/lib/runs";
import { ROUTES } from "@/lib/routes";
import { UNNAMED_CALLS_REFUSED } from "@/lib/setup";
import {
  byMode, draftChanges, draftFrom, draftParams, draftProblem, isDirty, money, ruleNames, ruleSentence, rulesFor, rowStat, scopeLabel, sentenceText, spendOverlap,
  type RuleDraft,
} from "@/lib/controls-view";

// The engine caps performance queries at 336h (hours_back check in security.ts).
const SUGGESTION_HOURS = 14 * 24;
const ACTIONS_HOURS = 7 * 24;

export default function ControlsPage() {
  const auth = useFleetAuth();
  if (auth.status !== "authenticated") return <FleetLogin auth={auth} />;
  if (!auth.fleetId) return null;
  // useSearchParams (?rec= Diagnosis suggestion, ?agent= filter) needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <ControlsContent fleetId={auth.fleetId} authKey={auth.authKey} onAuthError={auth.resetSession} />
    </Suspense>
  );
}

type Dialog =
  | { kind: "enforce"; rule: GovernanceRule; next: GovernanceRule }
  | { kind: "stop"; rule: GovernanceRule; next: GovernanceRule }
  | { kind: "remove"; rule: GovernanceRule }
  | { kind: "discard"; label: string; then: () => void };

function ControlsContent({ fleetId, authKey, onAuthError }: { fleetId: string; authKey: string | undefined; onAuthError: (msg?: string) => void }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const suggestionRec = searchParams.get("rec");
  const agentParam = searchParams.get("agent");

  const [rules, setRules] = useState<GovernanceRule[]>([]);
  const [history, setHistory] = useState<GovernanceHistoryEntry[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [govV1, setGovV1] = useState(false);
  const [actors, setActors] = useState<ControlActor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<GovernanceSuggestions>({ noCaching: false, onlyModels: null });
  /** rule_would_act per Watch rule, keyed `${id}@${version}`. */
  const [wouldActs, setWouldActs] = useState<Record<string, RuleWouldActResult>>({});
  const [actions, setActions] = useState<RuleActionsResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [adding, setAdding] = useState<"closed" | "open" | "busy">("closed");
  const [offOpen, setOffOpen] = useState(false);

  const agentFilter = agentParam && agents.includes(agentParam) ? agentParam : null;
  const selected = selectedId ? rules.find((r) => r.id === selectedId) ?? null : null;
  const dirty = !!(selected && draft && isDirty(draft, selected));

  // Only the newest load may set names or counts: an older one finishing last would undo it.
  const actorsReq = useRef(0);
  const wouldReq = useRef(0);
  const loadActors = useCallback((h: GovernanceHistoryEntry[]) => {
    const id = ++actorsReq.current;
    return fetchControlActors(fleetId, oldestTime(h)).then((a) => { if (id === actorsReq.current) setActors(a); });
  }, [fleetId]);

  const handleError = useCallback((e: unknown, what: string) => {
    const failure = controlFailure(e);
    if (failure === "sign-out") { onAuthError(); return; }
    if (failure === "refused") { setError((e as Error).message); return; }
    setError(`Couldn’t ${what}. Your last change may not have been saved — refreshed from the server.`);
  }, [onAuthError]);

  /** Reloads the rules; resolves false if that failed. */
  const fetchData = useCallback(async (): Promise<boolean> => {
    try {
      const d = await governanceList(fleetId, authKey);
      // One read per Watch rule. A failed read leaves that rule without a line rather than "hasn't fired".
      const req = ++wouldReq.current;
      void Promise.all(d.rules.filter((r) => r.mode === "watch").map((r) => ruleWouldAct(fleetId, r.id, r.version, authKey).then((c) => [`${r.id}@${r.version}`, c] as const, () => null)))
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
      setError("Couldn’t load your rules. Retrying on the next change.");
      setLoaded(true);
      return false;
    }
  }, [fleetId, authKey, onAuthError, loadActors]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  // Rule actions over the last 7 days, as Performance counts them. Optional: no card line without them.
  useEffect(() => {
    let cancelled = false;
    const from = Date.now() - ACTIONS_HOURS * 3_600_000;
    fetchRuleActions(fleetId, { fromDay: localDay(from), toDay: localDay() }, authKey, ACTIONS_HOURS)
      .then((d) => { if (!cancelled && !("unsupported" in d)) setActions(d); }, () => {});
    return () => { cancelled = true; };
  }, [fleetId, authKey]);

  // Suggested rules come from real traffic; the performance store is optional, so a failure just means none.
  useEffect(() => {
    let cancelled = false;
    Promise.all([performanceIndex(fleetId, SUGGESTION_HOURS, authKey), performanceFleetHourly(fleetId, SUGGESTION_HOURS, authKey)])
      .then(([index, hourly]) => { if (!cancelled) setSuggestions(computeSuggestions(index, hourly)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fleetId, authKey]);

  // ── Leaving with unsaved changes asks first ─────────────────────
  /** Runs `go` now, or after "Discard your changes?" when there are some. */
  const guard = useCallback((go: () => void) => {
    if (dirty && selected) setDialog({ kind: "discard", label: RULE_LABELS[selected.ruleType], then: go });
    else go();
  }, [dirty, selected]);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    // A link elsewhere in the app (the sidebar, a "→" link) asks too.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank") return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.hash)) return;
      e.preventDefault();
      e.stopPropagation();
      setDialog({ kind: "discard", label: selected ? RULE_LABELS[selected.ruleType] : "this rule", then: () => router.push(url.pathname + url.search + url.hash) });
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", onUnload); document.removeEventListener("click", onClick, true); };
  }, [dirty, selected, router]);

  const openRule = (id: string | null) => {
    if (id === selectedId) return;
    guard(() => {
      if (suggestionRec) router.replace(withParams({ rec: null }));
      setError(null);
      setNotice(null);
      setSelectedId(id);
      const r = id ? rules.find((x) => x.id === id) : null;
      setDraft(r ? draftFrom(r) : null);
    });
  };

  /** The current URL with some search params changed (null removes one). */
  const withParams = (changes: Record<string, string | null>) => {
    const q = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(changes)) { if (v === null) q.delete(k); else q.set(k, v); }
    const s = q.toString();
    return s ? `${ROUTES.controls}?${s}` : ROUTES.controls;
  };

  // ── Save ────────────────────────────────────────────────────────
  const save = () => {
    if (!selected || !draft || !dirty) return;
    const problem = draftProblem(draft);
    if (problem) { setError(problem); return; }
    const parsed = draftParams(draft);
    const next: GovernanceRule = { ...selected, mode: draft.mode, response: draft.response, alsoNotify: draft.alsoNotify, appliesTo: draft.appliesTo, params: "params" in parsed ? parsed.params : selected.params };
    // A rule that would stop agents must have run in Watch for a day, and is confirmed by typing who it covers.
    const stop = stopCheck(selected, { mode: draft.mode, response: draft.response }, history);
    if (stop.kind === "blocked") { setError(stop.reason); return; }
    if (stop.kind === "confirm") { setDialog({ kind: "stop", rule: selected, next }); return; }
    if (draft.mode === "enforce" && selected.mode !== "enforce") { setDialog({ kind: "enforce", rule: selected, next }); return; }
    void commit(selected, draft);
  };

  const commit = async (rule: GovernanceRule, d: RuleDraft) => {
    const changes = draftChanges(d, rule);
    setDialog(null);
    if (!changes) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { rule: saved } = await governanceUpdateRule(fleetId, rule.id, changes, authKey);
      setRules((rs) => rs.map((r) => (r.id === saved.id && saved.version >= r.version ? saved : r)));
      if (selectedId === saved.id) setDraft(draftFrom(saved));
      const how = saved.mode === "enforce" ? "now enforces" : saved.mode === "watch" ? "is in Watch only" : "is off";
      setNotice(`Saved. ${RULE_LABELS[saved.ruleType]} ${how}.`);
      void fetchData();
    } catch (e) {
      handleError(e, "save the rule");
      void fetchData();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (rule: GovernanceRule) => {
    setDialog(null);
    setError(null);
    setRules((rs) => rs.filter((r) => r.id !== rule.id));
    if (selectedId === rule.id) { setSelectedId(null); setDraft(null); }
    try {
      await governanceDeleteRule(fleetId, rule.id, authKey);
      setNotice(`Removed the ${RULE_LABELS[rule.ruleType]} rule.`);
      void fetchData();
    } catch (e) { handleError(e, "remove the rule"); void fetchData(); }
  };

  const add = async (ruleType: GovernanceRuleType) => {
    setAdding("busy");
    setError(null);
    try {
      // New rules start in Watch only; while viewing one agent, they start for that agent.
      const { rule } = await governanceCreateRule(fleetId, { ruleType, mode: "watch", ...(agentFilter && { appliesTo: [agentFilter] }) }, authKey);
      setRules((rs) => [...rs, rule]);
      setAdding("closed");
      if (suggestionRec) router.replace(withParams({ rec: null }));
      setSelectedId(rule.id);
      setDraft(draftFrom(rule));
      setNotice(null);
      void fetchData();
    } catch (e) { setAdding("closed"); handleError(e, "add the rule"); void fetchData(); }
  };

  const addSuggestedAllowlist = async (models: string[]) => {
    setError(null);
    const description = "Added Model allowlist in Watch (suggested)";
    try {
      const existing = rules.filter((r) => r.ruleType === "model_allowlist");
      if (existing.length === 0) {
        await governanceCreateRule(fleetId, { ruleType: "model_allowlist", mode: "watch", params: { allowedModels: models }, description }, authKey);
      } else {
        const prev = (existing[0].params as ModelAllowlistParams).allowedModels;
        await governanceUpdateRule(fleetId, existing[0].id, { mode: "watch", params: { allowedModels: [...models.filter((m) => !prev.includes(m)), ...prev] }, description }, authKey);
      }
    } catch (e) { handleError(e, "add the suggested allowlist"); }
    void fetchData();
  };

  // ── What the page shows ─────────────────────────────────────────
  const shown = useMemo(() => rulesFor(rules, agentFilter), [rules, agentFilter]);
  const enforcing = byMode(shown, "enforce"), watching = byMode(shown, "watch"), off = byMode(shown, "off");
  const overlap = spendOverlap(shown);
  const counts = actions ? countsFromRuleActions(actions, governanceFromSummary({ blocks: 0, wouldBlocks: 0, byAgent: {}, byRule: {} }).byRule) : null;
  const allowlistSuggestion = suggestions.onlyModels && !rules.some((r) => r.ruleType === "model_allowlist" && r.mode !== "off"
    && suggestions.onlyModels!.every((m) => (r.params as ModelAllowlistParams).allowedModels.includes(m))) ? suggestions.onlyModels : null;
  const typeCount = (t: GovernanceRuleType) => rules.filter((r) => r.ruleType === t).length;

  const row = (r: GovernanceRule) => {
    const s = ruleSentence(r);
    const scope = scopeLabel(r.appliesTo);
    const never = overlap?.never.id === r.id;
    const stat = never
      ? `Never acts: the ${money(overlap!.first.params as SpendCapParams)} cap acts first`
      : rowStat(r, { byRuleType: actions?.byRule as never, onlyOfItsType: typeCount(r.ruleType) === 1, wouldAct: wouldActs[`${r.id}@${r.version}`] ?? null });
    return (
      <button key={r.id} type="button" className={`gov-row${r.id === selectedId ? " is-on" : ""}`} onClick={() => openRule(r.id)} aria-current={r.id === selectedId || undefined}>
        <span style={{ minWidth: 0, flex: "1 1 320px" }}>
          <span style={{ display: "block", fontSize: 12.5, color: "var(--tx2)", marginBottom: 2 }}>{RULE_LABELS[r.ruleType]}</span>
          {s.pre}<span style={{ fontFamily: FONT_MONO }}>{s.val}</span>{s.post}
        </span>
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, fontSize: 12.5, color: "var(--tx2)" }}>
          <span>{scope.lead}<span style={{ fontFamily: FONT_MONO, color: "var(--tx)" }}>{scope.agents}</span></span>
          {stat && <span style={never ? { color: "var(--warn-tx)" } : undefined}>{stat}</span>}
        </span>
      </button>
    );
  };

  const group = (title: string, list: GovernanceRule[], empty: string, foldable = false) => (
    <Panel
      title={title}
      count={list.length}
      bodyPadding={0}
      actions={foldable && list.length > 0 ? <Button variant="ghost" size={28} onClick={() => setOffOpen((v) => !v)} aria-expanded={offOpen}>{offOpen ? "Hide" : "Show"}</Button> : undefined}
    >
      {(!foldable || offOpen || list.length === 0) && (
        list.length ? <div>{list.map(row)}</div> : <p style={{ margin: 0, padding: "14px 18px", fontSize: 12.5, color: "var(--tx2)" }}>{loaded ? empty : "Loading…"}</p>
      )}
    </Panel>
  );

  const recent = history.slice(0, 5);

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, flex: 1 }}>
      {/* Split like the columns below, so the actions end where the rule list ends. */}
      <header className="citadel-page-header gov-head" style={{ height: 56, flexShrink: 0, display: "flex", alignItems: "stretch", borderBottom: "1px solid var(--line)", minWidth: 0 }}>
        <div className="gov-head__main">
          <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, color: "var(--tx)", margin: 0, whiteSpace: "nowrap" }}>Controls</h1>
          <span className="citadel-page-fleet" title="Fleet ID" style={{ fontFamily: FONT_MONO, fontSize: 12, color: "var(--tx2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>/ {fleetId}</span>
          <div className="citadel-page-actions" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <SelectChip
              label="Agent"
              value={agentFilter ?? "all"}
              onChange={(v) => router.replace(withParams({ agent: v === "all" ? null : v }))}
              options={[{ value: "all", label: "All agents" }, ...agents.map((a) => ({ value: a, label: a }))]}
            />
            <Button variant="primary" onClick={() => guard(() => setAdding("open"))}>Add rule</Button>
          </div>
        </div>
        <div className="gov-head__side" aria-hidden="true" />
      </header>

      <div className="gov-columns">
        <main className="gov-list">
          <section aria-label="Rules at a glance" className="wr-stat-strip" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
            <StatCard variant="card" label="Enforcing" value={enforcing.length} sub={ruleNames(enforcing)} />
            <StatCard variant="card" label="Watching" hint="Watch only counts what a rule would do and never acts. Enforce acts." value={watching.length} sub={ruleNames(watching)} />
            <StatCard variant="card" label="Off" value={off.length} sub={ruleNames(off)} />
            <StatCard variant="card" label="Rule actions" hint={HELP.ruleActions} value={counts ? tallyTotal(counts).toLocaleString() : "—"}
              sub={counts ? tallyWords(counts).map((w) => w.text).join(" · ") || "no rule stepped in" : "last 7 days"} />
          </section>

          {error && !selected && <Banner variant="error" actions={<Button variant="ghost" size={28} onClick={() => setError(null)}>Dismiss</Button>}>{error}</Banner>}
          {notice && !selected && <Banner variant="info" icon="check" actions={<Button variant="ghost" size={28} onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Banner>}

          {overlap && (
            <Banner variant="warn" actions={<Button size={28} onClick={() => guard(() => setDialog({ kind: "remove", rule: overlap.never }))}>Remove the {money(overlap.never.params as SpendCapParams)} cap</Button>}>
              Your <span style={{ fontFamily: FONT_MONO }}>{money(overlap.never.params as SpendCapParams)}</span> cap will never act. The <span style={{ fontFamily: FONT_MONO }}>{money(overlap.first.params as SpendCapParams)}</span> cap covers the same agents and always acts first.
            </Banner>
          )}

          {suggestions.noCaching && (
            <Banner variant="info" actions={<a href="https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching" target="_blank" rel="noopener noreferrer" className="wr-btn wr-btn--secondary wr-btn--h28" style={{ textDecoration: "none" }}>How to turn on caching</a>}>
              None of your fleet’s input is cached, so agents pay full price for repeated context. Not a rule: caching is turned on in your client.
            </Banner>
          )}
          {allowlistSuggestion && (
            <Banner variant="info" actions={<Button size={28} onClick={() => void addSuggestedAllowlist(allowlistSuggestion)}>Add in Watch</Button>}>
              Your fleet only used <span style={{ fontFamily: FONT_MONO }}>{allowlistSuggestion.join(", ")}</span> in the last 14 days. A Model allowlist with {allowlistSuggestion.length === 1 ? "that model" : "those models"} would have stopped 0 calls.
            </Banner>
          )}

          {group("Enforcing", enforcing, "No rules are enforcing. Rules in Watch only show what they would do first.")}
          {group("Watching", watching, "No rules are watching.")}
          {group("Off", off, "No rules are off.", true)}

          <p style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: 12.5, color: "var(--tx2)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ flex: "none" }}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
            Rules cover calls through WhiteRoom. Claude Code signed in with OAuth isn’t covered.
          </p>
        </main>

        {suggestionRec ? (
          <SuggestionDraft
            fleetId={fleetId}
            authKey={authKey}
            recId={suggestionRec}
            existingRule={rules.find((r) => r.sourceRecommendationId === suggestionRec) ?? null}
            onDone={(ruleId, message) => {
              setNotice(message || null);
              router.replace(withParams({ rec: null }));
              // Select the new rule only once the list that holds it has loaded.
              void fetchData().then((ok) => { if (ok) { setSelectedId(ruleId); setDraft(null); } });
            }}
            onCancel={(ruleCreated) => { router.replace(withParams({ rec: null })); if (ruleCreated) void fetchData(); }}
          />
        ) : selected && draft ? (
          <aside aria-label="Edit rule" className="gov-panel is-sheet">
            {notice && <Banner variant="info" icon="check" actions={<Button variant="ghost" size={28} onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Banner>}
            <RuleEditor
              rule={selected}
              draft={draft}
              onDraft={(d) => { setDraft(d); setError(null); }}
              agents={agents}
              govV1={govV1}
              wouldAct={wouldActs[`${selected.id}@${selected.version}`] ?? null}
              history={history.filter((h) => h.ruleId === selected.id)}
              actors={actors}
              dirty={dirty}
              error={error}
              saving={saving}
              onSave={save}
              onDiscard={() => { setDraft(draftFrom(selected)); setError(null); }}
              onClose={() => openRule(null)}
              onRemove={() => setDialog({ kind: "remove", rule: selected })}
            />
          </aside>
        ) : (
          <aside aria-label="Rule details" className="gov-panel is-empty">
            <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Pick a rule to change it</p>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--tx2)" }}>Or use Add rule. New rules start in Watch only, so nothing is blocked until you say so.</p>
            {recent.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <p style={{ margin: "6px 0 0", fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--tx2)" }}>Recent changes</p>
                {recent.map((h) => (
                  <div key={h.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5 }}>
                    <span>{RULE_LABELS[h.ruleType]} · {h.description}</span>
                    <span style={{ color: "var(--tx2)", flex: "none" }}>{timeAgo(h.time)}</span>
                  </div>
                ))}
                <a href="/settings#audit-integrity" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--brand)" }}>Audit integrity →</a>
              </div>
            )}
          </aside>
        )}
      </div>

      <AddRuleDialog open={adding !== "closed"} busy={adding === "busy"} onPick={(t) => void add(t)} onCancel={() => setAdding("closed")} />

      <ConfirmDialog
        open={dialog?.kind === "enforce"}
        tone="neutral"
        title={dialog?.kind === "enforce" ? `Enforce the ${RULE_LABELS[dialog.rule.ruleType]} rule?` : ""}
        body={dialog?.kind === "enforce" ? <EnforcePreview rule={dialog.rule} next={dialog.next} wouldAct={wouldActs[`${dialog.rule.id}@${dialog.rule.version}`] ?? null} /> : null}
        confirmLabel="Enforce rule"
        cancelLabel={dialog?.kind === "enforce" && dialog.rule.mode === "watch" ? "Keep watching" : "Cancel"}
        busy={saving}
        onConfirm={() => { if (dialog?.kind === "enforce" && draft) void commit(dialog.rule, draft); }}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "stop"}
        title="Let this rule stop agents?"
        body={dialog?.kind === "stop" ? <>{RESPONSE_EFFECT.stop} It applies to {dialog.next.appliesTo === "all" ? "every agent in this fleet" : dialog.next.appliesTo.join(", ")}, and takes effect now.<span style={{ display: "block", marginTop: 8 }}>{UNNAMED_CALLS_REFUSED}</span></> : null}
        confirmLabel={RESPONSE_LABEL.stop}
        confirmPhrase={dialog?.kind === "stop" ? stopPhrase(dialog.next.appliesTo) : "stop"}
        busy={saving}
        onConfirm={() => { if (dialog?.kind === "stop" && draft) void commit(dialog.rule, draft); }}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "remove"}
        title={dialog?.kind === "remove" ? `Remove the ${RULE_LABELS[dialog.rule.ruleType]} rule?` : ""}
        body={dialog?.kind === "remove" ? <>{sentenceText(dialog.rule)} It stops right away. Its history stays in the audit chain.</> : null}
        confirmLabel="Remove rule"
        cancelLabel="Keep rule"
        onConfirm={() => { if (dialog?.kind === "remove") void remove(dialog.rule); }}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "discard"}
        tone="neutral"
        title={dialog?.kind === "discard" ? `Discard your changes to ${dialog.label}?` : ""}
        body="The rule stays as it was."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={() => {
          if (dialog?.kind !== "discard") return;
          const then = dialog.then;
          setDialog(null);
          if (selected) setDraft(draftFrom(selected));
          then();
        }}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}

/** What enforcing would have done, from the rule's time in Watch; and the fleet-wide side effect, when there is one. */
function EnforcePreview({ rule, next, wouldAct }: { rule: GovernanceRule; next: GovernanceRule; wouldAct: RuleWouldActResult | null }) {
  const watched = rule.mode === "watch" && wouldAct;
  const n = watched ? Object.values(wouldAct.byAgent).reduce((a, b) => a + b, 0) : null;
  const tile = { background: "var(--sunk)", borderRadius: 7, padding: 12 } as const;
  const big = { display: "block", fontFamily: FONT_MONO, fontSize: 24, fontWeight: 700, color: "var(--tx)" } as const;
  return (
    <>
      {sentenceText(next)} It applies to {next.appliesTo === "all" ? "every agent in this fleet" : next.appliesTo.join(", ")}, and takes effect now.
      <span style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 12 }}>
        <span style={tile}><span style={big}>{n === null ? "—" : n.toLocaleString()}</span>times it would have acted</span>
        <span style={tile}><span style={big}>{watched && wouldAct.since ? timeAgo(wouldAct.since).replace(/ ago$/, "") : "—"}</span>{watched ? "in Watch only, since its last change" : "Turn on Watch first to see what it would do"}</span>
      </span>
      {canAct(next) && <span style={{ display: "block", marginTop: 12 }}>{UNNAMED_CALLS_REFUSED}</span>}
    </>
  );
}
