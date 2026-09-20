'use client';

import { Sidebar } from '@/components/Sidebar';
import { TestRunFlow } from '@/components/sandbox/TestRunFlow';
import styles from '@/components/sandbox/sandbox.module.css';

export default function SandboxPage() {
  return <div className={`wr-shell ${styles.shell}`}><Sidebar /><div className={styles.main}><TestRunFlow /></div></div>;
}
