import test from "node:test";
import assert from "node:assert/strict";
import { TaskBroker } from "../src/core/task-broker.mjs";

test("auditor can delegate to researcher through broker", () => {
  const broker = new TaskBroker();
  const root = broker.createTask({
    requestedBy: "director",
    assignedTo: "auditor",
    objective: "Audit navigation"
  });

  const child = broker.requestDelegation({
    fromTaskId: root.id,
    to: "researcher",
    objective: "Research mobile navigation evidence",
    reason: "Need current external evidence"
  });

  assert.equal(child.parentTaskId, root.id);
  assert.equal(child.assignedTo, "researcher");
  assert.equal(child.depth, 1);
});

test("broker rejects an unapproved delegation route", () => {
  const broker = new TaskBroker();
  const root = broker.createTask({
    requestedBy: "director",
    assignedTo: "researcher",
    objective: "Research evidence"
  });

  assert.throws(() => broker.requestDelegation({
    fromTaskId: root.id,
    to: "improvement-planner",
    objective: "Write a proposal",
    reason: "Try an invalid route"
  }), /route not allowed/);
});

test("broker rejects duplicate active tasks", () => {
  const broker = new TaskBroker();
  broker.createTask({
    requestedBy: "director",
    assignedTo: "auditor",
    objective: "Audit navigation"
  });

  assert.throws(() => broker.createTask({
    requestedBy: "director",
    assignedTo: "auditor",
    objective: "  AUDIT   navigation "
  }), /Duplicate task rejected/);
});

test("broker enforces delegation depth", () => {
  const broker = new TaskBroker({ limits: { maxDelegationDepth: 1 } });
  const root = broker.createTask({
    requestedBy: "director",
    assignedTo: "auditor",
    objective: "Root audit"
  });
  const child = broker.requestDelegation({
    fromTaskId: root.id,
    to: "researcher",
    objective: "Research finding",
    reason: "Need evidence"
  });

  assert.throws(() => broker.requestDelegation({
    fromTaskId: child.id,
    to: "auditor",
    objective: "Re-audit researched finding",
    reason: "Need implementation check"
  }), /Delegation depth exceeded/);
});

test("broker enforces model call budget", () => {
  const broker = new TaskBroker({ limits: { maxModelCalls: 1 } });
  const task = broker.createTask({
    requestedBy: "director",
    assignedTo: "auditor",
    objective: "Audit repository"
  });

  assert.equal(broker.recordModelCall(task.id), 1);
  assert.throws(() => broker.recordModelCall(task.id), /Model call limit exceeded/);
});
