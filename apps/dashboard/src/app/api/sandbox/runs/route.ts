import { requireSandboxUser, requireSandboxMutation, SANDBOX_ID_RE } from "@/lib/sandbox/auth";
import { createRun, destroyRun, getStatus, toResponse, extractFleetToken } from "@/lib/sandbox/client";
import {
  type CloudProvider,
  endpointMismatchMessage,
  isCloudProvider,
  isEndpointError,
  isSandboxProvider,
  isUnsupportedProviderError,
  PROVIDER_UNSUPPORTED,
  unsupportedProviderMessage,
} from "@/lib/sandbox/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 65_536;
const MAX_ENDPOINT = 512;

export async function POST(req: Request) {
  const user = await requireSandboxMutation();
  if ("error" in user) return user.error;

  const cl = req.headers.get("content-length");
  if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
    return Response.json({ error: "Request too large." }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  // Anthropic and OpenAI (named or not): an sk- key and no endpoint, as
  // before. Azure OpenAI, Foundry and Bedrock: the https endpoint only. The
  // agent keeps its own key, so none is sent for them; the engine checks the
  // endpoint against its per-provider host rules, and this only bounds what
  // is forwarded.
  if (body.provider !== undefined && !isSandboxProvider(body.provider)) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const cloud = isCloudProvider(body.provider);

  if (cloud) {
    if (body.mode !== "connected" || body.apiKey !== undefined ||
        typeof body.endpoint !== "string" || body.endpoint.length > MAX_ENDPOINT || !isHttpsUrl(body.endpoint)) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  } else {
    if (body.endpoint !== undefined) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
    if (body.apiKey !== undefined) {
      if (typeof body.apiKey !== "string" || body.apiKey.length > 256 || !body.apiKey.startsWith("sk-")) {
        return Response.json({ error: "Invalid request." }, { status: 400 });
      }
    }
  }

  if (body.ttlMinutes !== undefined) {
    if (typeof body.ttlMinutes !== "number" || !Number.isInteger(body.ttlMinutes) || body.ttlMinutes < 1 || body.ttlMinutes > 1440) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  if (body.selectedCatalogIds !== undefined) {
    if (!Array.isArray(body.selectedCatalogIds) || body.selectedCatalogIds.length > 50 ||
        body.selectedCatalogIds.some((id: unknown) => typeof id !== "string" || (id as string).length > 128)) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  if (body.customControls !== undefined) {
    if (!Array.isArray(body.customControls) || body.customControls.length > 100) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  if (body.policyMode !== undefined) {
    if (body.policyMode !== "observe" && body.policyMode !== "enforce") {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  if (body.mode !== undefined) {
    if (body.mode !== "demo" && body.mode !== "connected") {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  const token = await extractFleetToken(req);
  const result = await createRun(user.ownerSubject, {
    apiKey: body.apiKey as string | undefined,
    ttlMinutes: body.ttlMinutes as number | undefined,
    selectedCatalogIds: body.selectedCatalogIds as string[] | undefined,
    customControls: body.customControls as unknown[] | undefined,
    policyMode: body.policyMode as "observe" | "enforce" | undefined,
    mode: body.mode as "demo" | "connected" | undefined,
    // Anthropic or OpenAI is forwarded for a connected test so status reports
    // it back (a reload shows the right code). The engine has accepted and
    // stored both since cloud Sandbox tests; older engines ignore it. A demo
    // names none: the engine refuses a provider for one.
    provider: cloud ? (body.provider as CloudProvider)
      : body.mode === "connected" && (body.provider === "anthropic" || body.provider === "openai") ? body.provider : undefined,
    endpoint: cloud ? (body.endpoint as string) : undefined,
  }, token);

  if (cloud) {
    const provider = body.provider as CloudProvider;
    const data = result.data as { success?: unknown; error?: unknown; sandboxId?: unknown; fleetToken?: unknown; proxyKey?: unknown };
    if (result.status === 400 && isUnsupportedProviderError(data.error)) {
      return unsupported(provider);
    }
    if (result.status === 400 && isEndpointError(data.error)) {
      return Response.json({ error: endpointMismatchMessage(provider) }, { status: 400 });
    }
    // An engine that predates cloud Sandbox tests ignores provider and makes a
    // plain test, with no proxy key for the agent to call through. Take it
    // down again rather than hand back a test that can't pass. Anything else
    // (including a 200 that carries an error, like "already have an active
    // sandbox") passes through as the engine sent it.
    if (data.success === true && typeof data.sandboxId === "string" && typeof data.proxyKey !== "string") {
      if (SANDBOX_ID_RE.test(data.sandboxId)) {
        await destroyRun(user.ownerSubject, data.sandboxId, typeof data.fleetToken === "string" ? data.fleetToken : token).catch(() => null);
      }
      return unsupported(provider);
    }
  }
  return toResponse(result);
}

function unsupported(provider: CloudProvider) {
  return Response.json({ error: unsupportedProviderMessage(provider), code: PROVIDER_UNSUPPORTED }, { status: 400 });
}

function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const user = await requireSandboxUser();
  if ("error" in user) return user.error;

  const token = await extractFleetToken(req);
  const result = await getStatus(user.ownerSubject, token);
  return toResponse(result);
}
