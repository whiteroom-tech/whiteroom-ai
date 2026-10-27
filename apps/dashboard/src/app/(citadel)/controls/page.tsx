"use client";

// Controls (spec Rev 1, D1): rules read as sentences, grouped by what they do
// now (Acting, Record only, Off), changed in one editor on the right and sent
// to the engine only on Save. Built from the shared primitives and the
// dashboard's own words, so it reads like the other tabs.

import { HistoryLine } from "./_components/HistoryLine";
import { undoFor, type Undo } from "@/lib/rule-history";
import { DOES_TAG, MODE_GROUP, MODE_LABEL, MODE_MEANING, RULE_ACTIVITY } from '@/lib/vocab';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Banner, Button, FONT_MONO, Panel, SelectChip, StatCard, Tag } from "@whiteroom/ui";
import { PageHeader } from "@/components/citadel/PageChrome";
import { SuggestionDraft } from "./_components/SuggestionDraft";
import { RuleEditor } from "./_components/RuleEditor";
import { AddRuleDialog } from "./_components/AddRuleDialog";
import { useFleetAuth } from "@/hooks/useFleetAuth";
import {
  WhiteRoomApiError, alertsGet, controlFailure, governanceCreateRule, governanceDeleteRule, governanceList, governanceUpdateRule, isAuthError,
  performanceFleetHourly, performanceIndex, ruleActions as fetchRuleActions, ruleWouldAct,
} from "@/lib/whiteroom/client";
import type {
  GovernanceHistoryEntry, GovernanceRule, GovernanceRuleType, ModelAllowlistParams, RuleActionsResult, RuleWouldActResult, SpendCapParams,
} from "@/lib/whiteroom/types";
import { computeSuggestions, RESPONSE_EFFECT, RESPONSE_LABEL, RULE_LABELS, tallyFromRuleActions, tallyTotal, tallyWords, type GovernanceSuggestions } from "@/lib/governance";
import { FleetLogin } from "@/components/citadel/FleetLogin";
import { ConfirmDialog } from "@/components/citadel/ConfirmDialog";
import { fetchControlActors, oldestTime, type ControlActor } from "@/lib/control-actors";
import { canAct, keywordBlockCheck, keywordPhrase, keywordVerb, stopCheck, stopPhrase } from "@/lib/controls-guard";
import { HELP } from "@/lib/metric-definitions";
import { timeAgo } from "@/lib/format";
import { localDay } from "@/lib/runs";
import { ROUTES } from "@/lib/routes";
import { UNNAMED_CALLS_REFUSED } from "@/lib/setup";
import {
  appliesNow, byMode, draftChanges, draftFrom, draftParams, draftProblem, emptyPick, isDirty, money, NO_ACTIONS, ruleNames, ruleSentence, rulesFor, rowStat, scopeLabel, ruleSentenceText, spendOverlap,
  type RuleDraft,
  coverageGroups, stopping,
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
  | { kind: "keyword"; rule: GovernanceRule; next: GovernanceRule }
  | { kind: "remove"; rule: GovernanceRule }
  | { kind: "discard"; label: string; then: () => void };

function ControlsContent({ fleetId, authKey, onAuthError }: { fleetId: string; authKey: string | undefined; onAuthError: (msg?: string) => void }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const suggestionRec = searchParams.get("rec");
  const agentParam = searchParams.get("agent");
  // ?rule=gr_…: a link from elsewhere (a run's Rule activity) opens that rule.
  const ruleParam = searchParams.get("rule");

  const [rules, setRules] = useState<GovernanceRule[]>([]);
  const [history, setHistory] = useState<GovernanceHistoryEntry[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [govV1, setGovV1] = useState(false);
  const [actors, setActors] = useState<ControlActor[]>([]);
  const [loaded, setLoaded] = useState(false);
  // True once the rules have actually been read (a failed read sets `loaded` too, with no rules).
  const [listed, setListed] = useState(false);
  const [addingSuggestion, setAddingSuggestion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<GovernanceSuggestions>({ noCaching: false, onlyModels: null });
  /** rule_would_act per Watch rule, keyed `${id}@${version}`. */
  const [wouldActs, setWouldActs] = useState<Record<string, RuleWouldActResult>>({});
  const [actions, setActions] = useState<RuleActionsResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const ruleOpened = useRef<string | null>(null);
  const openRuleRef = useRef<(id: string | null) => void>(() => {});
  useEffect(() => {
    // A link that's gone (or a new visit) can open the same rule again later.
    if (!ruleParam) { ruleOpened.current = null; return; }
    if (ruleOpened.current === ruleParam || !listed) return;
    ruleOpened.current = ruleParam;
    // A run can name a rule that's since been removed: say so rather than land silently.
    // Through openRule, so an unsaved edit to another rule is asked about first.
    if (rules.some((r) => r.id === ruleParam)) openRuleRef.current(ruleParam);
    else setNotice("That rule isn’t here any more; it may have been removed. Its changes are in Recent changes.");
  }, [ruleParam, rules, listed]);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [adding, setAdding] = useState<"closed" | "open" | "busy">("closed");
  const [offOpen, setOffOpen] = useState(false);
  /** Whether alerts have somewhere to go (Slack or Teams); null while unknown or unreadable. */
  const [alertChannel, setAlertChannel] = useState<boolean | null>(null);

  // Trusted from the URL until the agents load, then only if it names one.
  const agentFilter = agentParam && (!loaded || agents.includes(agentParam)) ? agentParam : null;
  const selected = selectedId ? rules.find((r) => r.id === selectedId) ?? null : null;
  // What's selected and being edited now, for a save that finishes later.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
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
    // The engine said why: show that, so the person knows what to change.
    if (e instanceof WhiteRoomApiError && e.reason) { setError(`Couldn’t ${what}. ${e.reason[0].toUpperCase()}${e.reason.slice(1)}`); return; }
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
      setListed(true);
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

  useEffect(() => {
    let cancelled = false;
    // null: an engine without alerts, so nothing to say either way.
    setAlertChannel(null);
    alertsGet(fleetId).then((a) => { if (!cancelled && a) setAlertChannel(!!a.slack || !!a.teams); }, () => {});
    return () => { cancelled = true; };
  }, [fleetId]);

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

  // A rule selected without a draft (a Diagnosis suggestion just added it, say) opens in the editor too.
  useEffect(() => {
    if (selected && !draft) setDraft(draftFrom(selected));
  }, [selected, draft]);

  const openRule = (id: string | null) => {
    if ((id === selectedId && (id === null || draft)) || saving) return;
    guard(() => {
      if (suggestionRec) router.replace(withParams({ rec: null }));
      setError(null);
      setNotice(null);
      setSelectedId(id);
      const r = id ? rules.find((x) => x.id === id) : null;
      setDraft(r ? draftFrom(r) : null);
    });
  };
  openRuleRef.current = openRule;

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
    // A Keywords rule that stops incoming data ends the run: the same day in Watch and typed confirmation.
    const kw = keywordBlockCheck(selected, { mode: draft.mode, response: draft.response, params: next.params }, history);
    if (kw.kind === "blocked") { setError(kw.reason); return; }
    if (kw.kind === "confirm") { setDialog({ kind: "keyword", rule: selected, next }); return; }
    if (draft.mode === "enforce" && selected.mode !== "enforce") { setDialog({ kind: "enforce", rule: selected, next }); return; }
    void commit(selected, draft);
  };

  // ── Undo (lib/rule-history) ─────────────────────────────────────
  // Never edits the log: an update's old settings go into the editor and are
  // saved as a new change, through the checks above; a removed rule comes
  // back as a new rule in Record only.
  // Removals added back in this visit: hidden at once, before the reload brings the log's own "added" line.
  const [restored, setRestored] = useState<Set<string>>(() => new Set());
  const undoOf = (h: GovernanceHistoryEntry) => (restored.has(h.id) ? null : undoFor(h, rules, history));
  const undo = (u: Undo, entryId?: string) => {
    if (u.kind === "update") {
      const r = rules.find((x) => x.id === u.ruleId);
      if (!r) return;
      guard(() => {
        if (suggestionRec) router.replace(withParams({ rec: null }));
        setSelectedId(r.id);
        setDraft(draftFrom({ ...r, ...u.changes }));
        setError(null);
        setNotice("The settings from before that change are filled in. Check them, then Save.");
      });
      return;
    }
    guard(() => void restore(u.rule, entryId));
  };

  const restore = async (rule: Extract<Undo, { kind: "restore" }>["rule"], entryId?: string) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { rule: created } = await governanceCreateRule(fleetId, {
        ruleType: rule.ruleType, mode: "watch", response: rule.response, alsoNotify: rule.alsoNotify,
        params: rule.params, appliesTo: rule.appliesTo, description: `Added back ${RULE_LABELS[rule.ruleType]} rule`,
      }, authKey);
      setRules((rs) => [...rs, created]);
      if (entryId) setRestored((s) => new Set(s).add(entryId));
      setSelectedId(created.id);
      setDraft(draftFrom(created));
      setNotice(`${RULE_LABELS[rule.ruleType]} is back, in Record only.${rule.mode === "enforce" ? " Turn on Block when you’re ready." : ""}`);
      void fetchData();
    } catch (e) {
      handleError(e, "add the rule back");
    } finally {
      setSaving(false);
    }
  };

  const commit = async (rule: GovernanceRule, d: RuleDraft) => {
    const changes = draftChanges(d, rule);
    setDialog(null);
    if (!changes) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const sent = JSON.stringify(d);
    try {
      // Only over the version the checks above were made on: another tab's change wins, and this one asks again.
      const { rule: saved } = await governanceUpdateRule(fleetId, rule.id, { ...changes, ifVersion: rule.version }, authKey);
      setRules((rs) => rs.map((r) => (r.id === saved.id && saved.version >= r.version ? saved : r)));
      // Only the draft that was saved becomes the saved rule's: never one edited since, or another rule's.
      if (selectedRef.current === saved.id) setDraft((cur) => (cur && JSON.stringify(cur) === sent ? draftFrom(saved) : cur));
      const how = saved.mode === "enforce" ? (saved.response === undefined || saved.response === "block" ? "now blocks" : "is now on") : saved.mode === "watch" ? "is in Record only" : "is off";
      setNotice(`Saved. ${RULE_LABELS[saved.ruleType]} ${how}.`);
      void fetchData();
    } catch (e) {
      if (e instanceof WhiteRoomApiError && e.status === 409) {
        // The edit was made on the old rule: it goes, so the next Save can't overwrite the other change.
        setError("This rule changed somewhere else, so your edit wasn’t saved. It’s been reloaded: make your change again.");
        void fetchData().then((ok) => { if (ok && selectedRef.current === rule.id) setDraft(null); });
      } else {
        handleError(e, "save the rule");
        void fetchData();
      }
    } finally {
      setSaving(false);
    }
  };

  // Not optimistic: a failed delete keeps the rule, and the person's place, as they were.
  // Any rule can go, the last of its type too: Add rule brings a type back.
  const remove = async (rule: GovernanceRule) => {
    setDialog(null);
    setError(null);
    setSaving(true);
    try {
      await governanceDeleteRule(fleetId, rule.id, authKey);
      setRules((rs) => rs.filter((r) => r.id !== rule.id));
      if (selectedRef.current === rule.id) { setSelectedId(null); setDraft(null); }
      setNotice(`Removed the ${RULE_LABELS[rule.ruleType]} rule.`);
      void fetchData();
    } catch (e) { handleError(e, "remove the rule"); void fetchData(); }
    finally { setSaving(false); }
  };

  const add = async (ruleType: GovernanceRuleType) => {
    setAdding("busy");
    setError(null);
    try {
      // New rules start in Record only; while viewing one agent, they start for that agent.
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
    if (saving) return;
    setSaving(true);
    setAddingSuggestion(true);
    setError(null);
    setNotice(null);
    const description = "Added Model allowlist in Record only (suggested)";
    // A fleet-wide allowlist that isn't enforcing takes the models (and goes to Watch). Otherwise, a new rule.
    const target = suggestedAllowlistTarget(rules);
    try {
      if (!target) {
        await governanceCreateRule(fleetId, { ruleType: "model_allowlist", mode: "watch", params: { allowedModels: models }, description }, authKey);
      } else {
        const prev = (target.params as ModelAllowlistParams).allowedModels;
        await governanceUpdateRule(fleetId, target.id, { mode: "watch", params: { allowedModels: [...models.filter((m) => !prev.includes(m)), ...prev] }, description }, authKey);
      }
      const added = target ? models.some((m) => !(target.params as ModelAllowlistParams).allowedModels.includes(m)) : true;
      setNotice(!target ? "Added a Model allowlist in Record only." : added ? "Added the models to your Model allowlist, in Record only." : "Turned your Model allowlist on in Record only.");
    } catch (e) { handleError(e, "add the suggested allowlist"); }
    // Busy until the list reloads and the banner goes, so a second click can't add another rule.
    try { await fetchData(); } finally { setSaving(false); setAddingSuggestion(false); }
    // The rule's version moved: an open editor on it reopens from the saved rule.
    if (target && selectedRef.current === target.id) setDraft(null);
  };

  /** Shows one agent's rules (null: all); an open rule that isn't among them closes. */
  const changeAgent = (agent: string | null) => {
    router.replace(withParams({ agent }));
    const open = rules.find((r) => r.id === selectedRef.current);
    if (open && !rulesFor([open], agent).length) { setSelectedId(null); setDraft(null); }
  };

  // ── What the page shows ─────────────────────────────────────────
  const shown = useMemo(() => rulesFor(rules, agentFilter), [rules, agentFilter]);
  const enforcing = byMode(shown, "enforce"), watching = byMode(shown, "watch"), off = byMode(shown, "off");
  const groups = coverageGroups(shown);
  const canStop = stopping(shown);
  const overlap = spendOverlap(shown);
  // Viewing one agent: that agent's rule actions, to match the rules shown.
  const counts = actions ? tallyFromRuleActions(agentFilter ? actions.byAgent[agentFilter] ?? NO_ACTIONS : actions.totals) : null;
  const countWords = counts ? tallyWords(counts).map((w) => w.text).join(" · ") : "";
  const allowlistSuggestion = suggestions.onlyModels && !rules.some((r) => r.ruleType === "model_allowlist" && r.mode !== "off"
    && suggestions.onlyModels!.every((m) => (r.params as ModelAllowlistParams).allowedModels.includes(m))) ? suggestions.onlyModels : null;
  // The allowlist the suggestion would add to (see addSuggestedAllowlist), and the models it lacks.
  const allowlistTarget = allowlistSuggestion ? suggestedAllowlistTarget(rules) : undefined;
  const allowlistMissing = allowlistTarget ? allowlistSuggestion!.filter((m) => !(allowlistTarget.params as ModelAllowlistParams).allowedModels.includes(m)) : [];
  const typeCount = (t: GovernanceRuleType) => rules.filter((r) => r.ruleType === t).length;

  const row = (r: GovernanceRule) => {
    const s = ruleSentence(r);
    const scope = scopeLabel(r.appliesTo);
    const never = overlap?.never.id === r.id;
    // In Watch neither cap acts, so the overlap is about what they would do.
    const stat = never
      ? overlap!.never.mode === "watch"
        ? `Would never act: the ${money(overlap!.first.params as SpendCapParams)} cap would act first`
        : `Never acts: the ${money(overlap!.first.params as SpendCapParams)} cap acts first`
      : rowStat(r, { byRuleType: actions?.byRule, byRuleId: actions?.byRuleId, onlyOfItsType: typeCount(r.ruleType) === 1, wouldAct: wouldActs[`${r.id}@${r.version}`] ?? null, agent: agentFilter });
    return (
      <button key={r.id} type="button" className={`gov-row${r.id === selectedId ? " is-on" : ""}`} onClick={() => openRule(r.id)} disabled={saving} aria-current={r.id === selectedId || undefined}>
        <span style={{ minWidth: 0, flex: "1 1 320px" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 'var(--fs-sm)', color: "var(--tx2)", marginBottom: 2 }}>
            {RULE_LABELS[r.ruleType]}
            {r.mode === "watch" && <Tag tone="muted">{MODE_LABEL.watch}</Tag>}
            {/* Filled only when it really stops calls (stopping()): an alert-only rule, or one with nothing picked yet, isn't. */}
            {r.mode === "enforce" && (emptyPick(r)
              ? <Tag tone="muted">Not set up</Tag>
              : <Tag tone={stopping([r]).length ? "block" : "brand"}>{DOES_TAG[r.response ?? "block"]}</Tag>)}
          </span>
          {s.pre}<span style={{ fontFamily: FONT_MONO }}>{s.val}</span>{s.post}
        </span>
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, fontSize: 'var(--fs-sm)', color: "var(--tx2)" }}>
          <span>{scope.lead}<span style={{ fontFamily: FONT_MONO, color: "var(--tx)" }}>{scope.agents}</span></span>
          {stat && <span style={never || emptyPick(r) ? { color: "var(--warn-tx)" } : undefined}>{stat}</span>}
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
        list.length ? <div>{list.map(row)}</div> : <p style={{ margin: 0, padding: "14px 18px", fontSize: 'var(--fs-sm)', color: "var(--tx2)" }}>{loaded ? empty : "Loading…"}</p>
      )}
    </Panel>
  );

  const recent = history.slice(0, 5);

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, flex: 1 }}>
      {/* Split like the columns below, so the actions end where the rule list ends. */}
      <PageHeader title="Controls" fleetId={fleetId} split>
        <SelectChip
          label="Agent"
          value={agentFilter ?? "all"}
          onChange={(v) => guard(() => changeAgent(v === "all" ? null : v))}
          options={[{ value: "all", label: "All agents" }, ...(agentFilter && !agents.includes(agentFilter) ? [agentFilter] : []).concat(agents).map((a) => ({ value: a, label: a }))]}
        />
        <Button variant="primary" onClick={() => guard(() => setAdding("open"))}>Add rule</Button>
      </PageHeader>

      <div className="gov-columns">
        <main className="gov-list">
          {/* The cards count rules by mode; the list below groups them by who they cover. */}
          <p className="gov-eyebrow" style={{ margin: 0 }}>By mode</p>
          <section aria-label="Rules at a glance" className="wr-stat-strip" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
            <StatCard variant="card" label={MODE_GROUP.enforce} value={enforcing.length} sub={ruleNames(enforcing)} />
            <StatCard variant="card" label={MODE_GROUP.watch} hint={`${MODE_MEANING.watch} ${MODE_MEANING.enforce}`} value={watching.length} sub={ruleNames(watching)} />
            <StatCard variant="card" label="Off" value={off.length} sub={ruleNames(off)} />
            <StatCard variant="card" label={RULE_ACTIVITY} hint={`${HELP.ruleActions} Last 7 days.`} value={counts ? tallyTotal(counts).toLocaleString() : "—"}
              sub={!counts ? "last 7 days" : countWords ? `${countWords} · last 7 days` : "none in the last 7 days"} />
          </section>

          {error && !selected && <Banner variant="error" actions={<Button variant="ghost" size={28} onClick={() => setError(null)}>Dismiss</Button>}>{error}</Banner>}
          {notice && !selected && <Banner variant="info" icon="check" actions={<Button variant="ghost" size={28} onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Banner>}

          {loaded && shown.some((r) => r.mode !== "off") && canStop.length <= 1 && (
            <Banner variant="warn">
              {canStop.length === 0
                ? <>No rule stops calls yet, so every call goes through.</>
                : <>Only 1 rule can stop calls ({RULE_LABELS[canStop[0].ruleType]}). The others don&rsquo;t stop calls.</>}
            </Banner>
          )}

          {(overlap || suggestions.noCaching || allowlistSuggestion) && (
            <section aria-labelledby="gov-suggestions" style={{ display: "grid", gap: 10 }}>
              <h2 id="gov-suggestions" style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600 }}>Suggestions</h2>
              {overlap && (
                <Banner variant="warn" actions={<Button size={28} onClick={() => guard(() => setDialog({ kind: "remove", rule: overlap.never }))}>Remove the {money(overlap.never.params as SpendCapParams)} cap</Button>}>
                  {overlap.never.mode === "watch"
                    ? <>Your <span style={{ fontFamily: FONT_MONO }}>{money(overlap.never.params as SpendCapParams)}</span> cap would never act. Both are in Record only, and the <span style={{ fontFamily: FONT_MONO }}>{money(overlap.first.params as SpendCapParams)}</span> cap covers the same agents and would always act first.</>
                    : <>Your <span style={{ fontFamily: FONT_MONO }}>{money(overlap.never.params as SpendCapParams)}</span> cap will never act. The <span style={{ fontFamily: FONT_MONO }}>{money(overlap.first.params as SpendCapParams)}</span> cap covers the same agents and always acts first.</>}
                </Banner>
              )}

              {suggestions.noCaching && (
                <Banner variant="info" actions={<a href="https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching" target="_blank" rel="noopener noreferrer" className="wr-btn wr-btn--secondary wr-btn--h28" style={{ textDecoration: "none" }}>How to turn on caching</a>}>
                  None of your fleet’s input is cached, so agents pay full price for repeated context. Not a rule: caching is turned on in your client.
                </Banner>
              )}
              {allowlistSuggestion && (
                <Banner variant="info" actions={<Button size={28} busy={addingSuggestion} disabled={saving} busyLabel="Adding…" onClick={() => guard(() => void addSuggestedAllowlist(allowlistSuggestion))}>{!allowlistTarget ? "Add in Record only" : allowlistMissing.length ? "Add to your allowlist" : "Turn on in Record only"}</Button>}>
                  {allowlistTarget && !allowlistMissing.length
                    ? <>Your Model allowlist is Off. In Record only, it would have stopped 0 calls in the last 14 days.</>
                    : allowlistTarget
                    ? <>Your Model allowlist leaves out <span style={{ fontFamily: FONT_MONO }}>{allowlistMissing.join(", ")}</span>, which your fleet used in the last 14 days. With {allowlistMissing.length === 1 ? "it" : "them"} added, the allowlist would have stopped 0 calls.{allowlistTarget.mode === "off" ? " It goes to Record only." : ""}</>
                    : <>Your fleet only used <span style={{ fontFamily: FONT_MONO }}>{allowlistSuggestion.join(", ")}</span> in the last 14 days. A Model allowlist with {allowlistSuggestion.length === 1 ? "that model" : "those models"} would have stopped 0 calls.</>}
                </Banner>
              )}
            </section>
          )}

          {group(agentFilter ? `Rules for all agents (including ${agentFilter})` : "Rules for all agents", groups.all, "No rules cover every agent.")}
          {group(agentFilter ? `Rules just for ${agentFilter} (or a few agents)` : "Rules for specific agents", groups.some, "No rules for specific agents.")}
          {group("Off", groups.off, "No rules are off.", true)}

          <p style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: 'var(--fs-sm)', color: "var(--tx2)" }}>
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
              alertChannel={alertChannel}
              wouldAct={wouldActs[`${selected.id}@${selected.version}`] ?? null}
              history={history.filter((h) => h.ruleId === selected.id)}
              actors={actors}
              undoOf={undoOf}
              onUndo={undo}
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
            <p style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600 }}>Pick a rule to change it</p>
            <p style={{ margin: 0, fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: "var(--tx2)" }}>Or use Add rule. New rules start in Record only, so nothing is blocked until you say so.</p>
            {recent.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <p className="gov-eyebrow" style={{ marginTop: 6 }}>Recent changes</p>
                {recent.map((h) => (
                  <HistoryLine key={h.id} entry={h} withRule undo={undoOf(h)} onUndo={undo} busy={saving} />
                ))}
                <Link href={`${ROUTES.settings}#audit-integrity`} style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--brand)" }}>Audit integrity →</Link>
              </div>
            )}
          </aside>
        )}
      </div>

      <AddRuleDialog open={adding !== "closed"} busy={adding === "busy"} onPick={(t) => void add(t)} onCancel={() => setAdding("closed")} />

      <ConfirmDialog
        open={dialog?.kind === "enforce"}
        tone="neutral"
        title={dialog?.kind === "enforce" ? (dialog.next.response === "notify" ? `Turn on the ${RULE_LABELS[dialog.rule.ruleType]} rule?` : `Turn on Block for the ${RULE_LABELS[dialog.rule.ruleType]} rule?`) : ""}
        body={dialog?.kind === "enforce" ? <EnforcePreview rule={dialog.rule} next={dialog.next} wouldAct={wouldActs[`${dialog.rule.id}@${dialog.rule.version}`] ?? null} /> : null}
        confirmLabel={dialog?.kind === "enforce" && dialog.next.response === "notify" ? "Turn it on" : "Turn on Block"}
        cancelLabel={dialog?.kind === "enforce" && dialog.rule.mode === "watch" ? "Keep Record only" : "Cancel"}
        busy={saving}
        onConfirm={() => { if (dialog?.kind === "enforce" && draft) void commit(dialog.rule, draft); }}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "stop"}
        title="Let this rule stop agents?"
        body={dialog?.kind === "stop" ? <>{RESPONSE_EFFECT.stop} {appliesNow(dialog.next.appliesTo)}<span style={{ display: "block", marginTop: 8 }}>{UNNAMED_CALLS_REFUSED}</span></> : null}
        confirmLabel={RESPONSE_LABEL.stop}
        confirmPhrase={dialog?.kind === "stop" ? stopPhrase(dialog.next.appliesTo) : "stop"}
        busy={saving}
        onConfirm={() => { if (dialog?.kind === "stop" && draft) void commit(dialog.rule, draft); }}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "keyword"}
        title={dialog?.kind === "keyword" ? `Let this rule ${keywordVerb(dialog.next.response)} on incoming data?` : ""}
        body={dialog?.kind === "keyword" ? <>{ruleSentenceText(dialog.next)} The agent can’t go on with that data in its run: it sends the same data again on every call. {appliesNow(dialog.next.appliesTo)}{canAct(dialog.next) && <span style={{ display: "block", marginTop: 8 }}>{UNNAMED_CALLS_REFUSED}</span>}</> : null}
        confirmLabel={dialog?.kind === "keyword" && dialog.next.response === "pause" ? "Pause on incoming data" : "Block on incoming data"}
        confirmPhrase={dialog?.kind === "keyword" ? keywordPhrase(dialog.next.appliesTo, dialog.next.response) : "block"}
        busy={saving}
        onConfirm={() => { if (dialog?.kind === "keyword" && draft) void commit(dialog.rule, draft); }}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "remove"}
        title={dialog?.kind === "remove" ? `Remove the ${RULE_LABELS[dialog.rule.ruleType]} rule?` : ""}
        body={dialog?.kind === "remove" ? <>{ruleSentenceText(dialog.rule)} {dialog.rule.mode === "off" ? "It's off now, so nothing changes for your agents." : dialog.rule.mode === "watch" ? "It stops recording right away." : "It stops right away."} Its history stays in the audit chain.</> : null}
        confirmLabel="Remove rule"
        cancelLabel="Keep rule"
        busy={saving}
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

