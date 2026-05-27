declare module "node-llama-cpp" {
  export function getLlama(): Promise<Llama>;

  export interface Llama {
    loadModel(options: { modelPath: string }): Promise<LlamaModel>;
  }

  export interface LlamaModel {
    createContext(): Promise<LlamaContext>;
  }

  export interface LlamaContext {
    getSequence(): LlamaContextSequence;
  }

  export interface LlamaContextSequence {}

  export class LlamaChatSession {
    constructor(options: { contextSequence: LlamaContextSequence });
    prompt(text: string, options?: { maxTokens?: number }): Promise<string>;
  }
}
