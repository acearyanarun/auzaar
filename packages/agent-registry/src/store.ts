import type { Agent } from "@auzaar/core";

export interface AgentStore {
  save(agent: Agent): Promise<void>;
  getById(agentId: string): Promise<Agent | null>;
  getByStatus(status: Agent["status"]): Promise<Agent[]>;
  list(): Promise<Agent[]>;
}

export class InMemoryAgentStore implements AgentStore {
  private readonly agents = new Map<string, Agent>();

  async save(agent: Agent): Promise<void> {
    this.agents.set(agent.id, agent);
  }

  async getById(agentId: string): Promise<Agent | null> {
    return this.agents.get(agentId) ?? null;
  }

  async getByStatus(status: Agent["status"]): Promise<Agent[]> {
    const result: Agent[] = [];
    for (const agent of this.agents.values()) {
      if (agent.status === status) {
        result.push(agent);
      }
    }
    return result;
  }

  async list(): Promise<Agent[]> {
    return Array.from(this.agents.values());
  }
}
