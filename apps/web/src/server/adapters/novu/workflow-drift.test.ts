import { describe, expect, it } from "vitest";

import { checkTransportWorkflows } from "@/server/adapters/novu/workflow-drift";
import {
  makeCanonicalTransportWorkflows,
  makeTransportWorkflow,
  makeTransportWorkflowList,
} from "@/test/factories/transport";

/**
 * U3 — the workflow drift assertion (notification design §8.3, API contract
 * §9.4).
 *
 * A dashboard edit that adds a workflow, adds a second step, or changes a step's
 * channel silently changes production behaviour. This pure check is the guard:
 * the workflow set must be exactly the three transport workflows, each with
 * exactly one step, and each step's channel must match its workflow name.
 */
describe("checkTransportWorkflows", () => {
  it("passes when exactly the three transport workflows each have one matching step", () => {
    // Arrange
    const workflows = makeCanonicalTransportWorkflows();

    // Act
    const report = checkTransportWorkflows(workflows);

    // Assert
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it("reports an unexpected fourth workflow", () => {
    // Arrange
    const workflows = makeTransportWorkflowList([
      ...makeCanonicalTransportWorkflows(),
      makeTransportWorkflow({
        workflowId: "welcome-email",
        steps: [{ active: true, channel: "email" }],
      }),
    ]);

    // Act
    const report = checkTransportWorkflows(workflows);

    // Assert
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes("welcome-email"))).toBe(true);
  });

  it("reports a transport workflow that has more than one step", () => {
    // Arrange
    const workflows = makeTransportWorkflowList([
      makeTransportWorkflow({
        workflowId: "transport-email",
        steps: [{ active: true, channel: "email" }],
      }),
      makeTransportWorkflow({
        workflowId: "transport-sms",
        steps: [
          { active: true, channel: "sms" },
          { active: true, channel: "sms" },
        ],
      }),
      makeTransportWorkflow({
        workflowId: "transport-whatsapp",
        steps: [{ active: true, channel: "whatsapp" }],
      }),
    ]);

    // Act
    const report = checkTransportWorkflows(workflows);

    // Assert
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes("transport-sms"))).toBe(true);
    expect(report.problems.some((problem) => problem.includes("step"))).toBe(true);
  });

  it("reports a step whose channel does not match its workflow name", () => {
    // Arrange
    const workflows = makeTransportWorkflowList([
      makeTransportWorkflow({
        workflowId: "transport-email",
        steps: [{ active: true, channel: "sms" }],
      }),
      makeTransportWorkflow({
        workflowId: "transport-sms",
        steps: [{ active: true, channel: "sms" }],
      }),
      makeTransportWorkflow({
        workflowId: "transport-whatsapp",
        steps: [{ active: true, channel: "whatsapp" }],
      }),
    ]);

    // Act
    const report = checkTransportWorkflows(workflows);

    // Assert
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes("transport-email"))).toBe(true);
    expect(report.problems.some((problem) => problem.includes("sms"))).toBe(true);
  });

  it("reports a missing transport workflow", () => {
    // Arrange
    const workflows = makeTransportWorkflowList([
      makeTransportWorkflow({
        workflowId: "transport-email",
        steps: [{ active: true, channel: "email" }],
      }),
      makeTransportWorkflow({
        workflowId: "transport-sms",
        steps: [{ active: true, channel: "sms" }],
      }),
    ]);

    // Act
    const report = checkTransportWorkflows(workflows);

    // Assert
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes("transport-whatsapp"))).toBe(true);
  });
});
