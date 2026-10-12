// The native Bedrock Runtime adapter's dashboard form: a cross-account IAM
// role (role_arn + external_id + region), not a bearer key. aws_account_id is
// derived from role_arn rather than asked for separately, since the engine
// rejects a mismatch anyway (concepts/bedrock.ts's validate()).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EMPTY_ROLE_FORM,
  bedrockRoleRequest,
  canSubmitRoleForm,
  generateExternalId,
  roleFormReducer,
} from '@/lib/bedrock-role-form';
import { BEDROCK_ROLE_LINES, BEDROCK_ROLE_SERVER_ID, PROXY_ORIGIN, bedrockRoleTrustPolicy } from '@/lib/setup';
import { deleteBedrockRole, getBedrockRoleStatus, storeBedrockRole } from '@/lib/whiteroom/client';

const ROLE_ARN = 'arn:aws:iam::123456789012:role/WhiteRoomBedrock';
const EXTERNAL_ID = 'a'.repeat(24);

describe('bedrockRoleRequest', () => {
  it('derives aws_account_id from role_arn and normalizes the region', () => {
    expect(bedrockRoleRequest(ROLE_ARN, EXTERNAL_ID, ' US-EAST-1 ')).toEqual({
      ok: true,
      request: { awsAccountId: '123456789012', roleArn: ROLE_ARN, externalId: EXTERNAL_ID, region: 'us-east-1' },
    });
  });

  it('refuses a role_arn that is not an IAM role ARN', () => {
    for (const bad of [
      '', 'arn:aws:iam::123456789012:user/not-a-role',
      'arn:aws:iam::12345:role/short-account',
      'not-an-arn-at-all',
    ]) {
      const check = bedrockRoleRequest(bad, EXTERNAL_ID, 'us-east-1');
      expect(check.ok, bad).toBe(false);
      if (!check.ok) expect(check.error).toMatch(/role_arn/);
    }
  });

  it('refuses a region that is not a real AWS region', () => {
    const check = bedrockRoleRequest(ROLE_ARN, EXTERNAL_ID, 'virginia');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(/region/i);
  });

  it('refuses an external ID under 20 characters, matching the engine floor', () => {
    const check = bedrockRoleRequest(ROLE_ARN, 'short-id', 'us-east-1');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(/20 characters/);
  });
});

describe('generateExternalId', () => {
  it('produces a value that passes validation and has real entropy', () => {
    const id = generateExternalId();
    const check = bedrockRoleRequest(ROLE_ARN, id, 'us-east-1');
    expect(check.ok).toBe(true);
    expect(generateExternalId()).not.toBe(generateExternalId());
  });
});

describe('roleFormReducer / canSubmitRoleForm', () => {
  it('starts empty and cannot submit until all three fields are filled', () => {
    expect(canSubmitRoleForm(EMPTY_ROLE_FORM)).toBe(false);
    let state = roleFormReducer(EMPTY_ROLE_FORM, { type: 'edit', field: 'roleArn', text: ROLE_ARN });
    expect(canSubmitRoleForm(state)).toBe(false);
    state = roleFormReducer(state, { type: 'edit', field: 'externalId', text: EXTERNAL_ID });
    expect(canSubmitRoleForm(state)).toBe(false);
    state = roleFormReducer(state, { type: 'edit', field: 'region', text: 'us-east-1' });
    expect(canSubmitRoleForm(state)).toBe(true);
  });

  it('cannot submit while saving, and clears back to empty once connected', () => {
    let state = roleFormReducer(EMPTY_ROLE_FORM, { type: 'edit', field: 'roleArn', text: ROLE_ARN });
    state = roleFormReducer(state, { type: 'saving' });
    expect(canSubmitRoleForm(state)).toBe(false);
    state = roleFormReducer(state, { type: 'connected' });
    expect(state).toEqual(EMPTY_ROLE_FORM);
  });

  it('surfaces an error message and keeps the typed fields', () => {
    let state = roleFormReducer(EMPTY_ROLE_FORM, { type: 'edit', field: 'roleArn', text: ROLE_ARN });
    state = roleFormReducer(state, { type: 'error', msg: 'nope' });
    expect(state.status).toBe('error');
    expect(state.msg).toBe('nope');
    expect(state.roleArn).toBe(ROLE_ARN);
  });
});

describe('Bedrock role client calls', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('store_bedrock_role sends snake_case fields, not the camelCase request shape', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const check = bedrockRoleRequest(ROLE_ARN, EXTERNAL_ID, 'us-east-1');
    if (!check.ok) throw new Error(check.error);
    await storeBedrockRole({ fleetId: 'f', apiKey: 'sk-wr-test', fleetToken: 'wr_test' }, check.request);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      action: 'store_bedrock_role',
      aws_account_id: '123456789012',
      role_arn: ROLE_ARN,
      external_id: EXTERNAL_ID,
      region: 'us-east-1',
    });
  });

  it('bedrock_role_status and delete_bedrock_role send only the action', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ configured: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await getBedrockRoleStatus({ fleetId: 'f', apiKey: 'sk-wr-test', fleetToken: 'wr_test' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ action: 'bedrock_role_status' });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await deleteBedrockRole({ fleetId: 'f', apiKey: 'sk-wr-test', fleetToken: 'wr_test' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toMatchObject({ action: 'delete_bedrock_role' });
  });
});

describe('bedrockRoleTrustPolicy and the SDK recipe', () => {
  it('names the external ID in the Condition block', () => {
    const policy = JSON.parse(bedrockRoleTrustPolicy(EXTERNAL_ID));
    expect(policy.Statement[0].Action).toBe('sts:AssumeRole');
    expect(policy.Statement[0].Condition.StringEquals['sts:ExternalId']).toBe(EXTERNAL_ID);
  });

  it('points boto3 at the proxy with a server_id matching the proxy host', () => {
    expect(BEDROCK_ROLE_SERVER_ID).toBe(new URL(PROXY_ORIGIN).hostname);
    const snippet = BEDROCK_ROLE_LINES.python('us-east-1');
    expect(snippet).toContain('whiteroom_bedrock.install(');
    expect(snippet).toContain(`endpoint_url="${PROXY_ORIGIN}"`);
    expect(snippet).toContain(`server_id="${BEDROCK_ROLE_SERVER_ID}"`);
    expect(snippet).toContain('region_name="us-east-1"');
  });
});
