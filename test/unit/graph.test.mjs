/**
 * findCycle (src/core/graph.ts, architecture §6.3): plan approval refuses dependency cycles (TASK-13).
 * Run after `npm run build`: npm run test:unit
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findCycle } from "../../dist/core/graph.js";

describe("findCycle", () => {
  test("two-task cycle T1→T2→T1", () => {
    assert.deepStrictEqual(findCycle([{ key: "T1", dependsOn: ["T2"] }, { key: "T2", dependsOn: ["T1"] }]), ["T1", "T2", "T1"]);
  });
  test("a DAG has no cycle", () => {
    assert.equal(findCycle([
      { key: "T1", dependsOn: [] },
      { key: "T2", dependsOn: ["T1"] },
      { key: "T3", dependsOn: ["T1"] },
      { key: "T4", dependsOn: ["T2", "T3", "T1"] },
    ]), null);
  });
  test("empty plan has no cycle", () => assert.equal(findCycle([]), null));
  test("self-edge", () => assert.deepStrictEqual(findCycle([{ key: "T1", dependsOn: ["T1"] }]), ["T1", "T1"]));
  test("longer cycle reached from an acyclic prefix lists only the cycle", () => {
    assert.deepStrictEqual(findCycle([
      { key: "T0", dependsOn: ["T1"] },
      { key: "T1", dependsOn: ["T2"] },
      { key: "T2", dependsOn: ["T3"] },
      { key: "T3", dependsOn: ["T1"] },
    ]), ["T1", "T2", "T3", "T1"]);
  });
  test("unknown dependency keys are ignored", () => {
    assert.equal(findCycle([{ key: "T1", dependsOn: ["T9"] }, { key: "T2", dependsOn: ["T1"] }]), null);
  });
  test("forward reference without a back edge is fine", () => {
    assert.equal(findCycle([{ key: "T1", dependsOn: ["T2"] }, { key: "T2", dependsOn: [] }]), null);
  });
});
