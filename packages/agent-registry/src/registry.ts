import type { Agent } from "@auzaar/core";
import {
  type Result,
  ok,
  err,
  AgentNotFoundError,
  AgentSuspendedError,
  StorageError,
  generateAgentId,
} from "@auzaar/core";
import type { AgentStore } from "./store.js";

export class AgentRegistry {
  constructor(private readonly store: AgentStore) {}

  async registerAgent(
    name: string,
    framework?: string,
    authorizationScope?: string[]
  ): Promise<Result<Agent>> {
    try {
      const now = new Date().toISOString();
      const agent: Agent = {
        id: generateAgentId(),
        name,
        framework,
        authorizationScope: authorizationScope ?? [],
        delegationChain: [],
        trustScore: 0.5,
        status: "active",
        registeredAt: now,
      };

      await this.store.save(agent);
      return ok(agent);
    } catch (error) {
      return err(
        new StorageError("Failed to register agent", {
          cause: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  async getAgent(agentId: string): Promise<Result<Agent>> {
    try {
      const agent = await this.store.getById(agentId);
      if (!agent) {
        return err(new AgentNotFoundError(agentId));
      }
      return ok(agent);
    } catch (error) {
      return err(
        new StorageError("Failed to get agent", {
          cause: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  async suspendAgent(agentId: string): Promise<Result<Agent>> {
    try {
      const agent = await this.store.getById(agentId);
      if (!agent) {
        return err(new AgentNotFoundError(agentId));
      }

      const suspended: Agent = { ...agent, status: "suspended" };
      await this.store.save(suspended);
      return ok(suspended);
    } catch (error) {
      return err(
        new StorageError("Failed to suspend agent", {
          cause: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  async revokeAgent(agentId: string): Promise<Result<Agent>> {
    try {
      const agent = await this.store.getById(agentId);
      if (!agent) {
        return err(new AgentNotFoundError(agentId));
      }

      const revoked: Agent = { ...agent, status: "revoked" };
      await this.store.save(revoked);
      return ok(revoked);
    } catch (error) {
      return err(
        new StorageError("Failed to revoke agent", {
          cause: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  async updateTrustScore(
    agentId: string,
    score: number
  ): Promise<Result<Agent>> {
    if (score < 0 || score > 1) {
      return err(
        new StorageError("Trust score must be between 0 and 1", {
          score,
        })
      );
    }

    try {
      const agent = await this.store.getById(agentId);
      if (!agent) {
        return err(new AgentNotFoundError(agentId));
      }

      const updated: Agent = { ...agent, trustScore: score };
      await this.store.save(updated);
      return ok(updated);
    } catch (error) {
      return err(
        new StorageError("Failed to update trust score", {
          cause: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
}
