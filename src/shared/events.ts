const eventModIdPattern = /^[1-9][0-9]{0,11}$/;

export function parseEventModId(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.toLowerCase() === "none") return null;
  if (!eventModIdPattern.test(value)) {
    throw new Error("event-mod-id must be a numeric CurseForge project ID or None");
  }
  return value;
}

export function eventModLabel(eventModId: string | null | undefined): string {
  return eventModId ? `mod ${eventModId}` : "not configured";
}
