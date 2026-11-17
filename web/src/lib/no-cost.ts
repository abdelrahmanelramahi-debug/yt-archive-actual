// What an answer or a depth costs is for admins only. For everyone else the routes that pass the
// brain's replies through drop the cost figures here, so they never reach the browser at all.

// A brain answer stream (Server-Sent Events) without `cost_usd` in any event.
export function withoutCost(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        buf += dec.decode(chunk, { stream: true });
        let end: number;
        while ((end = buf.indexOf("\n\n")) >= 0) {
          out.enqueue(enc.encode(scrubEvent(buf.slice(0, end + 2))));
          buf = buf.slice(end + 2);
        }
      },
      flush(out) {
        buf += dec.decode();
        if (buf) out.enqueue(enc.encode(scrubEvent(buf)));
      },
    })
  );
}

function scrubEvent(block: string): string {
  if (!block.includes("cost_usd")) return block; // nearly every event: passed through untouched
  return block.replace(/^data: (.*)$/m, (line, json: string) => {
    try {
      const o = JSON.parse(json);
      if (o && typeof o === "object") delete o.cost_usd;
      return "data: " + JSON.stringify(o);
    } catch {
      return line;
    }
  });
}

// A one-shot answer, or the depth modes list, without their cost figures.
export function stripCost<T>(data: T): T {
  if (!data || typeof data !== "object") return data;
  const o = { ...(data as Record<string, unknown>) };
  delete o.cost_usd;
  if (Array.isArray(o.modes)) {
    o.modes = (o.modes as Record<string, unknown>[]).map((m) => {
      const { usd: _usd, ...rest } = m; // eslint-disable-line @typescript-eslint/no-unused-vars
      return rest;
    });
  }
  return o as T;
}
