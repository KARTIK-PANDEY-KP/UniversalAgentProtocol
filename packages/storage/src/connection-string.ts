/**
 * A connection string carries a password, so anything that logs one or prints
 * one has to take it out first. Kept here because both the gateway and the
 * database CLI need it, and the alternative is two copies of a function whose
 * failure mode is a credential in a log aggregator.
 */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "(unparseable connection string)";
  }
}
