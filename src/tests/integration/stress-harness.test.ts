import { describe, expect, it } from "vitest";
import { runStress } from "../helpers/stress-runner";
describe("offline stress runner contract", () => {
  it("executes all role recipes with asynchronous response isolation and validates database/session invariants", async () => {
    const report = await runStress({ users: 5, updates: 125 });
    expect(
      report.passed,
      JSON.stringify({ invariants: report.invariants, failures: report.failures }),
    ).toBe(true);
    expect(report.result.completedUpdates).toBe(125);
    expect(report.result.peakConcurrentHandlers).toBe(5);
    expect(report.workload.createdOrders).toBe(3);
    expect(report.workload.fulfilledOrders).toBe(1);
    expect(report.workload.expectedRbacDenials).toBe(6);
    expect(report.persistence.updateReceipts).toBe(125);
    expect(report.workload.realNetworkAttempts).toBe(0);
  }, 30000);
  it("rejects malformed or unbounded workload sizes before creating a database or transport", async () => {
    await expect(runStress({ users: 4, updates: 100 })).rejects.toThrow("users");
    await expect(runStress({ users: 5, updates: 124 })).rejects.toThrow("updates");
  });
});
