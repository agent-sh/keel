# OpenTelemetry export

Keel sends three signals to an OTLP/HTTP collector as JSON: traces, metrics and events. Set the
traces address in Settings, Logs and traces (or `OTEL_EXPORTER_OTLP_ENDPOINT` in the daemon's
environment). Metrics and events are off until you turn them on there, or name `otlp` in
`OTEL_METRICS_EXPORTER` or `OTEL_LOGS_EXPORTER`: a collector that takes only traces answers 404
to the rest.

Nothing that is sent holds a prompt, a reply, tool input or output, or a failure's message.
What leaves is names (model, provider, tool), counts, durations, tokens, cost and a failure's
class.

## Where each signal goes

| Signal | Address |
| --- | --- |
| Traces | the setting, else `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, else `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces` |
| Metrics | the traces setting with `/v1/metrics` in place of `/v1/traces`, else `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, else `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/metrics` |
| Events | the same with `/v1/logs` and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` |

Auth headers are the same for all three: the reference in the settings, else the signal's own
`OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS`, else `OTEL_EXPORTER_OTLP_HEADERS`.

## Resource

All three signals carry one resource: `service.name` (`keel`), the build, the process id and the SDK
name. The daemon's `OTEL_RESOURCE_ATTRIBUTES` (comma separated `key=value` pairs, percent-encoded)
adds to it or replaces a default, and `OTEL_SERVICE_NAME` sets `service.name` last. A pair that does
not parse is left out alone and named once in Health.

## Metrics

Delta temporality. A batch goes out `OTEL_METRIC_EXPORT_INTERVAL` milliseconds (default 60000)
after its first measurement; an idle daemon sends nothing. No metric carries a session id.

| Metric | Kind, unit | Attributes |
| --- | --- | --- |
| `keel.turn.count` | sum, `{turn}` | `gen_ai.request.model`, `keel.status`, `error.type` |
| `keel.turn.duration` | histogram, `s` | `gen_ai.request.model`, `keel.status` |
| `keel.request.count` | sum, `{request}` | `gen_ai.request.model`, `gen_ai.provider.name`, `keel.status`, `error.type`, `keel.purpose` |
| `keel.request.duration` | histogram, `s` | `gen_ai.request.model`, `gen_ai.provider.name`, `keel.status` |
| `keel.token.usage` | sum, `{token}` | `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.token.type` (`input`, `output`, `cache_read`, `cache_write`) |
| `keel.cost.usage` | sum, `USD` | `gen_ai.request.model`, `gen_ai.provider.name` |
| `keel.tool.count` | sum, `{call}` | `gen_ai.tool.name`, `keel.status` |
| `keel.tool.duration` | histogram, `s` | `gen_ai.tool.name`, `keel.status` |

`keel.status` is `ok`, `error` or `interrupted`.

## Events

Log records with `eventName`, each with `gen_ai.conversation.id` (the session) and, when it
comes from a span, that span's trace and span ids.

| Event | When | Attributes besides the session |
| --- | --- | --- |
| `keel.user_prompt` | a prompt reached a session | `keel.prompt.origin`, `keel.prompt.length`, `keel.prompt.files` |
| `keel.api_request` | a model request ended | model, provider, `keel.duration_ms`, `keel.attempt`, `keel.purpose`, status code, token counts |
| `keel.api_error` | a model request failed (severity ERROR) | the same, with `error.type` |
| `keel.tool_result` | a tool call ended | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `keel.status`, `keel.duration_ms`, input and result bytes |
| `keel.turn` | a turn ended | model, `keel.turn.reason`, `keel.status`, `keel.duration_ms` |

`POST /api/debug/export/flush` sends what waits now; `GET /api/debug/export` shows each
signal's address and counts.
