import type {
  RegisterAgentResponse,
  PairAgentsResponse,
  AutoPairResponse,
  StartWatchResponse,
  CompleteTaskResponse,
  CompleteTaskReplay,
  CompleteTaskOptions,
  CheckWatchResponse,
  InitiateHandoverResponse,
  GenerateHandoverResponse,
  StoreHandoverResponse,
  GetHandoverResponse,
  FireAlarmResponse,
  FleetReport,
  AuditLogResponse,
  TokenLoginResponse,
  ListFleetsResponse,
  HandoverDoc,
  ApiError,
} from "./types.js";

export interface WhiteRoomConfig {
  baseUrl: string;
  apiKey?: string;
  /** Request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

export class WhiteRoomClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  private timeoutMs: number;

  constructor(config: WhiteRoomConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const data = await res.json();
    if (!res.ok) throw new WhiteRoomError(res.status, data as ApiError);
    return data as T;
  }

  async health(): Promise<{ status: string; app: string; version: string }> {
    const res = await fetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new WhiteRoomError(res.status, { error: `Health check failed (${res.status})` });
    }
    return res.json();
  }

  // -- Fleet management --

  async tokenLogin(fleetToken: string): Promise<TokenLoginResponse> {
    return this.post("/api/white-room", { action: "token_login", fleet_token: fleetToken });
  }

  async registerAgent(
    agentId: string,
    opts: { fleetId?: string; role?: string; llmEndpoint?: string } = {}
  ): Promise<RegisterAgentResponse> {
    return this.post("/api/white-room", {
      action: "register_agent",
      agent_id: agentId,
      fleet_id: opts.fleetId,
      agent_role: opts.role,
      llm_endpoint: opts.llmEndpoint,
    });
  }

  async pairAgents(
    agentId: string,
    pairedWith: string,
    fleetId?: string
  ): Promise<PairAgentsResponse> {
    return this.post("/api/white-room", {
      action: "pair_agents",
      agent_id: agentId,
      paired_with: pairedWith,
      fleet_id: fleetId,
    });
  }

  async autoPair(fleetId?: string): Promise<AutoPairResponse> {
    return this.post("/api/white-room", { action: "auto_pair", fleet_id: fleetId });
  }

  // -- Watch lifecycle --

  async startWatch(agentId: string, fleetId?: string): Promise<StartWatchResponse> {
    return this.post("/api/white-room", {
      action: "start_watch",
      agent_id: agentId,
      fleet_id: fleetId,
    });
  }

  /**
   * With `idempotencyKey`, a retry of the same call (same key and input,
   * within 24 hours) applies nothing and returns a CompleteTaskReplay.
   */
  completeTask(agentId: string, taskName: string, opts?: CompleteTaskOptions & { idempotencyKey?: undefined }): Promise<CompleteTaskResponse>;
  completeTask(agentId: string, taskName: string, opts: CompleteTaskOptions & { idempotencyKey?: string }): Promise<CompleteTaskResponse | CompleteTaskReplay>;
  async completeTask(
    agentId: string,
    taskName: string,
    opts: CompleteTaskOptions & { idempotencyKey?: string } = {}
  ): Promise<CompleteTaskResponse | CompleteTaskReplay> {
    return this.post("/api/white-room", {
      action: "complete_task",
      agent_id: agentId,
      task_name: taskName,
      fleet_id: opts.fleetId,
      minutes_spent: opts.minutesSpent,
      tokens_used: opts.tokensUsed,
      idempotency_key: opts.idempotencyKey,
    });
  }

  async checkWatch(agentId: string, fleetId?: string): Promise<CheckWatchResponse> {
    return this.post("/api/white-room", {
      action: "check_watch",
      agent_id: agentId,
      fleet_id: fleetId,
    });
  }

  // -- Handover --

  async initiateHandover(
    agentId: string,
    toAgent: string,
    opts: { fleetId?: string; contextSummary?: string; pendingTasks?: string[]; warnings?: string[] } = {}
  ): Promise<InitiateHandoverResponse> {
    return this.post("/api/white-room", {
      action: "initiate_handover",
      agent_id: agentId,
      to_agent: toAgent,
      fleet_id: opts.fleetId,
      context_summary: opts.contextSummary,
      pending_tasks: opts.pendingTasks,
      warnings: opts.warnings,
    });
  }

  async generateHandover(agentId: string, fleetId?: string): Promise<GenerateHandoverResponse> {
    return this.post("/api/white-room", {
      action: "generate_handover",
      agent_id: agentId,
      fleet_id: fleetId,
    });
  }

  async storeHandover(
    agentId: string,
    handoverDoc: HandoverDoc,
    fleetId?: string
  ): Promise<StoreHandoverResponse> {
    return this.post("/api/white-room", {
      action: "store_handover",
      agent_id: agentId,
      handover_doc: handoverDoc,
      fleet_id: fleetId,
    });
  }

  async getHandover(agentId: string, fleetId?: string): Promise<GetHandoverResponse> {
    return this.post("/api/white-room", {
      action: "get_handover",
      agent_id: agentId,
      fleet_id: fleetId,
    });
  }

  // -- Alarm & reporting --

  async fireAlarm(agentId: string, fleetId?: string): Promise<FireAlarmResponse> {
    return this.post("/api/white-room", {
      action: "fire_alarm",
      agent_id: agentId,
      fleet_id: fleetId,
    });
  }

  async auditLog(
    opts: { fleetId?: string; agentId?: string; type?: string; search?: string; limit?: number } = {}
  ): Promise<AuditLogResponse> {
    return this.post("/api/white-room", {
      action: "audit_log",
      fleet_id: opts.fleetId,
      agent_id: opts.agentId,
      type: opts.type,
      search: opts.search,
      limit: opts.limit,
    });
  }

  async fleetReport(fleetId?: string): Promise<FleetReport> {
    return this.post("/api/white-room", { action: "fleet_report", fleet_id: fleetId });
  }

  async listFleets(): Promise<ListFleetsResponse> {
    return this.post("/api/white-room", { action: "list_fleets" });
  }
}

export class WhiteRoomError extends Error {
  status: number;
  body: ApiError;
  constructor(status: number, body: ApiError) {
    super(body.error);
    this.name = "WhiteRoomError";
    this.status = status;
    this.body = body;
  }
}
