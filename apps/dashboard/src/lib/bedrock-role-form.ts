// Validation and form state for the native Bedrock Runtime adapter (a cross-
// account IAM role, not an API key). Mirrors the engine's own checks
// (apps/engine/src/concepts/bedrock.ts) so a bad value is caught here instead
// of round-tripping to the engine first — the engine still re-validates, this
// is just a faster no.

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
// Matches the engine's floor: AWS allows ExternalId as short as 2 characters,
// but a short one weakens the registration's ownership-proof check (see
// concepts/bedrock.ts's EXTERNAL_ID_RE comment) — same 20-character minimum.
const EXTERNAL_ID_CHARSET_RE = /^[\w+=,.@:/-]*$/;
const EXTERNAL_ID_RE = /^[\w+=,.@:/-]{20,1224}$/;
const ROLE_ARN_RE = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@/-]+$/;

export interface BedrockRoleRequest {
  awsAccountId: string;
  roleArn: string;
  externalId: string;
  region: string;
}

export type BedrockRoleCheck = { ok: true; request: BedrockRoleRequest } | { ok: false; error: string };

/** A random value that satisfies EXTERNAL_ID_RE with real entropy — offered as a default, not forced. */
export function generateExternalId(): string {
  return crypto.randomUUID();
}

export function bedrockRoleRequest(roleArn: string, externalId: string, region: string): BedrockRoleCheck {
  const arn = roleArn.trim();
  const ext = externalId.trim();
  const reg = region.trim().toLowerCase();

  const m = ROLE_ARN_RE.exec(arn);
  if (!m) return { ok: false, error: 'role_arn must look like arn:aws:iam::<12-digit-account>:role/<name>.' };
  // ROLE_ARN_RE's capture group already enforces exactly 12 digits — no separate check needed.
  const awsAccountId = m[1];
  if (!REGION_RE.test(reg)) return { ok: false, error: 'Region must look like a real AWS region, e.g. us-east-1.' };
  if (!EXTERNAL_ID_RE.test(ext)) {
    if (!EXTERNAL_ID_CHARSET_RE.test(ext)) return { ok: false, error: 'External ID can only contain letters, digits, and + = , . @ : / -.' };
    if (ext.length < 20) return { ok: false, error: 'External ID must be at least 20 characters — use the generated one, or your own random value.' };
    return { ok: false, error: 'External ID must be 1224 characters or fewer.' };
  }

  return { ok: true, request: { awsAccountId, roleArn: arn, externalId: ext, region: reg } };
}

export interface RoleFormState {
  roleArn: string;
  externalId: string;
  region: string;
  status: 'idle' | 'saving' | 'error';
  msg: string;
}

export const EMPTY_ROLE_FORM: RoleFormState = { roleArn: '', externalId: '', region: '', status: 'idle', msg: '' };

export type RoleFormAction =
  | { type: 'edit'; field: 'roleArn' | 'externalId' | 'region'; text: string }
  | { type: 'saving' }
  | { type: 'error'; msg: string }
  | { type: 'connected' };

export function roleFormReducer(state: RoleFormState, action: RoleFormAction): RoleFormState {
  switch (action.type) {
    case 'edit':
      return { ...state, [action.field]: action.text, status: 'idle', msg: '' };
    case 'saving':
      return { ...state, status: 'saving', msg: '' };
    case 'error':
      return { ...state, status: 'error', msg: action.msg };
    case 'connected':
      return { ...EMPTY_ROLE_FORM };
  }
}

export function canSubmitRoleForm(state: RoleFormState): boolean {
  return state.status !== 'saving' && state.roleArn.trim() !== '' && state.externalId.trim() !== '' && state.region.trim() !== '';
}
