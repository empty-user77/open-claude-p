// `--output-format json` adapter.
//
// Emits a single JSON object on `end()` mirroring the top-level shape that
// `claude -p --output-format json` produces. Fields the shim cannot derive
// from PTY-only output (token usage, exact cost) are reported as `null`.
//
// Schema:
//   {
//     "result":        string,
//     "session_id":    string | null,
//     "is_error":      boolean,
//     "cost":          { "total_usd": number|null, "num_turns": number|null },
//     "duration_ms":   number,
//     "completion":    "sentinel" | "idle" | "timeout" | "cancelled" | …
//   }

/**
 * Validate the assistant output against a JSON Schema, if one was provided
 * via `--json-schema`. We support the minimal subset (`type` + required
 * fields) the upstream documentation advertises. A real validator is out
 * of scope; the goal here is to flag obvious mismatches rather than be a
 * full JSON Schema engine.
 */
function validateAgainstSchema(text, schema) {
  if (!schema || typeof schema !== 'object') return null;
  let value;
  try { value = JSON.parse(text); } catch { return 'json-parse-failed'; }
  const expected = schema.type;
  const actual =
    value === null ? 'null'
      : Array.isArray(value) ? 'array'
      : typeof value;
  if (expected && expected !== actual) return `type ${actual} != expected ${expected}`;
  if (expected === 'object' && Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        return `missing required key: ${key}`;
      }
    }
  }
  return null;
}

export const jsonOutputAdapter = {
  name: 'json',
  /**
   * @param {{ jsonSchema?: object }} opts
   * @param {{ write: (s: string) => void }} sink
   */
  create(opts, sink) {
    return {
      onEvent(_event) {
        // The json adapter emits one consolidated object at end(); per-event
        // streaming is handled by the stream-json adapter instead.
      },
      /**
       * @param {object} finalResult
       */
      end(finalResult) {
        const result = finalResult?.text ?? '';
        let isError = !!finalResult?.isError;
        let schemaError = null;
        if (opts?.jsonSchema) {
          schemaError = validateAgainstSchema(result, opts.jsonSchema);
          if (schemaError) isError = true;
        }
        const out = {
          result,
          session_id: finalResult?.sessionId ?? null,
          is_error: isError,
          cost: {
            total_usd: finalResult?.cost?.totalUsd ?? null,
            num_turns: finalResult?.cost?.numTurns ?? null,
          },
          duration_ms: finalResult?.durationMs ?? null,
          completion: finalResult?.completionReason ?? null,
        };
        if (schemaError) out.schema_error = schemaError;
        sink.write(JSON.stringify(out) + '\n');
      },
    };
  },
};
