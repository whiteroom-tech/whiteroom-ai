import { describe, it, expect } from "vitest";
// Guards the real helper the dashboard provisioning path uses, so this cannot
// drift from the implementation.
import { fleetProvisioned } from "../lib/whiteroom/client";

// Every payload below is a verbatim response captured from the production
// engine (proxy.whiteroom.tech), so these cases document actual API behaviour
// rather than an assumed contract.
describe("fleetProvisioned", () => {
  it("accepts a fresh create_fleet response", () => {
    expect(
      fleetProvisioned({
        fleetToken: "wr_cf39d6e8-f597-48dc-996b-2c9de1f028e0",
      }),
    ).toBe(true);
  });

  // create_fleet answers cleanly on repeat calls, but register_agent — which
  // provisioning used to call, and which other callers still use — returns
  // HTTP 200 with an "already registered" error AND a usable token. Reading
  // `error` as failure is what made the dashboard treat a healthy fleet as
  // broken, so the helper must keep tolerating that shape.
  it("accepts 'already registered', which carries an error AND a token", () => {
    expect(
      fleetProvisioned({
        error: "Agent 'setup-agent' already registered in fleet 'alexnyan2004-gmail-com'.",
        fleetToken: "wr_cf39d6e8-f597-48dc-996b-2c9de1f028e0",
      }),
    ).toBe(true);
  });

  it("rejects a key conflict (fleet bound to a different API key)", () => {
    expect(
      fleetProvisioned({
        error: "Unauthorized. Use the same API key that registered this fleet.",
      }),
    ).toBe(false);
  });

  it("rejects an uninitialised fleet", () => {
    expect(
      fleetProvisioned({
        error: "Fleet not found or not initialized. Register an agent first.",
      }),
    ).toBe(false);
  });

  it("rejects a transport failure", () => {
    expect(fleetProvisioned({ error: "HTTP 500" })).toBe(false);
  });

  it("rejects an empty or missing token rather than trusting the field's presence", () => {
    expect(fleetProvisioned({ fleetToken: "" })).toBe(false);
    expect(fleetProvisioned({})).toBe(false);
  });
});
