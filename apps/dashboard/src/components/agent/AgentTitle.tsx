import { FONT_MONO } from '@whiteroom/ui';
/** The page title: the agent's display name with its id beside it, or the id alone (gap-closing spec A2). */
export function AgentTitle({ agentId, name }: { agentId: string; name: string | null }) {
  return name && name !== agentId
    ? <span>{name}<span className="wr-agent-title__id">{agentId}</span></span>
    : <span style={{ fontFamily: FONT_MONO }}>{agentId}</span>;
}
