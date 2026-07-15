import {describe, expect, it, vi} from "vitest";

import {LearningApiError, createLearningApi} from "./learning-api";

describe("learning api", () => {
  it("flattens graph buckets and keeps memory and skill pending writes typed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            buckets: [{nodes: [{id: "skill-1", label: "Safer deploys", meta: {category: "skill"}}]}],
          }),
          {status: 200},
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            memory: [{id: "mem-1", title: "Remember profile", operations: [{action: "add", after: "default"}]}],
            skills: [{id: "skill-2", title: "New skill"}],
          }),
          {status: 200},
        ),
      );
    const api = createLearningApi(fetchMock as unknown as typeof fetch);

    await expect(api.timeline("default")).resolves.toEqual([
      expect.objectContaining({id: "skill-1", kind: "skill", title: "Safer deploys"}),
    ]);
    await expect(api.pending("default")).resolves.toEqual([
      expect.objectContaining({id: "mem-1", kind: "memory", operations: [expect.objectContaining({action: "add"})]}),
      expect.objectContaining({id: "skill-2", kind: "skill"}),
    ]);
  });

  it("fails before fetch for unsafe profile and record identifiers", async () => {
    const fetchMock = vi.fn();
    const api = createLearningApi(fetchMock as unknown as typeof fetch);
    await expect(api.pending("all")).rejects.toBeInstanceOf(LearningApiError);
    await expect(api.detail("default", "node\n/approve")).rejects.toBeInstanceOf(LearningApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
