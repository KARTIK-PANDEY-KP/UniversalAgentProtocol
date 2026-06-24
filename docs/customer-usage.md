# Customer usage

Brainbase Model Runtime exposes OpenAI-compatible chat completions.

```python
from openai import OpenAI

client = OpenAI(api_key="BRAINBASE_API_KEY", base_url="https://api.brainbase.ai/v1")
response = client.chat.completions.create(
    model="brainbase-chat",
    messages=[{"role": "user", "content": "Say hello in one sentence."}],
)
print(response.choices[0].message.content)
```

Public model names:

- `brainbase-chat`
- `brainbase-code`
- `brainbase-agent`
- `brainbase-fast`
- `brainbase-premium`

The response `model` remains the public Brainbase model name. Internal provider models are hidden unless
debug routing metadata is explicitly requested.
