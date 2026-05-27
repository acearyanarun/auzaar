import type { Mandate } from "@auzaar/core";

export interface MandateStore {
  save(mandate: Mandate): Promise<void>;
  getById(id: string): Promise<Mandate | null>;
  getByUserId(userId: string): Promise<Mandate[]>;
  getVersionHistory(mandateId: string): Promise<Mandate[]>;
}

export class InMemoryMandateStore implements MandateStore {
  private readonly mandates = new Map<string, Mandate>();

  async save(mandate: Mandate): Promise<void> {
    this.mandates.set(mandate.id, mandate);
  }

  async getById(id: string): Promise<Mandate | null> {
    return this.mandates.get(id) ?? null;
  }

  async getByUserId(userId: string): Promise<Mandate[]> {
    const results: Mandate[] = [];
    for (const mandate of this.mandates.values()) {
      if (mandate.userId === userId) {
        results.push(mandate);
      }
    }
    return results;
  }

  async getVersionHistory(mandateId: string): Promise<Mandate[]> {
    const history: Mandate[] = [];
    let currentId: string | undefined = mandateId;

    while (currentId) {
      const mandate = this.mandates.get(currentId);
      if (!mandate) break;
      history.push(mandate);
      currentId = mandate.previousVersionId;
    }

    return history;
  }
}
