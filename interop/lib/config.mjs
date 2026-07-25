// The handful of addresses every part of the rig has to agree on. Separate
// from rig.mjs so the browser stand-in can read them without importing the
// process manager that starts the browser stand-in.
export const GATEWAY = "http://127.0.0.1:8801";
export const GATEWAY_KEY = "devkey";
export const ISSUER = "http://127.0.0.1:8821";
export const PROTECTED_URL = "http://127.0.0.1:8812/mcp";
