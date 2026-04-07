declare module 'lottie-frame' {
  export function exportFrame(data: Buffer, options: {
    frame: number;
    width: number;
    height: number;
    quality?: number;
  }): Promise<Buffer>;

  export function exportFrameSync(data: Buffer, options: {
    frame: number;
    width: number;
    height: number;
    quality?: number;
  }): Buffer;
}
