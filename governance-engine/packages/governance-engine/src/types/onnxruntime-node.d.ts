declare module "onnxruntime-node" {
  export class InferenceSession {
    static create(path: string): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }

  export class Tensor {
    constructor(type: string, data: BigInt64Array | Float32Array, dims: number[]);
    readonly data: Float32Array | BigInt64Array;
  }
}
