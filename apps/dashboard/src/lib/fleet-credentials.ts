export function clearFleetCredentials(): void {
  localStorage.removeItem('wr_token');
  localStorage.removeItem('wr_fleet');
  localStorage.removeItem('wr_fleet_token');
}