// Only a fleet-wide allowlist that isn't enforcing takes suggested models: an enforcing
// one stays as it is, and one for some agents isn't widened.
const suggestedAllowlistTarget = (rules: GovernanceRule[]) =>
  rules.find((r) => r.ruleType === "model_allowlist" && r.mode !== "enforce" && r.appliesTo === "all");

/** What enforcing would have done, from the rule's time in Watch; and the fleet-wide side effect, when there is one. */
function EnforcePreview({ rule, next, wouldAct }: { rule: GovernanceRule; next: GovernanceRule; wouldAct: RuleWouldActResult | null }) {
  const watched = rule.mode === "watch" && wouldAct;
  const n = watched ? Object.values(wouldAct.byAgent).reduce((a, b) => a + b, 0) : null;
  const tile = { background: "var(--sunk)", borderRadius: 7, padding: 12 } as const;
  const big = { display: "block", fontFamily: FONT_MONO, fontSize: 'var(--fs-xl)', fontWeight: 700, color: "var(--tx)" } as const;
  return (
    <>
      {ruleSentenceText(next)} {appliesNow(next.appliesTo)}
      <span style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 12 }}>
        <span style={tile}><span style={big}>{n === null ? "—" : n.toLocaleString()}</span>{watched && wouldAct.unversioned ? "times it would have acted, some maybe before its last change" : "times it would have acted"}</span>
        <span style={tile}><span style={big}>{watched && wouldAct.since ? timeAgo(wouldAct.since).replace(/ ago$/, "") : "—"}</span>{watched ? "in Record only, since its last change" : "Turn on Record only first to see what it would do"}</span>
      </span>
      {canAct(next) && <span style={{ display: "block", marginTop: 12 }}>{UNNAMED_CALLS_REFUSED}</span>}
    </>
  );
}
