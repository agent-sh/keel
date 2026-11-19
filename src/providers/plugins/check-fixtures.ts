// The frozen protocol v1 fixtures, embedded so a compiled `keel` carries them
// (copied from agent-sh/keel docs/provider-plugin-v1/fixtures; never edited).
import f0 from "../../../test/fixtures/plugin-v1/anthropic_messages.message.json" with { type: "file" };
import f1 from "../../../test/fixtures/plugin-v1/anthropic_messages.turn.malformed.sse" with { type: "file" };
import f2 from "../../../test/fixtures/plugin-v1/anthropic_messages.turn.sse" with { type: "file" };
import f3 from "../../../test/fixtures/plugin-v1/chat_completions.completion.json" with { type: "file" };
import f4 from "../../../test/fixtures/plugin-v1/chat_completions.turn.malformed.sse" with { type: "file" };
import f5 from "../../../test/fixtures/plugin-v1/chat_completions.turn.sse" with { type: "file" };
import f6 from "../../../test/fixtures/plugin-v1/errors/anthropic_messages.401.json" with { type: "file" };
import f7 from "../../../test/fixtures/plugin-v1/errors/anthropic_messages.429.json" with { type: "file" };
import f8 from "../../../test/fixtures/plugin-v1/errors/anthropic_messages.500.json" with { type: "file" };
import f9 from "../../../test/fixtures/plugin-v1/errors/chat_completions.401.json" with { type: "file" };
import f10 from "../../../test/fixtures/plugin-v1/errors/chat_completions.429.json" with { type: "file" };
import f11 from "../../../test/fixtures/plugin-v1/errors/chat_completions.500.json" with { type: "file" };
import f12 from "../../../test/fixtures/plugin-v1/errors/gemini_generate_content.401.json" with { type: "file" };
import f13 from "../../../test/fixtures/plugin-v1/errors/gemini_generate_content.429.json" with { type: "file" };
import f14 from "../../../test/fixtures/plugin-v1/errors/gemini_generate_content.500.json" with { type: "file" };
import f15 from "../../../test/fixtures/plugin-v1/errors/openai_responses.401.json" with { type: "file" };
import f16 from "../../../test/fixtures/plugin-v1/errors/openai_responses.429.json" with { type: "file" };
import f17 from "../../../test/fixtures/plugin-v1/errors/openai_responses.500.json" with { type: "file" };
import f18 from "../../../test/fixtures/plugin-v1/expected.json" with { type: "file" };
import f19 from "../../../test/fixtures/plugin-v1/gemini_generate_content.response.envelope.json" with { type: "file" };
import f20 from "../../../test/fixtures/plugin-v1/gemini_generate_content.response.json" with { type: "file" };
import f21 from "../../../test/fixtures/plugin-v1/gemini_generate_content.turn.envelope.json-array" with { type: "file" };
import f22 from "../../../test/fixtures/plugin-v1/gemini_generate_content.turn.envelope.malformed.sse" with { type: "file" };
import f23 from "../../../test/fixtures/plugin-v1/gemini_generate_content.turn.envelope.sse" with { type: "file" };
import f24 from "../../../test/fixtures/plugin-v1/gemini_generate_content.turn.json-array" with { type: "file" };
import f25 from "../../../test/fixtures/plugin-v1/gemini_generate_content.turn.malformed.sse" with { type: "file" };
import f26 from "../../../test/fixtures/plugin-v1/gemini_generate_content.turn.sse" with { type: "file" };
import f27 from "../../../test/fixtures/plugin-v1/openai_responses.response.json" with { type: "file" };
import f28 from "../../../test/fixtures/plugin-v1/openai_responses.turn.malformed.sse" with { type: "file" };
import f29 from "../../../test/fixtures/plugin-v1/openai_responses.turn.sse" with { type: "file" };

export const FIXTURE_FILES = {
  "anthropic_messages.message.json": f0,
  "anthropic_messages.turn.malformed.sse": f1,
  "anthropic_messages.turn.sse": f2,
  "chat_completions.completion.json": f3,
  "chat_completions.turn.malformed.sse": f4,
  "chat_completions.turn.sse": f5,
  "errors/anthropic_messages.401.json": f6,
  "errors/anthropic_messages.429.json": f7,
  "errors/anthropic_messages.500.json": f8,
  "errors/chat_completions.401.json": f9,
  "errors/chat_completions.429.json": f10,
  "errors/chat_completions.500.json": f11,
  "errors/gemini_generate_content.401.json": f12,
  "errors/gemini_generate_content.429.json": f13,
  "errors/gemini_generate_content.500.json": f14,
  "errors/openai_responses.401.json": f15,
  "errors/openai_responses.429.json": f16,
  "errors/openai_responses.500.json": f17,
  "expected.json": f18,
  "gemini_generate_content.response.envelope.json": f19,
  "gemini_generate_content.response.json": f20,
  "gemini_generate_content.turn.envelope.json-array": f21,
  "gemini_generate_content.turn.envelope.malformed.sse": f22,
  "gemini_generate_content.turn.envelope.sse": f23,
  "gemini_generate_content.turn.json-array": f24,
  "gemini_generate_content.turn.malformed.sse": f25,
  "gemini_generate_content.turn.sse": f26,
  "openai_responses.response.json": f27,
  "openai_responses.turn.malformed.sse": f28,
  "openai_responses.turn.sse": f29,
} as Record<string, unknown> as Record<string, string>;
