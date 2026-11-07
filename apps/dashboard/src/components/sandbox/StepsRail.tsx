import s from './guided.module.css';

const DONE = <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2.5 6l2.5 2.5 4.5-4.5"/></svg>;

/** A Sandbox flow's numbered steps: those before `current` are done, `current` is where you are. */
export function StepsRail({ steps, current, label = 'Test steps' }: { steps: readonly { title: string; sub: string }[]; current: number; label?: string }) {
  return (
    <ol className={s.rail} aria-label={label}>
      {steps.map((step, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <li key={step.title} className={`${s.railStep} ${now ? s.railStepCurrent : ''}`} aria-current={now ? 'step' : undefined}>
            <span className={`${s.railNum} ${done ? s.railNumDone : now ? s.railNumCurrent : ''}`}>{done ? DONE : i + 1}</span>
            <span className={`${s.railTitle} ${!done && !now ? s.railTitleTodo : ''}`}>{step.title}</span>
            <span className={s.railSub}>{step.sub}</span>
          </li>
        );
      })}
    </ol>
  );
}
