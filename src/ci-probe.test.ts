// Throwaway probe for PR 958: one failing and one passing test, to check how
// the sharded Vitest jobs report a failure. Do not merge.
describe("ci probe", () => {
  it("passes", () => {
    expect(1 + 1).toBe(2);
  });

  it("fails on purpose", () => {
    expect("actual").toBe("expected");
  });
});
