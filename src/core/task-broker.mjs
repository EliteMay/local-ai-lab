export const TASK_STATES = Object.freeze([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCELLED"
]);

const DEFAULT_ROUTES = Object.freeze({
  director: ["researcher", "auditor", "improvement-planner", "reviewer"],
  researcher: ["auditor", "reviewer"],
  auditor: ["researcher", "improvement-planner", "reviewer"],
  "improvement-planner": ["researcher", "auditor", "reviewer"],
  reviewer: ["researcher", "auditor", "improvement-planner"]
});

const TRANSITIONS = Object.freeze({
  PENDING: ["RUNNING", "CANCELLED", "BLOCKED"],
  RUNNING: ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"],
  BLOCKED: ["PENDING", "CANCELLED"],
  FAILED: [],
  COMPLETED: [],
  CANCELLED: []
});

function normalizeObjective(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
}

export class TaskBroker {
  #tasks = new Map();
  #sequence = 0;
  #modelCalls = 0;

  constructor({ limits, routes = DEFAULT_ROUTES } = {}) {
    this.limits = {
      maxDelegationDepth: 3,
      maxTasksPerRun: 12,
      maxModelCalls: 20,
      maxRetriesPerTask: 1,
      ...limits
    };
    this.routes = routes;
  }

  createTask({ requestedBy, assignedTo, objective, parentTaskId = null, inputs = {} }) {
    assertNonEmptyString(requestedBy, "requestedBy");
    assertNonEmptyString(assignedTo, "assignedTo");
    assertNonEmptyString(objective, "objective");

    if (this.#tasks.size >= this.limits.maxTasksPerRun) {
      throw new Error("Task limit exceeded");
    }

    let depth = 0;
    if (parentTaskId !== null) {
      const parent = this.getTask(parentTaskId);
      depth = parent.depth + 1;
    }

    if (depth > this.limits.maxDelegationDepth) {
      throw new Error("Delegation depth exceeded");
    }

    const duplicateKey = `${assignedTo}:${normalizeObjective(objective)}`;
    for (const task of this.#tasks.values()) {
      if (task.duplicateKey === duplicateKey && task.state !== "CANCELLED") {
        throw new Error(`Duplicate task rejected: ${task.id}`);
      }
    }

    const id = `task-${String(++this.#sequence).padStart(3, "0")}`;
    const task = {
      id,
      parentTaskId,
      requestedBy,
      assignedTo,
      objective: objective.trim(),
      inputs,
      depth,
      state: "PENDING",
      retries: 0,
      duplicateKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.#tasks.set(id, task);
    return structuredClone(task);
  }

  requestDelegation({ fromTaskId, to, objective, reason, priority = "normal", inputs = {} }) {
    assertNonEmptyString(fromTaskId, "fromTaskId");
    assertNonEmptyString(to, "to");
    assertNonEmptyString(objective, "objective");
    assertNonEmptyString(reason, "reason");

    const parent = this.getTask(fromTaskId);
    const allowed = this.routes[parent.assignedTo] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(`Delegation route not allowed: ${parent.assignedTo} -> ${to}`);
    }

    const task = this.createTask({
      requestedBy: parent.assignedTo,
      assignedTo: to,
      objective,
      parentTaskId: fromTaskId,
      inputs: {
        ...inputs,
        delegationReason: reason.trim(),
        priority
      }
    });

    return task;
  }

  transition(taskId, nextState) {
    if (!TASK_STATES.includes(nextState)) {
      throw new Error(`Unknown task state: ${nextState}`);
    }

    const current = this.#tasks.get(taskId);
    if (!current) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    if (!TRANSITIONS[current.state].includes(nextState)) {
      throw new Error(`Invalid task transition: ${current.state} -> ${nextState}`);
    }

    current.state = nextState;
    current.updatedAt = new Date().toISOString();
    return structuredClone(current);
  }

  recordRetry(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    if (task.retries >= this.limits.maxRetriesPerTask) {
      throw new Error(`Retry limit exceeded: ${taskId}`);
    }
    task.retries += 1;
    task.updatedAt = new Date().toISOString();
    return task.retries;
  }

  recordModelCall(taskId) {
    this.getTask(taskId);
    if (this.#modelCalls >= this.limits.maxModelCalls) {
      throw new Error("Model call limit exceeded");
    }
    this.#modelCalls += 1;
    return this.#modelCalls;
  }

  getTask(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    return structuredClone(task);
  }

  snapshot() {
    return {
      modelCalls: this.#modelCalls,
      taskCount: this.#tasks.size,
      tasks: [...this.#tasks.values()].map((task) => structuredClone(task))
    };
  }
}

export { DEFAULT_ROUTES };
