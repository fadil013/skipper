import { describe, expect, it } from "vitest";
import { SkipperError, callSkipper } from "../lib/skipper.ts";
import { buildRequests } from "../lib/questions.ts";
import { startFakeSkipper } from "../scripts/fake-skipper.ts";
import type { Segment, VideoInfo } from "../lib/types.ts";

const video: VideoInfo = { videoId: "v", title: "t", channel: "c", duration: 120 };
const segments = (n: number): Segment[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${String(i + 1).padStart(3, "0")}`,
    start: i * 30,
    end: i * 30 + 30,
    text: i === 1 ? "this video is brought to you by Nordpass, use code LAMPS20" : "the arm holds its position",
    has_promo_markers: i === 1,
  }));

const request = (n: number) => buildRequests(video, segments(n))[0];

describe("background skipper client", () => {
  it("answers every question against the fake", async () => {
    const fake = await startFakeSkipper();
    const response = await callSkipper(request(4), { apiKey: "k", baseUrl: fake.url });
    expect(Object.keys(response.answers)).toHaveLength(4);
    expect(response.answers.s002.choice).toBe("sponsor");
    expect(response.answers.s002.probabilities.sponsor).toBeGreaterThan(0.9);
    await fake.close();
  });

  it("retries a 429 once, honouring retry-after", async () => {
    const fake = await startFakeSkipper({ failFirstWith: 429 });
    const response = await callSkipper(request(2), { apiKey: "k", baseUrl: fake.url });
    expect(fake.requests).toHaveLength(2);
    expect(Object.keys(response.answers)).toHaveLength(2);
    await fake.close();
  });

  it("bisects a too-big 400 instead of giving up", async () => {
    const fake = await startFakeSkipper({ tooBigOver: 2 });
    const response = await callSkipper(request(8), { apiKey: "k", baseUrl: fake.url });
    expect(Object.keys(response.answers).sort()).toEqual(
      segments(8).map((s) => s.id),
    );
    // one rejected whole, then halves until they fit
    expect(fake.requests.length).toBeGreaterThan(4);
    expect(Math.max(...fake.requests.slice(1).map((r) => r.state.segments.length))).toBeLessThanOrEqual(8);
    await fake.close();
  });

  it("does not retry a 401 and surfaces the status", async () => {
    const fake = await startFakeSkipper({ failFirstWith: 401 });
    await expect(callSkipper(request(1), { apiKey: "bad", baseUrl: fake.url })).rejects.toBeInstanceOf(
      SkipperError,
    );
    expect(fake.requests).toHaveLength(1);
    await fake.close();
  });

  it("stops retrying a 500 at the attempt ceiling", async () => {
    const fake = await startFakeSkipper();
    const always500 = (async () =>
      new Response(JSON.stringify({ error: "nope" }), { status: 500 })) as unknown as typeof fetch;
    await expect(
      callSkipper(request(1), {
        apiKey: "k",
        baseUrl: fake.url,
        fetchImpl: always500,
        sleepImpl: async () => {},
      }),
    ).rejects.toMatchObject({ status: 500 });
    await fake.close();
  });
});
