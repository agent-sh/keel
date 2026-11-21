# Headless sessions: keel run

`keel run -p PROMPT` sends one prompt and prints the answer. `keel run --input-format stream-json`
holds one session open: a script writes JSON lines to standard input and reads JSON lines from
standard output until it closes the input. Both work with a daemon running (`keel serve`) and
without one: with none, the command runs the session inside itself and stops it at the end.

Schema version of the lines: 1 (`schema_version` on the first line). The version goes up when a
line a script reads changes its meaning or loses a field. A new field or a new line type does not
move it, so ignore what you do not know.

## A held session

```bash
keel run --input-format stream-json [--permission-mode MODE] [--on-ask deny|stdin|wait|exit]
         [--include-partial-messages] [--steer] [-r ID | -c] [-m MODEL] [-C DIR] [--timeout S]
```

`--input-format stream-json` implies `--output-format stream-json`. A prompt given as an argument
is the first message. `--attach`, `--wait`, `--queue`, `--json` and `--idempotency-key` are for a
single prompt and are refused here.

A client in a few lines:

```python
import json, subprocess

p = subprocess.Popen(["keel", "run", "--input-format", "stream-json"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

def ask(text):
    p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n")
    p.stdin.flush()
    for line in p.stdout:
        m = json.loads(line)
        if m["type"] == "result":
            return m

print(ask("Name the files in this folder.")["result"])
print(ask("Which one is the largest?")["result"])
p.stdin.close()
print("exit", p.wait())
```

### Input lines

One JSON object per line.

A prompt:

```json
{"type":"user","message":{"role":"user","content":"Fix the failing test."},"uuid":"m1"}
```

- `content` is a string, or a list of `{"type":"text","text"}` and
  `{"type":"image","source":{"type":"base64","media_type","data"}}` blocks.
- `uuid` is optional. The result of the turn that took the message names it in
  `user_message_uuids`.
- Prompts run one after another, each in a turn of its own: the next one is sent when the turn
  before it has ended. So prompts written in one go are answered in order. With `--steer` each
  prompt is sent at once and joins the turn that runs, and several can share one result.

An interrupt:

```json
{"type":"control_request","request_id":"r1","request":{"subtype":"interrupt"}}
```

- It stops the turn that runs. The answer is
  `{"type":"control_response","response":{"subtype":"success","request_id":"r1"}}`, written when
  the turn has ended, and the turn's result has `subtype: "cancelled"`.
- The session stays open. Prompts written before the interrupt that were not sent yet still run.
- Any other control request is answered with `subtype: "error"`. The permission mode cannot be
  changed over the stream: it is set with `--permission-mode` when the command starts.

An answer to a permission request or a question (only with `--on-ask stdin`, see below):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"ID","response":{"behavior":"allow"}}}
{"type":"control_response","response":{"subtype":"success","request_id":"ID","response":{"behavior":"deny","message":"Not in this folder."}}}
{"type":"control_response","response":{"subtype":"success","request_id":"ID","response":{"answers":{"0":{"picked":["Teal"]}}}}}
```

A line that is none of these is skipped and said back as
`{"type":"system","subtype":"input_error","error"}`. The session goes on.

### Output lines

| Line | When | Fields |
| --- | --- | --- |
| `system` / `init` | once, when the first prompt was accepted | `schema_version`, `session_id`, `cwd`, `model`, `provider`, `permission_mode`, `on_ask`, `capabilities`, `url` |
| `user` | a prompt was stored, or tool results came back | `message.content`: text blocks, or `tool_result` blocks with `tool_use_id`, `content`, `is_error` |
| `assistant` | a reply of the model | `message.content`: `text`, `thinking` and `tool_use` blocks (`id`, `name`, `input`) |
| `stream_event` | with `--include-partial-messages`, as the reply streams | `event.delta.type`: `text_delta`, `thinking_delta` or `input_json_delta`; `event.delta.text` |
| `system` / other | every other stored event (`turn_start`, `turn_end`, `error`, `note`, ...) | `subtype` is the event's kind |
| `control_request` | with `--on-ask stdin`: a call needs an answer | `request_id`, `request.subtype`: `can_use_tool` (`tool_name`, `tool_use_id`, `input`, `summary`, `risk`) or `ask_question` (`tool_use_id`, `input`) |
| `control_cancel_request` | an open request closed without the script (its turn was stopped, or it was answered in the workbench) | `request_id` |
| `control_response` | the answer to a control request of the script | `response.subtype`: `success` or `error`, `response.request_id` |
| `system` / `permission_denied` | a request was refused here | `request_id`, `tool_name`, `tool_use_id`, `reason` |
| `system` / `input_error` | an input line was not taken | `error`, `request_id` when it names one |
| `result` | a turn ended | see below |

`user`, `assistant` and the other `system` lines of stored events also carry `session_id`, `seq`,
`id`, `ts_ms` and the stored event itself as `event`.

One `result` line is written per turn:

```json
{"type":"result","subtype":"success","is_error":false,"result":"The answer.","session_id":"...",
 "num_turns":2,"duration_ms":5120,"usage":{"input_tokens":16,"output_tokens":8,
 "cache_read_input_tokens":184,"cache_creation_input_tokens":0},"total_cost_usd":0.000228,
 "outcome":"success","url":"http://127.0.0.1:47960/s/...","on_ask":"deny","user_message_uuids":["m1"]}
