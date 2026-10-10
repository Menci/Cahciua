// These native/static packages do not consistently ship declarations in their
// published artifacts. Keep the consumed API typed across local and Docker installs.
declare module 'ffprobe-static' {
  const ffprobe: { readonly path: string };
  export default ffprobe;
}

declare module 'lottie-frame' {
  export function exportFrame(data: Buffer, options?: {
    frame?: number;
    width?: number;
    height?: number;
    quality?: number;
  }): Promise<Buffer>;
}
