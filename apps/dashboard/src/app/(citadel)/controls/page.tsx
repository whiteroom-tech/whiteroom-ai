"use client";

// Controls (mockup parity, Oct 27): a lead line and Suggestions on top, rules
// in cards by who they cover (each row: kind, condition, 7-day count, mode),
// and the editor as a card on the right. Nothing reaches the engine until
// Save; every change ends in a toast with Undo.

import { HistoryLine } from "./_components/HistoryLine";
import { undoFor, type Undo } from "@/lib/rule-history";
import { DOES_TAG, MODE_LABEL } from '@/lib/vocab';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Banner, Button, FONT_MONO, Toast } from "@whiteroom/ui";
import { LiveStatus, PageHeader } from "@/components/citadel/PageChrome";
import { SuggestionDraft } from "./_components/SuggestionDraft";
import { RuleEditor } from "./_components/RuleEditor";
import { AddRuleDialog } from "./_components/AddRuleDialog";
import { AuditCheckDialog } from "./_components/AuditCheckDialog";
import { ChoiceDialog } from "./_components/ChoiceDialog";
import { useFleetAuth } from "@/hooks/useFleetAuth";
import {
  WhiteRoomApiError, alertsGet, controlFailure, governanceCreateRule, governanceDeleteRule, governanceList, governanceUpdateRule, isAuthError,
  performanceAgent, performanceFleetHourly, performanceIndex, ruleActions as fetchRuleActions, ruleWouldAct,
} from "@/lib/whiteroom/client";
import type {
  GovernanceHistoryEntry, GovernanceRule, GovernanceRuleType, KeywordParams, ModelAllowlistParams, RuleActionCounts, RuleActionsResult, RuleWouldActResult, SpendCapParams,
} from "@/lib/whiteroom/types";
import { computeSuggestions, RESPONSE_EFFECT, RESPONSE_LABEL, RULE_LABELS, tallyFromRuleActions, type GovernanceSuggestions } from "@/lib/governance";
import { FleetLogin } from "@/components/citadel/FleetLogin";
import { ConfirmDialog } from "@/components/citadel/ConfirmDialog";
import { fetchControlActors, oldestTime, type ControlActor } from "@/lib/control-actors";
import { canAct, keywordBlockCheck, keywordPhrase, keywordVerb, stopCheck, stopPhrase } from "@/lib/controls-guard";
import { fmtDay, HOUR_MS } from "@/lib/format";
import { localDay } from "@/lib/runs";
import { ROUTES } from "@/lib/routes";
import { UNNAMED_CALLS_REFUSED } from "@/lib/setup";
import {
  appliesNow, draftChanges, draftFrom, draftParams, draftProblem, isDirty, money, NO_ACTIONS, rulesFor, ruleSentenceText, spendOverlap,
  type RuleDraft,
  stopping,
  weakenings,
  averageDailySpend,
  sameValue,
  blocksWhen, duplicateRules, keywordGaps, keywordsShort, leadCounts, modeCount, notSetUp, ruleCondition, ruleConditionText, ruleGroups, rowCount, ruleStatus, whoFor,
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
  | { kind: "weaken"; rule: GovernanceRule; next: GovernanceRule; reasons: string[] }
  | { kind: "downgrade"; rule: GovernanceRule; next: GovernanceRule }
  /** Narrowing a rule for all agents: keep it and add a copy, or move it. `reasons`: anything else the edit weakens. */
  | { kind: "narrow"; rule: GovernanceRule; next: GovernanceRule; reasons: string[] }
  | { kind: "allow"; models: string[] }
  | { kind: "kwall"; rule: GovernanceRule }
  | { kind: "discard"; label: string; then: () => void };

/** The toast after a change: what happened, and how to undo it. */
type ToastState = { id: number; message: string; undo?: () => void };

function ControlsContent({ fleetId, authKey, onAuthError }: { fleetId: string; authKey: string | undefined; onAuthError: (msg?: string) => void }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The page's own path (the dev preview lives elsewhere), so ?agent= and ?rec= stay on it.
  const pathname = usePathname() ?? ROUTES.controls;
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
  // The fleet's average daily spend over the same 14 days, beside a dollars-a-day spend cap.
  const [dailySpend, setDailySpend] = useState<{ perDay: number; days: number } | null>(null);
  /** rule_would_act per Watch rule, keyed `${id}@${version}`. */
  const [wouldActs, setWouldActs] = useState<Record<string, RuleWouldActResult>>({});
  const [actions, setActions] = useState<RuleActionsResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fleetRef = useRef(fleetId);
  fleetRef.current = fleetId;
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
  /** When the rules were last read, for the header's "Live · updated". */
  const [listedAt, setListedAt] = useState<number | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [toast, setToastState] = useState<ToastState | null>(null);
  const toastId = useRef(0);
  const showToast = useCallback((message: string, undo?: () => void) => setToastState({ id: ++toastId.current, message, undo }), []);
  const [auditOpen, setAuditOpen] = useState(false);
  /** "Also covered by N rules for all agents", while one agent is picked. */
  const [alsoOpen, setAlsoOpen] = useState(false);
  /** Each agent's average daily spend (14 days), for a spend cap on specific agents; null: couldn't read. */
  const [agentSpend, setAgentSpend] = useState<Record<string, { perDay: number; days: number } | null>>({});
  /** Each agent's calls since a rule's last change, for the Block confirm's "every call" warning. */
  const [agentCalls, setAgentCalls] = useState<Record<string, number>>({});
  // Opening a rule moves focus into the editor on a wide screen (a phone's sheet focuses ‹ Controls).
  const focusEditor = useRef(false);

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
      setListedAt(Date.now());
      setListFailed(false);
      return true;
    } catch (e) {
      if (isAuthError(e)) { onAuthError(); return false; }
      setError("Couldn’t load your rules.");
      setListFailed(true);
      setLoaded(true);
      return false;
    }
  }, [fleetId, authKey, onAuthError, loadActors]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  // Rule actions over the last 7 days, as Performance counts them. Optional: no card line without them.
  useEffect(() => {
    let cancelled = false;
    const from = Date.now() - ACTIONS_HOURS * HOUR_MS;
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
    // Another fleet, or a failed read: never the last fleet's spend beside this one's cap.
    setDailySpend(null);
    // Each read on its own: a failed model index doesn't hide the spend, nor the other way round.
    const hourly = performanceFleetHourly(fleetId, SUGGESTION_HOURS, authKey);
    hourly.then((h) => { if (!cancelled) setDailySpend(averageDailySpend(h, SUGGESTION_HOURS / 24)); }, () => {});
    Promise.all([performanceIndex(fleetId, SUGGESTION_HOURS, authKey), hourly])
      .then(([index, h]) => { if (!cancelled) setSuggestions(computeSuggestions(index, h)); })
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
      focusEditor.current = !!id;
      setSelectedId(id);
      const r = id ? rules.find((x) => x.id === id) : null;
      setDraft(r ? draftFrom(r) : null);
    });
  };
  openRuleRef.current = openRule;
  // On a wide screen, focus goes to the editor's title once it shows, so the keyboard lands in it.
  useEffect(() => {
    if (!focusEditor.current || !selectedId || !draft) return;
    focusEditor.current = false;
    if (window.matchMedia?.('(max-width: 720px)').matches) return;
    document.getElementById('ctl-ed-title')?.focus({ preventScroll: false });
  }, [selectedId, draft]);
  // On phones the editor is a sheet over the list: Escape closes it, as ‹ Controls does
  // (an unsaved edit is asked about first). Not while a dialog is open over it.
  const sheetOpen = !!(selected && draft && !suggestionRec);
  useEffect(() => {
    if (!sheetOpen || dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && window.matchMedia('(max-width: 720px)').matches) openRuleRef.current(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen, dialog]);
  // On phones the sheet is modal: what's behind it (header, list, tab bar) is
  // inert, focus starts on ‹ Controls, and goes back where it was on close.
  // Follows the layout if the window crosses the phone width meanwhile.
  useEffect(() => {
    const phone = window.matchMedia?.('(max-width: 720px)');
    if (!sheetOpen || !phone) return;
    const from = document.activeElement as HTMLElement | null;
    const behind = [...document.querySelectorAll<HTMLElement>('.ctl-main, .wr-tabbar')];
    const apply = () => {
      behind.forEach((e) => { e.inert = phone.matches; });
      if (phone.matches) document.querySelector<HTMLElement>('aside.is-sheet .gov-edhead__back')?.focus();
    };
    apply();
    phone.addEventListener('change', apply);
    return () => {
      phone.removeEventListener('change', apply);
      behind.forEach((e) => { e.inert = false; });
      if (phone.matches && from?.isConnected) from.focus();
    };
  }, [sheetOpen]);

  /** The current URL with some search params changed (null removes one). */
  const withParams = (changes: Record<string, string | null>) => {
    const q = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(changes)) { if (v === null) q.delete(k); else q.set(k, v); }
    const s = q.toString();
    return s ? `${pathname}?${s}` : pathname;
  };

  // ── Save ────────────────────────────────────────────────────────
  /** Saves the draft, or asks first. */
  const save = (weakenChecked = false) => {
    if (!selected || !draft || !dirty) return;
    const problem = draftProblem(draft);
    if (problem) { setError(problem); return; }
    const parsed = draftParams(draft);
    const next: GovernanceRule = { ...selected, mode: draft.mode, response: draft.response, alsoNotify: draft.alsoNotify, appliesTo: draft.appliesTo, params: "params" in parsed ? parsed.params : selected.params };
    const ask = (d: Dialog) => setDialog(d);
    // Anything that makes the rule weaker is said and confirmed first (the change log can undo it).
    if (!weakenChecked) {
      const reasons = weakenings(selected, next);
      // Narrowing a rule for all agents asks who it should cover: a copy (the safe choice) or a move.
      if (selected.appliesTo === "all" && next.appliesTo !== "all" && next.appliesTo.length > 0) {
        return ask({ kind: "narrow", rule: selected, next, reasons: weakenings(selected, { ...next, appliesTo: "all" }) });
      }
      // Only stepping down from Block, nothing else weaker: "Stop blocking with this rule?"
      if (selected.mode === "enforce" && next.mode !== "enforce" && !weakenings(selected, { ...next, mode: selected.mode }).length) {
        return ask({ kind: "downgrade", rule: selected, next });
      }
      if (reasons.length) return ask({ kind: "weaken", rule: selected, next, reasons });
    }
    // A rule that would stop agents must have run in Watch for a day, and is confirmed by typing who it covers.
    const stop = stopCheck(selected, { mode: draft.mode, response: draft.response }, history);
    if (stop.kind === "blocked") { setError(stop.reason); return; }
    if (stop.kind === "confirm") return ask({ kind: "stop", rule: selected, next });
    // A Keywords rule that stops incoming data ends the run: the same day in Watch and typed confirmation.
    const kw = keywordBlockCheck(selected, { mode: draft.mode, response: draft.response, params: next.params }, history);
    if (kw.kind === "blocked") { setError(kw.reason); return; }
    if (kw.kind === "confirm") return ask({ kind: "keyword", rule: selected, next });
    if (draft.mode === "enforce" && selected.mode !== "enforce") return ask({ kind: "enforce", rule: selected, next });
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

  // The toast's Undo after a save puts the settings from before straight back: the person
  // just made that change and is taking it back, so it isn't asked about again. It's a new
  // entry in the change log, over the version that save made: if the rule changed again
  // since (another tab, a teammate), nothing is overwritten.
  const undoSaved = (before: GovernanceRule, saved: GovernanceRule) => {
    guard(() => void (async () => {
      const r = rules.find((x) => x.id === saved.id);
      if (!r) { showToast("That rule isn’t here any more, so there’s nothing to undo."); return; }
      if (r.version !== saved.version) { showToast("This rule changed again since, so Undo left it as it is."); return; }
      setSaving(true);
      setError(null);
      try {
        const { rule: back } = await governanceUpdateRule(fleetId, r.id, {
          mode: before.mode, response: before.response ?? "block", alsoNotify: !!before.alsoNotify, appliesTo: before.appliesTo, params: before.params,
          ifVersion: saved.version, description: "Undid the last change",
        }, authKey);
        setRules((rs) => rs.map((x) => (x.id === back.id && back.version >= x.version ? back : x)));
        if (selectedRef.current === back.id) setDraft(draftFrom(back));
        showToast(`Undone. ${RULE_LABELS[back.ruleType]} is ${MODE_LABEL[back.mode].toLowerCase()} again.`);
      } catch (e) {
        if (e instanceof WhiteRoomApiError && e.status === 409) showToast("This rule changed again since, so Undo left it as it is.");
        else handleError(e, "undo the change");
      } finally { setSaving(false); void fetchData(); }
    })());
  };
  const cancelDialog = () => setDialog(null);
  // A toast's Undo runs after later renders: through this ref it sees the page as it is then
  // (an edit made since is asked about first), not as it was when the toast opened.
  const live = useRef({ undoSaved: (_: GovernanceRule, __: GovernanceRule) => {}, restore: (_: GovernanceRule) => {}, undoAdded: (_: string) => {} });

  /** Undo of something this visit added: removes it again. */
  const undoAdded = async (ruleId: string) => {
    setSaving(true);
    setError(null);
    try {
      await governanceDeleteRule(fleetId, ruleId, authKey);
      setRules((rs) => rs.filter((r) => r.id !== ruleId));
      if (selectedRef.current === ruleId) { setSelectedId(null); setDraft(null); }
      showToast("Change undone.");
    } catch (e) { handleError(e, "undo the change"); }
    finally { setSaving(false); void fetchData(); }
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
      focusEditor.current = true;
      setSelectedId(created.id);
      setDraft(draftFrom(created));
      showToast(`${RULE_LABELS[rule.ruleType]} is back, in Record only.${rule.mode === "enforce" ? " Turn on Block when you’re ready." : ""}`);
      void fetchData();
    } catch (e) {
      handleError(e, "add the rule back");
    } finally {
      setSaving(false);
    }
  };

  // Narrowing a rule for all agents can keep it and add a copy just for the picked agents instead:
  // the original rule's settings (only the narrowing, none of the edit's other changes), in Record
  // only like any new rule. The original is left as it was.
  const copyFor = async (rule: GovernanceRule, agentsPicked: string[]) => {
    if (!agentsPicked.length || saving) return;
    const next = { ...rule, appliesTo: agentsPicked };
    // Already made (say, Save and Copy again): don't add a second, identical rule. Identical means
    // the same type, settings, response, alert and agents, whatever order the settings come in.
    if (rules.some((r) => r.ruleType === next.ruleType && sameValue(r.params, next.params) && sameValue(r.appliesTo, agentsPicked)
      && (r.response ?? "block") === (next.response ?? "block") && !!r.alsoNotify === !!next.alsoNotify)) {
      setDialog(null);
      setDraft((cur) => (cur ? { ...cur, appliesTo: "all" } : cur));
      setNotice(`There's already a copy for ${agentsPicked.join(", ")}. The rule for all agents is unchanged.`);
      return;
    }
    const forFleet = fleetId;
    setDialog(null);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { rule: created } = await governanceCreateRule(fleetId, {
        ruleType: next.ruleType, mode: "watch", response: next.response, alsoNotify: next.alsoNotify, params: next.params, appliesTo: agentsPicked,
        description: `Added a copy of the ${RULE_LABELS[next.ruleType]} rule for ${agentsPicked.join(", ")}`,
      }, authKey);
      // Signed into another fleet meanwhile: this answer isn't for the page now on screen.
      if (fleetRef.current !== forFleet) return;
      setRules((rs) => [...rs, created]);
      // The rest of the edit stays: only the narrowing is undone (the original keeps covering all agents).
      setDraft((cur) => (cur ? { ...cur, appliesTo: "all" } : cur));
      showToast(`Added a ${RULE_LABELS[next.ruleType]} rule just for ${agentsPicked.join(", ")}, in Record only. Everyone else keeps the original.`, () => live.current.undoAdded(created.id));
      void fetchData();
    } catch (e) {
      if (fleetRef.current === forFleet) handleError(e, "add the copy");
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
      const how = saved.mode === "enforce" ? (saved.response === undefined || saved.response === "block" ? "blocking" : "on") : saved.mode === "watch" ? "record only" : "off";
      showToast(`Saved. ${RULE_LABELS[saved.ruleType]} is ${how} for ${whoFor(saved.appliesTo)}.`, () => live.current.undoSaved(rule, saved));
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
  // Any rule can go, the last of its type too: Add rule brings a type back. Undo adds it back in Record only.
  const remove = async (rule: GovernanceRule, message = `Removed the ${RULE_LABELS[rule.ruleType]} rule.`) => {
    setDialog(null);
    setError(null);
    setSaving(true);
    try {
      await governanceDeleteRule(fleetId, rule.id, authKey);
      setRules((rs) => rs.filter((r) => r.id !== rule.id));
      if (selectedRef.current === rule.id) { setSelectedId(null); setDraft(null); }
      showToast(message, () => live.current.restore(rule));
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
      focusEditor.current = true;
      setSelectedId(rule.id);
      setDraft(draftFrom(rule));
      setNotice(null);
      void fetchData();
    } catch (e) { setAdding("closed"); handleError(e, "add the rule"); void fetchData(); }
  };

  // "Cover all agents": a copy of a Keywords rule for every agent, in Record only. The original stays.
  const coverAll = async (rule: GovernanceRule) => {
    setDialog(null);
    setSaving(true);
    setError(null);
    try {
      const { rule: created } = await governanceCreateRule(fleetId, {
        ruleType: "keyword", mode: "watch", response: rule.response, alsoNotify: rule.alsoNotify, params: rule.params, appliesTo: "all",
        description: `Added a copy of the ${RULE_LABELS.keyword} rule for all agents`,
      }, authKey);
      setRules((rs) => [...rs, created]);
      showToast(`${keywordsShort(rule.params as KeywordParams)} rule now covers all agents (Record only).`, () => live.current.undoAdded(created.id));
    } catch (e) { handleError(e, "add the rule for all agents"); }
    finally { setSaving(false); void fetchData(); }
  };

  /**
   * The allowlist suggestion. For all agents: the models go into the fleet-wide
   * allowlist (a new one in Record only when there's none). For one agent only:
   * the engine checks every allowlist that covers an agent, so a model is
   * allowed for one agent by giving that agent its own copy with the model
   * added, and narrowing the original to the other agents.
   */
  const addSuggestedAllowlist = async (models: string[], onlyFor: string | null = null) => {
    if (saving) return;
    setDialog(null);
    setSaving(true);
    setAddingSuggestion(true);
    setError(null);
    setNotice(null);
    const description = "Added Model allowlist in Record only (suggested)";
    // A fleet-wide allowlist that isn't enforcing takes the models (and goes to Watch). Otherwise, a new rule.
    const target = suggestedAllowlistTarget(rules);
    const label = models.join(", ");
    try {
      if (!target) {
        const { rule: created } = await governanceCreateRule(fleetId, { ruleType: "model_allowlist", mode: "watch", params: { allowedModels: models }, description }, authKey);
        showToast("Added a Model allowlist in Record only.", () => live.current.undoAdded(created.id));
      } else if (onlyFor) {
        const prev = (target.params as ModelAllowlistParams).allowedModels;
        const others = agents.filter((a) => a !== onlyFor);
        // The copy first, so the agent is never left without an allowlist.
        const { rule: copy } = await governanceCreateRule(fleetId, {
          ruleType: "model_allowlist", mode: "watch", response: target.response, alsoNotify: target.alsoNotify,
          params: { allowedModels: [...prev, ...models.filter((m) => !prev.includes(m))] }, appliesTo: [onlyFor],
          description: `Added a copy of the ${RULE_LABELS.model_allowlist} rule for ${onlyFor}, also allowing ${label}`,
        }, authKey);
        let narrowed: GovernanceRule;
        try {
          ({ rule: narrowed } = await governanceUpdateRule(fleetId, target.id, { appliesTo: others, ifVersion: target.version, description: `Now covers every agent but ${onlyFor}` }, authKey));
        } catch (e) {
          // The original still covers everyone, so the copy alone changes nothing: take it away again.
          await governanceDeleteRule(fleetId, copy.id, authKey).catch(() => setNotice(`A copy of the allowlist for ${onlyFor} was left in place. Remove it under Rules for specific agents.`));
          throw e;
        }
        showToast(`${label} allowed for ${onlyFor}.`, () => void (async () => {
          setSaving(true);
          // Widen the original first: if a step fails, the agent is still covered (by both), never by neither.
          let widened = false;
          try {
            await governanceUpdateRule(fleetId, target.id, { appliesTo: "all", ifVersion: narrowed.version }, authKey);
            widened = true;
            await governanceDeleteRule(fleetId, copy.id, authKey);
            showToast("Change undone.");
          } catch (e) {
            if (widened) setError(`The allowlist covers every agent again, but its copy for ${onlyFor} couldn’t be removed. Remove it under Rules for specific agents.`);
            else handleError(e, "undo the change");
          }
          finally { setSaving(false); void fetchData(); }
        })());
      } else {
        const prev = (target.params as ModelAllowlistParams).allowedModels;
        const { rule: updated } = await governanceUpdateRule(fleetId, target.id, { mode: "watch", params: { allowedModels: [...models.filter((m) => !prev.includes(m)), ...prev] }, description }, authKey);
        const added = models.some((m) => !prev.includes(m));
        showToast(added ? `${label} allowed for all agents.` : "Turned your Model allowlist on in Record only.", () => void (async () => {
          setSaving(true);
          try {
            await governanceUpdateRule(fleetId, target.id, { mode: target.mode, params: target.params, ifVersion: updated.version }, authKey);
            showToast("Change undone.");
          } catch (e) { handleError(e, "undo the change"); }
          finally { setSaving(false); void fetchData(); }
        })());
      }
    } catch (e) { handleError(e, "add the suggested allowlist"); }
    // Busy until the list reloads and the suggestion goes, so a second click can't add another rule.
    try { await fetchData(); } finally { setSaving(false); setAddingSuggestion(false); }
    // The rule's version moved: an open editor on it reopens from the saved rule.
    if (target && selectedRef.current === target.id) setDraft(null);
  };

  live.current = { undoSaved, restore: (r) => void restore(r), undoAdded: (id) => void undoAdded(id) };

  /** Shows one agent's rules (null: all); an open rule that isn't among them closes. */
  const changeAgent = (agent: string | null) => {
    router.replace(withParams({ agent }));
    const open = rules.find((r) => r.id === selectedRef.current);
    if (open && !rulesFor([open], agent).length) { setSelectedId(null); setDraft(null); }
  };

  // ── What the page shows ─────────────────────────────────────────
  const shown = useMemo(() => rulesFor(rules, agentFilter), [rules, agentFilter]);
  const groups = useMemo(() => ruleGroups(shown), [shown]);
  const canStop = stopping(shown);
  const overlap = spendOverlap(shown);
  const neverFirst = (r: GovernanceRule) => (overlap?.never.id === r.id ? money(overlap.first.params as SpendCapParams) : null);
  // Viewing one agent: that agent's rule actions, to match the rules shown.
  const counts = actions ? tallyFromRuleActions(agentFilter ? actions.byAgent[agentFilter] ?? NO_ACTIONS : actions.totals) : null;
  const typeCount = (t: GovernanceRuleType) => rules.filter((r) => r.ruleType === t).length;
  /** A rule's own counts over the last 7 days, when the engine sends them. */
  const weekOf = (r: GovernanceRule): RuleActionCounts | undefined =>
    actions?.byRuleId ? actions.byRuleId[r.id] ?? NO_ACTIONS : typeCount(r.ruleType) === 1 && actions?.byRule ? actions.byRule[r.ruleType] ?? NO_ACTIONS : undefined;
  const wouldOf = (r: GovernanceRule) => wouldActs[`${r.id}@${r.version}`] ?? null;

  // Suggestions, each one line with its button.
  const allowlistSuggestion = suggestions.onlyModels && !rules.some((r) => r.ruleType === "model_allowlist" && r.mode !== "off"
    && suggestions.onlyModels!.every((m) => (r.params as ModelAllowlistParams).allowedModels.includes(m))) ? suggestions.onlyModels : null;
  const allowlistTarget = allowlistSuggestion ? suggestedAllowlistTarget(rules) : undefined;
  const allowlistMissing = allowlistTarget ? allowlistSuggestion!.filter((m) => !(allowlistTarget.params as ModelAllowlistParams).allowedModels.includes(m)) : [];
  // Who the allowlist caught since its last change: one agent can have the model just for itself.
  const allowCaught = allowlistTarget && allowlistTarget.mode === "watch" ? Object.entries(wouldOf(allowlistTarget)?.byAgent ?? {}).filter(([, n]) => n > 0) : [];
  const allowOnlyFor = allowlistTarget && allowlistMissing.length && allowCaught.length === 1 && agents.length > 1 && agents.includes(allowCaught[0][0]) ? allowCaught[0][0] : null;
  const dups = duplicateRules(rules);
  const kwGaps = keywordGaps(rules, agents);
  const suggestionCount = kwGaps.length + dups.length + (overlap ? 1 : 0) + (allowlistSuggestion ? 1 : 0) + (suggestions.noCaching ? 1 : 0);

  // Each covered agent's own daily spend, beside a dollars-a-day cap for specific agents.
  const spendAgents = draft && draft.ruleType === "spend_cap" && (draft.params as SpendCapParams).unit === "dollars" && (draft.params as SpendCapParams).scope === "day" && draft.appliesTo !== "all"
    ? draft.appliesTo.slice(0, 3) : [];
  const spendKey = spendAgents.join("\n");
  // Each agent is read once per fleet; an answer for a fleet no longer shown is dropped.
  const spendAsked = useRef(new Set<string>());
  useEffect(() => {
    for (const a of spendKey ? spendKey.split("\n") : []) {
      if (spendAsked.current.has(a)) continue;
      spendAsked.current.add(a);
      const forFleet = fleetId;
      performanceAgent(fleetId, a, SUGGESTION_HOURS, authKey)
        .then((p) => averageDailySpend(p, SUGGESTION_HOURS / 24), () => null)
        .then((v) => { if (fleetRef.current === forFleet) setAgentSpend((m) => ({ ...m, [a]: v })); });
    }
  }, [spendKey, fleetId, authKey]);
  useEffect(() => { spendAsked.current = new Set(); setAgentSpend({}); setAgentCalls({}); }, [fleetId]);

  // Before Block on an allowlist: each caught agent's calls over the same time, to see if it would lose all of them.
  const enforceRule = dialog?.kind === "enforce" ? dialog.rule : null;
  const enforceWould = enforceRule ? wouldOf(enforceRule) : null;
  useEffect(() => {
    if (!enforceRule || enforceRule.ruleType !== "model_allowlist" || !enforceWould?.since || enforceWould.unversioned) return;
    let cancelled = false;
    const hours = Math.min(SUGGESTION_HOURS, Math.max(1, Math.ceil((Date.now() - Date.parse(enforceWould.since)) / HOUR_MS)));
    for (const [a, n] of Object.entries(enforceWould.byAgent).slice(0, 5)) {
      if (!n) continue;
      performanceAgent(fleetId, a, hours, authKey).then((p) => { if (!cancelled && !p.error) setAgentCalls((m) => ({ ...m, [`${enforceRule.id}:${a}`]: p.totals.calls })); }, () => {});
    }
    return () => { cancelled = true; };
  }, [enforceRule, enforceWould, fleetId, authKey]);

  const modeTag = (r: GovernanceRule) => {
    if (notSetUp(r)) return <span className="ctl-mtag is-off">Not set up</span>;
    if (r.mode === "off") return <span className="ctl-mtag is-off">{MODE_LABEL.off}</span>;
    if (r.mode === "watch") return <span className="ctl-mtag">{MODE_LABEL.watch}</span>;
    const response = r.response ?? "block";
    return <span className={`ctl-mtag${response === "notify" ? "" : " is-block"}`}>{response === "block" ? MODE_LABEL.enforce : DOES_TAG[response]}</span>;
  };

  const row = (r: GovernanceRule, showScope = false, key: string = r.id) => {
    const c = ruleCondition(r);
    const count = rowCount(r, { byRuleId: actions?.byRuleId, byRuleType: actions?.byRule, onlyOfItsType: typeCount(r.ruleType) === 1, wouldAct: wouldOf(r), agent: agentFilter, neverFirst: neverFirst(r) });
    const response = r.response ?? "block";
    return (
      <button key={key} type="button" className={`ctl-row${r.id === selectedId ? " is-on" : ""}${r.mode === "enforce" ? " is-block" : ""}`} onClick={() => openRule(r.id)} disabled={saving} aria-pressed={r.id === selectedId}>
        <span className="ctl-row__main">
          <span className="ctl-cap">{RULE_LABELS[r.ruleType]}{response !== "block" && ` · ${RESPONSE_LABEL[response]}`}</span>
          <span>{c.pre}{c.val && <span style={{ fontFamily: FONT_MONO }}>{c.val}</span>}{c.post}</span>
        </span>
        {showScope && <span className="ctl-cap">{r.appliesTo === "all" ? "All agents" : r.appliesTo.join(", ")}</span>}
        {count.text && <span className={`ctl-row__count is-${count.tone}`}>{count.text}</span>}
        {modeTag(r)}
      </button>
    );
  };

  const card = (title: React.ReactNode, sub: React.ReactNode, body: React.ReactNode, extra?: React.ReactNode, label?: string) => (
    <section className="wr-panel ctl-card" aria-label={label}>
      <div className="ctl-card__head">
        <div style={{ minWidth: 0 }}>
          <h2 className="wr-panel__title ctl-card__title">{title}</h2>
          {sub && <p className="ctl-cap" style={{ margin: "2px 0 0" }}>{sub}</p>}
        </div>
        {extra}
      </div>
      {body}
    </section>
  );

  const offCount = groups.off.length + groups.unset.length;
  const offSub = [groups.off.length ? `${groups.off.length} off` : "", groups.unset.length ? `${groups.unset.length} not set up: ${[...new Set(groups.unset.map((r) => RULE_LABELS[r.ruleType].toLowerCase()))].join(", ")}` : ""].filter(Boolean).join(" · ");
  const offCard = card(
    <>Off and not set up <span className="wr-panel__count">{offCount}</span></>,
    offCount ? offSub : "Every rule is on.",
    offOpen && offCount ? <div>{groups.off.concat(groups.unset).map((r) => row(r, true))}</div> : null,
    offCount ? <Button size={32} onClick={() => setOffOpen((v) => !v)} aria-expanded={offOpen}>{offOpen ? "Hide" : "Show"}</Button> : undefined,
  );

  const lists = !agentFilter ? (
    <>
      {card("Rules for all agents", groups.all.length ? `${modeCount(groups.all)} · new agents get these too` : "No rules cover every agent.", <div>{groups.all.map((r) => row(r))}</div>)}
      {card("Rules for specific agents", groups.byAgent.length ? `Only ${groups.byAgent.map((g) => g.agent).join(", ")} ${groups.byAgent.length > 1 ? "have" : "has"} extra rules` : "No agent has extra rules.",
        groups.byAgent.map((g) => (
          <div key={g.agent}>
            <div className="ctl-owner">
              <Link href={`/agents/${encodeURIComponent(g.agent)}`} style={{ fontFamily: FONT_MONO }}>{g.agent}</Link>
              <span className="ctl-cap">{g.rules.length} {g.rules.length === 1 ? "rule" : "rules"}</span>
            </div>
            {g.rules.map((r) => row(r, false, `${g.agent}:${r.id}`))}
          </div>
        )))}
      {offCard}
    </>
  ) : (
    <>
      {(() => {
        const mine = groups.byAgent.find((g) => g.agent === agentFilter)?.rules ?? [];
        return card(<>Only for <span style={{ fontFamily: FONT_MONO }}>{agentFilter}</span></>, mine.length ? modeCount(mine) : "No extra rules. Covered by the rules for all agents.",
          mine.length ? <div>{mine.map((r) => row(r))}</div> : (
            <div className="ctl-row ctl-row--static">
              <span className="ctl-cap" style={{ flex: "1 1 240px" }}>This agent follows the rules for all agents below.</span>
              <Button size={32} onClick={() => guard(() => setAdding("open"))}>Add a rule for {agentFilter}</Button>
            </div>
          ));
      })()}
      <section className="wr-panel ctl-card">
        <button type="button" className="ctl-disc" aria-expanded={alsoOpen} onClick={() => setAlsoOpen((v) => !v)}>
          <span className="ctl-disc__chev" aria-hidden="true">›</span>
          Also covered by {groups.all.length} {groups.all.length === 1 ? "rule" : "rules"} for all agents
          <span className="ctl-cap" style={{ marginLeft: "auto" }}>{modeCount(groups.all)}</span>
        </button>
        {alsoOpen && <div>{groups.all.map((r) => row(r))}</div>}
      </section>
      {offCard}
    </>
  );

  const lead = leadCounts(shown);
  const blocked = counts ? counts.blocks + (counts.paused ?? 0) + (counts.stopped ?? 0) : 0;
  const caught = counts ? blocked + counts.wouldBlocks + (counts.toldYou ?? 0) : 0;
  const warnIcon = <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: "none", color: "var(--warn)" }}><path d="M9 2l7.5 13h-15z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M9 7v4M9 13v.5" stroke="currentColor" strokeWidth="1.6" /></svg>;
  const infoIcon = <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: "none", color: "var(--tx2)" }}><circle cx="9" cy="9" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M9 8v5M9 5.5v.5" stroke="currentColor" strokeWidth="1.6" /></svg>;
  const mono = (t: string) => <span style={{ fontFamily: FONT_MONO }}>{t}</span>;
  const suggestion = (key: string, icon: React.ReactNode, text: React.ReactNode, action: React.ReactNode) => (
    <div key={key} className="ctl-row ctl-row--static ctl-sugg">{icon}<span className="ctl-sugg__text">{text}</span>{action}</div>
  );

  const recent = history.slice(0, 6);
  const edited = selected && draft ? selected : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, flex: 1 }}>
      <div className="wr-page-body ctl-body">
        <div className="ctl-layout">
          <div className="ctl-main">
            <PageHeader title="Controls" fleetId={fleetId} badge={listed ? <LiveStatus at={listedAt} failing={listFailed} /> : undefined}>
              <label className="ctl-cover-label" htmlFor="ctl-cover">Which rules cover</label>
              <span className="wr-select ctl-cover">
                <select id="ctl-cover" value={agentFilter ?? "all"} onChange={(e) => { const v = e.target.value; guard(() => changeAgent(v === "all" ? null : v)); }}>
                  {[{ value: "all", label: "All agents" }, ...(agentFilter && !agents.includes(agentFilter) ? [agentFilter] : []).concat(agents).map((a) => ({ value: a, label: a }))].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </span>
              <Button variant="primary" size={36} onClick={() => guard(() => setAdding("open"))}>Add rule</Button>
            </PageHeader>

            {!listed ? (
              error ? (
                <section className="wr-panel ctl-card ctl-state" role="alert">
                  <p style={{ margin: 0, fontWeight: 600 }}>Couldn’t load your rules.</p>
                  <p className="ctl-cap" style={{ margin: 0 }}>Nothing has changed. Check your connection and try again.</p>
                  <Button onClick={() => { setError(null); setLoaded(false); void fetchData(); }} style={{ alignSelf: "flex-start" }}>Try again</Button>
                </section>
              ) : <p className="ctl-cap" role="status" style={{ margin: 0 }}>Loading your rules…</p>
            ) : (
              <>
                {error && !selected && <Banner variant="error" actions={<Button variant="ghost" size={28} onClick={() => setError(null)}>Dismiss</Button>}>{error}</Banner>}
                {notice && !selected && <Banner variant="info" icon="check" actions={<Button variant="ghost" size={28} onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Banner>}

                {rules.length > 0 && (
                  <div>
                    <p className="ctl-lead">
                      {lead.total} {lead.total === 1 ? "rule" : "rules"} · <strong>{lead.enforce}</strong> Block · <strong>{lead.watch}</strong> Record only
                      {lead.off > 0 && <> · <strong>{lead.off}</strong> Off</>}
                      {counts && <> · <strong>{caught.toLocaleString("en-US")}</strong> caught this week, <strong>{blocked.toLocaleString("en-US")}</strong> blocked</>}
                    </p>
                    {/* Only when some active rule doesn't stop calls: a fleet whose one rule stops calls is fine. */}
                    {canStop.length <= 1 && shown.some((r) => r.mode !== "off" && !canStop.includes(r)) && (
                      <p className="ctl-amber">
                        {canStop.length === 0
                          ? <><strong>No rule blocks yet</strong>, so every call goes through.</>
                          : <><strong>Only 1 rule blocks</strong>, and {blocksWhen(canStop[0])}.</>}
                      </p>
                    )}
                  </div>
                )}

                {suggestionCount > 0 && (
                  <section className="wr-panel ctl-card" aria-labelledby="gov-suggestions">
                    <div className="ctl-card__head"><h2 id="gov-suggestions" className="wr-panel__title ctl-card__title">Suggestions <span className="wr-panel__count">{suggestionCount}</span></h2></div>
                    {kwGaps.map((r) => suggestion(`kw:${r.id}`, warnIcon,
                      <>{keywordsShort(r.params as KeywordParams)} rule covers only {r.appliesTo === "all" ? "" : r.appliesTo.length > 2 ? `${r.appliesTo.length} agents` : r.appliesTo.join(", ")} ({r.appliesTo === "all" ? 0 : r.appliesTo.length} of {agents.length}).</>,
                      <Button onClick={() => guard(() => setDialog({ kind: "kwall", rule: r }))} disabled={saving}>Cover all agents…</Button>))}
                    {dups.map((g) => suggestion(`dup:${g.keep.id}`, warnIcon,
                      <>{g.extra.length === 1 ? "Two" : g.extra.length + 1} identical {RULE_PLURAL[g.keep.ruleType]} ({ruleConditionText(g.keep).replace(/^./, (c) => c.toLowerCase())}).</>,
                      <Button onClick={() => guard(() => void remove(g.extra[g.extra.length - 1], `Duplicate ${RULE_LABELS[g.keep.ruleType]} rule removed.`))} disabled={saving}>Remove one</Button>))}
                    {overlap && suggestion("overlap", warnIcon,
                      <>{mono(money(overlap.never.params as SpendCapParams))} cap never triggers. The {mono(money(overlap.first.params as SpendCapParams))} cap catches it first.</>,
                      <Button onClick={() => guard(() => setDialog({ kind: "remove", rule: overlap.never }))} disabled={saving}>Remove {money(overlap.never.params as SpendCapParams)} cap</Button>)}
                    {allowlistSuggestion && suggestion("allow", infoIcon,
                      allowlistTarget && allowlistMissing.length
                        ? <>Allowlist is missing {mono(allowlistMissing.join(", "))}, used in the last 14 days.</>
                        : allowlistTarget
                        ? <>Your Model allowlist is off. It has every model your fleet used in the last 14 days.</>
                        : <>Your fleet used only {mono(allowlistSuggestion.join(", "))} in the last 14 days. An allowlist with {allowlistSuggestion.length === 1 ? "it" : "them"} would catch every other model.</>,
                      <Button busy={addingSuggestion} busyLabel="Adding…" disabled={saving} onClick={() => guard(() => setDialog({ kind: "allow", models: allowlistSuggestion }))}>
                        {allowlistTarget && allowlistMissing.length ? "Add to allowlist…" : allowlistTarget ? "Turn on in Record only…" : "Add allowlist…"}
                      </Button>)}
                    {suggestions.noCaching && suggestion("cache", infoIcon,
                      <>None of your fleet’s input is cached, so agents pay full price for repeated context. Caching is turned on in your client.</>,
                      <a href="https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching" target="_blank" rel="noopener noreferrer" className="wr-btn wr-btn--secondary wr-btn--h32">How to turn on caching</a>)}
                  </section>
                )}

                {rules.length === 0 ? (
                  <section className="wr-panel ctl-card ctl-state">
                    <h2 className="wr-panel__title ctl-card__title">No rules yet</h2>
                    <p className="ctl-cap" style={{ margin: 0 }}>Add a rule to record what your agents do. New rules start as Record only, so nothing is blocked until you say so.</p>
                    <Button variant="primary" onClick={() => guard(() => setAdding("open"))} style={{ alignSelf: "flex-start" }}>Add rule</Button>
                  </section>
                ) : lists}
              </>
            )}

            <p className="ctl-cap" style={{ margin: 0 }}>Not covered: Claude Code signed in with OAuth.</p>
          </div>

          {suggestionRec ? (
            <aside aria-label="Suggested rule" className="wr-panel ctl-editor">
              <SuggestionDraft
                fleetId={fleetId}
                authKey={authKey}
                recId={suggestionRec}
                existingRule={rules.find((r) => r.sourceRecommendationId === suggestionRec) ?? null}
                onDone={(ruleId, message) => {
                  if (message) showToast(message);
                  router.replace(withParams({ rec: null }));
                  // Select the new rule only once the list that holds it has loaded.
                  void fetchData().then((ok) => { if (ok) { setSelectedId(ruleId); setDraft(null); } });
                }}
                onCancel={(ruleCreated) => { router.replace(withParams({ rec: null })); if (ruleCreated) void fetchData(); }}
              />
            </aside>
          ) : edited && draft ? (
            <>
              {/* Phones only (globals.css): the dimmed list above the sheet; tapping it goes back, as ‹ Controls does. */}
              <div className="gov-scrim" aria-hidden="true" onClick={() => openRule(null)} />
              <aside aria-label="Edit rule" className="wr-panel ctl-editor is-sheet">
                {notice && <Banner variant="info" icon="check" actions={<Button variant="ghost" size={28} onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Banner>}
                <RuleEditor
                  rule={edited}
                  draft={draft}
                  onDraft={(d) => { setDraft(d); setError(null); }}
                  agents={agents}
                  govV1={govV1}
                  alertChannel={alertChannel}
                  history={history.filter((h) => h.ruleId === edited.id)}
                  actors={actors}
                  undoOf={undoOf}
                  fleetDailySpend={dailySpend}
                  agentSpend={spendAgents.flatMap((a) => (agentSpend[a] ? [{ agent: a, ...agentSpend[a]! }] : []))}
                  status={ruleStatus(edited, { week: weekOf(edited), wouldAct: wouldOf(edited), neverFirst: neverFirst(edited) })}
                  weekCaught={weekOf(edited)?.wouldAct ?? null}
                  onAudit={() => setAuditOpen(true)}
                  onUndo={undo}
                  dirty={dirty}
                  error={error}
                  saving={saving}
                  onSave={() => save()}
                  onDiscard={() => { setDraft(draftFrom(edited)); setError(null); }}
                  onClose={() => openRule(null)}
                  onRemove={() => setDialog({ kind: "remove", rule: edited })}
                />
              </aside>
            </>
          ) : (
            <aside aria-label="Rule details" className="wr-panel ctl-editor is-empty">
              <h2 className="ctl-ed-title">Select a rule to edit it</h2>
              <p className="ctl-cap" style={{ margin: "-8px 0 8px" }}>New rules start as Record only.</p>
              {recent.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <p className="gov-eyebrow">Recent changes</p>
                  {recent.map((h) => (
                    <HistoryLine key={h.id} entry={h} actors={actors} withRule compact undo={undoOf(h)} onUndo={undo} busy={saving} />
                  ))}
                </div>
              )}
              <Button onClick={() => setAuditOpen(true)} style={{ alignSelf: "flex-start" }}>Check audit trail</Button>
            </aside>
          )}
        </div>
      </div>

      {toast && <Toast key={toast.id} message={toast.message} action={toast.undo ? { label: "Undo", onClick: toast.undo } : undefined} onClose={() => setToastState((t) => (t?.id === toast.id ? null : t))} />}

      <AddRuleDialog open={adding !== "closed"} busy={adding === "busy"} onPick={(t) => void add(t)} onCancel={() => setAdding("closed")} />
      <AuditCheckDialog open={auditOpen} fleetId={fleetId} onClose={() => setAuditOpen(false)} />

      <ChoiceDialog
        open={dialog?.kind === "enforce"}
        title={dialog?.kind === "enforce" ? (dialog.next.response === "notify" ? "Turn on alerts for this rule?" : dialog.next.response === "block" || !dialog.next.response ? "Start blocking with this rule?" : `Let this rule ${RESPONSE_LABEL[dialog.next.response].toLowerCase()}?`) : ""}
        body={dialog?.kind === "enforce" ? <EnforcePreview rule={dialog.rule} next={dialog.next} wouldAct={wouldOf(dialog.rule)} week={weekOf(dialog.rule)} agentCalls={agentCalls} /> : null}
        busy={saving}
        cancelLabel={null}
        choices={[
          { label: dialog?.kind === "enforce" && dialog.rule.mode === "watch" ? "Keep recording only" : "Cancel", onClick: cancelDialog },
          { label: dialog?.kind === "enforce" && dialog.next.response === "notify" ? "Turn it on" : dialog?.kind === "enforce" && (dialog.next.response ?? "block") !== "block" ? "Turn it on" : "Start blocking", tone: "primary", onClick: () => { if (dialog?.kind === "enforce" && draft) void commit(dialog.rule, draft); } },
        ]}
        onCancel={cancelDialog}
      />
      <ChoiceDialog
        open={dialog?.kind === "downgrade"}
        title="Stop blocking with this rule?"
        body={dialog?.kind === "downgrade" ? (
          <>
            <p style={{ margin: "0 0 8px" }}><strong>{RULE_LABELS[dialog.rule.ruleType]}</strong> · {ruleConditionText(dialog.rule)}</p>
            <p style={{ margin: 0 }}>Calls that match will go through for {whoFor(dialog.next.appliesTo)}. {dialog.next.mode === "watch" ? "WhiteRoom will still record them." : "Nothing will be recorded."} The change is recorded, and you can undo it.</p>
          </>
        ) : null}
        busy={saving}
        cancelLabel={null}
        choices={[
          { label: "Keep blocking", tone: "primary", onClick: cancelDialog },
          { label: `Switch to ${dialog?.kind === "downgrade" ? MODE_LABEL[dialog.next.mode] : ""}`, tone: "bad", onClick: () => { setDialog(null); save(true); } },
        ]}
        onCancel={cancelDialog}
      />
      <ChoiceDialog
        open={dialog?.kind === "narrow"}
        title="Who should this rule cover?"
        stacked
        body={dialog?.kind === "narrow" ? (
          <>
            <p style={{ margin: "0 0 4px" }}><strong>{RULE_LABELS[dialog.rule.ruleType]}</strong> · {ruleConditionText(dialog.rule)}</p>
            <p className="ctl-cap" style={{ margin: 0 }}>Today it covers all {agents.length} agents, and new agents get it too.</p>
            {dialog.reasons.length > 0 && <p className="ctl-cap" style={{ margin: "8px 0 0" }}>Moving it also saves your other changes: {dialog.reasons.join("; ")}.</p>}
          </>
        ) : null}
        busy={saving}
        choices={dialog?.kind === "narrow" && dialog.next.appliesTo !== "all" ? [
          { label: <>Keep it for everyone, and add a copy just for {dialog.next.appliesTo.join(", ")}</>, tone: "primary", onClick: () => { if (dialog?.kind === "narrow" && dialog.next.appliesTo !== "all") void copyFor(dialog.rule, dialog.next.appliesTo); } },
          { label: <>Move it to {dialog.next.appliesTo.join(", ")} only: {loseCount(agents, dialog.next.appliesTo)}</>, tone: "bad", onClick: () => { setDialog(null); save(true); } },
        ] : []}
        onCancel={cancelDialog}
      />
      <ChoiceDialog
        open={dialog?.kind === "allow"}
        title={dialog?.kind === "allow" ? (allowlistTarget && allowlistMissing.length ? `Allow ${allowlistMissing.join(", ")}?` : allowlistTarget ? "Turn on the Model allowlist?" : "Add a Model allowlist?") : ""}
        body={dialog?.kind === "allow" ? (
          allowlistTarget && allowlistMissing.length ? (
            <>
              <p style={{ margin: "0 0 8px" }}>
                {allowCaught.length
                  ? <>Since it was last changed, the allowlist caught {allowCaught.map(([a, n]) => <span key={a}><strong>{n.toLocaleString("en-US")} {n === 1 ? "call" : "calls"}</strong> from {mono(a)}</span>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}. </>
                  : <>The allowlist hasn’t caught anything since it was last changed. </>}
                Calls to {mono(allowlistMissing.join(", "))} won’t be caught once {allowlistMissing.length === 1 ? "it’s" : "they’re"} allowed.
              </p>
              <p className="ctl-cap" style={{ margin: 0 }}>
                {allowOnlyFor
                  ? <>Applies to all agents. Or allow it for {allowOnlyFor} only: {allowOnlyFor} gets its own copy of the allowlist, and agents added later aren’t covered by the allowlist until you add them.</>
                  : <>Applies to all agents{allowlistTarget.mode === "off" ? ", in Record only" : ""}.</>}
              </p>
            </>
          ) : allowlistTarget
            ? <p style={{ margin: 0 }}>It goes to Record only: it records calls to other models and blocks nothing.</p>
            : <p style={{ margin: 0 }}>A Model allowlist with {mono(dialog.models.join(", "))}, in Record only: it records calls to other models and blocks nothing.</p>
        ) : null}
        busy={saving}
        choices={dialog?.kind === "allow" ? [
          ...(allowOnlyFor ? [{ label: `Allow for ${allowOnlyFor} only`, onClick: () => void addSuggestedAllowlist(dialog.models, allowOnlyFor) }] : []),
          { label: allowlistTarget && allowlistMissing.length ? "Allow for all agents" : allowlistTarget ? "Turn on in Record only" : "Add in Record only", tone: "primary" as const, onClick: () => void addSuggestedAllowlist(dialog.models) },
        ] : []}
        onCancel={cancelDialog}
      />
      <ChoiceDialog
        open={dialog?.kind === "kwall"}
        title={dialog?.kind === "kwall" ? `Cover all agents with the ${keywordsShort(dialog.rule.params as KeywordParams)} rule?` : ""}
        body={dialog?.kind === "kwall" ? (
          <>
            <p style={{ margin: "0 0 8px" }}>It will apply to all {agents.length} agents, in <strong>Record only</strong>. Nothing is blocked until you switch it to Block.</p>
            <p className="ctl-cap" style={{ margin: 0 }}>{dialog.rule.appliesTo === "all" ? "" : dialog.rule.appliesTo.join(", ")} {dialog.rule.appliesTo !== "all" && dialog.rule.appliesTo.length > 1 ? "keep their" : "keeps its"} own copy, so nothing changes for {dialog.rule.appliesTo !== "all" && dialog.rule.appliesTo.length > 1 ? "them" : "it"}.</p>
          </>
        ) : null}
        busy={saving}
        choices={[{ label: "Cover all agents", tone: "primary", onClick: () => { if (dialog?.kind === "kwall") void coverAll(dialog.rule); } }]}
        onCancel={cancelDialog}
      />
      <ConfirmDialog
        open={dialog?.kind === "stop"}
        title="Let this rule stop agents?"
        body={dialog?.kind === "stop" ? <>{RESPONSE_EFFECT.stop} {appliesNow(dialog.next.appliesTo)}<span style={{ display: "block", marginTop: 8 }}>{UNNAMED_CALLS_REFUSED}</span></> : null}
        confirmLabel={RESPONSE_LABEL.stop}
        confirmPhrase={dialog?.kind === "stop" ? stopPhrase(dialog.next.appliesTo) : "stop"}
        busy={saving}
        onConfirm={() => { if (dialog?.kind === "stop" && draft) void commit(dialog.rule, draft); }}
        onCancel={cancelDialog}
      />
      <ConfirmDialog
        open={dialog?.kind === "keyword"}
        title={dialog?.kind === "keyword" ? `Let this rule ${keywordVerb(dialog.next.response)} on incoming data?` : ""}
        body={dialog?.kind === "keyword" ? <>{ruleSentenceText(dialog.next)} The agent can’t go on with that data in its run: it sends the same data again on every call. {appliesNow(dialog.next.appliesTo)}{canAct(dialog.next) && <span style={{ display: "block", marginTop: 8 }}>{UNNAMED_CALLS_REFUSED}</span>}</> : null}
        confirmLabel={dialog?.kind === "keyword" && dialog.next.response === "pause" ? "Pause on incoming data" : "Block on incoming data"}
        confirmPhrase={dialog?.kind === "keyword" ? keywordPhrase(dialog.next.appliesTo, dialog.next.response) : "block"}
        busy={saving}
        onConfirm={() => { if (dialog?.kind === "keyword" && draft) void commit(dialog.rule, draft); }}
        onCancel={cancelDialog}
      />
      <ConfirmDialog
        open={dialog?.kind === "weaken"}
        title={dialog?.kind === "weaken" ? `Make the ${RULE_LABELS[dialog.rule.ruleType]} rule weaker?` : ""}
        body={dialog?.kind === "weaken" ? (
          <>
            <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>{dialog.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            The change is recorded, and you can undo it.
          </>
        ) : null}
        confirmLabel="Save the change"
        cancelLabel="Keep it as it is"
        busy={saving}
        onConfirm={() => { setDialog(null); save(true); }}
        onCancel={cancelDialog}
      />

      <ConfirmDialog
        open={dialog?.kind === "remove"}
        title={dialog?.kind === "remove" ? `Remove the ${RULE_LABELS[dialog.rule.ruleType]} rule?` : ""}
        body={dialog?.kind === "remove" ? <>{ruleSentenceText(dialog.rule)} {dialog.rule.mode === "off" ? "It's off now, so nothing changes for your agents." : dialog.rule.mode === "watch" ? "It stops recording right away." : "It stops right away."} Its history stays in the audit chain.</> : null}
        confirmLabel="Remove rule"
        cancelLabel="Keep rule"
        busy={saving}
        onConfirm={() => { if (dialog?.kind === "remove") void remove(dialog.rule); }}
        onCancel={cancelDialog}
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
        onCancel={cancelDialog}
      />
    </div>
  );
}

/** "Two identical loop breakers": each kind of rule, more than one. */
const RULE_PLURAL: Record<GovernanceRuleType, string> = {
  spend_cap: "spend caps", loop_breaker: "loop breakers", call_rate: "call rate rules", model_allowlist: "model allowlists", tool_list: "tool lists", keyword: "Keywords rules",
};

/** "6 agents will lose this rule", for moving a rule from all agents to some. */
const loseCount = (agents: string[], kept: string[]) => {
  const n = agents.filter((a) => !kept.includes(a)).length;
  return `${n} ${n === 1 ? "agent" : "agents"} will lose this rule`;
};

// Only a fleet-wide allowlist that isn't enforcing takes suggested models: an enforcing
// one stays as it is, and one for some agents isn't widened.
const suggestedAllowlistTarget = (rules: GovernanceRule[]) =>
  rules.find((r) => r.ruleType === "model_allowlist" && r.mode !== "enforce" && r.appliesTo === "all");

/**
 * What Block would have done: the last 7 days, and how long it has been
 * recording since its last change. An allowlist that caught every call an
 * agent made says so: that agent would stop working.
 */
function EnforcePreview({ rule, next, wouldAct, week, agentCalls }: {
  rule: GovernanceRule; next: GovernanceRule; wouldAct: RuleWouldActResult | null; week: RuleActionCounts | undefined; agentCalls: Record<string, number>;
}) {
  const watched = rule.mode === "watch";
  const n = watched && week ? week.wouldAct : watched && wouldAct ? Object.values(wouldAct.byAgent).reduce((a, b) => a + b, 0) : null;
  const since = watched && wouldAct?.since ? fmtDay(wouldAct.since) : null;
  const all = wouldAct && !wouldAct.unversioned && next.ruleType === "model_allowlist"
    ? Object.entries(wouldAct.byAgent).filter(([a, c]) => c > 0 && agentCalls[`${rule.id}:${a}`] !== undefined && c >= agentCalls[`${rule.id}:${a}`] && (next.appliesTo === "all" || next.appliesTo.includes(a)))
    : [];
  return (
    <>
      <p style={{ margin: "0 0 4px" }}><strong>{RULE_LABELS[next.ruleType]}</strong> · {ruleConditionText(next)}</p>
      <p className="ctl-cap" style={{ margin: "0 0 14px" }}>Applies to {whoFor(next.appliesTo)}</p>
      <div className="ctl-tiles">
        <div className="ctl-tile"><div className="ctl-tile__lbl">Would have blocked</div><div className="ctl-tile__num">{n === null ? "—" : n ? `${n.toLocaleString("en-US")} ${n === 1 ? "call" : "calls"}` : "no calls"}</div><div className="ctl-cap">{week || !watched ? "last 7 days" : "since its last change"}</div></div>
        <div className="ctl-tile"><div className="ctl-tile__lbl">Recording since</div><div className="ctl-tile__num">{since ?? "—"}</div><div className="ctl-cap">{watched ? "since its last change" : "Turn on Record only first to see what it would do"}</div></div>
      </div>
      {all.map(([a, c]) => (
        <p key={a} className="ctl-warnbox"><strong>This would block every call {a} makes.</strong> None of its {c.toLocaleString("en-US")} {c === 1 ? "call" : "calls"} since the last change used a model on this allowlist. Add its model first if {a} should keep working.</p>
      ))}
      <p style={{ margin: "14px 0 0" }}>{next.response === "notify" ? "From now on, a call that matches sends you an alert. The call goes through." : "From now on, a call that matches fails with a plain reason. The agent keeps going."}</p>
      {canAct(next) && <p className="ctl-cap" style={{ margin: "8px 0 0" }}>{UNNAMED_CALLS_REFUSED}</p>}
    </>
  );
}