```

- `subtype`: `success`, `cancelled` (interrupted), `error_during_execution`, `needs_input` (the
  session waits for the owner) or `timeout`.
- `result`: the last text the model wrote in the turn, or the error.
- `usage`: this turn's tokens. `total_cost_usd` and `num_turns`: the whole command so far.
  `total_cost_usd` is null when a model in it has no listed price.
- `refused_approvals`: how many requests were refused in the turn, when any.
- A turn that work in the background starts (an agent's report) gets a result too.

### Permission requests

The session's permission mode decides what runs without asking (`--permission-mode`, the same
flag a person uses). A call the mode asks about is never allowed silently:

- `--on-ask deny` (the default here): the request is refused at once, a `permission_denied` line
  says so, the model is told, and the turn goes on.
- `--on-ask stdin`: the request is written as a `control_request` and the turn waits for the
  script's `control_response`. `allow` covers that one call. A standing grant is the owner's to
  give in the workbench. When standard input closes, open requests and later ones are refused.
- `--on-ask wait`: the request stays open for the owner to answer in the workbench.
- `--on-ask exit`: the command writes a `needs_input` result and exits 2. Not available when the
  command runs the daemon itself.

### How it ends

The command reads until standard input closes, then stays until the prompts it took have run and
the work they left in the background has ended (`--no-wait-background`: until the last turn has
ended). The session is kept and can be resumed with `-r ID`.

| Exit code | Meaning |
| --- | --- |
| 0 | the last result was `success`, or no prompt was sent |
| 2 | the last result was `needs_input`: the session waits for the owner |
| 3 | the last result was an error or `cancelled`; a usage error; the first prompt was refused (no session was made, the reason is on standard error) |
| 124 | `--timeout` ran out |
| 130, 143 | SIGINT, SIGTERM: the turn that ran was stopped |

The same codes hold for `keel run -p` with one prompt.

## The HTTP API behind it

The command uses the daemon's HTTP API and nothing else. The routes it calls are stable and a
script can call them directly: see [http-api.md](http-api.md).

## The same shape elsewhere

The lines follow the stream-json form of Claude Code where Keel says the same thing, so a client
written for one needs few changes for the other:

- Claude Code: `claude -p --input-format stream-json --output-format stream-json`, user messages
  as `{"type":"user","message":{...}}`, one `result` per response, and `control_request` /
  `control_response` lines for an interrupt and for `can_use_tool`
  ([headless](https://code.claude.com/docs/en/headless),
  [CLI reference](https://code.claude.com/docs/en/cli-reference),
  [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)). Its
  SDKs for TypeScript and Python wrap these lines.
- Codex: `codex app-server` speaks JSON-RPC over JSON lines (`thread/start`, `turn/start`,
  `turn/interrupt`, approval requests the client answers with `accept` or `decline`), and its
  SDKs drive that server ([app server](https://developers.openai.com/codex/app-server),
  [SDK](https://developers.openai.com/codex/sdk)).

Differences from Claude Code's lines: Keel sends a `result` for an interrupted turn with
`subtype: "cancelled"`; a question is its own request (`ask_question`) and not a `can_use_tool`
of the question tool; the permission mode and the model are not changed over the stream.
