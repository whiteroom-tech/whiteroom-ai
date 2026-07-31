import { createClient } from '@/lib/supabase/client';

export interface UserFleet {
  id: string;
  fleet_token: string;
  fleet_id: string | null;
  label: string;
  created_at: string;
}

const supabase = createClient();

export async function getUserFleets(): Promise<UserFleet[]> {
  const { data, error } = await supabase
    .from('user_fleets')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return [];
  return data ?? [];
}

export async function addUserFleet(
  fleetToken: string,
  fleetId: string | null,
  label: string
): Promise<{ ok: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { error } = await supabase.from('user_fleets').insert({
    user_id: user.id,
    fleet_token: fleetToken,
    fleet_id: fleetId,
    label,
  });

  if (error) {
    if (error.code === '23505') return { ok: false, error: 'Fleet already linked' };
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function removeUserFleet(id: string): Promise<void> {
  await supabase.from('user_fleets').delete().eq('id', id);
}

export async function updateFleetLabel(id: string, label: string): Promise<void> {
  await supabase.from('user_fleets').update({ label }).eq('id', id);
}
