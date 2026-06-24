# Training data captured in traces

Runtime traces now persist the fields needed to build future router training datasets:

- request id, tenant id, public Brainbase model
- full request messages
- tools and response format
- candidate model ids
- routing budget and routing context
- policy name/version and policy metadata
- selected model and fallback usage
- input/output token counts
- latency and estimated cost
- assistant content and tool calls
- raw execution metadata
- shadow plan, shadow policy, and shadow selected model
- placeholder feedback signals and training labels

The placeholders for feedback and labels are intentionally structured JSON objects so future user feedback,
tool success, workflow success, quality scores, and human review labels can be added without changing the
customer API.
